// A design system's live draft (designSystemLive.ts): the line projection round trips by value
// over every fixture; the storage form is 2-space JSON under the limit and compact over it; the
// compact size counted line by line is exactly the compact JSON's; the value index; and the rules:
// a value edit must be one editable value written canonically that passes the publish grammar on
// the whole system, and the guidelines are lines of their own.
import { describe, expect, it } from "vitest";
import acme from "../../../apps/worker/test/fixtures/design-systems/acme.json";
import {
  applyDesignSystemStruct,
  designSystemFromLive,
  designSystemToLive,
  dsCompactBytes,
  dsEditableKind,
  dsGet,
  dsIndexNodes,
  dsLiveSystem,
  dsNodeAtPath,
  dsNodeLines,
  dsPrettySize,
  dsProjectionEnd,
  dsValueProblem,
  HTML_DOCUMENT_RE,
  joinLines,
  LIMITS,
  liveDocClientFrameSchema,
  liveRules,
  parseDesignSystem,
  sameDesignSystem,
  splitLines,
  utf8Length,
} from "../src/index.ts";

// The Worker's fixture (its 2-space file as an agent sends it).
const ACME = JSON.stringify(acme, null, 2);

const rules = liveRules("design_system");
if (!rules) throw new Error("no design system rules");

/** A small system with every token form the grammar takes. */
const FORMS = {
  format: "plinth.design-system/1",
  name: "Forms",
  prefix: "f",
  tokens: {
    color: {
      $type: "color",
      hex: { $value: "#3355ff", $description: "Primary" },
      fn: { $value: "oklch(0.6 0.2 260)" },
      obj: { $value: { colorSpace: "oklch", components: [0.52, 0.19, 268], alpha: 1 } },
      srgb: { $value: { colorSpace: "srgb", components: [0.2, 0.33, 1], hex: "#3354ff" } },
      alias: { $value: "{color.hex}" },
    },
    size: {
      $type: "dimension",
      s: { $value: "8px" },
      o: { $value: { value: 16, unit: "rem" } },
    },
    time: { $type: "duration", a: { $value: "120ms" }, b: { $value: { value: 2, unit: "s" } } },
    weight: { $type: "fontWeight", n: { $value: 600 }, k: { $value: "bold" } },
    num: { $type: "number", z: { $value: 0.5 } },
    fam: {
      $type: "fontFamily",
      s: { $value: "Inter, sans-serif" },
      a: { $value: ["Inter", "system-ui"] },
    },
    ease: { $type: "cubicBezier", in: { $value: [0.4, 0, 1, 1] } },
    shadow: {
      $type: "shadow",
      one: { $value: { color: "#0000001f", offsetX: "0px", offsetY: "1px", blur: "3px" } },
      two: {
        $value: [
          { color: "{color.hex}", offsetX: "0px", offsetY: "1px", blur: "3px" },
          { color: "#000000", offsetX: "0px", offsetY: "4px", blur: "8px", inset: true },
        ],
      },
    },
    border: { $type: "border", b: { $value: { color: "#000000", width: "1px", style: "solid" } } },
    type: {
      $type: "typography",
      body: { $value: { fontFamily: "Inter", fontSize: "16px", lineHeight: 1.5 } },
    },
  },
  themes: { dark: { color: { hex: { $value: "#6b8cff" } } } },
  components: [
    {
      id: "button",
      name: "Button",
      description: "Acts.",
      examples: [{ name: "A", html: "<b>x</b>" }],
    },
  ],
};

const FIXTURES: [string, string][] = [
  ["acme", ACME],
  ["forms", JSON.stringify(FORMS)],
  ["forms, pretty", JSON.stringify(FORMS, null, 2)],
  ["no guidelines", JSON.stringify({ ...JSON.parse(ACME), guidelines: undefined })],
];

const value = (s: string) => JSON.parse(s) as unknown;

