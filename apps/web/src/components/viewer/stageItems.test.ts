// The viewer's item lists: unique ids (they are React keys), per-type and per-capability tables
// keyed only by known values, and a notice made of its lines in order.
import { ARTIFACT_TYPES, DATA_CAPABILITIES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { DATA_NOTICE_LINES, noticeText } from "./DataNotice.tsx";
import {
  BAR_CONTROLS,
  CAPABILITY_MENU_ITEMS,
  MENU_ITEMS,
  STRIP_ITEMS,
  TYPE_MENU_ITEMS,
} from "./stageItems.tsx";

describe("viewer item lists", () => {
  it("give every bar control and strip item its own id", () => {
    for (const list of [BAR_CONTROLS, STRIP_ITEMS]) {
      const ids = list.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(MENU_ITEMS.length).toBeGreaterThan(0);
  });

  it("key per-type and per-capability menu items by known values only", () => {
    for (const t of Object.keys(TYPE_MENU_ITEMS)) expect(ARTIFACT_TYPES).toContain(t);
    for (const c of Object.keys(CAPABILITY_MENU_ITEMS)) expect(DATA_CAPABILITIES).toContain(c);
  });

  it("builds the notice from its lines, and says nothing when no line does", () => {
    // The data line, the people line (names and the people list), then the files line.
    expect(DATA_NOTICE_LINES.length).toBe(4);
    expect(noticeText({})).toBeNull();
    expect(
      noticeText({
        data: { available: false, capabilities: ["data"], identified: false, can_write: false },
      }),
    ).toBe("Shared data is not available on this server.");
  });
});
