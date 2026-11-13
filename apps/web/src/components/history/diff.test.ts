import { describe, expect, it } from "vitest";
import {
  type DiffLine,
  diffAssets,
  diffTextLines,
  foldUnchanged,
  splitLines,
  splitRows,
  unifiedRows,
} from "./diff.ts";

const kinds = (lines: DiffLine[]) =>
  lines.map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`);

/** Old and new text by applying `edit` to every `every`-th line of an n-line document. */
function bigDoc(n: number, every: number, edit: (line: string) => string) {
  const old = Array.from({ length: n }, (_, i) => `<div class="row-${i}">Row ${i}</div>`);
  const next = old.map((l, i) => (i % every === 0 ? edit(l) : l));
  return { old: old.join("\n"), next: next.join("\n") };
}

describe("splitLines", () => {
  it("splits on every newline style and ignores a final newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\r\nb\rc\n\nd")).toEqual(["a", "b", "c", "", "d"]);
  });
});

describe("diffTextLines", () => {
  it("reports identical documents", () => {
    const d = diffTextLines("a\nb\n", "a\nb");
    expect(d.identical).toBe(true);
    expect(d.added + d.removed).toBe(0);
    expect(d.lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("marks added, removed and unchanged lines with both line numbers", () => {
    const d = diffTextLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(kinds(d.lines)).toEqual([" a", "-b", "+B", " c", " d", "+e"]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.exact).toBe(true);
    expect(d.lines.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
      [4, 4],
      [null, 5],
    ]);
  });

  it("handles empty sides", () => {
    expect(kinds(diffTextLines("", "x\ny").lines)).toEqual(["+x", "+y"]);
    expect(kinds(diffTextLines("x\ny", "").lines)).toEqual(["-x", "-y"]);
  });

  it("finds a minimal diff in the middle after trimming common ends", () => {
    const d = diffTextLines("h\n1\n2\n3\nf", "h\n1\nX\n3\nf");
    expect(kinds(d.lines)).toEqual([" h", " 1", "-2", "+X", " 3", " f"]);
  });

  it("falls back to one replaced block when the edit is too large, and stays correct", () => {
    const d = diffTextLines("top\na\nb\nc\nbottom", "top\nx\ny\nz\nbottom", { maxEditLength: 1 });
    expect(d.exact).toBe(false);
    expect(kinds(d.lines)).toEqual([" top", "-a", "-b", "-c", "+x", "+y", "+z", " bottom"]);
  });

  it("diffs a 5,000-line document with scattered edits quickly", () => {
    const { old, next } = bigDoc(5000, 50, (l) => l.replace("Row", "Line"));
    const t0 = performance.now();
    const d = diffTextLines(old, next);
    const ms = performance.now() - t0;
    expect(d.exact).toBe(true);
    expect(d.added).toBe(100);
    expect(d.removed).toBe(100);
    expect(ms).toBeLessThan(500);
  });

  it("gives up within its time cap on a 5,000-line document that changed completely", () => {
    const { old, next } = bigDoc(5000, 1, (l) => `${l} changed`);
    const t0 = performance.now();
    const d = diffTextLines(old, next, { timeoutMs: 100 });
    const ms = performance.now() - t0;
    expect(d.added).toBe(5000);
    expect(d.removed).toBe(5000);
    expect(ms).toBeLessThan(1500);
  });
});

describe("foldUnchanged and unifiedRows", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");

  it("folds long unchanged runs, keeping context next to each change", () => {
    const old = lines(40);
    const next = old.replace("l20", "L20");
    const blocks = foldUnchanged(diffTextLines(old, next).lines, 3);
    // 1-16 folded, 17-19 context, change, 21-23 context, 24-40 folded.
    expect(blocks.map((b) => b.type)).toEqual(["fold", "lines", "fold"]);
    const rows = unifiedRows(blocks, new Set());
    expect(rows[0]).toMatchObject({ type: "fold", count: 16, firstOld: 1, firstNew: 1 });
    expect(rows.filter((r) => r.type === "line")).toHaveLength(8);
    expect(rows.at(-1)).toMatchObject({ type: "fold", count: 17, firstOld: 24 });
  });

  it("expands a fold by id", () => {
    const old = lines(40);
    const blocks = foldUnchanged(diffTextLines(old, old.replace("l20", "L20")).lines, 3);
    const first = blocks[0];
    if (first?.type !== "fold") throw new Error("expected a fold");
    const rows = unifiedRows(blocks, new Set([first.id]));
    expect(rows.slice(0, 16).every((r) => r.type === "line")).toBe(true);
    expect(rows.filter((r) => r.type === "fold")).toHaveLength(1);
  });

  it("does not fold short runs", () => {
    const old = lines(10);
    const blocks = foldUnchanged(diffTextLines(old, old.replace("l5", "L5")).lines, 3);
    expect(blocks.every((b) => b.type === "lines")).toBe(true);
  });

  it("folds everything when nothing changed", () => {
    const blocks = foldUnchanged(diffTextLines(lines(30), lines(30)).lines, 3);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("fold");
  });

  it("keeps the rendered row count small for a large document with a few edits", () => {
    const { old, next } = bigDoc(5000, 1000, (l) => `${l}!`);
    const rows = unifiedRows(foldUnchanged(diffTextLines(old, next).lines), new Set());
    expect(rows.length).toBeLessThan(60);
  });
});

describe("splitRows", () => {
  it("pairs removed runs with the added runs that follow", () => {
    const d = diffTextLines("a\nb\nc\nd", "a\nB1\nB2\nB3\nd");
    const rows = splitRows(unifiedRows(foldUnchanged(d.lines), new Set()));
    const show = rows.map((r) =>
      r.type === "fold" ? "fold" : `${r.left?.text ?? "·"}|${r.right?.text ?? "·"}`,
    );
    expect(show).toEqual(["a|a", "b|B1", "c|B2", "·|B3", "d|d"]);
  });

  it("passes folds through", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const rows = splitRows(
      unifiedRows(foldUnchanged(diffTextLines(old, old.replace("l15", "x")).lines), new Set()),
    );
    expect(rows[0]?.type).toBe("fold");
    expect(rows.at(-1)?.type).toBe("fold");
  });
});

describe("diffAssets", () => {
  it("lists added, removed and resized files, then unchanged ones", () => {
    const a = [
      { path: "img/a.png", size_bytes: 100, content_type: "image/png" },
      { path: "style.css", size_bytes: 50, content_type: "text/css" },
      { path: "old.js", size_bytes: 10, content_type: "text/javascript" },
    ];
    const b = [
      { path: "img/a.png", size_bytes: 100, content_type: "image/png" },
      { path: "style.css", size_bytes: 70, content_type: "text/css" },
      { path: "new.js", size_bytes: 5, content_type: "text/javascript" },
    ];
    expect(diffAssets(a, b)).toEqual([
      { path: "new.js", kind: "added", after: 5 },
      { path: "old.js", kind: "removed", before: 10 },
      { path: "style.css", kind: "changed", before: 50, after: 70 },
      { path: "img/a.png", kind: "same", before: 100, after: 100 },
    ]);
  });
});