describe("the projection", () => {
  it("round trips by value over every fixture, and only through the guidelines' own lines", () => {
    for (const [name, src] of FIXTURES) {
      expect(parseDesignSystem(src).ok, name).toBe(true);
      const live = designSystemToLive(src);
      expect(rules.valid(live), name).toBe(true);
      const lines = splitLines(live);
      const end = dsProjectionEnd(lines);
      expect(end, name).toBeGreaterThan(0);
      // The JSON part is canonical, with the placeholder.
      const json = joinLines(lines.slice(0, end + 1));
      expect(JSON.stringify(JSON.parse(json), null, 2)).toBe(json);
      expect((JSON.parse(json) as { guidelines: unknown }).guidelines).toBeNull();
      // The guidelines are the lines after it.
      const g = (value(src) as { guidelines?: string }).guidelines ?? "";
      expect(joinLines(lines.slice(end + 1))).toBe(g);
      expect(value(designSystemFromLive(live)), name).toEqual(value(src));
      expect(designSystemToLive(designSystemFromLive(live))).toBe(live);
    }
  });

  it("puts the placeholder last, wherever the file had the key, and lines only for a key", () => {
    const keys = (s: string) =>
      Object.keys(
        JSON.parse(
          splitLines(s)
            .slice(0, splitLines(s).indexOf("}") + 1)
            .join("\n"),
        ),
      );
    const all = [
      "format",
      "name",
      "description",
      "prefix",
      "fonts",
      "tokens",
      "themes",
      "css",
      "components",
      "guidelines",
    ];
    const a = JSON.parse(ACME) as Record<string, unknown>;
    expect(Object.keys(a).indexOf("guidelines")).toBeLessThan(Object.keys(a).length - 1);
    expect(keys(designSystemToLive(ACME))).toEqual(all);
    delete a.guidelines;
    expect(keys(designSystemToLive(JSON.stringify(a)))).toEqual(all);
    // No key: nothing after the JSON part. An empty string: one empty line.
    let ls = splitLines(designSystemToLive(JSON.stringify(a)));
    expect(ls.length).toBe(dsProjectionEnd(ls) + 1);
    ls = splitLines(designSystemToLive(JSON.stringify({ guidelines: "", ...a })));
    expect(ls.slice(dsProjectionEnd(ls) + 1)).toEqual([""]);
    delete a.themes;
    expect(keys(designSystemToLive(JSON.stringify(a))).at(-1)).toBe("guidelines");
  });

  it("stores the lines it was given: the draft row and a Publish load back as the same draft", () => {
    const a = JSON.parse(ACME) as Record<string, unknown>;
    delete a.guidelines;
    delete a.themes;
    const first = JSON.parse(ACME) as Record<string, unknown>;
    const g = first.guidelines;
    delete first.guidelines;
    const sources = [
      JSON.stringify(a),
      JSON.stringify({ guidelines: g, ...first }),
      JSON.stringify({ ...JSON.parse(ACME), guidelines: "" }),
      ACME,
    ];
    for (const src of sources) {
      const base = splitLines(designSystemToLive(src));
      const end = dsProjectionEnd(base);
      const drafts = [
        base,
        // A dark value adds `themes` (where there were none) before the placeholder.
        [...base],
        // Every guidelines line deleted, a lone empty line, and an empty line more.
        base.slice(0, end + 1),
        [...base.slice(0, end + 1), ""],
        [...base.slice(0, end + 1), "", ""],
      ];
      const dark = applyDesignSystemStruct(base, {
        op: "set_dark",
        token: "color.accent",
        value: "#000000",
      });
      if (typeof dark === "string") throw new Error(dark);
      drafts[1] = dark.lines;
      for (const d of drafts) {
        const live = joinLines(d);
        expect(rules.valid(live)).toBe(true);
        expect(designSystemToLive(designSystemFromLive(live))).toBe(live);
      }
    }
  });

  it("stores 2-space JSON within the limit and compact JSON past it", () => {
    const live = designSystemToLive(ACME);
    const { guidelines, ...rest } = JSON.parse(ACME) as Record<string, unknown>;
    expect(designSystemFromLive(live)).toBe(JSON.stringify({ ...rest, guidelines }, null, 2));
    // A system whose 2-space form is past the limit, and whose compact form is within it.
    const big = JSON.parse(ACME) as Record<string, unknown>;
    // Many small examples: 2-space JSON adds a few lines of indent to each.
    big.components = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      examples: Array.from({ length: 20 }, (_, j) => ({
        name: `E${j}`,
        html: `<div>${"y".repeat(170)}</div>`,
        height: 80,
      })),
    }));
    const src = JSON.stringify(big);
    expect(utf8Length(src)).toBeLessThanOrEqual(LIMITS.maxDesignSystemBytes);
    expect(utf8Length(JSON.stringify(big, null, 2))).toBeGreaterThan(LIMITS.maxDesignSystemBytes);
    expect(parseDesignSystem(src).ok).toBe(true);
    const projected = designSystemToLive(src);
    expect(rules.tooLarge(projected)).toBe(false);
    const { guidelines: bigGuidelines, ...bigRest } = big;
    expect(designSystemFromLive(projected)).toBe(
      JSON.stringify({ ...bigRest, guidelines: bigGuidelines }),
    );
  });

  it("counts the compact size line by line, exactly, after random edits", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const words = ["a", "é", '"', "\\", "😀", "\t", "}", "{", "  ", "x", " "];
    for (const [, src] of FIXTURES) {
      let lines = splitLines(designSystemToLive(src));
      for (let i = 0; i < 40; i++) {
        const end = dsProjectionEnd(lines);
        // A new description on some value, and new guidelines lines.
        const nodes = dsIndexNodes(lines).filter(
          (n) => n.end === n.start + 1 && n.path.join(".") !== "guidelines",
        );
        const n = nodes[rand(nodes.length)];
        if (n && rand(2) === 0) {
          const text = Array.from({ length: rand(6) }, () => words[rand(words.length)]).join("");
          lines = [...lines.slice(0, n.start), ...dsNodeLines(n, text), ...lines.slice(n.end)];
        } else {
          const at = end + 1 + rand(lines.length - end);
          const g = Array.from({ length: rand(3) }, () => words[rand(words.length)] ?? "");
          lines = [...lines.slice(0, at), ...g, ...lines.slice(at)];
        }
        const sys = dsLiveSystem(lines);
        expect(dsCompactBytes(lines)).toBe(utf8Length(JSON.stringify(sys)));
      }
    }
  });

  it("is too large past its line cap or when no storage form fits", () => {
    expect(rules.tooLarge(designSystemToLive(ACME))).toBe(false);
    const lines = splitLines(designSystemToLive(ACME));
    const many = [...lines, ...Array.from({ length: LIMITS.maxLiveProjectionLines }, () => "")];
    expect(rules.tooLarge(joinLines(many))).toBe(true);
    const long = [...lines, "x".repeat(LIMITS.maxDesignSystemBytes)];
    expect(rules.tooLarge(joinLines(long))).toBe(true);
  });

  it("compares versions by projection: white space alone is no change", () => {
    expect(sameDesignSystem(ACME, JSON.stringify(JSON.parse(ACME)))).toBe(true);
    expect(sameDesignSystem(ACME, JSON.stringify({ ...JSON.parse(ACME), name: "B" }))).toBe(false);
    expect(rules.toLive(JSON.stringify(JSON.parse(ACME)))).toBe(rules.toLive(ACME));
  });

  it("leaves a text it cannot project as it is, which the rules do not hold", () => {
    for (const s of ["", "not json", "[1]", '{"guidelines": 3}', "{}"]) {
      expect(designSystemToLive(s) === s || s === "{}").toBe(true);
      expect(rules.valid(designSystemToLive(s))).toBe(false);
    }
    expect(designSystemFromLive("not a projection")).toBe("not a projection");
  });

  it("never starts like an HTML document, so the stager's check never refuses a draft", () => {
    for (const [, src] of FIXTURES) {
      expect(HTML_DOCUMENT_RE.test(designSystemFromLive(designSystemToLive(src)))).toBe(false);
    }
  });
});

