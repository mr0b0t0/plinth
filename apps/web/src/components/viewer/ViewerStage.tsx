// The artifact on view: one 44px bar (breadcrumb, version, access on the left; History,
// Comments, Share and a ⋯ menu on the right), the artifact in a sandboxed frame filling the rest,
// an optional comments panel, and a one-line banner naming the platform with a report link
// (required on every artifact page) and, unless the operator turned it off (SHOW_SOURCE_LINK), a
// link to Plinth's source. The banner is app chrome: nothing is ever added to the artifact itself.

import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  DotsThreeIcon,
  FileIcon,
  FlagIcon,
  GearSixIcon,
  MoonIcon,
  PencilSimpleIcon,
  PrinterIcon,
  ShareNetworkIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { API, APP_ROUTES, type CommentInfo, route, type ViewGate } from "@plinth/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import { THEME_NAMES, useTheme } from "../../lib/theme.ts";
import { CommentsPanel } from "../artifact/CommentsPanel.tsx";
import { VersionPicker } from "../artifact/VersionPicker.tsx";
import { useMediaQuery } from "../editor/useMediaQuery.ts";
import { LogoMark } from "../Logo.tsx";
import { SkipLink } from "../layout/AppShell.tsx";
import { LegalLinks } from "../layout/LegalLinks.tsx";
import {
  Button,
  buttonClassName,
  IconProvider,
  Menu,
  type MenuEntry,
  Skeleton,
  Toaster,
  Tooltip,
  VISIBILITY_META,
} from "../ui/index.ts";
import { DataNotice } from "./DataNotice.tsx";
import { EditBar } from "./EditBar.tsx";
import { contentOriginOf, shareLink } from "./gate.ts";
import { LiveDraftNotice } from "./LiveDraftNotice.tsx";
import { postPrint, rendererTargetOrigin } from "./rendererProtocol.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { StageFrame } from "./StageFrame.tsx";
import { useLiveEdit } from "./useLiveEdit.ts";
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
}

