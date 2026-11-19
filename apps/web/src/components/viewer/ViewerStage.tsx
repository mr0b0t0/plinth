// The artifact on view: one 44px bar (breadcrumb, version, access on the left; History,
// Comments, Share and a ⋯ menu on the right), the artifact in a sandboxed frame filling the rest,
// an optional comments panel, and a one-line banner naming the platform with a report link
// (required on every artifact page) and, unless the operator turned it off (SHOW_SOURCE_LINK), a
// link to Plinth's source. The banner is app chrome: nothing is ever added to the artifact itself.
//
// The ⋯ menu, the controls on the right of the bar and the strip under it are item lists
// (stageItems.tsx): this component holds the state and hands every item one StageContext.

import { FileIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type CommentInfo, route, type ViewGate } from "@plinth/shared";
import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import { useTheme } from "../../lib/theme.ts";
import { CommentsPanel } from "../artifact/CommentsPanel.tsx";
import { VersionPicker } from "../artifact/VersionPicker.tsx";
import { useStagePageComments } from "../comments/usePageComments.ts";
import { useMediaQuery } from "../editor/useMediaQuery.ts";
import { LogoMark } from "../Logo.tsx";
import { SkipLink } from "../layout/AppShell.tsx";
import { LegalLinks } from "../layout/LegalLinks.tsx";
import { IconProvider, Skeleton, Toaster, VISIBILITY_META } from "../ui/index.ts";
import { DictationConsent } from "./DictationConsent.tsx";
import { contentOriginOf, shareLink } from "./gate.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { StageFrame } from "./StageFrame.tsx";
import { BAR_CONTROLS, STRIP_ITEMS, type StageContext, type StageItem } from "./stageItems.tsx";
import { useDictation } from "./useDictation.ts";
import { useLiveEdit } from "./useLiveEdit.ts";
import { useLiveDataRelay } from "./useLiveView.ts";
import { usePresentation } from "./usePresentation.ts";
import type { WatchPause } from "./useVersionWatch.ts";
import "./viewer.css";

// The review of overlapping page edits uses Monaco's diff: a chunk of its own, loaded on demand.
const LiveConflictDialog = lazy(() => import("./LiveConflictDialog.tsx"));

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** Below this width History and Share fold into the ⋯ menu. Keep in step with viewer.css. */
export const VIEWER_COMPACT_QUERY = "(max-width: 52rem)";

export interface ViewerStageProps {
  gate: OkGate;
  slug: string;
  /** Opened through a permanent version link (/a/:slug/v/:n). */
  pinned: boolean;
  commentsOpen: boolean;
  onToggleComments: () => void;
  /** Link to the current version. */
  currentHref: string;
  /** Fetch a fresh gate (on-page editing: after a solo save or discard, a lost session). */
  onReload?: () => void;
  /**
   * On-page editing turned on or off (#36). Editing and review mode (the comment-anchoring frame)
   * exclude each other, so the page turns review mode off when editing starts.
   */
  onEditModeChange?: (on: boolean) => void;
  /** How the version watch must treat the frame while the doc is edited on its page. */
  onPauseChange?: (pause: WatchPause) => void;
  /**
   * Live views: whether signals are pushed, and a count that moves each time the page's shared
   * data changed; the frame's runtime is told both (useLiveDataRelay).
   */
  liveData?: { pushed: boolean; tick: number };
}

export { canEdit } from "./stageItems.tsx";

/** Each item's element, in list order, keyed by the item's id. */
function renderItems(items: readonly StageItem[], c: StageContext) {
  return items.map((item) => <Fragment key={item.id}>{item.render(c)}</Fragment>);
}

/** Open threads in a comments list. */
export function openThreadCount(items: CommentInfo[]): number {
  return items.filter((c) => !c.parent_id && c.status === "open").length;
}

/** Access in words, for the pill next to the version ("Anyone with the link"). */
const ACCESS_PILL: Record<OkGate["artifact"]["visibility"], string> = {
  public: "Public",
  unlisted: "Anyone with the link",
  password: "Password",
  allowlist: "Private",
};

