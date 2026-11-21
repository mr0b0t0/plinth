// Editing a deck on its page (slides-text, docs/spec.md "Slides"): deckLayout and the parseDeck
// built on it, the room's structure rule (rules 1 to 5 and the HTML-document rule), deckKeeps,
// how the renderer empties a block, the structure-escaping serializer and the struct ops
// add_notes, remove_notes, set_deck and trim_start with their touches and postconditions.
import { describe, expect, it } from "vitest";
import {
  applySlidesStruct,
  deckEmptying,
  deckKeeps,
  deckLayout,
  editLineSources,
  escapeDeckPart,
  frontMatterEnd,
  type LineRange,
  liveRules,
  mapRange,
  notesFormOf,
  notesText,
  parseDeck,
  type RichBlock,
  type SlidesStructOp,
  serializeDeckBlock,
  serializeNotes,
  slidesTouches,
  structOverlaps,
} from "../src/index.ts";
import { parseDeck as legacyParseDeck } from "./legacySlides.ts";

const maybeRules = liveRules("slides");
if (!maybeRules) throw new Error("no slides rules");
const rules = maybeRules;
const check = (lines: string[], start: number, del: number, ins: string[]) =>
  rules.checkEdit(lines, start, del, ins);

/** A small deterministic random source. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = [
  "---",
  "---  ",
  "",
  "",
  "",
  "# Title",
  "## Section",
  "Some text",
  "more text",
  "- a point",
  "1. first",
  "|||",
  "Note: say this",
  "Notes:",
  "\\Note: kept",
  "```",
  "```js",
  "~~~",
  "aspect: 4:3",
  "Date: 3 March",
  "footer: Q4",
  "theme: dark",
  "    indented",
  "> quoted",
  "![chart](chart.png)",
  "***",
];

function randomDeck(r: () => number, max = 24): string[] {
  const n = Math.floor(r() * max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(VOCAB[Math.floor(r() * VOCAB.length)] as string);
  return out.length ? out : [""];
}

const FIXTURES = [
  "# Untitled deck\n",
  "---\naspect: 16:9\nfooter: Q4 review\n---\n\n# Q4 review\n\nRevenue, hiring and what comes next\n\nNote: Welcome everyone.\n\n---\n\n## Revenue\n\n- Up 18% on Q3\n- Two new enterprise accounts\n\n![Revenue by month](chart.png)\n\nNote: The September dip was a billing change.\n\n---\n\n## Hiring\n\n|||\n\nLeft\n\n|||\n\nRight\n",
  "---\n\n# Intro\n\n---\n\n# Next",
  "# Intro\n---\naspect: 4:3\n---\n# Next",
  "## A\n````md\n---\n```\n---\n````\n---\n## B\n~~~\n---\n~~~\n",
  "---\n\n# A\n---\n\n---\n## B\n---\n\n",
  "# A\n|||\nx\n|||\ny\n|||\nz\n|||\nw\n|||\n",
  "# A\r\n---\r\n## B\r\n",
  "# A\n\nNote: n\n|||\n---\n# B\nNotes:\nNote: inside\n|||\n",
];

/** The structure a deck shows: every line's kind, front matter's end, the raw slide count. */
function structure(lines: string[]) {
  const l = deckLayout(lines);
  return { kinds: l.kinds, fm: l.frontMatterEnd, raw: l.slides.length };
}

