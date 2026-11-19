// What changed in a whiteboard's version (board.json): its settings. The board's notes and
// arrows live in shared data, not in versions, so a version never changes them.
import { type BoardSettings, parseBoardSettings } from "../whiteboard.ts";
import type { ChangeCollector } from "./types.ts";

const BACKGROUND: Record<BoardSettings["background"], string> = {
  dots: "Dots",
  grid: "Grid",
  plain: "Plain",
};
const EDIT: Record<BoardSettings["edit"], string> = {
  commenters: "Commenters and editors",
  editors: "Editors only",
};

/** Adds the changes from `before` to `after`, two board settings files, to `out`. */
export function describeWhiteboard(out: ChangeCollector, before: string, after: string): void {
  const a = parseBoardSettings(before);
  const b = parseBoardSettings(after);
  const where = "Board settings";
  if (a.background !== b.background) {
    out.add({
      kind: "changed",
      where,
      what: "Background changed",
      before: BACKGROUND[a.background],
      after: BACKGROUND[b.background],
    });
  }
  if (a.edit !== b.edit) {
    out.add({
      kind: "changed",
      where,
      what: "Who can edit the board changed",
      before: EDIT[a.edit],
      after: EDIT[b.edit],
    });
  }
}
