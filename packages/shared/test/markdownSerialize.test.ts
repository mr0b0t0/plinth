// The formatted-text model and its serializer (doc-blocks): every block kind round trips in both
// dialects, the escaping keeps text as text (a leading `<` included), and random models read back
// as themselves. markdown-it is a test-only dependency here; the doc renderer passes its own
// instances, and apps/web holds the golden fidelity lists over the doc's corpus.
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import {
  applyMark,
  blockFromSource,
  COMMONMARK_DIALECT,
  DOC_DIALECT,
  editableBlock,
  HTML_DOCUMENT_RE,
  type MarkdownDialect,
  type MarkdownTools,
  type MdEnv,
  normalizeBlock,
  type RecordableMarkdown,
  type RichBlock,
  type RichInline,
  type RichMarks,
  rangeHasMark,
  recordSources,
  sameBlock,
  serializeBlock,
  splitInline,
  verifyBlock,
} from "../src/index.ts";

function tools(d: MarkdownDialect): MarkdownTools {
  const opts = { html: false, linkify: d.linkify, typographer: false, breaks: false };
  const make = () => {
    const md = d.gfm ? new MarkdownIt(opts) : new MarkdownIt("commonmark", opts);
    if (!d.gfm) md.disable(["table", "strikethrough"], true);
    return md;
  };
  const source = make();
  recordSources(source as unknown as RecordableMarkdown);
  const render = make();
  return {
    source: source as unknown as MarkdownTools["source"],
    render: render as unknown as MarkdownTools["render"],
    dialect: d,
  };
}

const DOC = tools(DOC_DIALECT);
const CM = tools(COMMONMARK_DIALECT);
const ENV: MdEnv = {};

const text = (t: string, m: RichMarks = {}) => ({ k: "text" as const, text: t, m });
const para = (...c: RichInline): RichBlock => ({ t: "paragraph", c });

/** Parses, serializes and parses again: the model must come back, and render the same. */
function roundTrip(md: string, t = DOC) {
  const model = editableBlock(md, t, ENV);
  expect(model, `not editable: ${JSON.stringify(md)}`).not.toBeNull();
  const out = serializeBlock(model as RichBlock, t.dialect);
  const again = blockFromSource(out, t.source, ENV);
  expect(again && sameBlock(model as RichBlock, again), `${md} -> ${out}`).toBe(true);
  return out;
}

