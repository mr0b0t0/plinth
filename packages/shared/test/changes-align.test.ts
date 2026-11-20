// Pairing inside a changed region by what blocks say (alignRegion): content words, an
// order-keeping alignment by likeness, and the fallback past its limits. Never by place alone.
import { describe, expect, it } from "vitest";
import {
  alignRegion,
  CHANGE_LIMITS,
  type ChangeItem,
  contentWords,
  describeChanges,
  SIMILARITY_MIN,
  STOPWORDS,
  similarity,
} from "../src/index.ts";

const items = (type: Parameters<typeof describeChanges>[0], a: string, b: string) =>
  describeChanges(type, a, b).items;

// The old paragraph and the one inserted next to it share only function words ("the", "for",
// "this", "what", "will"); the edit keeps the old one's content words.
const OLD = "The forecast for this quarter";
const INSERTED = "This is the plan for the team";
const EDITED = "The forecast for this quarter, revised";

describe("content words", () => {
  it("are lowercased NFKC letters and digits of three or more, without function words", () => {
    expect([...contentWords("The ＦＯＲＥＣＡＳＴ for this Q3 quarter: 2026 & ok, café")]).toEqual([
      "forecast",
      "quarter",
      "2026",
      "café",
    ]);
    expect(STOPWORDS.size).toBe(50);
    for (const w of STOPWORDS) expect([...w].length).toBeGreaterThanOrEqual(3);
  });

  it("cut text written without spaces into pairs of characters", () => {
    expect([...contentWords("价格表")]).toEqual(["价格", "格表"]);
    expect(similarity("今年的价格表", "明年的价格表")).toBeGreaterThanOrEqual(SIMILARITY_MIN);
  });

  it("make two texts alike by Jaccard overlap, and function words alone make nothing alike", () => {
    expect(similarity(OLD, INSERTED)).toBe(0);
    expect(similarity(OLD, EDITED)).toBeCloseTo(2 / 3);
    expect(similarity("Quarterly revenue", "Revenue fell")).toBeCloseTo(1 / 3);
    // No content words on either side: all their words are compared.
    expect(similarity("A · B / 1 · 2", "A · B / 1 · 3")).toBeCloseTo(3 / 5);
  });
});

describe("an insertion next to an edit that shares only function words with it", () => {
  const expected = (where: string, insertedFirst: boolean): ChangeItem[] => {
    const added: ChangeItem = { kind: "added", where, what: "Text added", after: INSERTED };
    const changed: ChangeItem = {
      kind: "changed",
      where,
      what: "Text changed",
      before: OLD,
      after: EDITED,
    };
    return insertedFirst ? [added, changed] : [changed, added];
  };
  const page = (...ps: string[]) => `<h1>T</h1>${ps.map((p) => `<p>${p}</p>`).join("")}`;
  const board = (...ps: string[]) => `<!-- artboard name="Home" size="iphone" -->\n${page(...ps)}`;

  it("lists the insertion as added and the edit as changed, on a page", () => {
    expect(items("html", page(OLD), page(INSERTED, EDITED))).toEqual(expected("Under “T”", true));
    expect(items("html", page(OLD), page(EDITED, INSERTED))).toEqual(expected("Under “T”", false));
  });

  it("lists the insertion as added and the edit as changed, on a board", () => {
    expect(items("design", board(OLD), board(INSERTED, EDITED))).toEqual(
      expected("Board “Home”, under “T”", true),
    );
    expect(items("design", board(OLD), board(EDITED, INSERTED))).toEqual(
      expected("Board “Home”, under “T”", false),
    );
  });

  it("lists the insertion as added and the edit as changed, in a doc", () => {
    const doc = (...ps: string[]) => ["# T", ...ps].join("\n\n");
    expect(items("doc", doc(OLD), doc(INSERTED, EDITED))).toEqual([
      { kind: "added", where: "Under “T”", what: "Paragraph added", after: INSERTED },
      {
        kind: "changed",
        where: "Under “T”",
        what: "Paragraph changed",
        before: OLD,
        after: EDITED,
      },
    ]);
    const list = (...ps: string[]) => ps.map((p) => `- ${p}`).join("\n");
    expect(items("doc", list(OLD), list(INSERTED, EDITED))).toEqual([
      { kind: "added", where: "", what: "List item added", after: INSERTED },
      { kind: "changed", where: "", what: "List item changed", before: OLD, after: EDITED },
    ]);
  });

  it("lists the slide inserted as added and the edited one as changed, in a deck", () => {
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    const old = "# Forecast\n\nWhat this quarter will bring";
    const inserted = "# Team plan\n\nWhat this team will do";
    const edited = "# Forecast\n\nWhat this quarter will bring, revised";
    const changed: ChangeItem = {
      kind: "changed",
      where: "Slide 2",
      what: "Text changed",
      before: "What this quarter will bring",
      after: "What this quarter will bring, revised",
    };
    expect(items("slides", deck(old), deck(inserted, edited))).toEqual([
      { kind: "added", where: "", what: "Slide 1 “Team plan” added" },
      changed,
    ]);
    expect(items("slides", deck(old), deck(edited, inserted))).toEqual([
      { ...changed, where: "Slide 1" },
      { kind: "added", where: "", what: "Slide 2 “Team plan” added" },
    ]);
  });
});

