// Change lists when the sequence diff gives up (its edit or time cap): the changed middle is one
// region, paired in order, and an unchanged block in it must not be listed as a change. The diff
// is made to give up every time here, so the shape does not depend on how fast the machine is.
import { describe, expect, it, vi } from "vitest";
import { CHANGE_LIMITS, type ChangeItem, describeChanges, diffSequence } from "../src/index.ts";

vi.mock("diff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("diff")>()),
  diffArrays: () => undefined,
}));

/** `n` rows; with `edit`, every third one (from the first) says "edited" instead of "ok". */
function rows(n: number, edit: boolean): string[] {
  return Array.from({ length: n }, (_, k) => `Row ${k} ${edit && k % 3 === 0 ? "edited" : "ok"}`);
}

/** The rows edited, in order, up to the item cap: what a list of real changes names. */
function editedRows(n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n && out.length < CHANGE_LIMITS.maxItems; k += 3) out.push(`Row ${k}`);
  return out;
}

/** Every item is a real edit: before says "ok" and after "edited", for the rows edited. */
function expectOnlyEdits(items: ChangeItem[], n: number, what: string): void {
  const expected = editedRows(n);
  expect(items).toHaveLength(expected.length);
  expect(items.map((i) => i.what)).toEqual(expected.map(() => what));
  expect(items.map((i) => i.before)).toEqual(expected.map((r) => `${r} ok`));
  expect(items.map((i) => i.after)).toEqual(expected.map((r) => `${r} edited`));
}

describe("a region the diff gave up on", () => {
  it("is one region (the diff did give up)", () => {
    const d = diffSequence(["x", "a", "b", "y"], ["x", "c", "d", "y"]);
    expect(d).toEqual({ hunks: [{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 3 }], exact: false });
  });

  for (const n of [3000, 300]) {
    it(`lists only the edited paragraphs of an HTML page (${n} paragraphs)`, () => {
      const page = (edit: boolean) =>
        `<h1>Rows</h1>\n${rows(n, edit)
          .map((r) => `<p>${r}</p>`)
          .join("\n")}`;
      const list = describeChanges("html", page(false), page(true));
      expect(list.truncated).toBe(true);
      expect(list.items.every((i) => i.where === "Under “Rows”")).toBe(true);
      expectOnlyEdits(list.items, n, "Text changed");
    });

    it(`lists only the edited paragraphs of a doc (${n} paragraphs)`, () => {
      const doc = (edit: boolean) =>
        [
          "# Rows",
          "[home]: https://example.com",
          ...rows(n, edit).map((r, k) => (k % 3 === 1 ? `${r} [home]` : r)),
        ].join("\n\n");
      const list = describeChanges("doc", doc(false), doc(true));
      expect(list.truncated).toBe(true);
      expectOnlyEdits(list.items, n, "Paragraph changed");
    });

    it(`lists only the edited items of a doc's list (${n} items)`, () => {
      const doc = (edit: boolean) =>
        rows(n, edit)
          .map((r) => `- ${r}`)
          .join("\n");
      const list = describeChanges("doc", doc(false), doc(true));
      expectOnlyEdits(list.items, n, "List item changed");
    });

    it(`lists only the edited paragraphs of a design board (${n} paragraphs)`, () => {
      const design = (edit: boolean) =>
        [
          '<!-- artboard name="Home" size="desktop" -->',
          ...rows(n, edit).map((r) => `<p>${r}</p>`),
        ].join("\n");
      const list = describeChanges("design", design(false), design(true));
      expect(list.truncated).toBe(true);
      expect(list.items.every((i) => i.where === "Board “Home”")).toBe(true);
      expectOnlyEdits(list.items, n, "Text changed");
    });
  }

  it("lists only the edited slides of a deck", () => {
    const deck = (edit: boolean) =>
      rows(300, edit)
        .map((r, k) => `# Slide ${k}\n\n${r}`)
        .join("\n\n---\n\n");
    const list = describeChanges("slides", deck(false), deck(true));
    expect(list.truncated).toBe(true);
    expectOnlyEdits(list.items, 300, "Text changed");
  });

  it("matches slides of one title in linear time, and edits in place are not moves", () => {
    const slides = Array.from({ length: 20_000 }, (_, k) => `# Same\n\nText ${k}`);
    const t = Date.now();
    const list = describeChanges(
      "slides",
      slides.join("\n\n---\n\n"),
      slides.map((s) => `${s}!`).join("\n\n---\n\n"),
    );
    expect(Date.now() - t).toBeLessThan(2000);
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(list.items.some((i) => i.kind === "moved")).toBe(false);
  });

  it("does not call an unchanged column of a sheet renamed", () => {
    const sheet = (names: string[]) =>
      `${JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: names.map((name) => ({ name, type: "text" })),
      })}\n${JSON.stringify(names.map(() => "x"))}\n`;
    expect(
      describeChanges("sheet", sheet(["A", "B", "C", "D"]), sheet(["A", "X", "C", "Y"])).items,
    ).toEqual([
      {
        kind: "changed",
        where: "Column B",
        what: "Column “B” renamed",
        before: "B",
        after: "X",
      },
      {
        kind: "changed",
        where: "Column D",
        what: "Column “D” renamed",
        before: "D",
        after: "Y",
      },
    ]);
  });
});
