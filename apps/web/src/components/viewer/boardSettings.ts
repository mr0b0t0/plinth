// A whiteboard's Board settings (docs/spec.md "Whiteboards"): the two choices a board's versions
// hold, as the app shows and saves them. Pure helpers, so the dialog and its tests agree. The app
// builds board.json itself from two known values (never from text a person typed), and saves it
// as a new version against the version the dialog read, so a newer version is never overwritten.
import {
  BOARD_BACKGROUND_LABELS,
  BOARD_EDIT_LABELS,
  type BoardBackground,
  type BoardEditMode,
  type BoardSettings,
  boardSettingsText,
  type ErrorCode,
} from "@plinth/shared";

// The labels are shared with History's Compare page, which lists a settings change in them.
export const BACKGROUND_CHOICES: readonly { value: BoardBackground; label: string }[] = [
  { value: "dots", label: BOARD_BACKGROUND_LABELS.dots },
  { value: "grid", label: BOARD_BACKGROUND_LABELS.grid },
  { value: "plain", label: BOARD_BACKGROUND_LABELS.plain },
];

export const EDIT_CHOICES: readonly { value: BoardEditMode; label: string }[] = [
  // The default (DEFAULT_BOARD_SETTINGS) first.
  { value: "editors", label: BOARD_EDIT_LABELS.editors },
  { value: "commenters", label: BOARD_EDIT_LABELS.commenters },
];

const labelOf = <T extends string>(list: readonly { value: T; label: string }[], v: T) =>
  list.find((c) => c.value === v)?.label ?? v;

/** Whether two settings differ in anything a version stores. */
export function settingsChanged(a: BoardSettings, b: BoardSettings): boolean {
  return a.background !== b.background || a.edit !== b.edit;
}

/** The version note for a settings change: what changed, in words ("Board settings: Grid"). */
export function settingsNote(before: BoardSettings, after: BoardSettings): string {
  const parts: string[] = [];
  if (before.background !== after.background) {
    parts.push(`background ${labelOf(BACKGROUND_CHOICES, after.background).toLowerCase()}`);
  }
  if (before.edit !== after.edit) {
    parts.push(after.edit === "editors" ? "editors only" : "commenters and editors");
  }
  return parts.length ? `Board settings: ${parts.join(", ")}` : "Board settings";
}

/**
 * The body of `PUT /artifacts/:ref` that saves new settings: board.json as Plinth stores it (the
 * settings only, no starting blocks), the version the dialog read as `base_version`, and a note.
 */
export function settingsBody(
  before: BoardSettings,
  after: BoardSettings,
  baseVersion: number,
): { content: string; base_version: number; note: string } {
  return {
    content: boardSettingsText(after),
    base_version: baseVersion,
    note: settingsNote(before, after),
  };
}

/** What the dialog says after a save was refused because a newer version exists. */
export function conflictNotice(version: number): string {
  return `v${version} was published meanwhile. These are its settings.`;
}

/** A refused request as the app's API client reports it (`ApiRequestError`). */
export interface Refusal {
  status: number;
  code: ErrorCode;
  details?: unknown;
}

/**
 * The newer version a refused save names, or null when the refusal is not a stale-version conflict.
 * Every 409 shares the error code `conflict`, so the kind is in the details: only the stager's
 * stale-version refusal (`conflictError`) carries a `current_version` and no `reason`. The other
 * 409s name a reason (`attempt_expired`, `upload_used`, `live_busy`, `already_shared`, ...) or no
 * version at all (another version being written, too many concurrent updates); for them, and for
 * every other code, the dialog shows the server's message and offers no newer settings.
 */
export function newerVersion(refusal: Refusal, read: number): number | null {
  if (refusal.status !== 409 || refusal.code !== "conflict") return null;
  const { details } = refusal;
  if (typeof details !== "object" || details === null) return null;
  if ("reason" in details) return null;
  const current = (details as { current_version?: unknown }).current_version;
  return typeof current === "number" && Number.isInteger(current) && current > read
    ? current
    : null;
}
