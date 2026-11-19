// Plain-language change lists (changes/*): each type's describer with its exact output, the caps,
// the fallbacks, and the rule that the list is visible text, never source.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPES,
  CHANGE_DESCRIBERS,
  CHANGE_LIMITS,
  CHANGES_INVISIBLE,
  CHANGES_UNREADABLE,
  ChangeCollector,
  type ChangeItem,
  DESIGN_SYSTEM_FORMAT,
  describeChanges,
} from "../src/index.ts";

const items = (...args: Parameters<typeof describeChanges>) => describeChanges(...args).items;

describe("describeChanges", () => {
  it("has a describer for every type", () => {
    expect(Object.keys(CHANGE_DESCRIBERS)).toEqual([...ARTIFACT_TYPES]);
  });

  it("lists nothing for identical texts", () => {
    for (const t of ARTIFACT_TYPES)
      expect(describeChanges(t, "same", "same")).toEqual({ items: [], truncated: false });
  });

  it("says so when the texts differ in nothing a person sees", () => {
    expect(items("doc", "# A\n\nText.\n", "# A\n\n\nText.")).toEqual([
      { kind: "changed", where: "", what: CHANGES_INVISIBLE },
    ]);
    expect(items("whiteboard", '{"v":1}', '{ "v": 1, "background": "dots" }')).toEqual([
      { kind: "changed", where: "", what: CHANGES_INVISIBLE },
    ]);
  });

  it("says a version cannot be read in detail rather than guessing", () => {
    expect(items("sheet", "not a sheet", '{"plinth":"sheet","v":1,"columns":[]}')).toEqual([
      { kind: "changed", where: "", what: CHANGES_UNREADABLE },
    ]);
    expect(items("design_system", "{}", "{ }")).toEqual([
      { kind: "changed", where: "", what: CHANGES_UNREADABLE },
    ]);
  });

  it("stops at maxItems and says the list is cut", () => {
    const many = (word: string) =>
      Array.from({ length: 300 }, (_, i) => `## Part ${i}\n\nParagraph ${i} ${word}.`).join("\n\n");
    const r = describeChanges("doc", many("one"), many("two"));
    expect(r.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(r.truncated).toBe(true);
  });

  it("cuts every excerpt to excerptChars, around the difference", () => {
    const long = (w: string) => `${"word ".repeat(80)}${w} ${"tail ".repeat(80)}`;
    const [item] = items("doc", long("alpha"), long("omega"));
    expect(item?.what).toBe("Paragraph changed");
    for (const s of [item?.before, item?.after]) {
      expect(s?.length).toBeLessThanOrEqual(CHANGE_LIMITS.excerptChars);
      expect(s?.startsWith("…")).toBe(true);
    }
    expect(item?.before).toContain("alpha");
    expect(item?.after).toContain("omega");
  });
});

describe("doc", () => {
  const before = [
    "# Plan",
    "",
    "Intro text here.",
    "",
    "## Pricing",
    "",
    "We charge **ten** euros a month for each [seat](https://example.com/seat).",
    "",
    "- one",
    "- two",
    "",
    "![Site map](img/map.png)",
    "",
    "```js",
    "const a = 1;",
    "```",
  ].join("\n");
  const after = [
    "# Plan",
    "",
    "Intro text here.",
    "",
    "## Prices",
    "",
    "We charge **twelve** euros a month for each [seat](https://example.com/seat).",
    "",
    "- one",
    "- two",
    "- three",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "## FAQ",
    "",
    "> Ask us _anything_.",
    "",
    "![](img/chart.png)",
  ].join("\n");

  it("lists headings, blocks and images with visible text, located by the heading above", () => {
    expect(items("doc", before, after)).toEqual<ChangeItem[]>([
      {
        kind: "changed",
        where: "Under “Plan”",
        what: "Heading “Pricing” renamed",
        before: "Pricing",
        after: "Prices",
      },
      {
        kind: "changed",
        where: "Under “Prices”",
        what: "Paragraph changed",
        before: "We charge ten euros a month for each seat.",
        after: "We charge twelve euros a month for each seat.",
      },
      {
        kind: "changed",
        where: "Under “Prices”",
        what: "List changed",
        before: "one two",
        after: "one two three",
      },
      { kind: "removed", where: "Under “Pricing”", what: "Image “Site map” removed" },
      { kind: "added", where: "Under “Prices”", what: "Heading “FAQ” added" },
      { kind: "added", where: "Under “FAQ”", what: "Quote added", after: "Ask us anything." },
      { kind: "added", where: "Under “FAQ”", what: "Image chart.png added" },
    ]);
  });

  it("tells formatting from text, and a heading's level from its name", () => {
    expect(items("doc", "# T\n\nSome *words*.", "# T\n\nSome **words**.")).toEqual([
      {
        kind: "changed",
        where: "Under “T”",
        what: "Paragraph formatting or links changed",
        after: "Some words.",
      },
    ]);
    expect(items("doc", "## Notes\n\nx", "### Notes\n\nx")).toEqual([
      {
        kind: "changed",
        where: "",
        what: "Heading “Notes” is now level 3",
        before: "Level 2",
        after: "Level 3",
      },
    ]);
  });

  it("reads setext headings, tables, dividers and image descriptions", () => {
    const a = "Title\n=====\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![Old](p.png)";
    const b = "Title\n=====\n\n| A | B |\n| - | - |\n| 1 | 3 |\n\n***\n\n![New](p.png)";
    expect(items("doc", a, b)).toEqual([
      {
        kind: "changed",
        where: "Under “Title”",
        what: "Table changed",
        before: "A · B / 1 · 2",
        after: "A · B / 1 · 3",
      },
      { kind: "added", where: "Under “Title”", what: "Divider added" },
      {
        kind: "changed",
        where: "Under “Title”",
        what: "Image description changed",
        before: "Old",
        after: "New",
      },
    ]);
  });

  it("keeps a fenced block whole, so a heading inside code is not a heading", () => {
    expect(items("doc", "```\n# not a heading\n```", "```\n# still not\n```")).toEqual([
      {
        kind: "changed",
        where: "",
        what: "Code block changed",
        before: "# not a heading",
        after: "# still not",
      },
    ]);
  });
});

describe("slides", () => {
  const before = [
    "---",
    "aspect: 4:3",
    "---",
    "# Welcome",
    "",
    "Hello",
    "",
    "---",
    "",
    "# Agenda",
    "",
    "- a",
    "- b",
    "",
    "---",
    "",
    "# Numbers",
    "",
    "Up 5%",
    "",
    "Note: say it loud",
    "",
    "---",
    "",
    "# End",
  ].join("\n");
  const after = [
    "---",
    "footer: Acme",
    "---",
    "# Welcome",
    "",
    "Hello",
    "",
    "---",
    "",
    "# Numbers",
    "",
    "Up 6%",
    "",
    "Note: say it louder",
    "",
    "---",
    "",
    "# Agenda",
    "",
    "- a",
    "- b",
    "",
    "---",
    "",
    "# Thanks",
    "",
    "![chart](img/chart.png)",
  ].join("\n");

  it("lists settings, moves, per-slide title, text, notes and images, and added slides", () => {
    expect(items("slides", before, after)).toEqual<ChangeItem[]>([
      {
        kind: "changed",
        where: "Deck settings",
        what: "Aspect changed",
        before: "4:3",
        after: "16:9",
      },
      { kind: "added", where: "Deck settings", what: "Footer added", after: "Acme" },
      { kind: "moved", where: "“Numbers”", what: "Slide 3 moved to 2" },
      { kind: "changed", where: "Slide 2", what: "Text changed", before: "Up 5%", after: "Up 6%" },
      {
        kind: "changed",
        where: "Slide 2",
        what: "Speaker notes changed",
        before: "say it loud",
        after: "say it louder",
      },
      { kind: "changed", where: "Slide 4", what: "Title changed", before: "End", after: "Thanks" },
      { kind: "added", where: "Slide 4", what: "Image chart.png added" },
    ]);
  });

  it("names a slide removed or added by its title, and lists columns", () => {
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    expect(items("slides", deck("# A", "# B", "# C"), deck("# A", "# C"))).toEqual([
      { kind: "removed", where: "", what: "Slide 2 “B” removed" },
    ]);
    expect(items("slides", deck("# A\n\nx"), deck("# A\n\n|||\n\nx\n\n|||\n\ny"))).toEqual([
      { kind: "changed", where: "Slide 1", what: "Text changed", before: "x", after: "x y" },
      {
        kind: "changed",
        where: "Slide 1",
        what: "Columns changed",
        before: "One column",
        after: "2 columns",
      },
    ]);
  });
});

describe("sheet", () => {
  const header = (qty: string) =>
    JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [
        { name: "Item", type: "text" },
        { name: qty, type: "number" },
        { name: "Price", type: "number", format: { style: "currency", currency: "EUR" } },
        { name: "Total", type: "number" },
        { name: "Paid", type: "checkbox" },
      ],
    });
  const rows = (...r: unknown[][]) => r.map((x) => JSON.stringify(x));
  const before = [
    header("Qty"),
    ...rows(["Apples", 3, 1.2, "=B2*C2", false], ["Pears", 2, 2, "=B3*C3", false]),
  ].join("\n");
  const after = [
    header("Quantity"),
    ...rows(
      ["Apples", 10, 1.2, "=B2*C2", true],
      ["Pears", 2, 2, "=B3*C3+1", false],
      ["Plums", 1, 3, "=B4*C4", false],
      ["Figs", 1, 3, "=B5*C5", false],
    ),
  ].join("\n");

  it("lists columns, cells with values, calculations with results, and added rows", () => {
    expect(items("sheet", before, after)).toEqual<ChangeItem[]>([
      {
        kind: "changed",
        where: "Column B",
        what: "Column “Qty” renamed",
        before: "Qty",
        after: "Quantity",
      },
      { kind: "changed", where: "Row 2, “Quantity”", what: "B2 changed", before: "3", after: "10" },
      {
        kind: "changed",
        where: "Row 2, “Paid”",
        what: "E2 changed",
        before: "unchecked",
        after: "checked",
      },
      {
        kind: "changed",
        where: "Row 3, “Total”",
        what: "D3: calculation changed",
        before: "4",
        after: "5",
      },
      { kind: "added", where: "Rows", what: "Rows 4 to 5 added (2 rows)", after: "“Plums”" },
    ]);
  });

  it("lists a column's type, format, choices, width and frozen columns", () => {
    const h = (cols: unknown[], freeze?: number) =>
      JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: cols,
        ...(freeze ? { freeze: { cols: freeze } } : {}),
      });
    const a = h([
      { name: "N", type: "number", format: { style: "plain" } },
      { name: "S", type: "select", options: ["a", "b"] },
      { name: "T", type: "text" },
    ]);
    const b = h(
      [
        { name: "N", type: "number", format: { style: "percent", decimals: 1 } },
        { name: "S", type: "select", options: ["a", "b", "c"] },
        { name: "T", type: "url", width: 120 },
      ],
      1,
    );
    expect(items("sheet", a, b)).toEqual([
      {
        kind: "changed",
        where: "Column A",
        what: "“N”: number format changed",
        before: "Plain",
        after: "Percent, 1 decimal",
      },
      {
        kind: "changed",
        where: "Column B",
        what: "“S”: choices changed",
        before: "a, b",
        after: "a, b, c",
      },
      {
        kind: "changed",
        where: "Column C",
        what: "“T”: type changed",
        before: "Text",
        after: "Link",
      },
      {
        kind: "changed",
        where: "Column C",
        what: "“T”: width changed",
        before: "Automatic",
        after: "120 px",
      },
      {
        kind: "changed",
        where: "Columns",
        what: "Frozen columns changed",
        before: "None",
        after: "1 column",
      },
    ]);
  });

  it("compares rows on the columns both sides have, so an added column changes no row", () => {
    const a = [
      JSON.stringify({ plinth: "sheet", v: 1, columns: [{ name: "A", type: "text" }] }),
      '["x"]',
      '["y"]',
    ].join("\n");
    const b = [
      JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: [
          { name: "A", type: "text" },
          { name: "B", type: "text" },
        ],
      }),
      '["x","1"]',
      '["z","2"]',
    ].join("\n");
    expect(items("sheet", a, b)).toEqual([
      { kind: "added", where: "Column B", what: "Column “B” added" },
      { kind: "changed", where: "Row 3, “A”", what: "A3 changed", before: "y", after: "z" },
    ]);
  });

  it("leaves results out when a calculation cannot be evaluated within the budget", () => {
    const h = JSON.stringify({ plinth: "sheet", v: 1, columns: [{ name: "A", type: "number" }] });
    expect(items("sheet", `${h}\n["=1+1"]`, `${h}\n["=2+2"]`)).toEqual([
      {
        kind: "changed",
        where: "Row 2, “A”",
        what: "A2: calculation changed",
        before: "2",
        after: "4",
      },
    ]);
  });
});