describe("deckLayout and parseDeck", () => {
  it("parses every fixture and a random corpus exactly as the parser before it did", () => {
    const r = rng(1);
    const decks = [...FIXTURES];
    for (let i = 0; i < 3000; i++) decks.push(randomDeck(r).join("\n"));
    for (const d of decks) expect(parseDeck(d), JSON.stringify(d)).toEqual(legacyParseDeck(d));
  });

  it("lists empty slides at the edges as raw slides, with each part's range", () => {
    const lines = "---\n\n# A\nNote: n\n---\n|||\nx\n---".split("\n");
    const l = deckLayout(lines);
    expect(l.frontMatterEnd).toBe(-1);
    expect(l.kinds).toEqual([
      "separator",
      "text",
      "text",
      "note",
      "separator",
      "column",
      "text",
      "separator",
    ]);
    expect(l.slides.map((s) => [s.start, s.end])).toEqual([
      [0, 0],
      [1, 4],
      [5, 7],
      [8, 8],
    ]);
    expect(l.slides[1]?.notes).toEqual({ start: 3, end: 4 });
    expect(l.slides[2]?.head).toEqual({ start: 5, end: 5 });
    expect(l.slides[2]?.columns).toEqual([{ start: 6, end: 7 }]);
    expect(parseDeck(lines.join("\n")).slides).toHaveLength(2);
  });

  it("reads front matter kinds, and nothing structural inside fences or after notes", () => {
    const l = deckLayout(["---", "aspect: 4:3", "---", "```", "---", "```", "Note: a", "|||"]);
    expect(l.kinds).toEqual([
      "fm_open",
      "setting",
      "fm_close",
      "text",
      "text",
      "text",
      "note",
      "text",
    ]);
  });

  it("extracts notes text from both marker forms", () => {
    expect(notesText(["Note: Welcome everyone.", "", "More"])).toBe("Welcome everyone.\n\nMore");
    expect(notesText(["Notes:", "  Alone", ""])).toBe("Alone");
    expect(notesText(["Note:\t x"])).toBe("x");
  });
});

