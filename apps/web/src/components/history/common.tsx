// Pieces shared by the History and Compare pages: the shell, the access-problem state, author and
// date labels.
import { RobotIcon, UserIcon } from "@phosphor-icons/react";
import { APP_ROUTES, type Author } from "@plinth/shared";
import { type ReactNode, useEffect } from "react";
import type { ApiRequestError } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { AppShell, type AppShellProps } from "../layout/AppShell.tsx";
import { ButtonLink, EmptyState, ICON_SIZE, Tooltip } from "../ui/index.ts";
import { artifactPath, fullTimestamp, relativeTime } from "./format.ts";
import "./history.css";

/** The artifact's title in the top bar: "Artifacts / <title> / History". */
export function ArtifactCrumbTitle({ slug, title }: { slug: string; title: string }) {
  return <Link to={artifactPath(slug)}>{title}</Link>;
}

export function HistoryShell({
  children,
  width = "content",
  title,
  trail,
  actions,
}: {
  children: ReactNode;
  width?: "content" | "full";
} & Pick<AppShellProps, "title" | "trail" | "actions">) {
  // Sign out is the shell's own (useSignOut), which drops what this tab kept to rescue.
  return (
    <AppShell
      width={width}
      crumbs={title !== undefined ? [{ label: "Artifacts", to: APP_ROUTES.dashboard }] : undefined}
      title={title}
      trail={trail}
      actions={actions}
    >
      {children}
    </AppShell>
  );
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Plinth`;
  }, [title]);
}

/** What to show when the API refuses: sign in, open the artifact (runs the viewer gate), or 404. */
export function AccessProblem({
  error,
  slug,
  what,
}: {
  error: ApiRequestError;
  slug: string;
  /** "history" or "comparison": what the person tried to see. */
  what: string;
}) {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  const open = (
    <ButtonLink to={artifactPath(slug)} variant="primary">
      Open the artifact
    </ButtonLink>
  );
  if (error.status === 401) {
    return (
      <EmptyState
        headingLevel={1}
        title="Sign in to see this"
        description={`This ${what} is only for people who can view the artifact. Open it to check your access, or sign in.`}
        action={
          <div className="hx-actions">
            {open}
            <ButtonLink to={APP_ROUTES.login}>Sign in</ButtonLink>
          </div>
        }
      />
    );
  }
  if (error.status === 403) {
    const description =
      reason === "password_required"
        ? "This artifact needs a password. Open it, enter the password, then come back."
        : reason === "email_required"
          ? "This artifact is private. If it was shared with you, open it and confirm your email, then come back."
          : reason === "taken_down"
            ? "This artifact was taken down."
            : `You do not have access to this ${what}.`;
    return (
      <EmptyState
        headingLevel={1}
        title="You can't see this yet"
        description={description}
        action={reason === "taken_down" ? undefined : open}
      />
    );
  }
  if (error.status === 404) {
    return (
      <EmptyState
        headingLevel={1}
        title="Artifact not found"
        description="It may have been deleted, or the link is wrong. If it was shared with you, opening it may ask you to confirm access first."
        action={open}
      />
    );
  }
  return (
    <EmptyState
      headingLevel={1}
      title="Something went wrong"
      description={error.message || "The request failed. Try again in a moment."}
      action={open}
    />
  );
}

/**
 * Person or agent, with an icon that tells them apart (and words for screen readers), and "Owner"
 * beside the owner's own versions. The mark comes from the server (is_owner), never from the name.
 */
export function AuthorLabel({ author }: { author: Author }) {
  const isAgent = author.kind === "connection";
  const AuthorIcon = isAgent ? RobotIcon : UserIcon;
  return (
    <span className="hx-author">
      <AuthorIcon size={ICON_SIZE.sm} aria-hidden="true" />
      <span className="visually-hidden">{isAgent ? "Agent: " : "Person: "}</span>
      <span className="hx-author__label">{author.label}</span>
      {!isAgent && author.is_owner && <span className="hx-author__owner">Owner</span>}
    </span>
  );
}

/** Relative date with the full timestamp in a tooltip (reachable by keyboard). */
export function VersionDate({ iso }: { iso: string }) {
  return (
    <Tooltip content={fullTimestamp(iso)}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can read the full timestamp in the tooltip */}
      <time dateTime={iso} tabIndex={0} className="hx-date">
        {relativeTime(iso)}
      </time>
    </Tooltip>
  );
}
