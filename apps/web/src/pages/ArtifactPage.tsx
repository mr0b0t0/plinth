// Page: the artifact itself, at /a/:slug and /a/:slug/v/:n (a permanent link to one version).
// The gate runs first (password, email, takedown); then the artifact fills the page in a sandboxed
// iframe on its own content subdomain, under a slim bar that stays out of the way.
import { APP_ROUTES, route, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useState } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, EmptyState, showToast } from "../components/ui/index.ts";
import { GateScreen } from "../components/viewer/GateScreen.tsx";
import { parseVersion } from "../components/viewer/gate.ts";
import { useGate } from "../components/viewer/useGate.ts";
import {
  useVersionWatch,
  VERSION_POLL_MS,
  type WatchPause,
} from "../components/viewer/useVersionWatch.ts";
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
  // the artifact. Editing on the page and presenting a deck turn it off.
  const [review, setReview] = useState(commentsOpen);
  // A page inside the artifact (from a direct content link): opened inside the frame.
  const rawPath = search.get("path");
  const next = rawPath?.startsWith("/") && !rawPath.startsWith("//") ? rawPath : undefined;
  const query = { version, review, next };
  const { state, path, reload, setGate } = useGate(slug, query);

  // A newer version published while this page is open (by an agent, or in the editor) replaces
  // the one on view, unless this is a permanent link to one version. While a doc is edited on its
  // page the frame stays (#36): it follows the room itself, or holds unsaved solo edits.
  const shown = state.kind === "gate" && state.gate.status === "ok" ? state.gate : null;
  const [pause, setPause] = useState<WatchPause>(null);
  useVersionWatch(
    path,
    shown,
    pinned,
    (gate) => {
      const moved = gate.artifact.version !== shown?.artifact.version;
      setGate(gate);
      if (!pinned && moved) showToast({ title: `Updated to v${gate.artifact.version}` });
    },
    VERSION_POLL_MS,
    pause,
  );
  // A page that declares `comments` anchors its own comments: opening the panel never reloads it
  // into review mode (the gate ignores review for it too). If a new version drops the declaration
  // while the panel is open, review mode turns on then, with one reload as on a first open.
  const pageComments = shown?.page_comments === true;
  useEffect(() => {
    if (commentsOpen && shown && !pageComments) setReview(true);
  }, [commentsOpen, shown, pageComments]);
  // Editing on the page and review mode (the comment-anchoring frame) exclude each other.
  const onEditModeChange = useCallback((on: boolean) => {
    if (!on) return;
    setCommentsOpen(false);
    setReview(false);
  }, []);
  // Presenting a deck and review mode exclude each other too: review mode shows every slide
  // stacked, so Present leaves it (and closes the panel) before it presents.
  const onLeaveReview = useCallback(() => {
    setCommentsOpen(false);
    setReview(false);
  }, []);

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
        if (!pageComments) setReview(true);
      }}
      currentHref={route(APP_ROUTES.artifact, { slug })}
      onReload={reload}
      onEditModeChange={onEditModeChange}
      onPauseChange={setPause}
      review={review}
      onLeaveReview={onLeaveReview}
    />
  );
}
