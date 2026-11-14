// Live preview: the draft rendered on the artifact's own content subdomain, under the content CSP,
// in the same sandboxed frame the published artifact uses. See previewProtocol.ts for the flow.
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { API, type AppConfig, artifactIframeSandbox, route, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { IconButton, Spinner, Tooltip } from "../ui/index.ts";
import {
  isReadyMessage,
  MAX_PREVIEW_BYTES,
  newPreviewNonce,
  PREVIEW_PATH,
  previewTarget,
  renderMessage,
  utf8Bytes,
  withPreviewNonce,
} from "./previewProtocol.ts";

/** Wait this long after the last keystroke before re-rendering. */
export const PREVIEW_DEBOUNCE_MS = 300;

type Status = "loading" | "ready" | "too_large" | "error";

export interface PreviewFrameProps {
  artifactId: string;
  title: string;
  html: string;
  config: AppConfig;
}

/** One loader frame: its own iframe element (by key) and URL (which carries its nonce). */
interface Loader {
  key: number;
  src: string;
}

export function PreviewFrame({ artifactId, title, html, config }: PreviewFrameProps) {
  const { base, messageOrigin, postOrigin } = previewTarget(config, artifactId);
  const sandbox = artifactIframeSandbox(
    config.content_path_fallback ? "opaque" : config.content_isolation,
  );
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** The one-time enter link from the gate; only the first loader goes through it. */
  const [entered, setEntered] = useState(false);
  const [loader, setLoader] = useState<Loader | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [gateError, setGateError] = useState<string | null>(null);
  /** The newest draft, read when a loader says it is ready. */
  const latest = useRef(html);
  latest.current = html;
  /** What the frame currently shows; null while a loader waits for HTML. */
  const shown = useRef<string | null>(null);
  /** The nonce of the loader that said "ready" and has not been sent HTML yet ("" for none). */
  const waiting = useRef("");
  /** The nonce of the current loader frame; a "ready" must carry it. */
  const expected = useRef("");

  const send = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win || !waiting.current || waiting.current !== expected.current) return;
    const draft = latest.current;
    if (utf8Bytes(draft) > MAX_PREVIEW_BYTES) {
      setStatus("too_large");
      return;
    }
    // One render per loader: the nonce is spent, so nothing more goes to this frame.
    waiting.current = "";
    expected.current = "";
    shown.current = draft;
    win.postMessage(renderMessage(draft), postOrigin);
    setStatus("ready");
  }, [postOrigin]);

  /** Mount a new frame on the loader with a new nonce; it says "ready". */
  const mount = useCallback((src: string, key: number) => {
    const nonce = newPreviewNonce();
    expected.current = nonce;
    waiting.current = "";
    shown.current = null;
    setStatus("loading");
    setLoader({ key, src: withPreviewNonce(src, nonce) });
  }, []);

  const reload = useCallback(() => {
    if (!entered) return;
    mount(`${base}${PREVIEW_PATH}`, (loader?.key ?? 0) + 1);
  }, [base, entered, loader?.key, mount]);

  // A one-time enter link for this artifact that lands on the loader. It sets the content cookie
  // on the artifact's subdomain, so the draft's relative asset URLs load like the published page.
  // Later loaders open the loader page directly: it holds no data and needs no cookie.
  useEffect(() => {
    if (entered) return;
    const ctl = new AbortController();
    const path = route(API.view, { ref: artifactId });
    api<ViewGate>(`${path}?next=${encodeURIComponent(PREVIEW_PATH)}`, { signal: ctl.signal })
      .then((gate) => {
        if (gate.status === "ok") {
          setEntered(true);
          mount(gate.enter_url, 0);
        } else {
          setGateError("This artifact cannot be opened right now.");
          setStatus("error");
        }
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setGateError(e instanceof Error ? e.message : "The preview could not load.");
        setStatus("error");
      });
    return () => ctl.abort();
  }, [artifactId, entered, mount]);

  // Messages from the frame: only "ready", only from the current frame's window, with its nonce.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== messageOrigin) return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      if (!isReadyMessage(event.data, expected.current)) return;
      waiting.current = expected.current;
      send();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [messageOrigin, send]);

  // Re-render shortly after the draft stops changing.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (waiting.current) send();
      else if (shown.current !== null && shown.current !== html) reload();
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [html, send, reload]);

  return (
    <div className="pl-editor-preview" aria-busy={status === "loading" || undefined}>
      <div className="pl-editor-preview__tools">
        <span className="pl-editor-pane__label" id={`preview-label-${artifactId}`}>
          Preview
        </span>
        {status === "loading" && <Spinner />}
        <Tooltip content="Reload preview">
          <IconButton
            icon={ArrowClockwiseIcon}
            label="Reload preview"
            variant="ghost"
            size="sm"
            onClick={reload}
            disabled={!entered}
          />
        </Tooltip>
      </div>
      <div className="pl-editor-preview__stage">
        {loader && (
          <iframe
            // A new element (a new browsing context) for every loader; see previewProtocol.ts.
            key={loader.key}
            ref={frameRef}
            className="pl-editor-preview__frame"
            src={loader.src}
            title={`Preview of ${title}`}
            sandbox={sandbox}
            referrerPolicy="no-referrer"
            allow=""
          />
        )}
        {status === "too_large" && (
          <div className="pl-editor-preview__message" role="status">
            <p>
              The draft is larger than 5 MB, the most a version can hold, so it cannot be previewed
              or saved.
            </p>
          </div>
        )}
        {status === "error" && (
          <div className="pl-editor-preview__message" role="alert">
            <p>The preview could not load. {gateError}</p>
          </div>
        )}
      </div>
    </div>
  );
}
