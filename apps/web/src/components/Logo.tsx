// The Plinth mark: a dark block (the work) standing above a bronze base (the plinth), and the
// wordmark in the interface face. public/favicon.svg draws the same shapes on the same 16px grid.
import "../styles/logo.css";

export function LogoMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`pl-logo-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path className="pl-logo-mark__block" d="M5 0h6a2 2 0 0 1 2 2v7H3V2a2 2 0 0 1 2-2z" />
      <rect className="pl-logo-mark__base" x="0" y="14" width="16" height="2" rx="1" />
    </svg>
  );
}

export interface LogoProps {
  /** "full": mark + wordmark. "mark": the mark alone (it still has an accessible name). */
  variant?: "full" | "mark";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const MARK = { sm: 16, md: 16, lg: 32 } as const;

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
