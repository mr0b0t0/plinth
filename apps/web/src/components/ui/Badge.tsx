import {
  ChatCircleIcon,
  CrownSimpleIcon,
  EyeIcon,
  GlobeSimpleIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  PencilSimpleIcon,
  UserListIcon,
} from "@phosphor-icons/react";
import type { EffectiveRole, Visibility } from "@plinth/shared";
import type { ReactNode } from "react";
import "./badge.css";
import { ICON_SIZE, type Icon } from "./icons.tsx";

export type BadgeTone = "neutral" | "strong" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: Icon;
  /** Monospace (versions, ids). */
  mono?: boolean;
  /** Extra text for screen readers, e.g. "Visibility:". */
  srPrefix?: string;
  title?: string;
  className?: string;
}

/** A short, non-interactive label. Color never carries the meaning alone: keep the text. */
export function Badge({
  children,
  tone = "neutral",
  icon: BadgeIcon,
  mono,
  srPrefix,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      className={`pl-badge pl-badge--${tone}${mono ? " pl-badge--mono" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      {BadgeIcon && <BadgeIcon size={ICON_SIZE.sm} aria-hidden="true" />}
      {srPrefix && <span className="visually-hidden">{srPrefix} </span>}
      {children}
    </span>
  );
}

/** Labels and one-line explanations for each visibility. Use these words everywhere. */
export const VISIBILITY_META: Record<
  Visibility,
  { label: string; description: string; icon: Icon }
> = {
  public: {
    label: "Public",
    description: "Anyone can open it, no sign-in or password needed.",
    icon: GlobeSimpleIcon,
  },
  unlisted: {
    label: "Unlisted",
    description: "Anyone with the link can open it.",
    icon: LinkSimpleIcon,
  },
  password: {
    label: "Password",
    description: "Anyone with the link and the password can open it.",
    icon: LockSimpleIcon,
  },
  allowlist: {
    label: "Specific people",
    description: "Only the email addresses you add can open it.",
    icon: UserListIcon,
  },
};

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const meta = VISIBILITY_META[visibility];
  return (
    <Badge
      tone={visibility === "public" ? "strong" : "neutral"}
      icon={meta.icon}
      srPrefix="Visibility:"
      title={meta.description}
    >
      {meta.label}
    </Badge>
  );
}

/** Labels and one-line explanations for each role. */
export const ROLE_META: Record<EffectiveRole, { label: string; description: string; icon: Icon }> =
  {
    owner: {
      label: "Owner",
      description: "Full control, including sharing and deletion.",
      icon: CrownSimpleIcon,
    },
    editor: {
      label: "Editor",
      description: "Can view, comment and publish new versions.",
      icon: PencilSimpleIcon,
    },
    commenter: { label: "Commenter", description: "Can view and comment.", icon: ChatCircleIcon },
    viewer: { label: "Viewer", description: "Can view.", icon: EyeIcon },
  };

export function RoleBadge({ value }: { value: EffectiveRole }) {
  const meta = ROLE_META[value];
  return (
    <Badge
      tone={value === "owner" ? "strong" : "neutral"}
      icon={meta.icon}
      srPrefix="Role:"
      title={meta.description}
    >
      {meta.label}
    </Badge>
  );
}
