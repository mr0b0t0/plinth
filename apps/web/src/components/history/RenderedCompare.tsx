// Side-by-side rendered comparison: each version in its own sandboxed frame on the artifact's
// content subdomain, loaded through a fresh viewer gate (each enter_url works once).
import type { ViewGate } from "@plinth/shared";
import { ARTIFACT_IFRAME_SANDBOX } from "@plinth/shared";
import { useEffect, useId, useState } from "react";
import { ButtonLink, Skeleton } from "../ui/index.ts";
import { fetchGate } from "./data.ts";
import { artifactPath } from "./format.ts";

/** The one sandbox every artifact frame uses (shared constant; never allow-top-navigation). */
export const ARTIFACT_SANDBOX = ARTIFACT_IFRAME_SANDBOX;

export function RenderedCompare({
  slug,
  title,
  from,
  to,
}: {
  slug: string;
  title: string;
  from: number;
  to: number;
}) {
  return (
    <div className="hx-rendered">
      <VersionFrame slug={slug} title={title} n={from} />
      <VersionFrame slug={slug} title={title} n={to} />
    </div>
  );
}

type FrameState =
  | { status: "loading" }
  | { status: "ok"; url: string }
  | { status: "blocked"; gate: ViewGate["status"] | "error"; message?: string };

function VersionFrame({ slug, title, n }: { slug: string; title: string; n: number }) {
  const [state, setState] = useState<FrameState>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchGate(slug, n, ctrl.signal).then(
      (gate) => {
        if (ctrl.signal.aborted) return;
        if (gate.status === "ok") setState({ status: "ok", url: gate.enter_url });
        else setState({ status: "blocked", gate: gate.status });
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          status: "blocked",
          gate: "error",
          message: e instanceof Error ? e.message : undefined,
        });
      },
    );
    return () => ctrl.abort();
  }, [slug, n]);

  const captionId = useId();
  return (
    <figure className="hx-frame" aria-labelledby={captionId}>
      <figcaption id={captionId} className="hx-frame__label">
        <span className="type-mono">v{n}</span>
      </figcaption>
      <div className="hx-frame__stage">
        {state.status === "loading" && (
          <div className="hx-frame__placeholder" aria-busy="true">
            <Skeleton width="100%" height="100%" radius="xs" />
          </div>
        )}
        {state.status === "ok" && (
          <iframe
            src={state.url}
            title={`v${n} of ${title}`}
            sandbox={ARTIFACT_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            className="hx-frame__iframe"
          />
        )}
        {state.status === "blocked" && (
          <div className="hx-frame__placeholder hx-frame__blocked">
            <p>
              {state.gate === "password_required" || state.gate === "email_required"
                ? "Open the artifact first to confirm your access, then come back."
                : state.gate === "taken_down"
                  ? "This artifact was taken down."
                  : (state.message ?? "This version could not be shown.")}
            </p>
            {state.gate !== "taken_down" && (
              <ButtonLink to={artifactPath(slug)} size="sm">
                Open the artifact
              </ButtonLink>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
