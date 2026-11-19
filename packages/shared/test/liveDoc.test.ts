import { describe, expect, it } from "vitest";
import {
  applyLineEdit,
  blockLines,
  chunkText,
  joinLines,
  LIMITS,
  LIVE_BOUNDS,
  LIVE_DEFAULTS,
  LIVE_DOC,
  type LineRange,
  liveCheckpointInput,
  liveDiscardQuery,
  liveDocClientFrameSchema,
  liveDocServerFrameSchema,
  liveDocTooLarge,
  rangesOverlap,
  shiftRange,
  splitLines,
  utf8Length,
} from "../src/index.ts";

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("live doc constants", () => {
  it("names the fixed limits and the env-var defaults", () => {
    expect(LIMITS.liveDocFrameBytes).toBe(65536);
    expect(LIMITS.liveLeaseIdleS).toBe(60);
    expect(LIMITS.maxLiveDraftsPerOwner).toBe(20);
    expect(LIMITS.maxLiveDocLines).toBe(50_000);
    expect(LIMITS.maxDocBytes).toBe(1024 * 1024);
    expect(LIVE_DOC.textChunkBytes).toBe(256 * 1024);
    expect(LIVE_DOC.maxMergeEdits).toBe(5000);
    expect(LIVE_DEFAULTS).toEqual({
      checkpointIdleS: 120,
      autoCheckpointMinS: 600,
      draftFlushS: 5,
      draftRetentionDays: 30,
    });
    expect(LIVE_BOUNDS.checkpointIdleS).toEqual([30, 3600]);
    expect(LIVE_BOUNDS.draftFlushS).toEqual([2, 60]);
    expect(LIVE_BOUNDS.draftRetentionDays).toEqual([1, 365]);
  });
});