describe("design system", () => {
  const base = {
    format: DESIGN_SYSTEM_FORMAT,
    name: "Acme UI",
    prefix: "acme",
    fonts: [
      { family: "Inter", google: "https://fonts.googleapis.com/css2?family=Inter&display=swap" },
    ],
    tokens: {
      color: {
        $type: "color",
        brand: { "500": { $value: "#3b5bdb", $description: "Primary actions" } },
        bg: { $value: "#ffffff" },
      },
      space: { $type: "dimension", "1": { $value: "4px" } },
    },
    themes: { dark: { color: { bg: { $value: "#0d1117" } } } },
    guidelines: "# Use\n\nUse the brand colour for actions.",
    components: [
      {
        id: "button",
        name: "Button",
        description: "A button.",
        css: ".acme-btn { color: red; }",
        examples: [{ name: "Primary", html: '<button class="acme-btn">Save</button>' }],
      },
    ],
  };
  const change = (f: (ds: Record<string, any>) => void) => {
    const ds = JSON.parse(JSON.stringify(base));
    f(ds);
    return JSON.stringify(ds);
  };

  it("lists tokens, dark values, guidelines and components, never their code", () => {
    const after = change((ds) => {
      ds.tokens.color.brand["500"].$value = "#2f4ac0";
      ds.themes.dark.color.bg.$value = "#000000";
      delete ds.tokens.space;
      ds.tokens.color.accent = { $value: "{color.brand.500}" };
      ds.guidelines = "# Use\n\nUse the brand colour for primary actions.";
      ds.components[0].name = "Primary button";
      ds.components[0].examples[0].html = '<button class="acme-btn acme-btn--lg">Save</button>';
      ds.components.push({
        id: "card",
        name: "Card",
        examples: [{ name: "Plain", html: "<div>Card</div>" }],
      });
    });
    const list = items("design_system", JSON.stringify(base), after);
    expect(list).toEqual<ChangeItem[]>([
      { kind: "removed", where: "Tokens", what: "space.1 removed", before: "4px" },
      {
        kind: "changed",
        where: "Tokens",
        what: "color.brand.500 changed",
        before: "#3b5bdb",
        after: "#2f4ac0",
      },
      {
        kind: "changed",
        where: "Tokens",
        what: "color.bg changed in the dark theme",
        before: "#0d1117",
        after: "#000000",
      },
      {
        kind: "added",
        where: "Tokens",
        what: "color.accent added",
        after: "color.brand.500 (#2f4ac0)",
      },
      {
        kind: "changed",
        where: "Guidelines, under “Use”",
        what: "Paragraph changed",
        before: "Use the brand colour for actions.",
        after: "Use the brand colour for primary actions.",
      },
      {
        kind: "changed",
        where: "Component “Primary button”",
        what: "Component “Button” renamed",
        before: "Button",
        after: "Primary button",
      },
      { kind: "changed", where: "Component “Primary button”", what: "Examples or styles changed" },
      { kind: "added", where: "Components", what: "Component “Card” added" },
    ]);
    for (const i of list) expect(JSON.stringify(i)).not.toMatch(/<button|acme-btn|\{color/);
  });

  it("cuts a long token value, and an alias with its value, to excerptChars", () => {
    const stack = (last: string) =>
      [...Array.from({ length: 15 }, (_, i) => `Familyname${i}`), last].join(", ");
    const withFonts = (last: string) =>
      change((ds) => {
        ds.tokens.font = { $type: "fontFamily", body: { $value: stack(last) } };
        ds.tokens.color.accent = { $value: "{color.brand.500}" };
      });
    const before = withFonts("Serif");
    const after = change((ds) => {
      ds.tokens.font = { $type: "fontFamily", body: { $value: stack("Sans") } };
      ds.tokens.color.brand["500"].$value = "#2f4ac0";
      ds.tokens.color.accent = { $value: "{color.brand.500}" };
    });
    expect(stack("Serif").length).toBeGreaterThan(CHANGE_LIMITS.excerptChars);
    const list = items("design_system", before, after);
    const font = list.find((i) => i.what === "font.body changed");
    expect(font?.before?.startsWith("Familyname0, Familyname1, ")).toBe(true);
    expect(font?.before?.endsWith("…")).toBe(true);
    const added = items("design_system", JSON.stringify(base), withFonts("Serif"));
    expect(added.find((i) => i.what === "font.body added")?.after?.endsWith("…")).toBe(true);
    for (const i of [...list, ...added]) {
      for (const s of [i.before, i.after]) {
        expect(s?.length ?? 0).toBeLessThanOrEqual(CHANGE_LIMITS.excerptChars);
      }
    }
  });
});

describe("ChangeCollector", () => {
  it("cuts every before and after longer than excerptChars, whatever a describer passes", () => {
    const out = new ChangeCollector();
    const long = "x ".repeat(200);
    out.add({ kind: "changed", where: "", what: "Value changed", before: long, after: "short" });
    const [item] = out.list().items;
    expect(item?.before?.length).toBeLessThanOrEqual(CHANGE_LIMITS.excerptChars);
    expect(item?.before?.endsWith("…")).toBe(true);
    expect(item?.after).toBe("short");
  });
});

describe("design", () => {
  const before = [
    '<link rel="stylesheet" href="brand.css">',
    '<!-- artboard name="Home" size="iphone" -->',
    "<h1>Hi</h1><p>Welcome to Acme.</p>",
    '<!-- artboard name="About" size="desktop" -->',
    "<p>About us</p>",
  ].join("\n");
  const after = [
    '<link rel="stylesheet" href="brand.css">',
    '<!-- artboard name="Home page" size="ipad" -->',
    '<h1>Hello</h1><p>Welcome to Acme.</p><img src="hero.png">',
    '<!-- artboard name="About" size="desktop" -->',
    '<p style="color: red">About us</p>',
    '<!-- artboard name="Banner" size="og-image" -->',
    "<p>Big</p>",
  ].join("\n");

  it("lists boards renamed, resized, added, and their text, images and styles", () => {
    expect(items("design", before, after)).toEqual<ChangeItem[]>([
      {
        kind: "changed",
        where: "Board “Home page”",
        what: "Board “Home” renamed",
        before: "Home",
        after: "Home page",
      },
      {
        kind: "changed",
        where: "Board “Home page”",
        what: "Resized",
        before: "393 × 852",
        after: "820 × 1180",
      },
      {
        kind: "changed",
        where: "Board “Home page”",
        what: "Heading “Hi” changed",
        before: "Hi",
        after: "Hello",
      },
      { kind: "changed", where: "Board “Home page”", what: "Images changed" },
      { kind: "changed", where: "Board “About”", what: "Styles changed" },
      { kind: "added", where: "", what: "Board “Banner” added", after: "1200 × 630" },
    ]);
  });

  it("lists a board taken from one place to another as moved", () => {
    const board = (name: string) =>
      `<!-- artboard name="${name}" size="iphone" -->\n<p>${name}</p>`;
    const design = (...names: string[]) => names.map(board).join("\n");
    expect(items("design", design("A", "B", "C"), design("C", "A", "B"))).toEqual([
      { kind: "moved", where: "", what: "Board “C” moved" },
    ]);
  });
});

describe("html", () => {
  it("lists the title, text by heading, links, images, forms, styles and scripts", () => {
    const a =
      '<!doctype html><html><head><title>Notes</title><style>p{color:red}</style></head><body><h1>Version one</h1><p>Alpha line</p><h2>More</h2><p>Keep <a href="/x">this</a></p></body></html>';
    const b =
      '<!doctype html><html><head><title>Notes 2</title><style>p{color:blue}</style></head><body><h1>Version three</h1><p>Beta line</p><p>Gamma &amp; delta</p><h2>More</h2><p>Keep <a href="/y">this</a></p><form></form><img src="a.png"><script>go()</script></body></html>';
    expect(items("html", a, b)).toEqual<ChangeItem[]>([
      { kind: "changed", where: "", what: "Page title changed", before: "Notes", after: "Notes 2" },
      {
        kind: "changed",
        where: "",
        what: "Heading “Version one” changed",
        before: "Version one",
        after: "Version three",
      },
      {
        kind: "changed",
        where: "Under “Version three”",
        what: "Text changed",
        before: "Alpha line",
        after: "Beta line",
      },
      { kind: "added", where: "Under “Version three”", what: "Text added", after: "Gamma & delta" },
      { kind: "added", where: "", what: "1 link added" },
      { kind: "removed", where: "", what: "1 link removed" },
      { kind: "added", where: "", what: "1 image added" },
      { kind: "added", where: "", what: "1 form added" },
      { kind: "changed", where: "", what: "Styles changed" },
      { kind: "changed", where: "", what: "Scripts changed" },
    ]);
  });

  it("never quotes markup, code or comments", () => {
    const a = "<p>Hello</p>";
    const b =
      '<p>Hello <b>world</b></p><script>var x = "<p>not text</p>";</script><style>p::after{content:"no"}</style><!-- secret --><template><p>hidden</p></template>';
    const list = items("html", a, b);
    expect(list[0]).toEqual({
      kind: "changed",
      where: "",
      what: "Text changed",
      before: "Hello",
      after: "Hello world",
    });
    const text = JSON.stringify(list);
    for (const bad of ["<", "not text", "secret", "hidden", "content"])
      expect(text).not.toContain(bad);
  });
});

describe("whiteboard", () => {
  it("lists the board's settings", () => {
    expect(
      items(
        "whiteboard",
        '{"v":1,"background":"dots"}',
        '{"v":1,"background":"grid","edit":"editors"}',
      ),
    ).toEqual([
      {
        kind: "changed",
        where: "Board settings",
        what: "Background changed",
        before: "Dots",
        after: "Grid",
      },
      {
        kind: "changed",
        where: "Board settings",
        what: "Who can edit the board changed",
        before: "Commenters and editors",
        after: "Editors only",
      },
    ]);
  });
});
