import type { CSSProperties } from "react";
import "./skeleton.css";

export interface SkeletonProps {
  /** CSS length; defaults to 100%. */
  width?: string;
  /** CSS length; defaults to one line of body text. */
  height?: string;
  radius?: "xs" | "sm" | "md" | "lg" | "full";
  className?: string;
}

/**
 * A placeholder block while content loads. Hidden from assistive tech: put aria-busy="true" on
 * the region that is loading, and a visually hidden "Loading…" if nothing else says so.
 */
export function Skeleton({ width, height, radius = "sm", className }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;
  return (
    <span
      aria-hidden="true"
      className={`pl-skeleton pl-skeleton--${radius}${className ? ` ${className}` : ""}`}
      style={style}
    />
  );
}

/** Lines of placeholder text; the last line is shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="pl-skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
          key={i}
          width={i === lines - 1 && lines > 1 ? "60%" : "100%"}
        />
      ))}
    </span>
  );
}