describe("every block kind round trips", () => {
  const both: string[] = [
    'Plain *em* and **strong** and `code` and [a link](https://example.com "Title").',
    "Line one\nline two, soft\\\nand hard",
    "# Heading one",
    "### Heading *three*",
    "Setext one\n==========",
    "Setext two\n---",
    "> A quote\n>\n> with two paragraphs",
    "> Outer\n>\n> > Inner quote",
    "- one\n- two\n- three",
    "* star\n* list",
    "+ plus\n+ list",
    "- loose\n\n- list",
    "- parent\n  - child\n  - child two\n- next",
    "1. one\n2. two",
    "0. zero\n1. one",
    "3) three\n4) four",
    "999. big\n1000. bigger",
    "```js\nconst a = 1;\n```",
    "~~~\ntilde fence\n~~~",
    "````\n```\nnested fence\n```\n````",
    "    indented code\n    stays indented",
    "***",
    "---",
    "___",
    '![Alt text](chart.png "A title")',
    "Text with an image ![i](a.png) inside",
    "<https://example.com/auto>",
  ];
  for (const md of both) {
    it(`doc: ${JSON.stringify(md)}`, () => roundTrip(md, DOC));
    it(`commonmark: ${JSON.stringify(md)}`, () => roundTrip(md, CM));
  }

  const gfm = [
    "| a | b | c | d |\n| --- | :-- | :-: | --: |\n| 1 | 2 | 3 | 4 |",
    "| only head |\n| --- |",
    "| *em* | `a|b` |\n| --- | --- |\n| x \\| y | [l](u) |",
    "Some ~~struck~~ text",
    "see https://example.com/a_b_c and www.example.org/x_y",
  ];
  for (const md of gfm) it(`doc: ${JSON.stringify(md)}`, () => roundTrip(md, DOC));

  it("keeps a list's start, delimiter, marker and tightness", () => {
    expect(roundTrip("3. a\n4. b")).toBe("3. a\n4. b");
    expect(roundTrip("7) a\n\n8) b")).toBe("7) a\n\n8) b");
    expect(roundTrip("* a\n* b")).toBe("* a\n* b");
    // Item numbers after the start are written from it.
    expect(roundTrip("1. a\n1. b\n1. c")).toBe("1. a\n2. b\n3. c");
  });

  it("keeps a setext heading's style and an ATX heading's level", () => {
    expect(roundTrip("Title\n=====")).toBe("Title\n===");
    expect(roundTrip("## Title ##")).toBe("## Title");
    expect(roundTrip("## C#")).toBe("## C#");
  });

  it("writes emphasis as *…*, so intraword emphasis stays emphasis", () => {
    const out = serializeBlock(
      para(text("un"), text("believ", { em: true }), text("able")),
      DOC_DIALECT,
    );
    expect(out).toBe("un*believ*able");
    expect(roundTrip("_under_ score")).toBe("*under* score");
  });

  it("keeps a reference link and an autolink as written", () => {
    const env: MdEnv = { references: {} };
    DOC.source.parse("[r]: https://example.com", env);
    const model = editableBlock("See [this][r] and <https://a.example>.", DOC, env);
    expect(model).not.toBeNull();
    expect(serializeBlock(model as RichBlock)).toBe("See [this][r] and <https://a.example>.");
  });

  it("turns a shortcut image reference into a full one, so a new alt keeps the image", () => {
    const env: MdEnv = { references: {} };
    DOC.source.parse("[logo]: logo.png", env);
    const model = editableBlock("![logo]", DOC, env) as Extract<RichBlock, { t: "image" }>;
    expect(model).toMatchObject({ t: "image", alt: "logo", rest: "[logo]" });
    expect(verifyBlock({ ...model, alt: "Our logo" }, DOC, env)).toBe("![Our logo][logo]");
  });

  it("refuses blocks the model lacks or would change", () => {
    // A fence in a list item, a definition inside the block, two blocks.
    expect(editableBlock("- item\n\n  ```\n  code\n  ```", DOC, ENV)).toBeNull();
    expect(editableBlock("> [r]: https://example.com\n> text", DOC, ENV)).toBeNull();
    expect(editableBlock("one\n\ntwo", DOC, ENV)).toBeNull();
  });
});

