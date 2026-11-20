// Change lists when the sequence diff gives up (its edit or time cap): the changed middle is
// anchored on blocks found once on each side, then each gap is paired in order. An unchanged block
// must not be listed as a change, even after a block added or removed earlier in the region. The
// diff is made to give up every time here, so the shape does not depend on how fast the machine is.
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

/** Rows as `rows(n, true)`, with a new row after row 1 and row 4 (unchanged) taken out. */
function shifted(n: number): string[] {
  const out = rows(n, true);
  out.splice(4, 1);
  out.splice(2, 0, "Brand new paragraph");
  return out;
}

/** What the list says for `shifted`: each edit in place, the added row and the removed one. */
function expectShifted(
  items: ChangeItem[],
  n: number,
  words: { changed: string; added: string; removed: string },
): void {
  const expected: Pick<ChangeItem, "what" | "before" | "after">[] = [];
  for (let k = 0; k < n && expected.length < CHANGE_LIMITS.maxItems; k++) {
    if (k % 3 === 0) {
      expected.push({ what: words.changed, before: `Row ${k} ok`, after: `Row ${k} edited` });
    }
    if (k === 1) expected.push({ what: words.added, after: "Brand new paragraph" });
    if (k === 4) expected.push({ what: words.removed, before: "Row 4 ok" });
  }
  expect(items.map((i) => ({ what: i.what, before: i.before, after: i.after }))).toEqual(
    expected
      .slice(0, CHANGE_LIMITS.maxItems)
      .map((e) => ({ before: undefined, after: undefined, ...e })),
  );
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

  for (const n of [3000, 300]) {
    it(`keeps the paragraphs of an HTML page in place around an insertion and a removal (${n})`, () => {
      const page = (list: string[]) =>
        `<h1>Rows</h1>\n${list.map((r) => `<p>${r}</p>`).join("\n")}`;
      const list = describeChanges("html", page(rows(n, false)), page(shifted(n)));
      expect(list.truncated).toBe(true);
      expectShifted(list.items, n, {
        changed: "Text changed",
        added: "Text added",
        removed: "Text removed",
      });
    });

    it(`keeps the paragraphs of a doc in place around an insertion and a removal (${n})`, () => {
      const doc = (list: string[]) => ["# Rows", ...list].join("\n\n");
      const list = describeChanges("doc", doc(rows(n, false)), doc(shifted(n)));
      expect(list.truncated).toBe(true);
      expectShifted(list.items, n, {
        changed: "Paragraph changed",
        added: "Paragraph added",
        removed: "Paragraph removed",
      });
    });

    it(`keeps a design board's paragraphs in place around an insertion and a removal (${n})`, () => {
      const design = (list: string[]) =>
        ['<!-- artboard name="Home" size="desktop" -->', ...list.map((r) => `<p>${r}</p>`)].join(
          "\n",
        );
      const list = describeChanges("design", design(rows(n, false)), design(shifted(n)));
      expect(list.truncated).toBe(true);
      expectShifted(list.items, n, {
        changed: "Text changed",
        added: "Text added",
        removed: "Text removed",
      });
    });
  }

  it("keeps a deck's slides in place around an insertion and a removal", () => {
    const deck = (list: string[]) =>
      list.map((r) => `# ${r.split(" ").slice(0, 2).join(" ")}\n\n${r}`).join("\n\n---\n\n");
    const list = describeChanges("slides", deck(rows(300, false)), deck(shifted(300)));
    expect(list.truncated).toBe(true);
    expect(list.items.filter((i) => i.kind === "moved")).toEqual([]);
    expect(list.items.filter((i) => i.kind === "added").map((i) => i.what)).toEqual([
      "Slide 3 “Brand new” added",
    ]);
    expect(list.items.filter((i) => i.kind === "removed").map((i) => i.what)).toEqual([
      "Slide 5 “Row 4” removed",
    ]);
    const changed = list.items.filter((i) => i.kind === "changed");
    expect(changed.map((i) => [i.before, i.after])).toEqual(
      editedRows(300).map((r) => [`${r} ok`, `${r} edited`]),
    );
  });

  it("keeps a sheet's rows in place around an insertion and a removal", () => {
    const sheet = (list: string[]) =>
      `${JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: [
          { name: "Name", type: "text" },
          { name: "Note", type: "text" },
        ],
      })}\n${list.map((r) => JSON.stringify([r.split(" ").slice(0, 2).join(" "), r])).join("\n")}\n`;
    const list = describeChanges("sheet", sheet(rows(300, false)), sheet(shifted(300)));
    expect(list.truncated).toBe(true);
    const changed = list.items.filter((i) => i.kind === "changed");
    expect(changed.map((i) => [i.before, i.after])).toEqual(
      editedRows(300).map((r) => [`${r} ok`, `${r} edited`]),
    );
    expect(list.items.filter((i) => i.kind !== "changed")).toHaveLength(2);
  });

  it("lists a paragraph added next to an edited one in one gap as added, on a page and a board", () => {
    const a = ["Alpha one here", "Middle stays", "Beta two here"];
    const b = [
      "Brand new thing",
      "Alpha one here, edited",
      "Middle stays",
      "Beta two here, edited",
    ];
    const expected = (where: string): ChangeItem[] => [
      { kind: "added", where, what: "Text added", after: "Brand new thing" },
      {
        kind: "changed",
        where,
        what: "Text changed",
        before: "Alpha one here",
        after: "Alpha one here, edited",
      },
      {
        kind: "changed",
        where,
        what: "Text changed",
        before: "Beta two here",
        after: "Beta two here, edited",
      },
    ];
    const page = (list: string[]) => `<h1>T</h1>${list.map((r) => `<p>${r}</p>`).join("")}`;
    const html = describeChanges("html", page(a), page(b));
    expect(html.truncated).toBe(true);
    expect(html.items).toEqual(expected("Under “T”"));
    const board = (list: string[]) => `<!-- artboard name="Home" size="iphone" -->\n${page(list)}`;
    expect(describeChanges("design", board(a), board(b)).items).toEqual(
      expected("Board “Home”, under “T”"),
    );
  });

  it("lists a slide added next to an edited one in one gap as added", () => {
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    const list = describeChanges(
      "slides",
      deck("# Plan\n\nStep one", "# Middle", "# End\n\nBye"),
      deck("# Budget\n\nMoney", "# Plan\n\nStep one, then two", "# Middle", "# End\n\nBye now"),
    );
    expect(list.truncated).toBe(true);
    expect(list.items).toEqual([
      { kind: "added", where: "", what: "Slide 1 “Budget” added" },
      {
        kind: "changed",
        where: "Slide 2",
        what: "Text changed",
        before: "Step one",
        after: "Step one, then two",
      },
      { kind: "changed", where: "Slide 4", what: "Text changed", before: "Bye", after: "Bye now" },
    ]);
  });

  it("anchors on items found once on each side, and keeps a moved one out of the anchors", () => {
    const d = diffSequence(["x", "a", "m", "b", "c", "y"], ["x", "a2", "b", "c", "m", "n", "y"]);
    expect(d).toEqual({
      exact: false,
      hunks: [
        { aStart: 1, aEnd: 3, bStart: 1, bEnd: 2 },
        { aStart: 5, aEnd: 5, bStart: 4, bEnd: 6 },
      ],
    });
  });

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
