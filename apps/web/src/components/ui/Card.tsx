import type { HTMLAttributes, ReactNode } from "react";
import "./card.css";

type BlockTag = "div" | "article" | "section" | "li" | "aside";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: BlockTag;
  /** raised: white card with outline (default). flat: no outline or shadow. sunk: a well. */
  variant?: "raised" | "flat" | "sunk";
  padding?: "none" | "sm" | "md" | "lg";
  /** Outline darkens on hover; use when the whole card is a link target. */
  interactive?: boolean;
}

/** A surface that groups related content. Not for every block: whitespace groups too. */
export function Card({
  as: Tag = "div",
  variant = "raised",
  padding = "md",
  interactive = false,
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={`pl-card pl-card--${variant} pl-card--pad-${padding}${interactive ? " pl-card--interactive" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

export interface ExhibitProps {
  as?: BlockTag;
  /** The work itself: a preview, a thumbnail, a frame. */
  children: ReactNode;
  /** The wall label under the plinth: title, meta, badges. */
  label?: ReactNode;
  /** CSS aspect ratio of the piece, e.g. "4 / 3". */
  aspect?: string;
  className?: string;
}

/**
 * The signature surface: a piece standing on a slightly wider base, with a wall label below.
 * Use it for artifacts (dashboard grid, history previews), not for settings or forms.
 */
export function Exhibit({ as: Tag = "div", children, label, aspect, className }: ExhibitProps) {
  return (
    <Tag className={`pl-exhibit${className ? ` ${className}` : ""}`}>
      <div className="pl-exhibit__piece" style={aspect ? { aspectRatio: aspect } : undefined}>
        {children}
      </div>
      <div className="pl-exhibit__base" aria-hidden="true" />
      {label && <div className="pl-exhibit__label">{label}</div>}
    </Tag>
  );
}