describe("escaping", () => {
  const cases: [string, string][] = [
    ["<html> basics", "\\<html> basics"],
    ["  <!DOCTYPE html> page", "\\<!DOCTYPE html> page"],
    ["# not a heading", "\\# not a heading"],
    ["> not a quote", "\\> not a quote"],
    ["- not a list", "\\- not a list"],
    ["+ not a list", "\\+ not a list"],
    ["1. not a list", "1\\. not a list"],
    ["2) not a list", "2\\) not a list"],
    ["*not em*", "\\*not em\\*"],
    ["_not em_", "\\_not em\\_"],
    ["snake_case_name", "snake_case_name"],
    ["[not a link](x)", "\\[not a link\\](x)"],
    ["`not code`", "\\`not code\\`"],
    ["~~not struck~~", "\\~\\~not struck\\~\\~"],
    ["a | b", "a \\| b"],
    ["&amp; stays text", "\\&amp; stays text"],
    ["back\\slash", "back\\\\slash"],
    ["~~~ not a fence", "\\~\\~\\~ not a fence"],
  ];
  for (const [input, out] of cases) {
    it(`${JSON.stringify(input)} stays text`, () => {
      const m = para(text(input));
      expect(serializeBlock(m, DOC_DIALECT)).toBe(out);
      const back = blockFromSource(out, DOC.source, ENV);
      expect(back && sameBlock(back, m)).toBe(true);
    });
  }

  it("escapes a leading < at the start of every top-level block, so any block can be first", () => {
    for (const b of [
      para(text("<html> basics")),
      { t: "heading", level: 2, setext: false, c: [text("<html>")] } as RichBlock,
      {
        t: "bullet",
        marker: "-",
        tight: true,
        items: [{ blocks: [para(text("<html>"))] }],
      } as RichBlock,
      { t: "quote", blocks: [para(text("<!doctype html>"))] } as RichBlock,
    ]) {
      const out = serializeBlock(b, DOC_DIALECT);
      expect(HTML_DOCUMENT_RE.test(out), out).toBe(false);
      expect(HTML_DOCUMENT_RE.test(`${out}\n`), out).toBe(false);
    }
  });

  it("keeps typed URLs unescaped, so they become links when rendered", () => {
    const m = para(text("go to https://example.com/a_b*c and mailto:a@b.example"));
    const out = serializeBlock(m, DOC_DIALECT);
    expect(out).toContain("https://example.com/a_b*c");
    expect(verifyBlock(m, DOC, ENV)).toBe(out);
    const html = (DOC.render as unknown as InstanceType<typeof MarkdownIt>).render(out);
    expect(html).toContain('href="https://example.com/a_b*c"');
  });

  it("an empty block is nothing, and breaks never start or end one", () => {
    expect(serializeBlock(para(), DOC_DIALECT)).toBe("");
    expect(serializeBlock(para(text("  ")), DOC_DIALECT)).toBe("");
    expect(serializeBlock(para({ k: "br" }, text("a"), { k: "br" }), DOC_DIALECT)).toBe("a");
    expect(serializeBlock(para(text("a\n\n\nb")), DOC_DIALECT)).toBe("a\nb");
  });

  it("moves white space out of marks, so they still close", () => {
    const m = para(text("bold ", { strong: true }), text("text"));
    expect(serializeBlock(m, DOC_DIALECT)).toBe("**bold** text");
    expect(verifyBlock(m, DOC, ENV)).toBe("**bold** text");
  });

  it("verify refuses what CommonMark cannot read back, and the refused text is never sent", () => {
    // Emphasis and strong that overlap without nesting have no CommonMark form.
    const m = para(
      text("a", { em: true }),
      text("b", { em: true, strong: true }),
      text("c", { strong: true }),
    );
    expect(verifyBlock(m, DOC, ENV)).toBeNull();
    // Strong closing after punctuation right before a letter is written with the letter as a
    // character reference, so it closes.
    expect(verifyBlock(para(text("(a)", { strong: true }), text("b")), DOC, ENV)).toBe(
      "**(a)**&#x62;",
    );
    expect(verifyBlock(para(text("ok", { strike: true })), CM, ENV)).toBeNull();
  });
});

describe("editing helpers", () => {
  it("splits and marks ranges of inline content", () => {
    const c: RichInline = [text("hello "), text("world", { em: true })];
    const [a, b] = splitInline(c, 3);
    expect(a).toEqual([text("hel")]);
    expect(b).toEqual([text("lo "), text("world", { em: true })]);
    const bold = applyMark(c, 0, 5, "strong", true);
    expect(rangeHasMark(bold, 0, 5, "strong")).toBe(true);
    expect(rangeHasMark(bold, 0, 8, "strong")).toBe(false);
    expect(serializeBlock(para(...bold), DOC_DIALECT)).toBe("**hello** *world*");
  });
});

// ---------- random models ----------

