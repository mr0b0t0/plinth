// The Plinth mark: a small block (the work, in verdigris) standing on a wider base (the plinth).
// public/favicon.svg draws the same shapes.
import "../styles/logo.css";

export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`pl-logo-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect className="pl-logo-mark__block" x="11" y="6" width="10" height="13" rx="1" />
      <rect className="pl-logo-mark__base" x="5" y="21" width="22" height="5" rx="1" />
    </svg>
  );
}

export interface LogoProps {
  /** "full": mark + wordmark. "mark": the mark alone (it still has an accessible name). */
  variant?: "full" | "mark";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const MARK = { sm: 20, md: 24, lg: 40 } as const;

export function Logo({ variant = "full", size = "md", className }: LogoProps) {
  return (
    <span className={`pl-logo pl-logo--${size}${className ? ` ${className}` : ""}`}>
      <LogoMark size={MARK[size]} />
      {variant === "full" ? (
        <span className="pl-logo__word">Plinth</span>
      ) : (
        <span className="visually-hidden">Plinth</span>
      )}
    </span>
  );
}
