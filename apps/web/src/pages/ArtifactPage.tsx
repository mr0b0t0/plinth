// Page: the artifact itself, at /a/:slug and /a/:slug/v/:n (a permanent link to one version).
// The gate runs first (password, email, takedown); then the artifact fills the page in a sandboxed
// iframe on its own content subdomain, under a slim bar that stays out of the way.
import { APP_ROUTES, route, type ViewGate } from "@plinth/shared";
import { useEffect, useState } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, EmptyState, showToast } from "../components/ui/index.ts";
import { GateScreen } from "../components/viewer/GateScreen.tsx";
import { parseVersion } from "../components/viewer/gate.ts";
import { useGate } from "../components/viewer/useGate.ts";
import { useVersionWatch } from "../components/viewer/useVersionWatch.ts";
import { ViewerSkeleton, ViewerStage } from "../components/viewer/ViewerStage.tsx";
import { useLocation } from "../lib/router.tsx";

export default function ArtifactPage({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const pinned = params.n !== undefined;
  const version = parseVersion(params.n);
  const { search } = useLocation();
  const [commentsOpen, setCommentsOpen] = useState(() => search.has("comments"));
  // Review mode (the comment-anchoring bridge) needs a fresh gate and a frame reload. It turns on
  // when comments first open and then stays on, so closing and reopening the panel does not reload
  // the artifact.
  const [review, setReview] = useState(commentsOpen);
  // A page inside the artifact (from a direct content link): opened inside the frame.
  const rawPath = search.get("path");
  const next = rawPath?.startsWith("/") && !rawPath.startsWith("//") ? rawPath : undefined;
  const query = { version, review, next };
  const { state, path, reload, setGate } = useGate(slug, query);

  // A newer version published while this page is open (by an agent, or in the editor) replaces
  // the one on view, unless this is a permanent link to one version.
  const shown = state.kind === "gate" && state.gate.status === "ok" ? state.gate : null;
  useVersionWatch(path, shown, pinned, (gate) => {
    setGate(gate);
    if (!pinned) showToast({ title: `Updated to v${gate.artifact.version}` });
  });

  // Direct links arrive by artifact id; show the readable slug address once the gate knows it.
  useEffect(() => {
    if (state.kind !== "gate" || !("artifact" in state.gate)) return;
    const real = state.gate.artifact.slug;
    if (real && real !== slug) {
      const url = new URL(window.location.href);
      url.pathname = url.pathname.replace(`/a/${encodeURIComponent(slug)}`, `/a/${real}`);
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, [state, slug]);

  useEffect(() => {
    if (state.kind === "loading") document.title = "Opening artifact · Plinth";
    else if (state.kind === "error") document.title = "Could not open artifact · Plinth";
    else if (state.gate.status === "ok") document.title = `${state.gate.artifact.title} · Plinth`;
  }, [state]);

  if (pinned && version === undefined) {
    return (
      <GateScreen gate={{ status: "not_found" }} artifactRef={slug} query={{}} onGate={setGate} />
    );
  }
  if (state.kind === "loading") return <ViewerSkeleton />;
  if (state.kind === "error") {
    return (
      <PublicShell centered width="reading">
        <EmptyState
          headingLevel={1}
          title="This artifact could not be opened"
          description={`${state.message} Check your connection and try again.`}
          action={
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
          }
        />
      </PublicShell>
    );
  }
  const gate: ViewGate = state.gate;
  if (gate.status !== "ok") {
    return <GateScreen gate={gate} artifactRef={slug} query={query} onGate={setGate} />;
  }
  return (
    <ViewerStage
      gate={gate}
      slug={slug}
      pinned={pinned}
      commentsOpen={commentsOpen}
      onToggleComments={() => {
        setCommentsOpen((o) => !o);
        setReview(true);
      }}
      currentHref={route(APP_ROUTES.artifact, { slug })}
    />
  );
}