/** A small seeded generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha",
  "beta",
  "x*y",
  "a_b",
  "[c]",
  "<d>",
  "#e",
  "f|g",
  "~h~",
  "`i`",
  "j\\k",
  "l&amp;",
  "1.",
  "-",
  "+",
  ">",
  "=",
  "naïve",
  "日本",
  "!",
  "(m)",
];

function randomInline(r: () => number, d: MarkdownDialect, oneLine: boolean): RichInline {
  const out: RichInline = [];
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const sep = r();
      if (!oneLine && sep < 0.1) out.push(text("\n"));
      else if (!oneLine && sep < 0.15) out.push({ k: "br" });
      else out.push(text(" "));
    }
    const word = WORDS[Math.floor(r() * WORDS.length)] as string;
    const m: RichMarks = {};
    const p = r();
    if (p < 0.15) m.strong = true;
    else if (p < 0.3) m.em = true;
    else if (p < 0.38 && d.gfm) m.strike = true;
    else if (p < 0.46) m.code = true;
    else if (p < 0.52) m.link = { href: "https://example.com/p", title: r() < 0.5 ? "" : "T" };
    out.push(text(word, m));
  }
  return out;
}

function randomBlock(r: () => number, d: MarkdownDialect, depth = 0): RichBlock {
  const kinds = ["paragraph", "heading", "quote", "bullet", "ordered", "code", "divider"];
  if (d.gfm) kinds.push("table");
  const k = kinds[Math.floor(r() * (depth > 1 ? 2 : kinds.length))] as string;
  switch (k) {
    case "heading": {
      const setext = r() < 0.3;
      const level = setext ? 1 + Math.floor(r() * 2) : 1 + Math.floor(r() * 6);
      return { t: "heading", level, setext, c: randomInline(r, d, !setext) };
    }
    case "quote":
      return {
        t: "quote",
        blocks: [randomBlock(r, d, depth + 1), para(...randomInline(r, d, false))],
      };
    case "bullet":
    case "ordered": {
      const tight = r() < 0.5;
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
        blocks: [para(...randomInline(r, d, false))],
      }));
      if (k === "bullet") {
        const marker = (["-", "*", "+"] as const)[Math.floor(r() * 3)] as "-";
        return { t: "bullet", marker, tight, items };
      }
      const start = [0, 1, 3, 999][Math.floor(r() * 4)] as number;
      return { t: "ordered", start, delim: r() < 0.5 ? "." : ")", tight, items };
    }
    case "code":
      return {
        t: "code",
        fence: r() < 0.5 ? "```" : "~~~",
        info: r() < 0.5 ? "js" : "",
        text: "a\n```\nb\n",
      };
    case "divider":
      return { t: "divider", markup: "***" };
    case "table": {
      const cols = 1 + Math.floor(r() * 3);
      const cells = () => Array.from({ length: cols }, () => randomInline(r, d, true));
      return {
        t: "table",
        align: Array.from(
          { length: cols },
          () => (["left", "center", "right", null] as const)[Math.floor(r() * 4)] ?? null,
        ),
        head: cells(),
        rows: [cells(), cells()],
      };
    }
    default:
      return para(...randomInline(r, d, false));
  }
}

describe("random models read back as themselves", () => {
  for (const [name, t] of [
    ["doc", DOC],
    ["commonmark", CM],
  ] as const) {
    it(`${name}: parse(serialize(m)) equals m, or verify refuses it`, () => {
      let kept = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const r = rng(seed);
        const m = normalizeBlock(randomBlock(r, t.dialect));
        const out = verifyBlock(m, t, ENV);
        if (out === null) {
          continue;
        }
        kept++;
        const back = blockFromSource(out, t.source, ENV);
        expect(back && sameBlock(back, m), `seed ${seed}: ${out}`).toBe(true);
        expect(HTML_DOCUMENT_RE.test(out), `seed ${seed}`).toBe(false);
      }
      // Words are whole runs of one mark, so nearly every model is expressible.
      expect(kept).toBeGreaterThan(360);
    });
  }
});

describe("a mark next to punctuation", () => {
  // CommonMark opens and closes `*`, `**` and `~~` by the characters on either side, so a mark
  // that ends in punctuation right before a letter ("*重要，*的") closes nothing as written. The
  // character outside is then written as a character reference, which renders the same.
  it("closes after punctuation before a letter", () => {
    const m = para(text("这是"), text("重要，", { em: true }), text("的事情"));
    const out = verifyBlock(m, DOC, ENV);
    expect(out).toBe("这是*重要，*&#x7684;事情");
    const back = blockFromSource(out as string, DOC.source, ENV);
    expect(back && sameBlock(back, m)).toBe(true);
    // Saved that way, the block opens for editing again, and takes the next edit.
    const reopened = editableBlock(out as string, DOC, ENV);
    expect(reopened && sameBlock(reopened, m)).toBe(true);
    const next = para(text("这是"), text("重要，", { em: true }), text("的事情。"));
    expect(verifyBlock(next, DOC, ENV)).toBe("这是*重要，*&#x7684;事情。");
    expect(editableBlock("**(a)**&#x62;", DOC, ENV)).not.toBeNull();
    // Text that needs no reference is written as before.
    expect(verifyBlock(para(text("a "), text("b", { em: true }), text(" c")), DOC, ENV)).toBe(
      "a *b* c",
    );
  });

  it("opens before punctuation after a letter", () => {
    const m = para(text("a"), text("(b)", { strong: true }), text("c"));
    const out = verifyBlock(m, DOC, ENV) as string;
    expect(out).not.toBeNull();
    const back = blockFromSource(out, DOC.source, ENV);
    expect(back && sameBlock(back, m), out).toBe(true);
  });

  // Every single character typed anywhere in or around a formatted run, over a fixed corpus,
  // can be written: none is refused, so the editor never has to hold typing back for it.
  const CORPUS = [
    "这是*重要*的事情",
    "foo *bar* baz",
    "a**b**c",
    "x ~~y~~ z",
    "a~~b~~c",
    "*a* **b**",
    "(*x*)",
    "**bold *nested* bold**",
    "[link *em*](https://x.example) after",
    "*em* end.",
    "start *em*",
    "中文**粗体**中文",
    "word *two words* word",
    "see `code` and *em*",
    "*a*,b",
    "a.*b*",
    "~~a~~*b*",
  ];
  const CHARS = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", " ", "a", "中", "，", "。", "1", "é"];
  it("takes every single-character insertion in or next to a formatted run, and reopens it", () => {
    const refused: string[] = [];
    let tried = 0;
    for (const md of CORPUS) {
      const b = editableBlock(md, DOC, ENV);
      if (b?.t !== "paragraph") throw new Error(`not an editable paragraph: ${md}`);
      b.c.forEach((s, i) => {
        if (s.k !== "text") return;
        const marked = !!(s.m.em || s.m.strong || s.m.strike);
        const nextToMark = [b.c[i - 1], b.c[i + 1]].some(
          (n) => n?.k === "text" && !!(n.m.em || n.m.strong || n.m.strike),
        );
        if (!marked && !nextToMark) return;
        for (let o = 0; o <= s.text.length; o++) {
          for (const ch of CHARS) {
            tried++;
            const c = b.c.slice();
            c[i] = { ...s, text: s.text.slice(0, o) + ch + s.text.slice(o) };
            const m = normalizeBlock(para(...c));
            const out = verifyBlock(m, DOC, ENV);
            if (out === null) refused.push(`${md} [${i}:${o}] ${JSON.stringify(ch)}`);
            else {
              const back = blockFromSource(out, DOC.source, ENV);
              if (!back || !sameBlock(back, m)) refused.push(`${md} -> ${out}`);
              // What was saved opens for editing again (never read-only), as the same model.
              const reopened = editableBlock(out, DOC, ENV);
              if (!reopened || !sameBlock(reopened, m))
                refused.push(`${md} -> ${out} reopens read-only`);
            }
          }
        }
      });
    }
    expect(tried).toBeGreaterThan(1500);
    expect(refused).toEqual([]);
  });
});
