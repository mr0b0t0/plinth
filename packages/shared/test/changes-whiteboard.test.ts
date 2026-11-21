// A whiteboard's change list: a version holds only the board's settings, so Compare names the
// settings that changed in the Board settings dialog's words, and nothing when they are the same.
import { describe, expect, it } from "vitest";
import {
  BOARD_OTHER_SETTINGS,
  boardSettingsText,
  CHANGES_INVISIBLE,
  CHANGES_UNREADABLE,
  describeChanges,
} from "../src/index.ts";

const board = (background: "dots" | "grid" | "plain", edit: "editors" | "commenters") =>
  boardSettingsText({ v: 1, background, edit });

const whats = (before: string, after: string) =>
  describeChanges("whiteboard", before, after).items.map((i) => i.what);

describe("whiteboard", () => {
  it("lists a background change", () => {
    expect(
      describeChanges("whiteboard", board("dots", "editors"), board("grid", "editors")),
    ).toEqual({
      items: [{ kind: "changed", where: "", what: "Background: Dots → Grid" }],
      truncated: false,
    });
  });

  it("lists a change of who can change the board", () => {
    expect(whats(board("dots", "editors"), board("dots", "commenters"))).toEqual([
      "Who can change the board: Editors only → Commenters and editors",
    ]);
  });

  it("lists both, in the dialog's order", () => {
    expect(whats(board("plain", "commenters"), board("grid", "editors"))).toEqual([
      "Background: Plain → Grid",
      "Who can change the board: Commenters and editors → Editors only",
    ]);
  });

  it("lists nothing when the settings are unchanged", () => {
    const same = board("grid", "commenters");
    expect(describeChanges("whiteboard", same, same)).toEqual({ items: [], truncated: false });
    // Spelled differently, the same settings: no setting is named, only that the storage differs.
    expect(whats(same, '{"edit":"commenters","v":1,"background":"grid"}')).toEqual([
      CHANGES_INVISIBLE,
    ]);
    // A missing setting is its default, as the board renders it.
    expect(whats('{"v":1}', board("dots", "editors"))).toEqual([CHANGES_INVISIBLE]);
  });

  it("never throws on a malformed version, and says it cannot be read in detail", () => {
    for (const bad of ["not json", "[1,2]", "null", '"grid"', "{", "[".repeat(100_000)]) {
      expect(() => describeChanges("whiteboard", bad, board("grid", "editors"))).not.toThrow();
      expect(whats(bad, board("grid", "editors"))).toEqual([CHANGES_UNREADABLE]);
      expect(whats(board("grid", "editors"), bad)).toEqual([CHANGES_UNREADABLE]);
    }
  });

  it("reads a value outside its list as the default, and names no unknown setting", () => {
    // "neon" renders as dots, so only the edit change shows.
    expect(
      whats(
        '{"v":1,"background":"neon","edit":42}',
        '{"v":1,"background":"dots","edit":"commenters"}',
      ),
    ).toEqual(["Who can change the board: Editors only → Commenters and editors"]);
    expect(whats('{"v":1,"background":"neon"}', board("grid", "editors"))).toEqual([
      "Background: Dots → Grid",
    ]);
    // A setting the list does not know is listed once, without its name or value.
    const items = describeChanges(
      "whiteboard",
      '{"v":1,"zoom":1,"<img src=x onerror=alert(1)>":"a"}',
      '{"v":1,"zoom":2,"snap":true}',
    ).items;
    expect(items).toEqual([{ kind: "changed", where: "", what: BOARD_OTHER_SETTINGS }]);
    // The format version and a starting board are not settings.
    expect(whats('{"v":1}', '{"v":2,"blocks":[{"id":"a"}],"arrows":[]}')).toEqual([
      CHANGES_INVISIBLE,
    ]);
  });
});