describe("value nodes", () => {
  const lines = splitLines(designSystemToLive(JSON.stringify(FORMS)));
  const system = dsLiveSystem(lines);

  it("index every member with its lines, and the editable ones by path", () => {
    const node = dsNodeAtPath(lines, ["tokens", "color", "obj", "$value"]);
    expect(node).not.toBeNull();
    if (!node) return;
    expect(lines.slice(node.start, node.end).join("\n")).toBe(
      dsNodeLines(node, FORMS.tokens.color.obj.$value).join("\n"),
    );
    expect(lines[node.end - 1]?.trim()).toBe("}");
    const editable = dsIndexNodes(lines)
      .filter((n) => dsEditableKind(system, n.path) !== null)
      .map((n) => n.path.join("."));
    expect(editable).toContain("name");
    expect(editable).toContain("tokens.color.hex.$description");
    expect(editable).toContain("themes.dark.color.hex.$value");
    expect(editable).toContain("components.0.description");
    // Never the code, the type, the format or the fonts.
    for (const p of editable) {
      expect(p).not.toMatch(/\$type|\.css$|html|format|prefix|fonts/);
    }
    expect(editable).not.toContain("tokens.shadow.one.$value.color");
  });

  it("take every grammar form of every type as a replacement, written canonically", () => {
    for (const n of dsIndexNodes(lines)) {
      if (dsEditableKind(system, n.path) !== "token_value") continue;
      const ins = dsNodeLines(n, dsGet(system, n.path));
      expect(ins).toEqual(lines.slice(n.start, n.end));
      expect(rules.checkEdit(lines, n.start, n.end - n.start, ins), n.path.join(".")).toBeNull();
    }
  });

  it("take a change of kind the grammar allows: a keyword weight, a string colour, an alias", () => {
    const at = (p: (string | number)[]) => {
      const n = dsNodeAtPath(lines, p);
      if (!n) throw new Error(p.join("."));
      return n;
    };
    const cases: [(string | number)[], unknown][] = [
      [["tokens", "weight", "n", "$value"], "semi-bold"],
      [["tokens", "color", "obj", "$value"], "#2f4ac0"],
      [["tokens", "shadow", "two", "$value"], "{tokens.shadow.one}".replace("tokens.", "")],
      [["tokens", "size", "o", "$value"], "{size.s}"],
      [["tokens", "color", "hex", "$value"], { colorSpace: "srgb", components: [1, 0, 0] }],
    ];
    for (const [p, v] of cases) {
      const n = at(p);
      expect(
        rules.checkEdit(lines, n.start, n.end - n.start, dsNodeLines(n, v)),
        p.join("."),
      ).toBeNull();
    }
  });

  it("refuse what a publish would refuse, and anything not written canonically", () => {
    const n = dsNodeAtPath(lines, ["tokens", "color", "hex", "$value"]);
    if (!n) throw new Error("no node");
    const edit = (ins: string[]) => rules.checkEdit(lines, n.start, n.end - n.start, ins);
    expect(edit(dsNodeLines(n, "red; background: url(x)"))).toBe("invalid");
    expect(edit(dsNodeLines(n, "12px"))).toBe("invalid");
    expect(edit(dsNodeLines(n, "{size.s}"))).toBe("invalid");
    expect(edit(dsNodeLines(n, "{color.alias}"))).toBe("invalid");
    expect(edit(dsNodeLines(n, "{color.nope}"))).toBe("invalid");
    // Not canonical: other spacing, another key, a second member, no comma.
    const [line] = dsNodeLines(n, "#000000");
    expect(edit([(line as string).replace(": ", ":")])).toBe("invalid");
    expect(edit([(line as string).replace('"$value"', '"$type"')])).toBe("invalid");
    expect(edit([line as string, `${" ".repeat(n.indent)}"$type": "color",`])).toBe("invalid");
    expect(edit([(line as string).replace(/,$/, "")])).toBe("invalid");
    // A range that is not one editable value: a $type, two lines, the root's braces.
    const type = dsNodeAtPath(lines, ["tokens", "color", "$type"]);
    if (!type) throw new Error("no $type");
    expect(rules.checkEdit(lines, type.start, 1, [lines[type.start] as string])).toBe("invalid");
    expect(rules.checkEdit(lines, n.start, 2, dsNodeLines(n, "#000"))).toBe("invalid");
    expect(rules.checkEdit(lines, 0, 1, ["{"])).toBe("invalid");
    const end = dsProjectionEnd(lines);
    expect(rules.checkEdit(lines, end, 1, ["}"])).toBe("invalid");
    expect(rules.checkEdit(lines, end - 1, 2, ["x"])).toBe("invalid");
  });

  it("check texts: a name is never empty, a status is one of three, sizes hold", () => {
    expect(dsValueProblem(system, ["name"], "")).not.toBeNull();
    expect(dsValueProblem(system, ["name"], "New name")).toBeNull();
    expect(dsValueProblem(system, ["components", 0, "status"], "beta")).toBeNull();
    expect(dsValueProblem(system, ["components", 0, "status"], "draft")).not.toBeNull();
    expect(dsValueProblem(system, ["components", 0, "usage"], "x".repeat(9000))).not.toBeNull();
    expect(dsValueProblem(system, ["description"], "**Hi**")).toBeNull();
    expect(dsValueProblem(system, ["prefix"], "g")).toMatchObject({
      message: "can't be changed on the page",
    });
    expect(dsValueProblem(system, ["components", 0, "css"], "a{}")).not.toBeNull();
  });

  it("take any guidelines lines, within their limit, and none that span both parts", () => {
    const end = dsProjectionEnd(lines);
    expect(rules.checkEdit(lines, end + 1, 0, ["# Hello", "", "}", "{"])).toBeNull();
    expect(
      rules.checkEdit(lines, end + 1, 0, ["x".repeat(LIMITS.designSystem.maxGuidelinesBytes + 1)]),
    ).toBe("too_large");
    expect(rules.checkEdit(lines, end, 1, ["}", "# Hi"])).toBe("invalid");
  });
});

