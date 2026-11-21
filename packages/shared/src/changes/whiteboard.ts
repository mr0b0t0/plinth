// What changed in a whiteboard (board.json). A version holds only the board's settings, never its
// blocks or arrows (shared data), so the list names the settings that changed, in the Board
// settings dialog's labels: "Background: Dots → Grid", "Who can change the board: Editors only →
// Commenters and editors". A value outside its list reads as the default, as the board renders it,
// so it is listed only when what people see changed. Any other setting that changed is listed once,
// without its name or value; the format version and a starting board's blocks and arrows (which a
// stored version never holds) are not settings and are left out.
import {
  BOARD_BACKGROUND_LABELS,
  BOARD_BACKGROUNDS,
  BOARD_EDIT_LABELS,
  BOARD_EDIT_MODES,
  BOARD_SETTING_LABELS,
  DEFAULT_BOARD_SETTINGS,
} from "../whiteboard.ts";
import type { ChangeCollector } from "./types.ts";

/** Said when a setting the list does not name changed. */
export const BOARD_OTHER_SETTINGS = "Other board settings changed";

/** Keys of board.json that are not settings a person changes. */
const NOT_SETTINGS = new Set(["v", "blocks", "arrows"]);

type Settings = Record<string, unknown>;

function read(text: string): Settings | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Settings) : null;
}

/** The value the board renders: `v` when it is one of `list`, else the default. */
const effective = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

/** Whether a setting outside the known ones differs, compared as JSON. */
function othersChanged(a: Settings, b: Settings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (NOT_SETTINGS.has(k) || k === "background" || k === "edit") continue;
    if (Object.hasOwn(a, k) !== Object.hasOwn(b, k)) return true;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  return false;
}

/**
 * Adds the settings that changed from one board.json to another, in the dialog's order. False when
 * either text is not a JSON object, so nothing can be said in detail.
 */
export function describeWhiteboard(out: ChangeCollector, before: string, after: string): boolean {
  const a = read(before);
  const b = read(after);
  if (!a || !b) return false;
  const bgA = effective(BOARD_BACKGROUNDS, a.background, DEFAULT_BOARD_SETTINGS.background);
  const bgB = effective(BOARD_BACKGROUNDS, b.background, DEFAULT_BOARD_SETTINGS.background);
  if (bgA !== bgB) {
    out.add({
      kind: "changed",
      where: "",
      what: `${BOARD_SETTING_LABELS.background}: ${BOARD_BACKGROUND_LABELS[bgA]} → ${BOARD_BACKGROUND_LABELS[bgB]}`,
    });
  }
  const editA = effective(BOARD_EDIT_MODES, a.edit, DEFAULT_BOARD_SETTINGS.edit);
  const editB = effective(BOARD_EDIT_MODES, b.edit, DEFAULT_BOARD_SETTINGS.edit);
  if (editA !== editB) {
    out.add({
      kind: "changed",
      where: "",
      what: `${BOARD_SETTING_LABELS.edit}: ${BOARD_EDIT_LABELS[editA]} → ${BOARD_EDIT_LABELS[editB]}`,
    });
  }
  if (othersChanged(a, b)) out.add({ kind: "changed", where: "", what: BOARD_OTHER_SETTINGS });
  return true;
}
