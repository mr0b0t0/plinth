// The artifact on view: a slim bar (title, version, actions), the artifact in a sandboxed frame
// filling the rest, an optional comments panel, and a one-line banner naming the platform with a
// report link (required on every artifact page).
import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  FlagIcon,
  MoonIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, route, type ViewGate } from "@plinth/shared";
import { useState } from "react";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import { THEME_NAMES, useTheme } from "../../lib/theme.ts";
import { CommentsPanel } from "../artifact/CommentsPanel.tsx";
import { VersionPicker } from "../artifact/VersionPicker.tsx";
import { LogoMark } from "../Logo.tsx";
import { SkipLink } from "../layout/AppShell.tsx";
import {
  Button,
  ButtonLink,
  IconProvider,
  Menu,
  type MenuEntry,
  Skeleton,
  ThemeToggle,
  Toaster,
  VisibilityBadge,
} from "../ui/index.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import { contentOriginOf, shareLink } from "./gate.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import "./viewer.css";

type OkGate = Extract<ViewGate, { status: "ok" }>;

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
  const { artifact, role } = gate;
  const isOwner = role === "owner";
  const older = artifact.version < artifact.current_version;
  const appOrigin = config?.app_origin ?? window.location.origin;
  const link = shareLink(appOrigin, artifact.slug, pinned ? artifact.version : undefined);
  const contentOrigin = contentOriginOf(gate.enter_url, artifact.id, config);
  const nextTheme = theme === "dark" ? "light" : "dark";

  const editHref = route(APP_ROUTES.editor, { slug });
  const historyHref = route(APP_ROUTES.history, { slug });
  const reportHref = route(APP_ROUTES.report, { slug });

  const menuItems: MenuEntry[] = [
    { label: "Share", icon: ShareNetworkIcon, onSelect: () => setShareOpen(true) },
    ...(canEdit(role) ? [{ label: "Edit", icon: PencilSimpleIcon, href: editHref }] : []),
    { label: "History", icon: ClockCounterClockwiseIcon, href: historyHref },
    {
      label: commentsOpen ? "Hide comments" : "Show comments",
      icon: ChatCircleIcon,
      onSelect: onToggleComments,
    },
    { label: "Report", icon: FlagIcon, href: reportHref },
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
          <Link
            to={me ? APP_ROUTES.dashboard : APP_ROUTES.home}
            className="pl-viewer__home"
            aria-label={me ? "Plinth, go to dashboard" : "Plinth, go to home"}
          >
            <LogoMark size={24} />
          </Link>
          <div className="pl-viewer__heading">
            <h1 className="pl-viewer__title" title={artifact.title}>
              {artifact.title}
            </h1>
            <div className="pl-viewer__version">
              <VersionPicker
                slug={slug}
                current={artifact.current_version}
                shown={artifact.version}
              />
            </div>
            {isOwner && (
              <span className="pl-viewer__badge">
                <VisibilityBadge visibility={artifact.visibility} />
              </span>
            )}
          </div>
          <div className="pl-viewer__actions">
            <Button size="sm" icon={ShareNetworkIcon} onClick={() => setShareOpen(true)}>
              Share
            </Button>
            {canEdit(role) && (
              <ButtonLink size="sm" variant="ghost" icon={PencilSimpleIcon} to={editHref}>
                Edit
              </ButtonLink>
            )}
            <ButtonLink size="sm" variant="ghost" icon={ClockCounterClockwiseIcon} to={historyHref}>
              History
            </ButtonLink>
            <Button
              size="sm"
              variant="ghost"
              icon={ChatCircleIcon}
              aria-pressed={commentsOpen}
              onClick={onToggleComments}
            >
              Comments
            </Button>
            <ButtonLink size="sm" variant="ghost" icon={FlagIcon} to={reportHref}>
              Report
            </ButtonLink>
            <ThemeToggle />
          </div>
          <div className="pl-viewer__compact">
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
              You are viewing <span className="type-mono">v{artifact.version}</span>
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
                  onClose={onToggleComments}
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
            <Link to={APP_ROUTES.terms}>Terms</Link>
            <Link to={APP_ROUTES.privacy}>Privacy</Link>
            <Link to={APP_ROUTES.acceptableUse}>Acceptable use</Link>
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
        <span className="pl-viewer__home">
          <LogoMark size={24} />
        </span>
        <div className="pl-viewer__heading">
          <Skeleton width="12rem" height="1.25rem" />
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
