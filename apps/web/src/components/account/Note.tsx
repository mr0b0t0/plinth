// A quiet inline notice: an icon and one or two sentences. Not a toast; it stays on the page.
import { InfoIcon, WarningIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ICON_SIZE } from "../ui/index.ts";

export interface NoteProps {
  children: ReactNode;
  /** neutral: context. warning: something that cannot be undone or will not be shown again. */
  tone?: "neutral" | "warning";
  className?: string;
  id?: string;
}

export function Note({ children, tone = "neutral", className, id }: NoteProps) {
  const Glyph = tone === "warning" ? WarningIcon : InfoIcon;
  return (
    <div
      id={id}
      className={`pl-acct-note pl-acct-note--${tone}${className ? ` ${className}` : ""}`}
    >
      <Glyph size={ICON_SIZE.sm} aria-hidden="true" className="pl-acct-note__icon" />
      <div className="pl-acct-note__body">{children}</div>
    </div>
  );
}
