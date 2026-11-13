// Live preview: the draft rendered on the artifact's own content subdomain, under the content CSP,
// in the same sandboxed frame the published artifact uses. See previewProtocol.ts for the flow.
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { API, type AppConfig, route, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { IconButton, Spinner, Tooltip } from "../ui/index.ts";
import {
  ARTIFACT_FRAME_SANDBOX,
  isReadyMessage,
  MAX_PREVIEW_BYTES,
  PREVIEW_PATH,
  previewOrigin,
  renderMessage,
  utf8Bytes,
} from "./previewProtocol.ts";

/** Wait this long after the last keystroke before re-rendering. */
export const PREVIEW_DEBOUNCE_MS = 300;

type Status = "loading" | "ready" | "too_large" | "error" | "unavailable";

export interface PreviewFrameProps {
  artifactId: string;
  title: string;
  html: string;
  config: AppConfig;
}

export function PreviewFrame({ artifactId, title, html, config }: PreviewFrameProps) {
  const origin = previewOrigin(config, artifactId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(origin ? "loading" : "unavailable");
  const [gateError, setGateError] = useState<string | null>(null);
  /** The newest draft, read when a loader says it is ready. */
  const latest = useRef(html);
  latest.current = html;
  /** What the frame currently shows; null while a loader waits for HTML. */
  const shown = useRef<string | null>(null);
  /** True while the frame holds a loader that has said "ready" and has not been sent HTML. */
  const waiting = useRef(false);

  const send = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win || !origin) return;
    const draft = latest.current;
    if (utf8Bytes(draft) > MAX_PREVIEW_BYTES) {
      setStatus("too_large");
      return;
    }
    waiting.current = false;
    shown.current = draft;
    win.postMessage(renderMessage(draft), origin);
    setStatus("ready");
  }, [origin]);

  /** Load a fresh loader into the frame (without adding a history entry); it says "ready". */
  const reload = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win || !origin) return;
    waiting.current = false;
    shown.current = null;
    setStatus("loading");
    try {
      win.location.replace(`${origin}${PREVIEW_PATH}`);
    } catch {
      // Should not happen (a parent may always navigate its frame); fall back to a new gate.
      setSrc(null);
    }
  }, [origin]);

  // A one-time enter link for this artifact that lands on the loader. It sets the content cookie
  // on the artifact's subdomain, so the draft's relative asset URLs load like the published page.
  useEffect(() => {
    if (!origin || src) return;
    const ctl = new AbortController();
    const path = route(API.view, { ref: artifactId });
    api<ViewGate>(`${path}?next=${encodeURIComponent(PREVIEW_PATH)}`, { signal: ctl.signal })
      .then((gate) => {
        if (gate.status === "ok") setSrc(gate.enter_url);
        else {
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
  }, [artifactId, origin, src]);

  // Messages from the frame: only "ready", only from this frame's window on the artifact origin.
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      if (!isReadyMessage(event.data)) return;
      waiting.current = true;
      send();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, send]);

  // Re-render shortly after the draft stops changing.
  useEffect(() => {
    if (!origin) return;
    const t = window.setTimeout(() => {
      if (waiting.current) send();
      else if (shown.current !== null && shown.current !== html) reload();
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [html, origin, send, reload]);

  if (!origin) {
    return (
      <div className="pl-editor-preview__message">
        <p>
          Live preview is not available on this instance, because artifacts are served from the app
          address here. Save to see your changes on the artifact page.
        </p>
      </div>
    );
  }

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
            disabled={!src}
          />
        </Tooltip>
      </div>
      <div className="pl-editor-preview__stage">
        {src && (
          <iframe
            ref={frameRef}
            className="pl-editor-preview__frame"
            src={src}
            title={`Preview of ${title}`}
            sandbox={ARTIFACT_FRAME_SANDBOX}
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
