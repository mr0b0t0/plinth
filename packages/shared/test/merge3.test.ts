import { describe, expect, it } from "vitest";
import { diffLines, LIVE_DOC, merge3 } from "../src/index.ts";

const L = (...lines: string[]) => lines.join("\n");

/** Apply a diff's hunks to `a` and check it gives `b`. */
function applyDiff(a: string[], b: string[], hunks: NonNullable<ReturnType<typeof diffLines>>) {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks.hunks) {
    out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  out.push(...a.slice(pos));
  return out;
}

/** A small deterministic PRNG (mulberry32), so property runs are reproducible. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("diffLines", () => {
  it("finds a minimal diff that turns one text into the other", () => {
    const a = ["a", "b", "c", "a", "b", "b", "a"];
    const b = ["c", "b", "a", "b", "a", "c"];
    const d = diffLines(a, b);
    expect(d).not.toBeNull();
    // Myers' classic example: the shortest edit script has 5 edits.
    expect(d?.edits).toBe(5);
    expect(applyDiff(a, b, d as NonNullable<typeof d>)).toEqual(b);
  });

  it("returns no hunks for equal texts and one hunk for a full replacement", () => {
    expect(diffLines(["x", "y"], ["x", "y"])?.hunks).toEqual([]);
    expect(diffLines([], [])?.hunks).toEqual([]);
    expect(diffLines(["a"], ["b"])?.hunks).toEqual([{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 }]);
    expect(diffLines([], ["a", "b"])?.hunks).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
  });

  it("gives hunks that never touch, and reproduces the target on random inputs", () => {
    const r = rng(7);
    for (let run = 0; run < 300; run++) {
      const n = Math.floor(r() * 30);
      const a = Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(r() * 4)));
      const b = Array.from({ length: Math.floor(r() * 30) }, () =>
        String.fromCharCode(97 + Math.floor(r() * 4)),
      );
      const d = diffLines(a, b);
      expect(d).not.toBeNull();
      const diff = d as NonNullable<typeof d>;
      expect(applyDiff(a, b, diff)).toEqual(b);
      for (let i = 1; i < diff.hunks.length; i++) {
        const p = diff.hunks[i - 1] as (typeof diff.hunks)[number];
        const h = diff.hunks[i] as (typeof diff.hunks)[number];
        expect(h.aStart).toBeGreaterThan(p.aEnd);
        expect(h.bStart).toBeGreaterThan(p.bEnd);
      }
      // A line edit count never exceeds deleting everything and inserting everything.
      expect(diff.edits).toBeLessThanOrEqual(a.length + b.length);
    }
  });

  it("bails out past maxEdits", () => {
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 79)).toBeNull();
    expect(diffLines(a, b, 80)?.edits).toBe(80);
  });

  it("costs work in proportion to the text when the change is small (no clock)", () => {
    const doc = (n: number, changed: number) =>
      Array.from({ length: n }, (_, i) => (i === changed ? "changed" : `line ${i}`));
    const small = diffLines(doc(2000, 1000), doc(2000, -1));
    const large = diffLines(doc(20000, 10000), doc(20000, -1));
    // One line replaced: one deleted, one inserted.
    expect(small?.edits).toBe(2);
    expect(large?.edits).toBe(2);
    // Ten times the lines, about ten times the work: linear, not quadratic.
    expect((large?.work ?? 0) / (small?.work ?? 1)).toBeLessThan(12);
  });

  it("costs work bounded by N times D, so the 5,000-edit cap bounds the worst case", () => {
    const words = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const d1 = diffLines(words(1000, "a"), words(1000, "b"), 100_000);
    const d2 = diffLines(words(2000, "a"), words(2000, "b"), 100_000);
    expect(d1?.edits).toBe(2000);
    expect(d2?.edits).toBe(4000);
    // Both N and D double: at most about four times the work.
    expect((d2?.work ?? 0) / (d1?.work ?? 1)).toBeLessThan(4.5);
    // With the default cap, the second never runs to completion.
    expect(diffLines(words(3000, "a"), words(3000, "b"))).toBeNull();
  });
});

describe("merge3", () => {
  const base = L("# Title", "", "One.", "", "Two.", "", "Three.", "");

  it("takes a change made on one side only", () => {
    const ours = L("# Title", "", "One, edited.", "", "Two.", "", "Three.", "");
    expect(merge3(base, ours, base)).toMatchObject({ clean: true, text: ours });
    expect(merge3(base, base, ours)).toMatchObject({ clean: true, text: ours });
  });

  it("combines changes on both sides that do not touch", () => {
    const ours = L("# Title", "", "One, by the page.", "", "Two.", "", "Three.", "");
    const theirs = L("# Title", "", "One.", "", "Two.", "", "Three, by the agent.", "");
    expect(merge3(base, ours, theirs)).toEqual({
      clean: true,
      text: L("# Title", "", "One, by the page.", "", "Two.", "", "Three, by the agent.", ""),
      work: expect.any(Number),
    });
  });

  it("takes the same change made on both sides once", () => {
    const both = L("# Title", "", "One.", "", "Two, fixed.", "", "Three.", "");
    expect(merge3(base, both, both)).toMatchObject({ clean: true, text: both });
    // The same paragraph changed identically, plus a separate change on one side.
    const ours = L("# Title", "", "One, page.", "", "Two, fixed.", "", "Three.", "");
    expect(merge3(base, ours, both)).toMatchObject({ clean: true, text: ours });
  });

  it("is a conflict when both sides change the same lines differently", () => {
    const ours = L("# Title", "", "One.", "", "Two, page.", "", "Three.", "");
    const theirs = L("# Title", "", "One.", "", "Two, agent.", "", "Three.", "");
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(false);
    if (r.clean) return;
    expect(r.reason).toBe("conflict");
    expect(r.conflicts).toEqual([
      { baseStart: 4, baseEnd: 5, ours: ["Two, page."], theirs: ["Two, agent."] },
    ]);
  });

  it("is a conflict when the changes are on adjacent lines", () => {
    const b = L("a", "b", "c", "d");
    const r = merge3(b, L("a", "B", "c", "d"), L("a", "b", "C", "d"));
    expect(r).toMatchObject({ clean: false, reason: "conflict" });
  });

  it("is a conflict when one side inserts at the edge of the other's change", () => {
    const b = L("a", "b", "c");
    // Theirs replaces b; ours inserts right after b.
    expect(merge3(b, L("a", "b", "new", "c"), L("a", "B", "c"))).toMatchObject({
      clean: false,
      reason: "conflict",
    });
    // Two different inserts at the same point.
    expect(merge3(b, L("a", "x", "b", "c"), L("a", "y", "b", "c"))).toMatchObject({
      clean: false,
      reason: "conflict",
    });
    // The same insert at the same point is taken once.
    expect(merge3(b, L("a", "x", "b", "c"), L("a", "x", "b", "c"))).toMatchObject({
      clean: true,
      text: L("a", "x", "b", "c"),
    });
  });

  it("with rows, merges changes that only touch, but not two inserts at the same place", () => {
    const b = L("h", "r1", "r2", "r3");
    // Adjacent rows changed on each side: both kept.
    expect(merge3(b, L("h", "R1", "r2", "r3"), L("h", "r1", "R2", "r3"), { rows: true })).toEqual({
      clean: true,
      text: L("h", "R1", "R2", "r3"),
      work: expect.any(Number),
    });
    // A row inserted beside a row the other side changed.
    expect(
      merge3(b, L("h", "r1", "new", "r2", "r3"), L("h", "R1", "r2", "r3"), { rows: true }),
    ).toMatchObject({ clean: true, text: L("h", "R1", "new", "r2", "r3") });
    // A row deleted beside a row the other side changed.
    expect(merge3(b, L("h", "r1", "r3"), L("h", "r1", "r2", "R3"), { rows: true })).toMatchObject({
      clean: true,
      text: L("h", "r1", "R3"),
    });
    // Rows appended on both sides, different: a conflict, so nothing is guessed.
    expect(merge3(b, L(b, "x"), L(b, "y"), { rows: true })).toMatchObject({
      clean: false,
      reason: "conflict",
    });
    // The same row changed on both sides differently: a conflict, as for text.
    expect(
      merge3(b, L("h", "A", "r2", "r3"), L("h", "B", "r2", "r3"), { rows: true }),
    ).toMatchObject({ clean: false, reason: "conflict" });
    // Without rows, adjacent changes stay a conflict.
    expect(merge3(b, L("h", "R1", "r2", "r3"), L("h", "r1", "R2", "r3"))).toMatchObject({
      clean: false,
    });
  });

  it("handles empty texts", () => {
    expect(merge3("", "", "")).toMatchObject({ clean: true, text: "" });
    expect(merge3("", "new", "")).toMatchObject({ clean: true, text: "new" });
    expect(merge3("", "", "new")).toMatchObject({ clean: true, text: "new" });
    expect(merge3("", "a", "b")).toMatchObject({ clean: false, reason: "conflict" });
    expect(merge3("gone", "", "gone")).toMatchObject({ clean: true, text: "" });
  });

  it("treats a trailing newline as a line", () => {
    const b = L("a", "b", "c", "d", "e");
    // Ours adds a trailing newline; theirs edits the first line.
    expect(merge3(b, `${b}\n`, L("A", "b", "c", "d", "e"))).toMatchObject({
      clean: true,
      text: `${L("A", "b", "c", "d", "e")}\n`,
    });
    // Both remove it the same way.
    expect(merge3(`${b}\n`, b, b)).toMatchObject({ clean: true, text: b });
    // A trailing-newline change touching an edit of the last line is a conflict.
    expect(merge3(b, `${b}\n`, L("a", "b", "c", "d", "E"))).toMatchObject({ clean: false });
  });

  it("is too_large when a diff has more than 5,000 edits", () => {
    const n = LIVE_DOC.maxMergeEdits; // replacing n lines is 2n edits
    const lines = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join("\n");
    const b = lines("base");
    const r = merge3(b, lines("ours"), `${b}\nx`);
    expect(r).toMatchObject({ clean: false, reason: "too_large", conflicts: [] });
    // A small diff on the same large text still merges.
    expect(merge3(b, `x\n${b}`, `${b}\ny`)).toMatchObject({ clean: true, text: `x\n${b}\ny` });
  });

  it.each([
    ["text", false],
    ["rows", true],
  ])(
    "never drops text (%s): every line either side added or kept is in a clean merge",
    (_, rows) => {
      const r = rng(42);
      let clean = 0;
      for (let run = 0; run < 500; run++) {
        const n = 1 + Math.floor(r() * 25);
        const b = Array.from({ length: n }, (_, i) => `b${i}`);
        let uid = 0;
        const edit = (side: string) => {
          const out: string[] = [];
          const deleted = new Set<string>();
          const added: string[] = [];
          for (const line of b) {
            const p = r();
            if (p < 0.1) {
              deleted.add(line);
            } else if (p < 0.2) {
              deleted.add(line);
              const l = `${side}${uid++}`;
              out.push(l);
              added.push(l);
            } else out.push(line);
            if (r() < 0.08) {
              const l = `${side}${uid++}`;
              out.push(l);
              added.push(l);
            }
          }
          return { text: out.join("\n"), deleted, added };
        };
        const o = edit("o");
        const t = edit("t");
        const m = merge3(b.join("\n"), o.text, t.text, { rows });
        if (!m.clean) {
          if (m.reason === "conflict") expect(m.conflicts.length).toBeGreaterThan(0);
          continue;
        }
        clean++;
        const result = m.text.split("\n");
        const has = new Set(result);
        // Everything added on either side is there, exactly once.
        for (const l of [...o.added, ...t.added]) {
          expect(has.has(l), `${l} in ${m.text}`).toBe(true);
          expect(result.filter((x) => x === l)).toHaveLength(1);
        }
        // A base line both sides kept is still there; one either side deleted is gone.
        for (const l of b) {
          const kept = !o.deleted.has(l) && !t.deleted.has(l);
          expect(has.has(l), `${l} in ${m.text}`).toBe(kept);
        }
        // Lines keep their order relative to each side.
        const order = (side: string[]) => side.filter((l) => has.has(l));
        const idx = new Map(result.map((l, i) => [l, i]));
        for (const side of [o.text.split("\n"), t.text.split("\n")]) {
          const kept = order(side).map((l) => idx.get(l) as number);
          expect([...kept].sort((x, y) => x - y)).toEqual(kept);
        }
      }
      // The generator exercises both outcomes.
      expect(clean).toBeGreaterThan(50);
      expect(clean).toBeLessThan(500);
    },
  );
});