describe("the slides structure rule", () => {
  const NEW_DECK = ["# Untitled deck", ""];

  it("accepts emptying the New deck's only title, which then cannot be published", () => {
    expect(check(NEW_DECK, 0, 1, [])).toBeNull();
    expect(rules.unpublishable("")).toBe("empty");
    expect(rules.unpublishable("# Untitled deck\n")).toBeNull();
    expect(rules.valid("")).toBe(true);
  });

  it("accepts emptying the last slide, and slide 1 of a deck without front matter", () => {
    const deck = ["# A", "", "---", "", "# B", ""];
    expect(check(deck, 4, 1, [])).toBeNull();
    expect(check(deck, 0, 1, [])).toBeNull();
  });

  it("accepts a text edit inside one part (the skill deck's 18% to 14%)", () => {
    const deck = FIXTURES[1]?.split("\n") as string[];
    expect(deck[15]).toBe("- Up 18% on Q3");
    expect(check(deck, 15, 2, ["- Up 14% on Q3", "- Two new enterprise accounts"])).toBeNull();
    // Typing a bullet that reads "---" sends `- \---`; a forged `---` line is refused.
    expect(check(deck, 15, 1, ["- \\---"])).toBeNull();
    expect(check(deck, 15, 1, ["---"])).toBe("invalid");
  });

  it("refuses a ---, a ||| or a Note: line put in a head", () => {
    const deck = ["# A", "text", "", "---", "# B"];
    for (const bad of ["---", "|||", "Note: x", "Notes:"]) {
      expect(check(deck, 1, 1, ["text", bad]), bad).toBe("invalid");
    }
    expect(check(deck, 1, 1, ["\\Note: x", "\\|||", "\\---"])).toBeNull();
  });

  it("refuses an unclosed fence, alone or with a ---", () => {
    const deck = ["# A", "text", "", "---", "# B"];
    expect(check(deck, 1, 1, ["```"])).toBe("invalid");
    expect(check(deck, 1, 1, ["```", "---"])).toBe("invalid");
    expect(check(deck, 1, 1, ["```", "---", "```"])).toBeNull();
  });

  it("refuses notes without their marker, and keeps the marker form either way", () => {
    const deck = FIXTURES[1]?.split("\n") as string[];
    expect(deck[9]).toBe("Note: Welcome everyone.");
    expect(check(deck, 9, 1, ["Note: Welcome, everyone."])).toBeNull();
    expect(check(deck, 9, 1, ["Notes:", "Welcome, everyone.", "Note: more"])).toBeNull();
    expect(check(deck, 9, 1, ["Welcome, everyone."])).toBe("invalid");
    expect(check(deck, 9, 1, [])).toBe("invalid");
    expect(check(deck, 9, 1, ["Note: a", "---"])).toBe("invalid");
  });

  it("refuses an edit that touches the front matter, or spans two parts", () => {
    const deck = FIXTURES[1]?.split("\n") as string[];
    expect(check(deck, 1, 1, ["aspect: 4:3"])).toBe("invalid");
    expect(check(deck, 3, 0, ["x"])).toBe("invalid");
    expect(check(deck, 4, 0, ["x"])).toBeNull();
    // Slide 1's head into its notes, and slide 1 into slide 2.
    expect(check(deck, 7, 3, ["x"])).toBe("invalid");
    expect(check(deck, 10, 3, ["x"])).toBe("invalid");
  });

  it("escapes a setting-like line in the slide after a bare opening ---, and refuses it forged", () => {
    const deck = ["---", "# Intro", "---", "# Next"];
    const typed = serializeDeckBlock(
      { t: "paragraph", c: [{ k: "text", text: "Date: 3 March", m: {} }] },
      { notes: false, settings: true },
    );
    expect(typed).toEqual(["Date\\: 3 March"]);
    expect(check(deck, 1, 1, typed)).toBeNull();
    const after = ["---", ...typed, "---", "# Next"];
    const parsed = parseDeck(after.join("\n"));
    expect(parsed.slides).toHaveLength(2);
    expect(parsed.problems).toEqual([]);
    for (const forged of ["Date: 3 March", "aspect: 4:3", "footer: x"]) {
      expect(check(deck, 1, 1, [forged]), forged).toBe("invalid");
    }
  });

  it("refuses a result that starts like an HTML document, and lines holding a CR", () => {
    expect(check(["# A"], 0, 1, ["<html> basics"])).toBe("invalid");
    expect(check(["# A"], 0, 1, ["  <!DOCTYPE html>"])).toBe("invalid");
    expect(check(["# A"], 0, 1, ["\\<html> basics"])).toBeNull();
    expect(rules.valid("<html><body>")).toBe(false);
    expect(check(["# A", "b"], 1, 1, ["x\r---"])).toBe("invalid");
    expect(rules.toLive("# A\r\n---\r# B")).toBe("# A\n---\n# B");
    expect(rules.toLive("# A\n")).toBe("# A\n");
  });

  it("never lets an accepted edit change the structure outside it (random decks and edits)", () => {
    const r = rng(7);
    let accepted = 0;
    for (let i = 0; i < 6000; i++) {
      const lines = randomDeck(r);
      const start = Math.floor(r() * (lines.length + 1));
      const del = Math.floor(r() * Math.min(3, lines.length - start + 1));
      const ins = randomDeck(r, 4);
      if (check(lines, start, del, ins) !== null) continue;
      accepted++;
      const next = [...lines.slice(0, start), ...ins, ...lines.slice(start + del)];
      const from = editLineSources(lines.length, start, del, ins.length);
      expect(deckKeeps(lines, next, from)).toBe(true);
      const a = structure(lines);
      const b = structure(next);
      expect(b.fm).toBe(a.fm);
      expect(b.raw).toBe(a.raw);
      for (let j = 0; j < next.length; j++) {
        const k = from[j] as number;
        if (k >= 0) expect(b.kinds[j]).toBe(a.kinds[k]);
      }
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it("refuses a hand-built edit that changes a later line's kind", () => {
    // Opening a fence that a later fence line closes would make the separator between them text.
    const deck = ["# A", "x", "---", "```", "y"];
    expect(check(deck, 1, 1, ["```"])).toBe("invalid");
    const next = ["# A", "```", "---", "```", "y"];
    expect(deckKeeps(deck, next, editLineSources(5, 1, 1, 1))).toBe(false);
  });
});

describe("deckKeeps", () => {
  it("checks line kinds, the front matter byte for byte and where it ends", () => {
    const deck = ["---", "aspect: 4:3", "---", "# A"];
    expect(deckKeeps(deck, [...deck], [0, 1, 2, 3])).toBe(true);
    const fm = ["---", "aspect: 16:9", "---", "# A"];
    expect(deckKeeps(deck, fm, [0, -1, 2, 3])).toBe(false);
    expect(deckKeeps(deck, fm, [0, -1, 2, 3], "set_deck")).toBe(true);
    expect(deckKeeps(["# A", "---", "# B"], ["# A", "# B"], [0, 2])).toBe(true);
    expect(deckKeeps(["# A", "---", "# B"], ["# A", "x", "# B"], [0, 1, 2])).toBe(false);
  });
});

describe("emptying a block", () => {
  /** Empties [start, start + del) as the renderer does, and returns the lines, or null. */
  function empty(lines: string[], start: number, del: number): string[] | null {
    let at = { start, end: start + del };
    let cur = lines;
    for (let round = 0; round < 2; round++) {
      const plan = deckEmptying(cur, at.start, at.end - at.start);
      if (plan === null) return null;
      if (plan === "trim") {
        const r = applySlidesStruct(cur, { op: "trim_start" });
        if (!r) return null;
        const moved = mapRange(at, r.map, cur.length, r.lines.length);
        if (!moved) return null;
        at = moved;
        cur = r.lines;
        continue;
      }
      expect(check(cur, at.start, at.end - at.start, plan.ins)).toBeNull();
      return [...cur.slice(0, at.start), ...plan.ins, ...cur.slice(at.end)];
    }
    return null;
  }

  it("trims a bare opening --- first, then sends zero lines", () => {
    const deck = ["---", "", "# Intro", "", "---", "", "# Next"];
    expect(deckEmptying(deck, 2, 1)).toBe("trim");
    const out = empty(deck, 2, 1);
    expect(out).toEqual(["", "", "---", "", "# Next"]);
    expect(frontMatterEnd(out as string[])).toBe(-1);
    expect(parseDeck((out as string[]).join("\n")).slides).toHaveLength(1);
  });

  it("sends one blank line above an agent's setting-like line", () => {
    const deck = ["# Intro", "---", "aspect: 4:3", "---", "# Next"];
    expect(deckEmptying(deck, 0, 1)).toEqual({ ins: [" "] });
    const out = empty(deck, 0, 1) as string[];
    expect(parseDeck(out.join("\n")).settings).toEqual(parseDeck(deck.join("\n")).settings);
    expect(structure(out).kinds.slice(1)).toEqual(structure(deck).kinds.slice(1));
  });

  it("keeps two text lines apart", () => {
    expect(deckEmptying(["a", "# H", "b"], 1, 1)).toEqual({ ins: [" "] });
    expect(deckEmptying(["a", "", "# H", "", "b"], 2, 1)).toEqual({ ins: [] });
  });

  it("is always accepted on random decks, for every run of text lines in a part", () => {
    const r = rng(11);
    let tried = 0;
    for (let i = 0; i < 2000; i++) {
      const lines = randomDeck(r);
      const l = deckLayout(lines);
      for (const s of l.slides) {
        for (const part of [s.head, ...s.columns]) {
          let a = part.start;
          while (a < part.end) {
            if ((lines[a] ?? "").trim() === "" || l.fenced[a]) {
              a++;
              continue;
            }
            let b = a;
            while (b < part.end && (lines[b] ?? "").trim() !== "" && !l.fenced[b]) b++;
            tried++;
            const out = empty(lines, a, b - a);
            expect(out, JSON.stringify({ lines, a, b })).not.toBeNull();
            a = b;
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(1000);
  });
});

const para = (text: string): RichBlock => ({ t: "paragraph", c: [{ k: "text", text, m: {} }] });

describe("slidesSerialize", () => {
  it("escapes deck structure per part", () => {
    const body = { notes: false, settings: false };
    const notes = { notes: true, settings: false };
    expect(escapeDeckPart(["---", "Note: x", "Notes: y", "|||", "text"], body)).toEqual([
      "----",
      "\\Note: x",
      "\\Notes: y",
      "\\|||",
      "text",
    ]);
    expect(escapeDeckPart(["---", "Note: x", "|||"], notes)).toEqual(["----", "Note: x", "|||"]);
    expect(escapeDeckPart(["```", "---", "Note: x", "```"], body)).toEqual([
      "```",
      "---",
      "Note: x",
      "```",
    ]);
    expect(escapeDeckPart(["Date: 3 March", "- x: y"], { notes: false, settings: true })).toEqual([
      "Date\\: 3 March",
      "- x: y",
    ]);
  });

  it("writes text that reads as structure so that it stays text", () => {
    const body = { notes: false, settings: false };
    expect(serializeDeckBlock(para("---"), body)).toEqual(["\\---"]);
    expect(serializeDeckBlock(para("Note: hi"), body)).toEqual(["\\Note: hi"]);
    expect(serializeDeckBlock(para("|||"), body)).toEqual(["\\|\\|\\|"]);
    expect(serializeDeckBlock(para("<html> basics"), body)).toEqual(["\\<html> basics"]);
    const setext: RichBlock = {
      t: "heading",
      level: 2,
      setext: true,
      c: [{ k: "text", text: "Title", m: {} }],
    };
    expect(serializeDeckBlock(setext, body)).toEqual(["Title", "----"]);
    expect(serializeDeckBlock(para(""), body)).toEqual([]);
  });

  it("keeps a typed block as text wherever it goes in a head (random texts)", () => {
    const r = rng(3);
    const bits = ["---", "Note:", "Notes: x", "|||", "```", "~~~", "Date: 3", "# h", "- l", "x"];
    const deck = ["# A", "", "old", "", "---", "# B", "", "Note: n"];
    for (let i = 0; i < 2000; i++) {
      const text = Array.from(
        { length: 1 + Math.floor(r() * 4) },
        () => bits[Math.floor(r() * bits.length)],
      ).join(r() < 0.5 ? "\n" : " ");
      const lines = serializeDeckBlock(para(text), { notes: false, settings: false });
      expect(check(deck, 2, 1, lines), JSON.stringify(text)).toBeNull();
    }
  });

  it("writes notes in both marker forms, with Note and Notes", () => {
    const blocks = [para("Welcome everyone."), para("Second.")];
    expect(serializeNotes(blocks, { word: "Note", inline: true })).toEqual([
      "Note: Welcome everyone.",
      "",
      "Second.",
    ]);
    expect(serializeNotes(blocks, { word: "Notes", inline: false })).toEqual([
      "Notes:",
      "Welcome everyone.",
      "",
      "Second.",
    ]);
    expect(serializeNotes([], { word: "Note", inline: true })).toEqual(["Note:"]);
    const code: RichBlock = { t: "code", fence: "```", info: "", text: "---\nNote: x\n" };
    expect(serializeNotes([code], { word: "Note", inline: true })).toEqual([
      "Note:",
      "```",
      "---",
      "Note: x",
      "```",
    ]);
    expect(notesFormOf("Notes: x")).toEqual({ word: "Notes", inline: true });
    expect(notesFormOf("Note:")).toEqual({ word: "Note", inline: false });
  });

  it("keeps notes that hold Note:, ||| and --- lines as one notes part", () => {
    const deck = FIXTURES[1]?.split("\n") as string[];
    const lines = serializeNotes([para("Note: again\n|||\n---")], { word: "Note", inline: true });
    // No deck escape in notes: `|` is Markdown's own (a table cell), `\---` keeps the text a line.
    expect(lines).toEqual(["Note: Note: again", "\\|\\|\\|", "\\---"]);
    expect(check(deck, 9, 1, lines)).toBeNull();
    const next = [...deck.slice(0, 9), ...lines, ...deck.slice(10)];
    expect(parseDeck(next.join("\n")).slides[0]?.notes).toBe("Note: again\n\\|\\|\\|\n\\---");
    // A notes line `Note:` or `|||` an agent wrote stays text there.
    expect(check(deck, 9, 1, ["Note: a", "Note: b", "|||"])).toBeNull();
  });
});

describe("slidesStruct", () => {
  const SKILL = FIXTURES[1]?.split("\n") as string[];

  /** Applies an op and checks its postcondition by hand. */
  function apply(lines: string[], op: SlidesStructOp) {
    const r = applySlidesStruct(lines, op);
    if (!r) return null;
    expect(rules.valid(r.lines.join("\n"))).toBe(true);
    return r;
  }

  it("adds and removes notes", () => {
    const deck = ["# A", "", "text", "", "---", "# B"];
    const added = apply(deck, { op: "add_notes", n: 1 });
    expect(added?.lines).toEqual(["# A", "", "text", "", "Note:", "", "---", "# B"]);
    expect(added?.map).toEqual([0, 1, 2, 5, 6, 7]);
    expect(apply(added?.lines as string[], { op: "add_notes", n: 1 })).toBeNull();
    const removed = apply(added?.lines as string[], { op: "remove_notes", n: 1 });
    expect(removed?.lines).toEqual(["# A", "", "text", "", "---", "# B"]);
    expect(apply(deck, { op: "remove_notes", n: 2 })).toBeNull();
    expect(apply(deck, { op: "add_notes", n: 3 })).toBeNull();
    const notes = apply(SKILL, { op: "remove_notes", n: 1 });
    expect(parseDeck(notes?.lines.join("\n") as string).slides[0]?.notes).toBe("");
  });

  it("writes the deck settings canonically, and keeps unknown keys", () => {
    const deck = ["# A"];
    const set = (lines: string[], s: Partial<Extract<SlidesStructOp, { op: "set_deck" }>>) =>
      apply(lines, {
        op: "set_deck",
        aspect: "16:9",
        theme: "auto",
        paginate: true,
        footer: "",
        ...s,
      });
    const made = set(deck, { aspect: "4:3", footer: "  Q4 review " });
    expect(made?.lines).toEqual(["---", "aspect: 4:3", "footer: Q4 review", "---", "# A"]);
    expect(parseDeck(made?.lines.join("\n") as string).settings).toMatchObject({
      aspect: "4:3",
      footer: "Q4 review",
    });
    expect(set(made?.lines as string[], {})?.lines).toEqual(["# A"]);
    const unknown = ["---", "aspect: 4:3", "author: Ana", "---", "# A"];
    expect(set(unknown, { theme: "dark" })?.lines).toEqual([
      "---",
      "theme: dark",
      "author: Ana",
      "---",
      "# A",
    ]);
    expect(set(unknown, {})?.lines).toEqual(["---", "author: Ana", "---", "# A"]);
    expect(set(deck, { footer: "a\nb" })).toBeNull();
    expect(set(deck, { footer: "x".repeat(121) })).toBeNull();
    // Removing the front matter above a `Date: x` slide leaves it as text.
    const date = ["---", "aspect: 4:3", "---", "---", "Date: x", "---", "# B"];
    const plain = set(date, {});
    expect(plain?.lines).toEqual(["Date: x", "---", "# B"]);
    expect(frontMatterEnd(plain?.lines as string[])).toBe(-1);
  });

  it("trims a bare opening --- and refuses to run otherwise", () => {
    expect(apply(["---", "# A"], { op: "trim_start" })?.lines).toEqual(["# A"]);
    expect(apply(["---", "---", "a: b", "---", "# X"], { op: "trim_start" })?.lines).toEqual([
      "a: b",
      "---",
      "# X",
    ]);
    expect(apply(["# A", "---"], { op: "trim_start" })).toBeNull();
    expect(apply(["---", "aspect: 4:3", "---", "# A"], { op: "trim_start" })).toBeNull();
  });

  it("never changes frontMatterEnd or leaves a bare --- at line 0 (random decks)", () => {
    const r = rng(5);
    const ops = (n: number): SlidesStructOp[] => [
      { op: "add_notes", n },
      { op: "remove_notes", n },
      { op: "trim_start" },
    ];
    for (let i = 0; i < 3000; i++) {
      const lines = randomDeck(r);
      const before = deckLayout(lines);
      const n = 1 + Math.floor(r() * before.slides.length);
      for (const op of ops(n)) {
        const res = applySlidesStruct(lines, op);
        if (!res) continue;
        const after = deckLayout(res.lines);
        if (before.frontMatterEnd > 0) expect(after.frontMatterEnd).toBe(before.frontMatterEnd);
        else expect(after.frontMatterEnd).toBe(-1);
        expect(/^---[ \t]*$/.test(res.lines[0] ?? "") && after.frontMatterEnd === -1).toBe(false);
      }
    }
  });

  it("lists every removed line and insertion point in touches (random decks)", () => {
    const r = rng(9);
    for (let i = 0; i < 2000; i++) {
      const lines = randomDeck(r);
      const n = 1 + Math.floor(r() * deckLayout(lines).slides.length);
      for (const op of [
        { op: "add_notes", n },
        { op: "remove_notes", n },
        { op: "trim_start" },
      ] as SlidesStructOp[]) {
        const res = applySlidesStruct(lines, op);
        if (!res) continue;
        const touched = slidesTouches(lines, op) as LineRange[];
        for (let k = 0; k < lines.length; k++) {
          if (res.map[k] !== -1) continue;
          expect(touched.some((t) => t.start <= k && k < t.end)).toBe(true);
        }
        // Every inserted line sits right after a kept line the touches name as a point.
        const kept = new Set(res.map.filter((j) => j >= 0));
        for (let j = 0; j < res.lines.length; j++) {
          if (kept.has(j)) continue;
          let prev = -1;
          for (let k = 0; k < res.map.length; k++) {
            if ((res.map[k] as number) >= 0 && (res.map[k] as number) < j) prev = k;
          }
          expect(touched.some((t) => t.start === prev + 1 && t.end === prev + 1)).toBe(true);
        }
      }
    }
  });

  it("names line 0 in touches when the deck has front matter", () => {
    const t = slidesTouches(SKILL, { op: "add_notes", n: 3 });
    expect(t).toContainEqual({ start: 0, end: 1 });
    expect(slidesTouches(["# A", "", "---", "# B"], { op: "add_notes", n: 2 })).not.toContainEqual({
      start: 0,
      end: 1,
    });
  });

  it("collides with leases by the overlap rule, and lets leases elsewhere move by the map", () => {
    // A removed range and an insert point at either of its ends; an insertion point inside a
    // block, and at an insert point.
    expect(structOverlaps({ start: 2, end: 4 }, { start: 4, end: 4 })).toBe(true);
    expect(structOverlaps({ start: 2, end: 4 }, { start: 2, end: 2 })).toBe(true);
    expect(structOverlaps({ start: 2, end: 4 }, { start: 4, end: 6 })).toBe(false);
    expect(structOverlaps({ start: 3, end: 3 }, { start: 2, end: 5 })).toBe(true);
    expect(structOverlaps({ start: 2, end: 2 }, { start: 2, end: 5 })).toBe(false);
    expect(structOverlaps({ start: 5, end: 5 }, { start: 2, end: 5 })).toBe(false);
    expect(structOverlaps({ start: 2, end: 2 }, { start: 2, end: 2 })).toBe(true);
    // trim_start is held while an insert point sits next to the line it removes.
    const deck = ["---", "# A"];
    const t = slidesTouches(deck, { op: "trim_start" }) as LineRange[];
    expect(t.some((r) => structOverlaps(r, { start: 1, end: 1 }))).toBe(true);
    // Adding notes to slide 2 of the New deck while someone holds slide 1's title.
    const two = ["# Untitled deck", "", "---", "# B"];
    const touched = slidesTouches(two, { op: "add_notes", n: 2 }) as LineRange[];
    expect(touched.some((r) => structOverlaps(r, { start: 0, end: 1 }))).toBe(false);
    const res = applySlidesStruct(two, { op: "add_notes", n: 2 });
    expect(mapRange({ start: 0, end: 1 }, res?.map as number[], 4, 6)).toEqual({
      start: 0,
      end: 1,
    });
  });

  it("is refused by the room's rules for an op that would leave an HTML document start", () => {
    const struct = rules.struct;
    expect(struct?.kinds).toEqual(["add_notes", "remove_notes", "set_deck", "trim_start"]);
    expect(struct?.apply(["---", "<html>"], { op: "trim_start" })).toEqual({ error: "invalid" });
    expect(struct?.touches(["# A"], { op: "remove_notes", n: 1 })).toEqual([]);
  });
});