describe("an edit in place", () => {
  it("pairs as changed when it keeps a content word", () => {
    expect(items("html", "<p>Quarterly revenue</p>", "<p>Revenue fell</p>")).toEqual([
      {
        kind: "changed",
        where: "",
        what: "Text changed",
        before: "Quarterly revenue",
        after: "Revenue fell",
      },
    ]);
  });

  it("reads as removed and added when it shares no content word", () => {
    expect(items("html", "<p>Quarterly revenue</p>", "<p>Office move</p>")).toEqual([
      { kind: "removed", where: "", what: "Text removed", before: "Quarterly revenue" },
      { kind: "added", where: "", what: "Text added", after: "Office move" },
    ]);
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    expect(
      items("slides", deck("# Intro", "# Revenue\n\nUp"), deck("# Intro", "# Office\n\nMoved")),
    ).toEqual([
      { kind: "removed", where: "", what: "Slide 2 “Revenue” removed" },
      { kind: "added", where: "", what: "Slide 2 “Office” added" },
    ]);
  });
});

describe("a block moved to another place, unchanged", () => {
  // Cut from the top and pasted near the bottom, under another heading. A page or a doc has no
  // moves: the block is removed at its old place and added at its new one, each listed where a
  // person finds it. It is never "changed" against the block that took its place. A deck's block
  // is a slide, which moves.
  const MOVED = "The harbour lighthouse keeper logs every passing ship";
  const rest = [
    "Orchard soils hold the spring rain",
    "River ferries cross at dawn",
    "Mountain passes close in winter",
    "Desert wells run dry by August",
  ];
  const removedAdded = (what: string) => [
    { kind: "removed", where: "Under “Atlas”", what: `${what} removed`, before: MOVED },
    { kind: "added", where: "Under “Appendix”", what: `${what} added`, after: MOVED },
  ];

  it("is removed at the old place and added at the new one, on a page", () => {
    const page = (top: boolean) =>
      [
        "<h1>Atlas</h1>",
        top ? `<p>${MOVED}</p>` : "",
        `<p>${rest[0]}</p><p>${rest[1]}</p>`,
        "<h2>Appendix</h2>",
        `<p>${rest[2]}</p>`,
        top ? "" : `<p>${MOVED}</p>`,
        `<p>${rest[3]}</p>`,
      ].join("\n");
    expect(items("html", page(true), page(false))).toEqual(removedAdded("Text"));
  });

  it("is removed at the old place and added at the new one, in a doc", () => {
    const doc = (top: boolean) =>
      [
        "# Atlas",
        ...(top ? [MOVED] : []),
        rest[0],
        rest[1],
        "## Appendix",
        rest[2],
        ...(top ? [] : [MOVED]),
        rest[3],
      ].join("\n\n");
    expect(items("doc", doc(true), doc(false))).toEqual(removedAdded("Paragraph"));
  });

  it("is listed once as moved when it is a slide, in a deck", () => {
    const titled: [string, string][] = [
      ["Harbour", MOVED],
      ["Orchards", rest[0] as string],
      ["Ferries", rest[1] as string],
      ["Passes", rest[2] as string],
      ["Wells", rest[3] as string],
    ];
    const deck = (order: number[]) =>
      order.map((k) => `# ${titled[k]?.[0]}\n\n${titled[k]?.[1]}`).join("\n\n---\n\n");
    expect(items("slides", deck([0, 1, 2, 3, 4]), deck([1, 2, 3, 0, 4]))).toEqual([
      { kind: "moved", where: "“Harbour”", what: "Slide 1 moved to 4" },
    ]);
  });

  it("changes the two slides it left and joined, each against itself, in a deck", () => {
    const deck = (top: boolean) =>
      [
        `# Harbour\n\n${top ? `${MOVED}\n\n` : ""}Boats wait for the tide`,
        `# Orchards\n\n${rest[0]}`,
        `# Ferries\n\n${rest[1]}`,
        `# Passes\n\n${rest[2]}${top ? "" : `\n\n${MOVED}`}`,
        `# Wells\n\n${rest[3]}`,
      ].join("\n\n---\n\n");
    expect(items("slides", deck(true), deck(false))).toEqual([
      {
        kind: "changed",
        where: "Slide 1",
        what: "Text changed",
        before: `${MOVED} Boats wait for the tide`,
        after: "Boats wait for the tide",
      },
      {
        kind: "changed",
        where: "Slide 4",
        what: "Text changed",
        before: rest[2],
        after: `${rest[2]} ${MOVED}`,
      },
    ]);
  });
});

