// Page: the artifact itself, at /a/:slug and /a/:slug/v/:n (a permanent link to one version).
// The gate runs first (password, email, takedown); then the artifact fills the page in a sandboxed
// iframe on its own content subdomain, under a slim bar that stays out of the way.
import { APP_ROUTES, route, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, dismissToast, EmptyState, showToast } from "../components/ui/index.ts";
import { GateScreen } from "../components/viewer/GateScreen.tsx";
import { gatePath, parseVersion } from "../components/viewer/gate.ts";
import { useGate } from "../components/viewer/useGate.ts";
import { useLiveView } from "../components/viewer/useLiveView.ts";
import {
  afterAccessChange,
  useVersionWatch,
  versionPollMs,
  type WatchPause,
} from "../components/viewer/useVersionWatch.ts";
import type { UpdateHandlers } from "../components/viewer/useViewUpdate.ts";
import { ViewerSkeleton, ViewerStage } from "../components/viewer/ViewerStage.tsx";
import { api } from "../lib/api.ts";
import { useLocation } from "../lib/router.tsx";

type OkGate = Extract<ViewGate, { status: "ok" }>;

export default function ArtifactPage({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const pinned = params.n !== undefined;
  const version = parseVersion(params.n);
  const { search } = useLocation();
  const [commentsOpen, setCommentsOpen] = useState(() => search.has("comments"));
  // Review mode (the comment-anchoring bridge) needs a fresh gate and a frame reload. It turns on
  // when comments first open and then stays on, so closing and reopening the panel does not reload
  // the artifact. Presenting a deck turns it off. A page edited on it never enters it: editing is
  // always on for owners and editors, and their frame picks places for comments itself.
  const [review, setReview] = useState(commentsOpen);
  const [editing, setEditing] = useState(false);
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
  // Live views: the watch socket says when to look (a version, or the page's data changed), so the
  // gate poll is only a backstop while it is open.
  const checkRef = useRef<() => void>(() => undefined);
  const [dataTick, setDataTick] = useState(0);
  // One quiet notice: a version pushed while the last one's notice is still up replaces it, so an
  // agent publishing several versions in a row never stacks "Updated to" toasts.
  const updatedToast = useRef<number | null>(null);
  // While the frame is held (edited on the page, a deck presented) the page's own bar says what
  // happened, so no toast repeats it. A held version (the hold rule) says so in that same slot, so
  // the frame never moves under the viewer and the two notices never stack; the bar's "vN of M"
  // stays after it is dismissed.
  const heldToast = useRef<number | null>(null);
  // A fresh gate for a newer version waits here until the stage has applied it: in place for a
  // doc, with the page's state, or held while the viewer uses it (useViewUpdate.ts).
  const [pending, setPending] = useState<OkGate | null>(null);
  // While editing on the page the save status says what a newer version did ("v5 was published
  // while you edited", "your changes were kept"), so no toast repeats it.
  const editingRef = useRef(false);
  const show = (gate: OkGate, quiet = false) => {
    const moved = gate.artifact.version !== shown?.artifact.version;
    setPending(null);
    setGate(gate);
    if (!pinned && moved && !quiet && pause === null && !editingRef.current) {
      if (updatedToast.current !== null) dismissToast(updatedToast.current);
      updatedToast.current = showToast({ title: `Updated to v${gate.artifact.version}` });
    }
  };
  const onNewer = (gate: OkGate) => {
    // The frame stays (a pinned link, or a paused one): only the bar moves on.
    if (gate.enter_url === shown?.enter_url) show(gate);
    else setPending(gate);
  };
  const latest = useRef({ shown, pause, path, onNewer, show });
  latest.current = { shown, pause, path, onNewer, show };
  // A sharing change ended the frame's content pass. The page re-reads its gate; a refusal is
  // shown, and otherwise a fresh frame renews the pass, except while a deck is presented or a doc
  // is edited on its page: that frame stays, and is renewed once the pause ends.
  const renew = useRef(false);
  const onAccessChanged = useCallback(() => {
    const asked = latest.current.path;
    api<ViewGate>(asked).then(
      (fresh) => {
        const { shown: now, pause: paused, path: current, show } = latest.current;
        if (!now || current !== asked) return;
        const next = afterAccessChange(now, fresh, pinned, paused);
        if (next.kind === "keep") {
          renew.current = true;
          if (next.gate) show(next.gate);
        } else if (next.gate.status === "ok") show(next.gate);
        else setGate(next.gate);
      },
      // Offline or a hiccup: the frame stays; the reconnect and the poll try again.
      () => undefined,
    );
  }, [pinned, setGate]);
  useEffect(() => {
    if (pause !== null || !renew.current) return;
    renew.current = false;
    reload();
  }, [pause, reload]);
  const live = useLiveView({
    gate: shown,
    onVersion: () => checkRef.current(),
    onData: () => setDataTick((n) => n + 1),
    onAccessChanged,
    onGone: reload,
  });
  const { checkNow } = useVersionWatch(
    path,
    shown,
    pinned,
    (gate) => latest.current.onNewer(gate),
    versionPollMs(live),
    pause,
  );
  checkRef.current = checkNow;
  const onVersionSeen = useCallback(() => checkRef.current(), []);
  // A page that declares `comments` anchors its own comments: opening the panel never reloads it
  // into review mode (the gate ignores review for it too). If a new version drops the declaration
  // while the panel is open, review mode turns on then, with one reload as on a first open.
  const pageComments = shown?.page_comments === true;
  const updateHandlers: UpdateHandlers = {
    pending,
    apply: (gate, quiet) => latest.current.show(gate, quiet),
    count: (gate) => {
      setPending(null);
      setGate(gate);
    },
    drop: () => setPending(null),
    fetchGate: async (to) => {
      // The place comes from the older version: the gate lands on the root if this one lacks it.
      const fresh = await api<ViewGate>(
        to ? gatePath("view", slug, { ...query, next: to, carried: true }) : latest.current.path,
      );
      return fresh.status === "ok" ? fresh : null;
    },
    offer: (version, update) => {
      const offered = heldToast.current;
      heldToast.current = null;
      if (offered !== null) dismissToast(offered);
      if (updatedToast.current === offered) updatedToast.current = null;
      if (version === null) return;
      if (updatedToast.current !== null) dismissToast(updatedToast.current);
      const id = showToast({
        title: `v${version} is available`,
        duration: 0,
        action: { label: "Update", onClick: update },
      });
      heldToast.current = id;
      updatedToast.current = id;
    },
  };
  useEffect(() => {
    if (commentsOpen && shown && !pageComments && !editing) setReview(true);
  }, [commentsOpen, shown, pageComments, editing]);
  // Editing on the page and review mode (the comment-anchoring frame) exclude each other: an
  // editing frame stays as it is, with the comments panel beside it (a `?comments` link opened by
  // an editor loads the page once more, without review mode).
  const onEditModeChange = useCallback((on: boolean) => {
    editingRef.current = on;
    setEditing(on);
    if (on) setReview(false);
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
        if (!pageComments && !editing) setReview(true);
      }}
      currentHref={route(APP_ROUTES.artifact, { slug })}
      onReload={reload}
      onEditModeChange={onEditModeChange}
      onPauseChange={setPause}
      onVersionSeen={onVersionSeen}
      review={review}
      onLeaveReview={onLeaveReview}
      liveData={{ pushed: live === "open", tick: dataTick }}
      update={updateHandlers}
    />
  );
}
