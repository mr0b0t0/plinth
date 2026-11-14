// The artifact on view: one 44px bar (breadcrumb, version, access on the left; History,
// Comments, Share and a ⋯ menu on the right), the artifact in a sandboxed frame filling the rest,
// an optional comments panel, and a one-line banner naming the platform with a report link
// (required on every artifact page).

import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  FileIcon,
  FlagIcon,
  GearSixIcon,
  MoonIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { API, APP_ROUTES, type CommentInfo, route, type ViewGate } from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
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
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import { contentOriginOf, shareLink } from "./gate.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import "./viewer.css";

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

  // The toggle gets focus back when the panel closes.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeComments = () => {
    onToggleComments();
    requestAnimationFrame(() => toggleRef.current?.focus());
  };

  const menuItems: MenuEntry[] = [
    ...(compact
      ? [
          { label: "Share", icon: ShareNetworkIcon, onSelect: () => setShareOpen(true) },
          { label: "History", icon: ClockCounterClockwiseIcon, href: historyHref },
        ]
      : []),
    ...(canEdit(role) ? [{ label: "Edit", icon: PencilSimpleIcon, href: editHref }] : []),
    ...(isOwner ? [{ label: "Settings", icon: GearSixIcon, href: settingsHref }] : []),
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
      <div className={`pl-viewer${commentsOpen ? " pl-viewer--panel" : ""}`}>
        <header className="pl-viewer__bar">
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
                onClick={commentsOpen ? closeComments : onToggleComments}
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
          <div className="pl-viewer__room">
            <div className="pl-viewer__frame-wrap">
              <ArtifactFrame
                key={gate.enter_url}
                ref={setFrame}
                src={gate.enter_url}
                title={`${artifact.title}, version ${artifact.version}`}
                isolation={config?.content_isolation}
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