describe("alignRegion", () => {
  const key = (x: string) => x;
  const text = (x: string) => x;

  it("keeps order, and pairs the most alike blocks overall", () => {
    const p = alignRegion(
      ["Alpha report", "Beta summary"],
      ["New gamma", "Alpha report draft", "Beta summary draft"],
      { key, text },
    );
    expect(p).toEqual({
      pairs: [
        ["Alpha report", "Alpha report draft"],
        ["Beta summary", "Beta summary draft"],
      ],
      removed: [],
      added: ["New gamma"],
      aligned: true,
    });
  });

  it("chooses between equally alike pairs by all their words, short ones included", () => {
    const p = alignRegion(["Row 3 ok", "Row 4 ok"], ["Row 3 edited"], { key, text });
    expect(p.pairs).toEqual([["Row 3 ok", "Row 3 edited"]]);
    expect(p.removed).toEqual(["Row 4 ok"]);
  });

  it("pairs the earlier block when two are as alike in every way", () => {
    const p = alignRegion(["Alpha line"], ["Beta line", "Gamma line"], { key, text });
    expect(p.pairs).toEqual([["Alpha line", "Beta line"]]);
    expect(p.added).toEqual(["Gamma line"]);
  });

  it("pairs only compatible blocks, except equal keys", () => {
    const p = alignRegion(["#Revenue"], ["Revenue up"], {
      key,
      text: (x) => x.replace("#", ""),
      compatible: (x, y) => x.startsWith("#") === y.startsWith("#"),
    });
    expect(p.pairs).toEqual([]);
  });

  it("matches equal keys only past alignCells, and never pairs by position", () => {
    const n = 201;
    expect(n * (n - 1)).toBeGreaterThan(CHANGE_LIMITS.alignCells);
    const a = Array.from({ length: n }, (_, k) => `Report ${k} first`);
    const b = Array.from({ length: n - 1 }, (_, k) => `Report ${k} second`);
    b[100] = a[150] as string;
    const p = alignRegion(a, b, { key, text });
    expect(p.aligned).toBe(false);
    expect(p.pairs).toEqual([[a[150], a[150]]]);
    expect(p.removed).toHaveLength(n - 1);
    expect(p.added).toHaveLength(n - 2);
    // At the limit it still aligns by likeness.
    const q = alignRegion(a.slice(0, 200), b.slice(0, 200), { key, text });
    expect(q.aligned).toBe(true);
    expect(q.pairs).toHaveLength(200);
  });

  it("matches equal keys only past alignWork", () => {
    const long = (k: number) =>
      `${Array.from({ length: 2000 }, (_, w) => `word${w}`).join(" ")} tail${k}`;
    const a = Array.from({ length: 50 }, (_, k) => long(k));
    expect(50 * 50 * 2001).toBeGreaterThan(CHANGE_LIMITS.alignWork);
    const b = a.map((x) => `${x} more`);
    const p = alignRegion(a, b, { key, text });
    expect(p.aligned).toBe(false);
    expect(p.pairs).toEqual([]);
  });

  it("counts the word sets it compares, so text without spaces is bounded too", () => {
    // Paragraphs of Chinese with no punctuation: one word each, but thousands of character pairs,
    // and those are what it compares.
    let seed = 7;
    const han = (len: number) =>
      Array.from({ length: len }, () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return String.fromCodePoint(0x4e00 + (seed % 20000));
      }).join("");
    const a = Array.from({ length: 200 }, () => han(3000));
    const b = Array.from({ length: 200 }, () => han(3000));
    // Counted by words, this was 40,000 comparisons of one word and took seconds; counted by the
    // character pairs compared, it passes alignWork and matches equal keys only.
    const p = alignRegion(a, b, { key, text });
    expect(p.aligned).toBe(false);
    // A region whose comparisons stay within alignWork still aligns.
    const edited = (x: string) => `${x.slice(0, 1500)}${han(1)}${x.slice(1500)}`;
    const q = alignRegion(a.slice(0, 20), a.slice(0, 20).map(edited), { key, text });
    expect(q.aligned).toBe(true);
    expect(q.pairs).toHaveLength(20);
  });

  it("pairs two slides with no words at all, so an image slide pairs with itself", () => {
    expect(similarity("", "")).toBe(0);
    expect(similarity("", "Hello there")).toBe(0);
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    const slides = (image: string, notes: string) =>
      deck("# Intro\n\nHello world there", `![](${image})\n\nNote: ${notes}`, "# End");
    expect(
      items("slides", slides("photo.png", "old notes here"), slides("photo.png", "new notes text")),
    ).toEqual([
      {
        kind: "changed",
        where: "Slide 2",
        what: "Speaker notes changed",
        before: "old notes here",
        after: "new notes text",
      },
    ]);
    expect(
      items(
        "slides",
        slides("photo.png", "old notes here"),
        slides("other.png", "old notes here"),
      ).map((i) => [i.kind, i.where]),
    ).toEqual([
      ["removed", "Slide 2"],
      ["added", "Slide 2"],
    ]);
  });

  it("pairs blocks with no words only when the caller says so, and below any real pair", () => {
    expect(alignRegion(["★★★"], ["→"], { key, text })).toMatchObject({
      pairs: [],
      removed: ["★★★"],
      added: ["→"],
    });
    // With `wordless`, two blocks with no words pair, but a pair that shares words outweighs them.
    expect(
      alignRegion(["★", "Pricing starts at ten"], ["Pricing starts at twelve", "→"], {
        key,
        text,
        wordless: true,
      }).pairs,
    ).toEqual([["Pricing starts at ten", "Pricing starts at twelve"]]);
    // Even a pair exactly at the least likeness that pairs at all: 3 shared of 10 words.
    const low = [
      "alpha beta gamma delta epsilon zeta",
      "alpha beta gamma theta iota kappa lambda",
    ] as const;
    expect(similarity(low[0], low[1])).toBe(SIMILARITY_MIN);
    expect(alignRegion(["★", low[0]], [low[1], "→"], { key, text, wordless: true }).pairs).toEqual([
      [low[0], low[1]],
    ]);
    expect(alignRegion(["★"], ["→"], { key, text, wordless: true }).pairs).toEqual([["★", "→"]]);
  });

  it("never pairs text of only symbols by where it is, on a page, in a doc or in a deck", () => {
    const pricing = (price: string) =>
      `Pricing starts at ${price} dollars monthly for every team member`;
    const changed = {
      kind: "changed",
      before: pricing("ten"),
      after: pricing("twelve"),
    };
    const doc = (...ps: string[]) => ["# Plans", ...ps, "Contact us"].join("\n\n");
    expect(
      items("doc", doc("🎉🎉🎉", pricing("ten")), doc(pricing("twelve"), "👉")).map((i) => [
        i.kind,
        i.before ?? i.after,
      ]),
    ).toEqual([
      ["removed", "🎉🎉🎉"],
      ["changed", pricing("ten")],
      ["added", "👉"],
    ]);
    const page = (...ps: string[]) =>
      ["Intro words here", ...ps, "End"].map((p) => `<p>${p}</p>`).join("");
    expect(items("html", page("★★★", pricing("ten")), page(pricing("twelve"), "→"))).toEqual([
      { kind: "removed", where: "", what: "Text removed", before: "★★★" },
      { ...changed, where: "", what: "Text changed" },
      { kind: "added", where: "", what: "Text added", after: "→" },
    ]);
    const deck = (...slides: string[]) => ["# Intro", ...slides, "# End"].join("\n\n---\n\n");
    expect(
      items("slides", deck("![](a.png)", pricing("ten")), deck(pricing("twelve"), "![](b.png)")),
    ).toEqual([
      { kind: "removed", where: "", what: "Slide 2 removed" },
      { ...changed, where: "Slide 2", what: "Text changed" },
      { kind: "added", where: "", what: "Slide 3 added" },
    ]);
  });

  it("shares one alignWork budget between the regions of one change list", () => {
    const budget = { left: 10_000 };
    // A region past what is left falls back, and charges only the cells it looked at.
    const long = (k: number) => Array.from({ length: 200 }, (_, w) => `big${k}w${w}`).join(" ");
    const big = alignRegion(
      Array.from({ length: 20 }, (_, k) => long(k)),
      Array.from({ length: 20 }, (_, k) => `${long(k)} more`),
      { key, text, budget },
    );
    expect(big.aligned).toBe(false);
    expect(budget.left).toBeGreaterThan(9_000);
    // A small region still aligns, and spends the budget.
    const small = alignRegion(["Alpha report"], ["Alpha report draft"], { key, text, budget });
    expect(small.aligned).toBe(true);
    const left = budget.left;
    expect(left).toBeLessThan(10_000);
    budget.left = 0;
    expect(
      alignRegion(["Alpha report"], ["Alpha report draft"], { key, text, budget }).aligned,
    ).toBe(false);
  });

  it("aligns a later region by keys only once earlier regions spent the budget", () => {
    // Two regions of 50 paragraphs of 500 words, each edited: one region costs about 2,500,000
    // (50 × 50 cells, each comparing 500 content words and 500 words for the tie), so the second
    // finds less than that left and lists its paragraphs as removed and added.
    const n = 50;
    const para = (r: number, k: number) =>
      Array.from({ length: 500 }, (_, w) => `r${r}p${k}w${w}`).join(" ");
    const region = (r: number, edit: string) =>
      Array.from({ length: n }, (_, k) => `${para(r, k)}${edit}`);
    const doc = (edit: string) =>
      ["# Report", ...region(1, edit), "Middle part", ...region(2, edit)].join("\n\n");
    expect(n * n * 1001).toBeLessThan(CHANGE_LIMITS.alignWork);
    expect(2 * n * n * 1001).toBeGreaterThan(CHANGE_LIMITS.alignWork);
    const list = items("doc", doc(""), doc(" revised"));
    const kinds = (from: number, to: number) => [
      ...new Set(list.slice(from, to).map((i) => i.kind)),
    ];
    expect(list).toHaveLength(3 * n);
    expect(kinds(0, n)).toEqual(["changed"]);
    expect(kinds(n, 3 * n).sort()).toEqual(["added", "removed"]);
  });

  it("uses the fallback for a region of more than alignCells in a change list", () => {
    const page = (word: string, n: number) =>
      Array.from({ length: n }, (_, k) => `<p>Report ${k} ${word}</p>`).join("");
    const over = describeChanges("html", page("first", 201), page("second", 200));
    expect(over.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(over.items.some((i) => i.kind === "changed")).toBe(false);
    const at = describeChanges("html", page("first", 200), page("second", 200));
    expect(at.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(at.items.every((i) => i.kind === "changed")).toBe(true);
    expect(at.items[7]).toMatchObject({ before: "Report 7 first", after: "Report 7 second" });
  });

  it("aligns a region of exactly alignCells, and falls back at one cell more", () => {
    expect(200 * 200).toBe(CHANGE_LIMITS.alignCells);
    expect(221 * 181).toBe(CHANGE_LIMITS.alignCells + 1);
    const region = (n: number, word: string) =>
      Array.from({ length: n }, (_, k) => `Report ${k} ${word}`);
    const key = (x: string) => x;
    const at = alignRegion(region(200, "first"), region(200, "second"), { key, text: key });
    expect(at.aligned).toBe(true);
    expect(at.pairs).toHaveLength(200);
    expect(at.pairs[7]).toEqual(["Report 7 first", "Report 7 second"]);
    const over = alignRegion(region(221, "first"), region(181, "second"), { key, text: key });
    expect(over.aligned).toBe(false);
    expect(over.pairs).toEqual([]);
    expect(over.removed).toHaveLength(221);
    expect(over.added).toHaveLength(181);
    // And on a page: 200 paragraphs edited pair as changed; 221 replaced by 181 are only removed
    // and added, never paired by place.
    const page = (n: number, word: string) =>
      region(n, word)
        .map((p) => `<p>${p}</p>`)
        .join("");
    const pageAt = describeChanges("html", page(200, "first"), page(200, "second"));
    expect(pageAt.items.every((i) => i.kind === "changed")).toBe(true);
    const pageOver = describeChanges("html", page(221, "first"), page(181, "second"));
    expect(pageOver.items.some((i) => i.kind === "changed")).toBe(false);
    expect(pageOver.items.slice(0, 2)).toEqual([
      { kind: "removed", where: "", what: "Text removed", before: "Report 0 first" },
      { kind: "removed", where: "", what: "Text removed", before: "Report 1 first" },
    ]);
  });

  it("aligns the costliest region at alignCells within alignWork", () => {
    // 200 × 200 blocks of 49 content words, 45 of them shared by all, so every cell is compared
    // and every pair is alike: each cell costs 1 + 49 + 49, and the region 3,960,000 of 4,000,000.
    const shared = Array.from({ length: 45 }, (_, w) => `common${w}`);
    const block = (k: number, word: string) =>
      [...shared, `block${k}`, `${word}${k}`, `${word}x${k}`, `${word}y${k}`].join(" ");
    const a = Array.from({ length: 200 }, (_, k) => block(k, "old"));
    const b = Array.from({ length: 200 }, (_, k) => block(k, "new"));
    expect(contentWords(a[0] as string).size).toBe(49);
    const budget = { left: CHANGE_LIMITS.alignWork };
    const key = (x: string) => x;
    const p = alignRegion(a, b, { key, text: key, budget });
    expect(p.aligned).toBe(true);
    expect(CHANGE_LIMITS.alignWork - budget.left).toBe(200 * 200 * (1 + 49 + 49));
    // Each block pairs with its own edit: "block7" is what tells them apart.
    expect(p.pairs[7]).toEqual([a[7], b[7]]);
  });

  it("stays fast on a deck of many same-titled slides", () => {
    const slides = Array.from({ length: 200 }, (_, k) => `# Same\n\nText ${k}`);
    const t = Date.now();
    const list = describeChanges(
      "slides",
      slides.join("\n\n---\n\n"),
      slides.map((s) => `${s}, edited`).join("\n\n---\n\n"),
    );
    expect(Date.now() - t).toBeLessThan(200);
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(list.items.every((i) => i.kind === "changed")).toBe(true);
    expect(list.items[42]).toMatchObject({ where: "Slide 43", before: "Text 42" });
  });
});