describe("lines", () => {
  it("split and join give the text back exactly", () => {
    for (const t of ["", "a", "a\n", "\n", "a\nb", "a\n\nb\n", "\n\n"]) {
      expect(joinLines(splitLines(t))).toBe(t);
    }
    expect(splitLines("a\nb\n")).toEqual(["a", "b", ""]);
  });

  it("a cleared block puts no lines in place of its range", () => {
    expect(blockLines("")).toEqual([]);
    expect(blockLines("one")).toEqual(["one"]);
    expect(blockLines("one\n")).toEqual(["one", ""]);
  });

  it("applyLineEdit replaces a range and leaves the input alone", () => {
    const lines = ["a", "b", "c", "d"];
    expect(applyLineEdit(lines, 1, 2, ["X"])).toEqual(["a", "X", "d"]);
    expect(applyLineEdit(lines, 4, 0, ["e"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(applyLineEdit(lines, 0, 4, [])).toEqual([]);
    expect(lines).toEqual(["a", "b", "c", "d"]);
  });
});

describe("leases", () => {
  it("overlap when they share a line, or an insert point sits inside, or two coincide", () => {
    const r = (start: number, end: number): LineRange => ({ start, end });
    expect(rangesOverlap(r(0, 3), r(2, 5))).toBe(true);
    expect(rangesOverlap(r(0, 3), r(3, 5))).toBe(false);
    expect(rangesOverlap(r(0, 3), r(1, 1))).toBe(true);
    expect(rangesOverlap(r(0, 3), r(0, 0))).toBe(false);
    expect(rangesOverlap(r(0, 3), r(3, 3))).toBe(false);
    expect(rangesOverlap(r(2, 2), r(2, 2))).toBe(true);
    expect(rangesOverlap(r(2, 2), r(3, 3))).toBe(false);
    // Symmetric.
    expect(rangesOverlap(r(1, 1), r(0, 3))).toBe(true);
  });

  it("shift: a lease at or after the edited range moves, one before it stays", () => {
    const e = { start: 4, del: 2, ins: 5 };
    expect(shiftRange({ start: 0, end: 4 }, e)).toEqual({ start: 0, end: 4 });
    expect(shiftRange({ start: 4, end: 4 }, e)).toEqual({ start: 4, end: 4 });
    expect(shiftRange({ start: 6, end: 6 }, e)).toEqual({ start: 9, end: 9 });
    expect(shiftRange({ start: 6, end: 8 }, e)).toEqual({ start: 9, end: 11 });
    // An insert lease filling in moves what follows it.
    expect(shiftRange({ start: 4, end: 6 }, { start: 4, del: 0, ins: 2 })).toEqual({
      start: 6,
      end: 8,
    });
  });

  it("property: after any edit, other leases still cover the same lines and stay disjoint", () => {
    const r = rng(3);
    for (let run = 0; run < 2000; run++) {
      const n = Math.floor(r() * 30);
      const lines = Array.from({ length: n }, (_, i) => `l${i}`);
      // Random disjoint leases, cut left to right.
      const leases: LineRange[] = [];
      let pos = 0;
      while (pos <= n && leases.length < 6) {
        pos += Math.floor(r() * 4);
        if (pos > n) break;
        const len = Math.min(Math.floor(r() * 4), n - pos);
        const l = { start: pos, end: pos + len };
        if (!leases.some((x) => rangesOverlap(x, l))) leases.push(l);
        pos += len + (len === 0 ? 1 : 0);
      }
      if (leases.length === 0) continue;
      for (let i = 0; i < leases.length; i++)
        for (let j = i + 1; j < leases.length; j++)
          expect(rangesOverlap(leases[i] as LineRange, leases[j] as LineRange)).toBe(false);
      const k = Math.floor(r() * leases.length);
      const held = leases[k] as LineRange;
      const ins = Array.from({ length: Math.floor(r() * 5) }, (_, i) => `new${run}.${i}`);
      const e = { start: held.start, del: held.end - held.start, ins: ins.length };
      const after = applyLineEdit(lines, e.start, e.del, ins);
      const moved = leases.map((l, i) =>
        i === k ? { start: e.start, end: e.start + ins.length } : shiftRange(l, e),
      );
      expect(after.slice(moved[k]?.start, moved[k]?.end)).toEqual(ins);
      for (let i = 0; i < leases.length; i++) {
        if (i === k) continue;
        const was = leases[i] as LineRange;
        const now = moved[i] as LineRange;
        expect(after.slice(now.start, now.end)).toEqual(lines.slice(was.start, was.end));
        expect(now.end - now.start).toBe(was.end - was.start);
      }
      for (let i = 0; i < moved.length; i++)
        for (let j = i + 1; j < moved.length; j++) {
          const a = moved[i] as LineRange;
          const b = moved[j] as LineRange;
          // Two empty leases may only meet when the held one became empty at the same point.
          if (a.start === a.end && b.start === b.end && (i === k || j === k)) continue;
          expect(rangesOverlap(a, b), JSON.stringify({ leases, k, ins, moved })).toBe(false);
        }
    }
  });
});

describe("caps", () => {
  it("a draft is too large past 1 MB of UTF-8 or 50,000 lines", () => {
    expect(liveDocTooLarge("")).toBe(false);
    expect(liveDocTooLarge("a".repeat(LIMITS.maxDocBytes))).toBe(false);
    expect(liveDocTooLarge("a".repeat(LIMITS.maxDocBytes + 1))).toBe(true);
    // Multi-byte characters count as bytes, not characters.
    expect(liveDocTooLarge("é".repeat(LIMITS.maxDocBytes / 2 + 1))).toBe(true);
    expect(liveDocTooLarge("\n".repeat(LIMITS.maxLiveDocLines - 1))).toBe(false);
    expect(liveDocTooLarge("\n".repeat(LIMITS.maxLiveDocLines))).toBe(true);
  });

  it("chunks text under the frame size and never inside a character", () => {
    const text = `${"a".repeat(10)}😀é${"b".repeat(7)}😀`;
    const parts = chunkText(text, 8);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      expect(utf8Length(p)).toBeLessThanOrEqual(8);
      // No lone surrogate at either end.
      expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p)).toBe(false);
    }
    expect(chunkText("")).toEqual([""]);
    const big = "x".repeat(LIMITS.maxDocBytes);
    const pieces = chunkText(big);
    expect(pieces).toHaveLength(4);
    expect(pieces.join("")).toBe(big);
  });
});

