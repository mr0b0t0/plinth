// Solo editing: every type's own copy counts its changes from the text last published (the app's
// `saved`, rebase), not only from the text the frame loaded. Without it, a change back to the
// loaded text after an autosave read as clean: nothing published it and leaving did not warn.
import { describe, expect, it } from "vitest";
import { LocalSystem } from "../design_system/local.ts";
import { LocalDoc } from "../doc/edit.ts";
import { LocalSheet } from "../sheet/edit.ts";
import { LocalDeck } from "../slides/edit.ts";

const events = { granted: () => undefined, changed: () => undefined } as never;

describe("a solo copy's base", () => {
  for (const [name, make] of [
    ["doc", (t: string) => new LocalDoc(t, events)],
    ["deck", (t: string) => new LocalDeck(t, events)],
    ["sheet", (t: string) => new LocalSheet(t, events)],
    ["design system", (t: string) => new LocalSystem(t, events)],
  ] as const) {
    it(`${name}: is the published text once rebased`, () => {
      const local = make("one\ntwo");
      expect(local.dirty).toBe(false);
      local.lines = ["one", "two", "three"];
      expect(local.dirty).toBe(true);
      // Published: clean again.
      local.rebase(local.text);
      expect(local.dirty).toBe(false);
      // Back to the text the frame loaded: a change from what is published.
      local.lines = ["one", "two"];
      expect(local.dirty).toBe(true);
    });
  }
});
