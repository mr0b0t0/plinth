// Plain-language change lists (changes/*): each type's describer with its exact output, the caps,
// the fallbacks, and the rule that the list is visible text, never source.
import { describe, expect, it } from "vitest";
import { CHANGE_DESCRIBERS } from "../src/changes/describers.ts";
import { CHANGES_LAYOUT } from "../src/changes/html.ts";
import {
  ARTIFACT_TYPES,
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
      // "Pricing" and "Prices" share no content word: one heading removed, another added.
      { kind: "removed", where: "Under “Plan”", what: "Heading “Pricing” removed" },
      { kind: "added", where: "Under “Plan”", what: "Heading “Prices” added" },
      {
        kind: "changed",
        where: "Under “Prices”",
        what: "Paragraph changed",
        before: "We charge ten euros a month for each seat.",
        after: "We charge twelve euros a month for each seat.",
      },
      // A list's items one at a time: only the one added, not the list joined into a sentence.
      { kind: "added", where: "Under “Prices”", what: "List item added", after: "three" },
      { kind: "removed", where: "Under “Pricing”", what: "Image “Site map” removed" },
      // A heading of the same level follows the one before it.
      { kind: "added", where: "After “Prices”", what: "Heading “FAQ” added" },
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
      { kind: "removed", where: "", what: "Code block removed", before: "# not a heading" },
      { kind: "added", where: "", what: "Code block added", after: "# still not" },
    ]);
    expect(items("doc", "```\n# a heading\n```", "```\n# a heading, not\n```")).toEqual([
      {
        kind: "changed",
        where: "",
        what: "Code block changed",
        before: "# a heading",
        after: "# a heading, not",
      },
    ]);
  });

  it("pairs a renamed heading with the one that keeps a word, past a heading added before it", () => {
    const a = "## Plot 4\n\nTwelve nests.\n\n## Notes\n\n- Fence needs repair.";
    const b =
      "## Plot 4\n\nTwelve nests.\n\n## Plot 5\n\nSix nests.\n\n## Field notes\n\n- Fence needs repair.";
    // In reading order: "Plot 5" comes before the renamed heading on the page.
    expect(items("doc", a, b)).toEqual([
      { kind: "added", where: "After “Plot 4”", what: "Heading “Plot 5” added" },
      { kind: "added", where: "Under “Plot 5”", what: "Paragraph added", after: "Six nests." },
      {
        kind: "changed",
        where: "After “Plot 5”",
        what: "Heading “Notes” renamed",
        before: "Notes",
        after: "Field notes",
      },
    ]);
    // A heading that keeps no content word was replaced: it is never paired by its place alone.
    expect(items("doc", "## Notes\n\nText.", "## Observations\n\nText.")).toEqual([
      { kind: "removed", where: "", what: "Heading “Notes” removed" },
      { kind: "added", where: "", what: "Heading “Observations” added" },
    ]);
  });

  it("names only the list items that changed, and sets a whole list's items apart", () => {
    const a = "## Notes\n\n- Rain stopped counts at noon.\n- The north fence needs repair.";
    const b =
      "## Notes\n\n- Rain stopped counts at noon.\n- The north fence was repaired on 9 May.";
    expect(items("doc", a, b)).toEqual([
      {
        kind: "changed",
        where: "Under “Notes”",
        what: "List item changed",
        before: "The north fence needs repair.",
        after: "The north fence was repaired on 9 May.",
      },
    ]);
    expect(items("doc", `${a}\n- Gate left open.`, a)).toEqual([
      {
        kind: "removed",
        where: "Under “Notes”",
        what: "List item removed",
        before: "Gate left open.",
      },
    ]);
    expect(items("doc", "## Notes", `## Notes\n\n- One\n- Two`)).toEqual([
      { kind: "added", where: "Under “Notes”", what: "List added", after: "One · Two" },
    ]);
    expect(items("doc", "- One\n- Two", "* One\n* Two")).toEqual([
      { kind: "changed", where: "", what: "List formatting or links changed" },
    ]);
  });

  it("puts a heading under one of a higher level, and after one of its own", () => {
    const a = "# Survey\n\n## Plot 4\n\nTwelve.";
    const b = "# Survey\n\n## Plot 4\n\nTwelve.\n\n### Edge\n\nTwo.\n\n## Plot 5\n\nSix.";
    expect(items("doc", a, b).map((x) => [x.what, x.where])).toEqual([
      ["Heading “Edge” added", "Under “Plot 4”"],
      ["Paragraph added", "Under “Edge”"],
      ["Heading “Plot 5” added", "After “Plot 4”"],
      ["Paragraph added", "Under “Plot 5”"],
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
      // "End" and "Thanks" share no content word: one slide removed, another added.
      { kind: "removed", where: "", what: "Slide 4 “End” removed" },
      { kind: "added", where: "", what: "Slide 4 “Thanks” added" },
    ]);
  });

  it("lists a slide added before an edited one as added, not as the edited one changed", () => {
    const deck = (...slides: string[]) => slides.join("\n\n---\n\n");
    expect(
      items(
        "slides",
        deck("# Intro\n\nHello", "# Plan\n\nStep one", "# End"),
        deck("# Intro\n\nHello", "# Budget\n\nMoney", "# Plan\n\nStep one, then two", "# End"),
      ),
    ).toEqual([
      { kind: "added", where: "", what: "Slide 2 “Budget” added" },
      {
        kind: "changed",
        where: "Slide 3",
        what: "Text changed",
        before: "Step one",
        after: "Step one, then two",
      },
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

describe("slides with one title", () => {
  const deck = (...slides: string[]) => slides.join("\n\n---\n\n");

  it("lists same-titled slides edited where they are as edits, not as moves", () => {
    expect(
      items(
        "slides",
        deck("# Same\n\nx1", "# Other", "# Same\n\nx2"),
        deck("# Same\n\ny1", "# Other", "# Same\n\ny2"),
      ),
    ).toEqual([
      { kind: "changed", where: "Slide 1", what: "Text changed", before: "x1", after: "y1" },
      { kind: "changed", where: "Slide 3", what: "Text changed", before: "x2", after: "y2" },
    ]);
  });

  it("still finds a moved slide among many with its title", () => {
    // Every other slide edited: a region each, and none of them a move.
    const many = Array.from({ length: 2000 }, (_, k) => `# Same\n\nText ${k}`);
    const list = describeChanges(
      "slides",
      deck(...many),
      deck(...many.map((s, k) => (k % 2 === 0 ? `${s}!` : s))),
    );
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expect(list.items.some((i) => i.kind === "moved")).toBe(false);
    // A slide taken from the end to the front, its text changed, among slides of the same title.
    const slides = Array.from({ length: 50 }, (_, k) => `# Same\n\nText ${k}`);
    expect(
      items("slides", deck(...slides, "# Same\n\nLast"), deck("# Same\n\nFirst", ...slides)),
    ).toEqual([
      { kind: "moved", where: "“Same”", what: "Slide 51 moved to 1" },
      { kind: "changed", where: "Slide 1", what: "Text changed", before: "Last", after: "First" },
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
        what: "D3 calculation changed",
        before: "4",
        after: "5",
      },
      { kind: "added", where: "", what: "Rows 4 to 5 added (2 rows)", after: "“Plums”" },
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
        where: "",
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

  it("lists a row added above a total as one row, and leaves out the total it recomputes", () => {
    const h = JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [
        { name: "Task", type: "text" },
        { name: "Hours", type: "number" },
      ],
    });
    const a = [h, '["Audit",14]', '["Total","=SUM(B2:B2)"]'].join("\n");
    const b = [h, '["Audit",14]', '["Handover",6]', '["Total","=SUM(B2:B3)"]'].join("\n");
    // The total's range grew to take the new row: the same calculation, so only the row is listed.
    expect(items("sheet", a, b)).toEqual([
      { kind: "added", where: "", what: "Row 3 added", after: "“Handover”" },
    ]);
    // Another calculation in the same version is still a change of its own.
    const c = [h, '["Audit",14]', '["Handover",6]', '["Total","=AVERAGE(B2:B3)"]'].join("\n");
    expect(items("sheet", a, c)).toEqual([
      {
        kind: "changed",
        where: "Row 4, “Hours”",
        what: "B4 calculation changed",
        before: "14",
        after: "10",
      },
      { kind: "added", where: "", what: "Row 3 added", after: "“Handover”" },
    ]);
    // With no row added or removed, a reference changed by hand is listed.
    const d = [h, '["Audit",14]', '["Total","=SUM(B1:B2)"]'].join("\n");
    expect(items("sheet", a, d).map((x) => x.what)).toEqual(["B3 calculation changed"]);
  });

  it("leaves results out when a calculation cannot be evaluated within the budget", () => {
    const h = JSON.stringify({ plinth: "sheet", v: 1, columns: [{ name: "A", type: "number" }] });
    expect(items("sheet", `${h}\n["=1+1"]`, `${h}\n["=2+2"]`)).toEqual([
      {
        kind: "changed",
        where: "Row 2, “A”",
        what: "A2 calculation changed",
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

  it("drops bidirectional controls from excerpts, names and values, and keeps joiners", () => {
    const bidi = "‪‫‬‭‮⁦⁧⁨⁩‎‏؜";
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const has = (s: string) => /[‪-‮⁦-⁩‎‏؜]/.test(s);
    const page = (text: string) => `<title>T${bidi}</title><h1>Top</h1><p>${text}</p>`;
    const html = items("html", page(`Pay ${bidi}rof ${family}`), page(`Pay ${bidi}now ${family}`));
    const board = (name: string) => `<!-- artboard name="${name}" size="desktop" -->\n<p>x</p>`;
    const design = items("design", board(`Home${bidi}`), board(`Start‮gnp.exe`));
    const out = new ChangeCollector();
    out.add({
      kind: "changed",
      where: `A${bidi}`,
      what: `B${bidi}`,
      before: bidi,
      after: `C${bidi}`,
    });
    for (const item of [...html, ...design, ...out.list().items]) {
      for (const s of [item.where, item.what, item.before ?? "", item.after ?? ""]) {
        expect(has(s)).toBe(false);
      }
    }
    expect(html).toEqual([
      {
        kind: "changed",
        where: "Under “Top”",
        what: "Text changed",
        before: `Pay rof ${family}`,
        after: `Pay now ${family}`,
      },
    ]);
    expect(design[0]).toMatchObject({ before: "Home", after: "Startgnp.exe" });
    expect(out.list().items).toEqual([{ kind: "changed", where: "A", what: "B", after: "C" }]);
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
      // "Hi" is no content word, so "Hello" is a heading added in its place.
      { kind: "removed", where: "Board “Home page”", what: "Heading “Hi” removed" },
      { kind: "added", where: "Board “Home page”", what: "Heading “Hello” added" },
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

  it("lists text in reading order, with a heading after one of its own level", () => {
    const a = "<h2>Plot 4</h2><p>Twelve.</p><h2>Notes</h2><p>Fence.</p>";
    const b =
      "<h2>Plot 4</h2><p>Twelve.</p><h2>Plot 5</h2><p>Six.</p><h2>Field notes</h2><p>Fence.</p>";
    expect(items("html", a, b).map((x) => [x.what, x.where])).toEqual([
      ["Heading “Plot 5” added", "After “Plot 4”"],
      ["Text added", "Under “Plot 5”"],
      ["Heading “Notes” changed", "After “Plot 5”"],
    ]);
  });

  it("lists a paragraph added before an edited one as added, not as the edited one changed", () => {
    const a = "<h1>T</h1><p>Alpha one here</p><p>Beta two here</p>";
    const b = "<h1>T</h1><p>Brand new thing</p><p>Alpha one here, edited</p><p>Beta two here</p>";
    expect(items("html", a, b)).toEqual<ChangeItem[]>([
      { kind: "added", where: "Under “T”", what: "Text added", after: "Brand new thing" },
      {
        kind: "changed",
        where: "Under “T”",
        what: "Text changed",
        before: "Alpha one here",
        after: "Alpha one here, edited",
      },
    ]);
    // On a board too: the same text runs.
    const board = (html: string) => `<!-- artboard name="Home" size="iphone" -->\n${html}`;
    expect(items("design", board(a), board(b))).toEqual<ChangeItem[]>([
      {
        kind: "added",
        where: "Board “Home”, under “T”",
        what: "Text added",
        after: "Brand new thing",
      },
      {
        kind: "changed",
        where: "Board “Home”, under “T”",
        what: "Text changed",
        before: "Alpha one here",
        after: "Alpha one here, edited",
      },
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

  it("says layout or formatting changed for a change it does not name", () => {
    const layout = [{ kind: "changed", where: "", what: CHANGES_LAYOUT }];
    for (const [a, b] of [
      ['<p class="text-red-500">Hi</p>', '<p class="text-blue-500 text-4xl">Hi</p>'],
      ["<div><p>Hi</p></div>", "<div hidden><p>Hi</p></div>"],
      ["<img src=a.png width=10>", "<img src=a.png width=900>"],
      ["<p>Hello <b>world</b></p>", "<p>Hello world</p>"],
      ["<p>Hi</p>", "<p>Hi</p><iframe src=x></iframe><video src=v.mp4></video>"],
      ["<p>Hi</p>", '<p>Hi</p><svg><circle r="4"></circle></svg>'],
      ["<pre>a\n  b</pre>", "<pre>a\n    b</pre>"],
      ["<pre><code>a\n  b</code></pre>", "<pre><code>a b</code></pre>"],
      ["<textarea>a\n  b</textarea>", "<textarea>a b</textarea>"],
      ["<div><p>x</p></div><p>y</p>", "<div><p>x</p><p>y</p></div>"],
      ["<p>Hi</p>", "<!doctype html><p>Hi</p>"],
    ] as const) {
      expect(items("html", a, b), `${a} → ${b}`).toEqual(layout);
    }
  });

  it("says nothing visible changed only for changes in how the markup is written", () => {
    const invisible = [{ kind: "changed", where: "", what: CHANGES_INVISIBLE }];
    for (const [a, b] of [
      ["<div><p>Hi</p></div>", "<div>\n  <p>\n    Hi\n  </p>\n</div>\n"],
      ['<p class="a" id="x">Hi</p>', "<P ID=x CLASS='a'>Hi</P>"],
      ['<p class="a  b">Hi</p>', '<p class=" a b ">Hi</p>'],
      ["<p>Hi</p>", "<p>Hi</p><!-- a note -->"],
      ["<p>A &amp; B</p>", "<p>A &#38; B</p>"],
      ["<input disabled>", '<input disabled="">'],
      ["<template><p>x</p></template>", "<template>\n  <p>x</p>\n</template>"],
    ] as const) {
      expect(items("html", a, b), `${a} → ${b}`).toEqual(invisible);
    }
  });

  it("names the changes it can and leaves layout to the rendered versions", () => {
    // "Hi" is no content word, so "Hello" is text added in its place; the class is not named.
    expect(items("html", '<p class="a">Hi</p>', '<p class="b">Hello</p>')).toEqual([
      { kind: "removed", where: "", what: "Text removed", before: "Hi" },
      { kind: "added", where: "", what: "Text added", after: "Hello" },
    ]);
  });
});
