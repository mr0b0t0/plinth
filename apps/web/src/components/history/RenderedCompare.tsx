// Side-by-side rendered comparison: each version in its own sandboxed frame on the artifact's
// content subdomain, loaded through a fresh viewer gate (each enter_url works once). At phone
// width the frames are shown one at a time, with a Before and After switch.
import type { ViewGate } from "@plinth/shared";
import { artifactIframeSandbox } from "@plinth/shared";
import { useEffect, useId, useState } from "react";
import { useSession } from "../../lib/session.ts";
import { ButtonLink, SegmentedControl, Skeleton } from "../ui/index.ts";
import { fetchGate } from "./data.ts";
import { artifactPath } from "./format.ts";

type Side = "before" | "after";

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
  const [shown, setShown] = useState<Side>("after");
  const id = useId();
  return (
    <section className="hx-rendered-section" aria-labelledby={id}>
      {/* The two captions say which version is which; the heading only names the region. */}
      <h2 id={id} className="visually-hidden">
        Side by side
      </h2>
      {/* Only shown at phone width (history.css), where one frame fits at a time. */}
      <SegmentedControl
        label="Version shown"
        className="hx-rendered__switch"
        value={shown}
        onChange={setShown}
        options={[
          { value: "before", label: `Before · v${from}` },
          { value: "after", label: `After · v${to}` },
        ]}
      />
      <div className="hx-rendered" data-shown={shown}>
        <VersionFrame slug={slug} title={title} n={from} side="before" />
        <VersionFrame slug={slug} title={title} n={to} side="after" />
      </div>
    </section>
  );
}

type FrameState =
  | { status: "loading" }
  | { status: "ok"; url: string }
  | { status: "blocked"; gate: ViewGate["status"] | "error"; message?: string };

function VersionFrame({
  slug,
  title,
  n,
  side,
}: {
  slug: string;
  title: string;
  n: number;
  side: Side;
}) {
  const { config } = useSession();
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
    <figure className={`hx-frame hx-frame--${side}`} aria-labelledby={captionId}>
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
            sandbox={artifactIframeSandbox(config?.content_isolation)}
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
