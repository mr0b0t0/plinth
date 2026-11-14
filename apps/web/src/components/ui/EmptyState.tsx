import type { ReactNode } from "react";
import "./empty-state.css";

/**
 * An empty plinth: the pedestal is there, the dashed outline marks where an exhibit will stand.
 * Decorative; colors come from tokens.
 */
export function EmptyPlinth({ size = 96 }: { size?: number }) {
  return (
    <svg
      className="pl-empty-plinth"
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
    >
      <rect className="pl-empty-plinth__ghost" x="31.5" y="13.5" width="33" height="37" rx="1.5" />
      <rect className="pl-empty-plinth__top" x="20" y="56" width="56" height="6" rx="1" />
      <rect className="pl-empty-plinth__body" x="24" y="62" width="48" height="26" />
      <path className="pl-empty-plinth__floor" d="M8 88.5h80" />
    </svg>
  );
}

export interface EmptyStateProps {
  /** What is empty, said plainly ("No artifacts yet"). */
  title: string;
  /** What to do about it. */
  description?: ReactNode;
  /** Usually one primary Button or ButtonLink. */
  action?: ReactNode;
  /** Replaces the empty-plinth drawing (e.g. an icon); pass null for none. */
  art?: ReactNode;
  /** Heading level for the title, to fit the page outline (1 when it is the whole page). */
  headingLevel?: 1 | 2 | 3;
  size?: "md" | "lg";
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  art,
  headingLevel = 2,
  size = "md",
  className,
}: EmptyStateProps) {
  const H = (["h1", "h2", "h3"] as const)[headingLevel - 1] ?? "h2";
  return (
    <div className={`pl-empty pl-empty--${size}${className ? ` ${className}` : ""}`}>
      {art === undefined ? <EmptyPlinth size={size === "lg" ? 80 : 64} /> : art}
      <H className="pl-empty__title">{title}</H>
      {description && <div className="pl-empty__description">{description}</div>}
      {action && <div className="pl-empty__action">{action}</div>}
    </div>
  );
}