/** Who may open the editor. The editor page and the API check again. */
export const canEdit = (role: OkGate["role"]) => role === "owner" || role === "editor";

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
}: ViewerStageProps) {
  const { me, config } = useSession();
  const [theme, setTheme] = useTheme();
  const [shareOpen, setShareOpen] = useState(false);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const compact = useMediaQuery(VIEWER_COMPACT_QUERY);
  const { artifact, role } = gate;
  const isOwner = role === "owner";
  const older = artifact.version < artifact.current_version;
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
      .then((res) => setOpenCount(openThreadCount(res.items)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [artifact.id, slug, commentsOpen]);

  const counted = openCount !== null && openCount > 0;

  // On-page editing of a doc (#36): owners and editors on the current version only.
  const live = useLiveEdit({
    gate,
    frame,
    contentOrigin,
    config,
    onReload: onReload ?? (() => undefined),
  });
  const editing = live.editing;
  useEffect(() => {
    onPauseChange?.(live.pause);
  }, [live.pause, onPauseChange]);
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

  const menuItems: MenuEntry[] = [
    ...(compact
      ? [
          { label: "Share", icon: ShareNetworkIcon, onSelect: () => setShareOpen(true) },
          { label: "History", icon: ClockCounterClockwiseIcon, href: historyHref },
        ]
      : []),
    ...(compact && live.available && !live.signIn
      ? [
          {
            label: editing ? "Done editing" : "Edit on the page",
            icon: PencilSimpleIcon,
            onSelect: toggleEditing,
          },
        ]
      : []),
    ...(compact && live.available && live.signIn
      ? [{ label: "Sign in to edit", icon: PencilSimpleIcon, href: signInHref }]
      : []),
    ...(canEdit(role)
      ? [
          {
            label: live.available ? "Edit source" : "Edit",
            icon: live.available ? CodeIcon : PencilSimpleIcon,
            href: editHref,
          },
        ]
      : []),
    ...(isOwner ? [{ label: "Settings", icon: GearSixIcon, href: settingsHref }] : []),
    // A doc prints itself: the renderer in the frame calls its own print(), so the browser prints
    // the document (or saves it as PDF), not this page around it.
    ...(artifact.type === "doc"
      ? [
          {
            label: "Print or save as PDF",
            icon: PrinterIcon,
            onSelect: () => postPrint(frame, rendererTargetOrigin(config, contentOrigin)),
          },
        ]
      : []),
    // Owners and editors do not report their own work; the footer link stays for all.
    ...(canEdit(role) ? [] : [{ label: "Report", icon: FlagIcon, href: reportHref }]),
    { type: "separator" },
    {
      label: `Switch to ${THEME_NAMES[nextTheme]}`,
      icon: nextTheme === "dark" ? MoonIcon : SunIcon,
      onSelect: () => setTheme(nextTheme),
    },
  ];

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
          <div className="pl-viewer__actions">
            {!compact && (
              <Tooltip content="History" placement="bottom">
                <Link
                  to={historyHref}
                  aria-label="History"
                  className={buttonClassName({ variant: "ghost", iconOnly: true })}
                >
                  <span className="pl-button__content">
                    <ClockCounterClockwiseIcon size={16} aria-hidden="true" />
                  </span>
                </Link>
              </Tooltip>
            )}
            {live.available && !compact && !live.signIn && (
              <Tooltip content={editing ? "Done editing" : "Edit on the page"} placement="bottom">
                <Button
                  ref={editRef}
                  variant="ghost"
                  icon={PencilSimpleIcon}
                  aria-label="Edit"
                  aria-pressed={editing}
                  className="pl-viewer__edit"
                  onClick={toggleEditing}
                />
              </Tooltip>
            )}
            {live.available && !compact && live.signIn && (
              <Tooltip content="Sign in to edit" placement="bottom">
                <Link
                  to={signInHref}
                  aria-label="Sign in to edit"
                  className={buttonClassName({ variant: "ghost", iconOnly: true })}
                >
                  <span className="pl-button__content">
                    <PencilSimpleIcon size={16} aria-hidden="true" />
                  </span>
                </Link>
              </Tooltip>
            )}
            {/* The count sits beside the button, not in it, so the button's name stays exactly its
                visible label (WCAG 2.5.3); the panel announces the numbers. */}
            <span className="pl-viewer__comments-wrap">
              <Button
                ref={toggleRef}
                variant="ghost"
                icon={ChatCircleIcon}
                aria-label="Comments"
                aria-pressed={commentsOpen}
                className={`pl-viewer__comments${counted ? " pl-viewer__comments--counted" : ""}`}
                onClick={commentsOpen ? closeComments : () => void toggleComments()}
              />
              {counted && (
                <span className="pl-viewer__count" aria-hidden="true">
                  {openCount}
                </span>
              )}
            </span>
            {!compact && (
              <Button variant="primary" onClick={() => setShareOpen(true)}>
                Share
              </Button>
            )}
            <Menu
              label="Artifact actions"
              icon={DotsThreeIcon}
              iconOnly
              variant="ghost"
              align="end"
              items={menuItems}
            />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="pl-viewer__stage">
          {older && (
            <p className="pl-viewer__notice">
              You are viewing <span className="type-num">v{artifact.version}</span>
              <span aria-hidden="true"> · </span>
              <Link to={currentHref}>Go to current</Link>
              <span className="visually-hidden"> (v{artifact.current_version})</span>
            </p>
          )}
          <DataNotice data={gate.data} />
          {editing && live.mode && (
            <EditBar
              focusRef={barRef}
              phase={live.phase}
              mode={live.mode}
              version={live.status?.base_version || artifact.version}
              connected={live.status?.connected ?? false}
              connecting={live.status === null}
              dirty={live.status?.dirty ?? false}
              saving={live.saving}
              savedVersion={live.savedVersion}
              rebasedVersion={live.rebasedVersion}
              newerVersion={live.newerVersion}
              editors={live.status?.editors ?? []}
              onSave={(note) => void live.save(note)}
              onDiscard={() => void live.discard()}
              onDone={() => void finishEditing()}
              onReview={() => void live.review()}
            />
          )}
          {live.available && !editing && (
            <LiveDraftNotice
              draft={gate.live?.draft ?? null}
              status={live.status}
              restore={live.restore}
              signIn={live.signIn}
              unavailable={
                live.roomReady
                  ? null
                  : live.mode === "room" && live.status === null
                    ? "Connecting to the live draft…"
                    : "Live editing is unavailable right now."
              }
              onSave={() => {
                void live.save().then(() => refocusIfLost(focusEditEntry));
              }}
              onContinue={startEditing}
              onDiscard={() => {
                void live.discard().then(() => refocusIfLost(focusEditEntry));
              }}
              onReview={() => void live.review()}
              onSaveRestore={() => void live.saveRestore()}
              onDropRestore={live.dropRestore}
            />
          )}
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
