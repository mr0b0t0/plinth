// The save status in the artifact bar while a doc, a deck, a sheet or a design system is edited on
// its page (#36). Editing is always on for owners and editors (decided 2026-11-23), so this is the
// whole edit chrome: one quiet line beside the version ("Draft saved", "Saving…", "Publishing…",
// "Published as v7", "Unpublished changes"), announced politely, and nothing at all while there
// is nothing to say. How many others are editing shows as a count (who and where in its tooltip
// and its name). While a version published meanwhile waits for review beside the unpublished
// changes, the line says so and holds the one button the bar ever adds for editing: "Review
// changes", which opens the whole-draft review in the frame (the review holds the two choices and
// its own way out, Back). While that review is open the line shows its status only. There is no
// Edit toggle, no Done and no Publish button: changes publish on their own, Cmd/Ctrl+S and the ⋯
// menu's "Publish changes" publish now, and "Discard unpublished changes" is in the ⋯ menu
// (stageItems.tsx). At phone width every status has a short form, so the bar stays one line.
// A page that cannot be edited here though the person may edit it (problems only an agent can
// fix, or too large) says so once, in the same place: "Read-only", with the reason as its name.
import { UsersIcon } from "@phosphor-icons/react";
import { versionRange } from "@plinth/shared";
import type { Ref } from "react";
import { Button, Tooltip } from "../ui/index.ts";
import type { LivePhase } from "./useLiveEdit.ts";

export interface SaveStatusProps {
  phase: LivePhase;
  mode: "room" | "solo";
  /** The version the edits are based on. */
  version: number;
  connected: boolean;
  /** Room mode, before the frame first reported. */
  connecting?: boolean;
  /** There are changes that are not a version yet. */
  dirty: boolean;
  /** Room mode: everything typed has been written to the draft (flushed). */
  flushed?: boolean;
  saving: boolean;
  savedVersion: number | null;
  rebasedVersion: number | null;
  /** The version the frozen page edits are reviewed against, when known. */
  conflictVersion?: number | null;
  editors: { email: string; block: boolean; where?: string }[];
  onReview?: () => void;
  /** The whole-draft review is open in the frame: the line shows its status only. */
  reviewing?: boolean;
  /** Why the page is read-only for this person, who may edit it (the frame said so). */
  blocked?: string | null;
  /** The line's accessible name (the design page shows several at once). */
  label?: string;
  /** The line itself, focusable, so focus can move to it (Esc at the top level of the frame). */
  focusRef?: Ref<HTMLElement>;
}

/** The status's words, most urgent first, or "" when there is nothing to say. */
export function saveStatus(p: SaveStatusProps): string {
  if (p.blocked) return p.blocked;
  if (p.saving) return "Publishing…";
  if (p.phase === "conflict") {
    const n = p.conflictVersion;
    if (!n) return "A newer version was published while you edited";
    const from = Math.min(p.version + 1, n);
    return from < n
      ? `${versionRange(from, n)} were published while you edited`
      : `v${n} was published while you edited`;
  }
  if (p.mode === "room" && p.connecting) return "Connecting…";
  if (p.mode === "room" && !p.connected) return "Not connected, your changes are kept";
  if (p.rebasedVersion && p.dirty) {
    return `v${p.rebasedVersion} was published; your changes were kept`;
  }
  if (p.savedVersion && !p.dirty) return `Published as v${p.savedVersion}`;
  if (p.dirty && p.mode === "solo") return "Unpublished changes, kept in this tab";
  if (p.dirty) return p.flushed === false ? "Saving…" : "Draft saved";
  return "";
}

/**
 * The status at phone width, where the long words would crowd the bar, or null when it is the same
 * as the long one.
 */
export function saveStatusShort(p: SaveStatusProps): string | null {
  if (p.blocked) return "Read-only";
  if (p.saving) return null;
  if (p.phase === "conflict") {
    const n = p.conflictVersion;
    if (!n) return "Newer version published";
    const from = Math.min(p.version + 1, n);
    return `${versionRange(from, n)} published`;
  }
  if (p.mode === "room" && p.connecting) return null;
  if (p.mode === "room" && !p.connected) return "Not connected";
  if (p.rebasedVersion && p.dirty) return `Merged with v${p.rebasedVersion}`;
  if (p.savedVersion && !p.dirty) return "Published";
  if (p.dirty && p.mode === "solo") return "Unpublished";
  if (p.dirty && p.flushed !== false) return "Saved";
  return null;
}

/** "ana@example.org (editing row 12)" for one of the others editing. */
function editorText(e: { email: string; block: boolean; where?: string }): string {
  if (!e.block) return e.email;
  return e.where ? `${e.email} (editing ${e.where})` : `${e.email} (editing)`;
}

/** Who else is editing and where, for the count's tooltip and name. */
export function editorsText(editors: SaveStatusProps["editors"]): string {
  return `Also here: ${editors.map(editorText).join(", ")}`;
}

export function SaveStatus(props: SaveStatusProps) {
  const { phase, editors, onReview } = props;
  const status = saveStatus(props);
  const short = saveStatusShort(props);
  const conflict = phase === "conflict" && !props.blocked;
  return (
    <section
      ref={props.focusRef}
      tabIndex={-1}
      className="pl-savestatus"
      aria-label={props.label ?? "Editing on the page"}
      data-blocked={props.blocked ? "" : undefined}
    >
      <span aria-live="polite" className="pl-savestatus__text" title={short ? status : undefined}>
        {short ? (
          <>
            <span className="pl-savestatus__long">{status}</span>
            <span className="pl-savestatus__short" aria-hidden="true">
              {short}
            </span>
          </>
        ) : (
          status
        )}
      </span>
      {editors.length > 0 && !props.blocked && (
        // How many others are here, at every width; who and where are its tooltip and its name.
        <Tooltip content={editorsText(editors)} placement="bottom">
          <span
            className="pl-savestatus__editors"
            role="img"
            aria-label={editorsText(editors)}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can read who in the tooltip
            tabIndex={0}
          >
            <UsersIcon size={14} aria-hidden="true" />
            {editors.length}
          </span>
        </Tooltip>
      )}
      {conflict && !props.reviewing && onReview && (
        <Button variant="secondary" size="sm" onClick={onReview}>
          Review changes
        </Button>
      )}
    </section>
  );
}
