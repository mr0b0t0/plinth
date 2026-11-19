// The sequence diff and the file changes of change lists (moved from the web app's
// components/history/diff.test.ts with the code), and the bounded file summary.
import { describe, expect, it } from "vitest";
import {
  diffSequence,
  diffTextLines,
  FILE_SUMMARY_LIMITS,
  fileChanges,
  summarizeFileChanges,
  type TextDiffLine,
  textLines,
} from "../src/index.ts";

const kinds = (lines: TextDiffLine[]) =>
  lines.map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`);

/** Old and new text by applying `edit` to every `every`-th line of an n-line document. */
function bigDoc(n: number, every: number, edit: (line: string) => string) {
  const old = Array.from({ length: n }, (_, i) => `<div class="row-${i}">Row ${i}</div>`);
  const next = old.map((l, i) => (i % every === 0 ? edit(l) : l));
  return { old: old.join("\n"), next: next.join("\n") };
}

describe("textLines", () => {
  it("splits on every newline style and ignores a final newline", () => {
    expect(textLines("")).toEqual([]);
    expect(textLines("a")).toEqual(["a"]);
    expect(textLines("a\n")).toEqual(["a"]);
    expect(textLines("a\r\nb\rc\n\nd")).toEqual(["a", "b", "c", "", "d"]);
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

  it("falls back to one replaced block past the edit cap, still correct", () => {
    const d = diffTextLines("top\na\nb\nc\nbottom", "top\nx\ny\nz\nbottom", { maxEdits: 1 });
    expect(d.exact).toBe(false);
    expect(kinds(d.lines)).toEqual([" top", "-a", "-b", "-c", "+x", "+y", "+z", " bottom"]);
  });

  it("diffs a 5,000-line document with scattered edits exactly", () => {
    const { old, next } = bigDoc(5000, 50, (l) => l.replace("Row", "Line"));
    const d = diffTextLines(old, next);
    expect(d.exact).toBe(true);
    expect(d.added).toBe(100);
    expect(d.removed).toBe(100);
  });
});

describe("diffSequence", () => {
  it("returns the regions that differ, merging adjacent removals and additions", () => {
    expect(diffSequence(["a", "b", "c"], ["a", "c", "d"]).hunks).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
      { aStart: 3, aEnd: 3, bStart: 2, bEnd: 3 },
    ]);
    expect(diffSequence(["a", "b"], ["a", "x", "y"]).hunks).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 3 },
    ]);
    expect(diffSequence([], []).hunks).toEqual([]);
    expect(diffSequence(["a"], ["a"]).hunks).toEqual([]);
  });

  it("caps its work: past maxEdits the middle is one hunk", () => {
    const a = Array.from({ length: 400 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 400 }, (_, i) => `b${i}`);
    const d = diffSequence(["x", ...a, "y"], ["x", ...b, "y"], { maxEdits: 10 });
    expect(d).toEqual({ hunks: [{ aStart: 1, aEnd: 401, bStart: 1, bEnd: 401 }], exact: false });
  });
});

describe("fileChanges", () => {
  it("lists added, removed and replaced files, then unchanged ones", () => {
    const a = [
      { path: "img/a.png", size_bytes: 100, content_type: "image/png", sha256: null },
      { path: "style.css", size_bytes: 50, content_type: "text/css", sha256: null },
      { path: "old.js", size_bytes: 10, content_type: "text/javascript", sha256: null },
    ];
    const b = [
      { path: "img/a.png", size_bytes: 100, content_type: "image/png", sha256: null },
      { path: "style.css", size_bytes: 70, content_type: "text/css", sha256: null },
      { path: "new.js", size_bytes: 5, content_type: "text/javascript", sha256: null },
    ];
    expect(fileChanges(a, b)).toEqual([
      { path: "new.js", kind: "added", after: 5 },
      { path: "old.js", kind: "removed", before: 10 },
      { path: "style.css", kind: "replaced", before: 50, after: 70 },
      { path: "img/a.png", kind: "same", before: 100, after: 100 },
    ]);
  });

  it("compares sha256 when both sides have it, and sizes otherwise", () => {
    const h = (c: string) => c.repeat(64);
    const a = [
      { path: "same-size.js", size_bytes: 10, sha256: h("a") },
      { path: "same-hash.js", size_bytes: 10, sha256: h("b") },
      { path: "legacy.css", size_bytes: 10, sha256: null },
    ];
    const b = [
      // Same size, other bytes: only the hash can tell.
      { path: "same-size.js", size_bytes: 10, sha256: h("c") },
      { path: "same-hash.js", size_bytes: 10, sha256: h("b") },
      // One side stored before hashes: sizes decide.
      { path: "legacy.css", size_bytes: 10, sha256: h("d") },
    ];
    expect(fileChanges(a, b)).toEqual([
      { path: "same-size.js", kind: "replaced", before: 10, after: 10 },
      { path: "legacy.css", kind: "same", before: 10, after: 10 },
      { path: "same-hash.js", kind: "same", before: 10, after: 10 },
    ]);
  });
});

describe("summarizeFileChanges", () => {
  // UTF-8 length; the shared package's types have no TextEncoder.
  const utf8 = (s: string) =>
    Array.from(s).reduce((n, ch) => {
      const c = ch.codePointAt(0) as number;
      return n + (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);
    }, 0);

  it("lists each kind in order and counts the rest", () => {
    const changes = fileChanges(
      [
        { path: "a.png", size_bytes: 1, sha256: null },
        { path: "b.png", size_bytes: 1, sha256: null },
        { path: "keep.png", size_bytes: 1, sha256: null },
      ],
      [
        { path: "a.png", size_bytes: 2, sha256: null },
        { path: "c.png", size_bytes: 3, sha256: null },
        { path: "keep.png", size_bytes: 1, sha256: null },
      ],
    );
    expect(summarizeFileChanges(changes)).toEqual({
      added: [{ path: "c.png", kind: "added", after: 3 }],
      removed: [{ path: "b.png", kind: "removed", before: 1 }],
      replaced: [{ path: "a.png", kind: "replaced", before: 1, after: 2 }],
      more: 0,
      same: 1,
    });
  });

  it("stops at maxPaths per kind", () => {
    const after = Array.from({ length: 80 }, (_, i) => ({
      path: `f${i}.png`,
      size_bytes: 1,
      sha256: null,
    }));
    const s = summarizeFileChanges(fileChanges([], after));
    expect(s.added).toHaveLength(FILE_SUMMARY_LIMITS.maxPaths);
    expect(s.more).toBe(80 - FILE_SUMMARY_LIMITS.maxPaths);
  });

  it("stays under 16 KB as JSON for 300 changed files with the longest, widest paths", () => {
    // 200 characters is the longest asset path; each of these takes four bytes in UTF-8.
    const long = (i: number, tag: string) => `${tag}${i}/`.padEnd(200, "😀").slice(0, 200);
    const before = Array.from({ length: 200 }, (_, i) => ({
      path: long(i, i < 100 ? "gone" : "swap"),
      size_bytes: 1_000_000_000 + i,
      sha256: "a".repeat(64),
    }));
    const after = [
      ...Array.from({ length: 100 }, (_, i) => ({
        path: long(i, "new"),
        size_bytes: 999_999_999,
        sha256: "b".repeat(64),
      })),
      ...before.slice(100).map((f) => ({ ...f, sha256: "c".repeat(64) })),
    ];
    const changes = fileChanges(before, after);
    expect(changes.filter((c) => c.kind !== "same")).toHaveLength(300);
    const s = summarizeFileChanges(changes);
    const json = JSON.stringify(s);
    expect(utf8(json)).toBeLessThanOrEqual(FILE_SUMMARY_LIMITS.maxBytes);
    // As one socket frame with its envelope, too.
    expect(utf8(JSON.stringify({ t: "conflict", version: 6, files: s }))).toBeLessThan(16 * 1024);
    expect(s.added.length + s.removed.length + s.replaced.length + s.more).toBe(300);
    expect(s.more).toBeGreaterThan(0);
  });

  it("shortens a path past maxPathChars around an ellipsis", () => {
    const path = `${"a".repeat(150)}/${"b".repeat(150)}.png`;
    const s = summarizeFileChanges(fileChanges([], [{ path, size_bytes: 1, sha256: null }]), {
      maxPathChars: 21,
    });
    expect(s.added[0]?.path).toBe("aaaaaaaaaa…bbbbbb.png");
  });
});