describe("doc socket schemas", () => {
  it("accepts each client frame and refuses malformed ones", () => {
    const ok = [
      { t: "lease", rev: 3, start: 2, end: 5 },
      { t: "lease", rev: 0, start: 4, end: 4 },
      { t: "edit", lease: "L1", seq: 1, text: "Hello" },
      { t: "release", lease: "L1" },
      { t: "takeover", lease: "L_2-x" },
      { t: "sync" },
    ];
    for (const f of ok)
      expect(liveDocClientFrameSchema.safeParse(f).success, JSON.stringify(f)).toBe(true);
    const bad: unknown[] = [
      null,
      "sync",
      [],
      {},
      { t: "nope" },
      { t: "lease", rev: 1, start: 5, end: 2 },
      { t: "lease", rev: -1, start: 0, end: 0 },
      { t: "lease", rev: 1.5, start: 0, end: 0 },
      { t: "lease", rev: 1, start: 0, end: LIMITS.maxLiveDocLines + 1 },
      { t: "edit", lease: "bad id!", seq: 1, text: "x" },
      { t: "edit", lease: "L1", seq: 1, text: 7 },
      { t: "edit", lease: "L1", seq: 1, text: "x".repeat(LIMITS.liveDocFrameBytes + 1) },
      { t: "release" },
      { t: "takeover", lease: "x".repeat(33) },
    ];
    for (const f of bad)
      expect(liveDocClientFrameSchema.safeParse(f).success, JSON.stringify(f)?.slice(0, 80)).toBe(
        false,
      );
  });

  it("fuzz: random values never parse as a frame by accident, and never throw", () => {
    const r = rng(11);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
    const values = [null, true, 0, -1, 1.5, "", "x", [], {}, "L1", 3, 2 ** 40];
    for (let i = 0; i < 3000; i++) {
      const f: Record<string, unknown> = {
        t: pick(["lease", "edit", "release", "takeover", "sync", "x", 1]),
      };
      for (const k of ["rev", "start", "end", "lease", "seq", "text"])
        if (r() < 0.6) f[k] = pick(values);
      const a = liveDocClientFrameSchema.safeParse(f);
      const b = liveDocServerFrameSchema.safeParse(f);
      if (a.success) {
        // Anything accepted satisfies the rules the room relies on.
        const v = a.data;
        if (v.t === "lease") expect(v.end).toBeGreaterThanOrEqual(v.start);
        if (v.t === "edit") expect(typeof v.text).toBe("string");
      }
      expect(typeof b.success).toBe("boolean");
    }
  });

  it("accepts the server frames the renderer handles", () => {
    const frames = [
      {
        t: "welcome",
        v: 1,
        you: { id: "s1", email: "a@example.com", right: "write" },
        gen: "g1",
        rev: 0,
        base_version: 1,
        flushed_rev: 0,
        conflict_version: null,
        last_by_you: false,
        leases: [{ id: "L1", start: 0, end: 2, by: "b@example.com" }],
        peers: [{ id: "s2", email: "b@example.com", lease: "L1" }],
      },
      { t: "text", gen: "g1", part: 0, of: 1, chunk: "# Hi" },
      { t: "leased", lease: "L2", start: 3, end: 3, holder: "s_1", by: "a@example.com" },
      { t: "lease_denied", reason: "held", by: "b@example.com" },
      { t: "lease_denied", reason: "frozen" },
      { t: "op", gen: "g1", rev: 1, lease: "L2", start: 3, del: 0, ins: "New", by: "s1", seq: 1 },
      { t: "released", lease: "L2" },
      { t: "lease_lost", lease: "L1", reason: "takeover" },
      { t: "flushed", rev: 1 },
      { t: "saved", version: 2, rev: 1 },
      { t: "reset", version: 3, gen: "g2", rev: 0 },
      { t: "rebased", version: 3, gen: "g2", rev: 2 },
      { t: "conflict", version: 3 },
      {
        t: "status",
        dirty: true,
        editors: ["a@example.com"],
        last_edit_at: null,
        last_by_you: true,
      },
      { t: "error", code: "draft_limit" },
    ];
    for (const f of frames) expect(liveDocServerFrameSchema.safeParse(f).success, f.t).toBe(true);
    expect(liveDocServerFrameSchema.safeParse({ t: "error", code: "boom" }).success).toBe(false);
    expect(liveDocServerFrameSchema.safeParse({ t: "op", gen: "g", rev: 0 }).success).toBe(false);
  });
});

describe("REST inputs", () => {
  it("checkpoint", () => {
    expect(liveCheckpointInput.safeParse({ base_version: 4, rev: 9, reason: "save" }).success).toBe(
      true,
    );
    expect(
      liveCheckpointInput.safeParse({ base_version: 4, rev: 9, reason: "idle", note: "n" }).success,
    ).toBe(true);
    // Publish mine names the version reviewed; the room publishes its own draft.
    expect(
      liveCheckpointInput.safeParse({
        base_version: 4,
        rev: 9,
        reason: "save",
        conflict_version: 6,
      }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { base_version: 0, rev: 1, reason: "save" },
      { base_version: 1, rev: -1, reason: "save" },
      { base_version: 1, rev: 1, reason: "later" },
      { base_version: 1, rev: 1, reason: "save", note: "x".repeat(LIMITS.maxNoteLength + 1) },
      // No draft text travels from the app any more.
      { base_version: 1, rev: 1, reason: "save", resolved_text: "# Mine", conflict_version: 2 },
      { base_version: 1, rev: 1, reason: "save", conflict_version: 0 },
    ])
      expect(liveCheckpointInput.safeParse(bad).success).toBe(false);
  });

  it("discard takes the revision from the query string", () => {
    expect(liveDiscardQuery.parse({ rev: "12" })).toEqual({ rev: 12 });
    expect(liveDiscardQuery.parse({ rev: "12", conflict_version: "6" })).toEqual({
      rev: 12,
      conflict_version: 6,
    });
    expect(liveDiscardQuery.safeParse({ rev: "1", conflict_version: "0" }).success).toBe(false);
    expect(liveDiscardQuery.safeParse({ rev: "-1" }).success).toBe(false);
    expect(liveDiscardQuery.safeParse({ rev: "1.5" }).success).toBe(false);
    expect(liveDiscardQuery.safeParse({}).success).toBe(false);
  });
});