export function ViewerStage({
  gate,
  slug,
  pinned,
  commentsOpen,
  onToggleComments,
  currentHref,
  onReload,
  onEditModeChange,
  onPauseChange,
  liveData,
}: ViewerStageProps) {
  const { me, config } = useSession();
  const [theme, setTheme] = useTheme();
  const [shareOpen, setShareOpen] = useState(false);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [openCount, setOpenCount] = useState<number | null>(null);
  // The comments, for a page that declares `comments` (its threads and pins); the panel keeps
  // them current while open.
  const [commentItems, setCommentItems] = useState<CommentInfo[] | null>(null);
  const compact = useMediaQuery(VIEWER_COMPACT_QUERY);
  const { artifact, role } = gate;
  const isOwner = role === "owner";
  const appOrigin = config?.app_origin ?? window.location.origin;
  const link = shareLink(appOrigin, artifact.slug, pinned ? artifact.version : undefined);
  const contentOrigin = contentOriginOf(gate.enter_url, artifact.id, config);
  const nextTheme = theme === "dark" ? "light" : "dark";
  const access = VISIBILITY_META[artifact.visibility];
  const AccessIcon = access.icon;

  const editHref = route(APP_ROUTES.editor, { slug });
  const historyHref = route(APP_ROUTES.history, { slug });
  const reportHref = route(APP_ROUTES.report, { slug });
  const settingsHref = route(APP_ROUTES.settings, { slug });

  // The open-thread count on the Comments toggle. The panel reports it while open; while closed
  // it is read once (and again after the panel closes). Failures just hide the number.
  useEffect(() => {
    if (commentsOpen) return;
    const ctrl = new AbortController();
    api<{ items: CommentInfo[] }>(route(API.comments, { ref: artifact.id || slug }), {
      signal: ctrl.signal,
    })
      .then((res) => {
        setOpenCount(openThreadCount(res.items));
        setCommentItems(res.items);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [artifact.id, slug, commentsOpen]);

  // Comments from the page: it may open the composer with its own anchors (gate.page_comments).
  const pageComments = useStagePageComments({
    gate,
    frame,
    contentOrigin,
    opaque: config?.content_isolation === "opaque",
    items: commentItems,
    blocked: shareOpen,
    commentsOpen,
    openComments: onToggleComments,
  });

  // On-page editing of a doc (#36): owners and editors on the current version only.
  const live = useLiveEdit({
    gate,
    frame,
    contentOrigin,
    config,
    onReload: onReload ?? (() => undefined),
  });
  const editing = live.editing;
  // Presenting a deck: the slide, full screen, presenter view and its audience window.
  const present = usePresentation({ gate, frame, contentOrigin, config, slug, pinned });
  const pause: WatchPause = live.pause ?? present.pause;
  // Dictation run by the app, for the main artifact frame only (never a preview or a compare).
  const dictation = useDictation({ frame, contentOrigin, gate, config });
  // Live views: shared-data changes reach the page's runtime (origin isolation only).
  useLiveDataRelay({
    frame,
    contentOrigin,
    enabled:
      config?.content_isolation === "origin" &&
      !config.content_path_fallback &&
      gate.data?.available === true,
    pushed: liveData?.pushed === true,
    dataTick: liveData?.tick ?? 0,
  });
  useEffect(() => {
    onPauseChange?.(pause);
  }, [pause, onPauseChange]);
  // A version published while presenting waits; once presenting ends, the deck catches up.
  const presented = useRef(false);
  useEffect(() => {
    const was = presented.current;
    presented.current = present.pause !== null;
    if (was && present.pause === null && !pinned) {
      if (artifact.version < artifact.current_version) onReload?.();
    }
  }, [present.pause, pinned, artifact.version, artifact.current_version, onReload]);
  useEffect(() => {
    onEditModeChange?.(editing);
  }, [editing, onEditModeChange]);

  // The toggle gets focus back when the panel closes.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeComments = () => {
    onToggleComments();
    requestAnimationFrame(() => toggleRef.current?.focus());
  };
  // Opening comments while editing finishes editing first; when that save failed (solo edits
  // exist only in the frame, which review mode would reload), the panel stays closed.
  const toggleComments = async () => {
    if (editing && !(await live.done())) return;
    onToggleComments();
  };

  const editRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // Where focus goes when editing ends, or when the control that had it went away: the Edit
  // toggle, or at phone width (no toggle) the actions menu that holds "Edit on the page".
  const focusEditEntry = () => {
    const target =
      editRef.current ??
      headerRef.current?.querySelector<HTMLElement>('button[aria-label="Artifact actions"]') ??
      document.getElementById("main");
    target?.focus();
  };
  // A notice button that started editing or saved unmounts with focus in it: move focus on.
  const refocusIfLost = (to: () => void) => {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) to();
    });
  };
  const finishEditing = async () => {
    if (await live.done()) requestAnimationFrame(focusEditEntry);
  };
  const startEditing = () => {
    live.start();
    requestAnimationFrame(() => barRef.current?.focus());
  };
  const toggleEditing = () => {
    if (editing) void finishEditing();
    else startEditing();
  };
  const signInHref = `${APP_ROUTES.login}?next=${encodeURIComponent(currentHref)}`;

  const stage: StageContext = {
    gate,
    config,
    compact,
    frame,
    contentOrigin,
    live,
    editing,
    present,
    dictation,
    hrefs: {
      current: currentHref,
      edit: editHref,
      history: historyHref,
      report: reportHref,
      settings: settingsHref,
      signIn: signInHref,
    },
    comments: {
      open: commentsOpen,
      count: openCount,
      toggleRef,
      close: closeComments,
      toggle: () => void toggleComments(),
    },
    refs: { edit: editRef, bar: barRef },
    theme: { next: nextTheme, set: setTheme },
    actions: {
      openShare: () => setShareOpen(true),
      toggleEditing,
      startEditing,
      finishEditing: () => void finishEditing(),
      refocusAfterNotice: () => refocusIfLost(focusEditEntry),
      reload: () => onReload?.(),
    },
  };

  return (
    <IconProvider>
      <SkipLink />
      <div
        className={`pl-viewer${commentsOpen ? " pl-viewer--panel" : ""}${editing ? " pl-viewer--editing" : ""}`}
      >
        <header className="pl-viewer__bar" ref={headerRef}>
          <div className="pl-viewer__crumbs">
            {isOwner ? (
              <>
                <Link to={APP_ROUTES.dashboard} className="pl-viewer__crumb">
                  <FileIcon size={16} aria-hidden="true" />
                  <span className="pl-viewer__crumb-label">Artifacts</span>
                </Link>
                <span className="pl-viewer__sep" aria-hidden="true">
                  /
                </span>
              </>
            ) : (
              <Link
                to={me ? APP_ROUTES.dashboard : APP_ROUTES.home}
                className="pl-viewer__home"
                aria-label={me ? "Plinth, go to your artifacts" : "Plinth, go to home"}
              >
                <LogoMark size={16} />
              </Link>
            )}
            <h1 className="pl-viewer__title" title={artifact.title}>
              {artifact.title}
            </h1>
          </div>
          <div className="pl-viewer__version">
            <VersionPicker
              slug={slug}
              current={artifact.current_version}
              shown={artifact.version}
            />
          </div>
          {isOwner && (
            <span className="pl-viewer__access" title={access.description}>
              <AccessIcon size={14} aria-hidden="true" />
              <span className="visually-hidden">Visibility: </span>
              {ACCESS_PILL[artifact.visibility]}
            </span>
          )}
          <div className="pl-viewer__actions">{renderItems(BAR_CONTROLS, stage)}</div>
        </header>
        <main id="main" tabIndex={-1} className="pl-viewer__stage">
          {renderItems(STRIP_ITEMS, stage)}
          <div className="pl-viewer__room">
            <div className="pl-viewer__frame-wrap">
              <StageFrame
                ref={setFrame}
                src={gate.enter_url}
                title={`${artifact.title}, version ${artifact.version}`}
                isolation={config?.content_isolation}
                loadingLabel={`Loading version ${artifact.version}`}
              />
            </div>
            {commentsOpen && (
              <div className="pl-viewer__panel">
                <CommentsPanel
                  artifactId={artifact.id}
                  slug={slug}
                  version={artifact.version}
                  frame={frame}
                  contentOrigin={contentOrigin}
                  opaque={config?.content_isolation === "opaque"}
                  onClose={closeComments}
                  onOpenCountChange={setOpenCount}
                  onItemsChange={setCommentItems}
                  {...pageComments}
                />
              </div>
            )}
          </div>
        </main>
        <footer className="pl-viewer__banner">
          <span>
            Hosted on <Link to={APP_ROUTES.home}>Plinth</Link>
            {config?.source_url && (
              <>
                {", "}
                <a href={config.source_url} target="_blank" rel="noopener noreferrer">
                  open source
                </a>
              </>
            )}
          </span>
          <span aria-hidden="true">·</span>
          <Link to={reportHref}>Report this artifact</Link>
          <span aria-hidden="true" className="pl-viewer__banner-wide">
            ·
          </span>
          <nav aria-label="Legal" className="pl-viewer__banner-wide pl-viewer__legal">
            <LegalLinks />
          </nav>
        </footer>
      </div>
      {live.reviewing && live.conflict && (
        <Suspense fallback={null}>
          <LiveConflictDialog
            conflict={live.conflict}
            artifactId={artifact.id}
            saving={live.saving}
            mode={live.mode === "room" && live.conflict.rev !== undefined ? "room" : "solo"}
            onClose={live.closeReview}
            onKeepMine={() => void live.keepMine()}
            onTakeLatest={() => void live.takeLatest()}
          />
        </Suspense>
      )}
      <DictationConsent request={dictation.consent} />
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        link={link}
        slug={slug}
        visibility={artifact.visibility}
        isOwner={isOwner}
      />
      <Toaster />
    </IconProvider>
  );
}

/** Placeholder while the gate loads: the same bar and an empty stage. */
export function ViewerSkeleton() {
  return (
    <div className="pl-viewer" aria-busy="true">
      <header className="pl-viewer__bar">
        <div className="pl-viewer__crumbs">
          <span className="pl-viewer__home">
            <LogoMark size={16} />
          </span>
          <Skeleton width="10rem" height="0.875rem" />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="pl-viewer__stage">
        <span className="visually-hidden" role="status">
          Opening artifact
        </span>
        <div className="pl-viewer__frame-wrap pl-viewer__frame-wrap--empty" />
      </main>
    </div>
  );
}