describe("nesting and size", () => {
  /** An array nested `depth` levels deep, around `inner`. */
  const nested = (depth: number, inner: unknown = 0): unknown => {
    let v: unknown = inner;
    for (let i = 0; i < depth; i++) v = [v];
    return v;
  };
  /** Its JSON, written without recursion (JSON.stringify cannot write it). */
  const nestedText = (depth: number, inner = "0") =>
    `${"[".repeat(depth)}${inner}${"]".repeat(depth)}`;
  /** Acme with `ext` (JSON text) as a token's $extensions. */
  const withExtensions = (ext: string) => {
    const a = JSON.parse(ACME) as { tokens: { color: { bg: Record<string, unknown> } } };
    a.tokens.color.bg.$extensions = "EXT";
    return JSON.stringify(a).replace('"EXT"', ext);
  };
  /** `raw` as the whole line of the node's value, its key, indent and comma kept. */
  const valueLine = (n: { indent: number; comma: boolean }, raw: string) =>
    `${" ".repeat(n.indent)}"$value": ${raw}${n.comma ? "," : ""}`;

  it("counts what dsNodeLines writes exactly, without writing it", () => {
    for (const [, src] of FIXTURES) {
      const v = JSON.parse(src) as unknown;
      const pretty = JSON.stringify(v, null, 2);
      expect(dsPrettySize(v, { maxLines: 1e9, maxChars: 1e9 })).toEqual({
        lines: splitLines(pretty).length,
        chars: pretty.length,
      });
      const ls = splitLines(designSystemToLive(src));
      const sys = dsLiveSystem(ls);
      for (const n of dsIndexNodes(ls)) {
        const key = n.path[n.path.length - 1];
        // The placeholder's value is the projection's, not the system's.
        if (key === "guidelines") continue;
        const size = dsPrettySize(dsGet(sys, n.path), {
          indent: n.indent,
          key: typeof key === "string" ? JSON.stringify(key).length + 2 : 0,
          comma: n.comma,
          maxLines: 1e9,
          maxChars: 1e9,
        });
        const text = joinLines(ls.slice(n.start, n.end));
        expect(size).toEqual({ lines: n.end - n.start, chars: text.length });
      }
    }
    expect(dsPrettySize(nested(5), { maxLines: 10, maxChars: 1e9 })).toBeNull();
    expect(dsPrettySize(nested(5), { maxLines: 11, maxChars: 1e9 })).not.toBeNull();
  });

  it("refuses an edit of a deeply nested value without writing it out", () => {
    const ls = splitLines(designSystemToLive(ACME));
    const n = dsNodeAtPath(ls, ["tokens", "color", "bg", "$value"]);
    if (!n) throw new Error("no node");
    // About 60 KB, within one frame: written 2-space it would recurse past the stack.
    const line = valueLine(n, nestedText(30_000));
    expect(utf8Length(line)).toBeLessThan(LIMITS.liveDocFrameBytes);
    expect(rules.checkEdit(ls, n.start, n.end - n.start, [line])).toBe("invalid");
    // 6,000 levels would write out to 36 million characters first.
    const small = valueLine(n, nestedText(6000));
    const t = Date.now();
    expect(rules.checkEdit(ls, n.start, n.end - n.start, [small])).toBe("invalid");
    expect(Date.now() - t).toBeLessThan(100);
  });

  it("refuses a structural op whose value nests past the limit, in the frame and in the room", () => {
    const ls = splitLines(designSystemToLive(ACME));
    const op = { op: "set_dark" as const, token: "color.accent", value: nested(30_000) };
    expect(applyDesignSystemStruct(ls, op)).toBe("invalid");
    const add = { op: "add_token" as const, group: "color", name: "x", value: nested(40) };
    expect(applyDesignSystemStruct(ls, add)).toBe("invalid");
    const frame = { t: "struct", rev: 1, op: { ...op, value: nested(40) } };
    expect(liveDocClientFrameSchema.safeParse(frame).success).toBe(false);
    const ok = { t: "struct", rev: 1, op: { ...op, value: "#000000" } };
    expect(liveDocClientFrameSchema.safeParse(ok).success).toBe(true);
  });

  it("does not project a file that nests or writes out past a draft, and says it is too large", () => {
    // $extensions is never read, so only the nesting limit stops it at publish.
    const deep = withExtensions(nestedText(30_000));
    expect(parseDesignSystem(deep)).toMatchObject({
      ok: false,
      errors: [{ path: "", message: expect.stringMatching(/deeper than 32 levels/) }],
    });
    expect(designSystemToLive(deep)).toBe(deep);
    expect(rules.tooLarge(designSystemToLive(deep))).toBe(true);
    expect(rules.valid(designSystemToLive(deep))).toBe(false);
    // Within the nesting limit and small as a file, but past 8 MB once indented.
    const wide = withExtensions(
      nestedText(26, Array.from({ length: 150_000 }, () => "0").join(",")),
    );
    expect(utf8Length(wide)).toBeLessThan(LIMITS.maxDesignSystemBytes);
    expect(parseDesignSystem(wide).ok).toBe(true);
    expect(designSystemToLive(wide)).toBe(wide);
    expect(rules.tooLarge(designSystemToLive(wide))).toBe(true);
    // Nothing edits a text that is not a projection, even after a line that is exactly "}".
    const { guidelines: _, ...plain } = JSON.parse(ACME) as Record<string, unknown>;
    const pretty = splitLines(`${JSON.stringify(plain, null, 2)}\n`);
    expect(rules.checkEdit(pretty, pretty.length - 1, 1, ["# Hi"])).toBe("invalid");
  });
});
