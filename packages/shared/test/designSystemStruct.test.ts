// A design system's structural ops (designSystemStruct.ts) and colour spaces (colorSpaces.ts):
// set_text and clear_text with the comma line in what they touch; set_dark and clear_dark; add_token
// last in its group with $type only when the group gives none; remove_token refused while an alias
// or a component's CSS uses the token, and taking its dark value with it; every pure insert listed
// as a zero-length range; the line map moves the leases outside; and the CSS Color 4 conversions.
import { describe, expect, it } from "vitest";
import acme from "../../../apps/worker/test/fixtures/design-systems/acme.json";
import {
  applyDesignSystemStruct,
  type DsStructOp,
  designSystemFromLive,
  designSystemToLive,
  dsGet,
  dsLiveSystem,
  dsNodeAtPath,
  dsTokenUsers,
  fromSrgb,
  hexToSrgb,
  joinLines,
  liveDocClientFrameSchema,
  liveDocServerFrameSchema,
  liveRules,
  mapRange,
  parseDesignSystem,
  rangesOverlap,
  splitLines,
  srgbToHex,
  toSrgb,
} from "../src/index.ts";

const ACME = JSON.stringify(acme, null, 2);
const rules = liveRules("design_system");
if (!rules?.struct) throw new Error("no design system struct rules");
const struct = rules.struct;

const lines = () => splitLines(designSystemToLive(ACME));

function apply(ls: readonly string[], op: DsStructOp) {
  const r = applyDesignSystemStruct(ls, op);
  if (typeof r === "string") throw new Error(`${op.op}: ${r}`);
  return r;
}

/** The lines that differ between two drafts, as one run (what the op should say it touches). */
function diffRun(a: readonly string[], b: readonly string[]) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { start: s, end: ea };
}

describe("design system ops", () => {
  it("set_text adds an absent text after the last member, touching the comma it adds", () => {
    const ls = lines();
    const value = dsNodeAtPath(ls, ["tokens", "color", "bg", "$value"]);
    if (!value) throw new Error("no node");
    const op: DsStructOp = {
      op: "set_text",
      path: "tokens.color.bg.$description",
      value: "The page ground",
    };
    const r = apply(ls, op);
    expect(dsGet(dsLiveSystem(r.lines), ["tokens", "color", "bg", "$description"])).toBe(
      "The page ground",
    );
    // The $value line gained a comma, so the op touches it, and a lease there refuses it.
    expect(r.touched).toEqual([{ start: value.start, end: value.end }]);
    expect(struct.touches(ls, op)).toEqual(r.touched);
    expect(rangesOverlap(r.touched[0] as never, { start: value.start, end: value.end })).toBe(true);
    // Already there: refused, the person edits it in place instead.
    expect(applyDesignSystemStruct(r.lines, op)).toBe("invalid");
    const cleared = apply(r.lines, { op: "clear_text", path: "tokens.color.bg.$description" });
    expect(joinLines(cleared.lines)).toBe(joinLines(ls));
    // Status and the root description too; an empty text is never set.
    expect(applyDesignSystemStruct(ls, { op: "set_text", path: "description", value: "x" })).toBe(
      "invalid",
    );
    expect(apply(ls, { op: "clear_text", path: "description" })).toBeTruthy();
    expect(
      applyDesignSystemStruct(ls, { op: "set_text", path: "components.card.usage", value: "" }),
    ).toBe("invalid");
    expect(
      dsGet(
        dsLiveSystem(
          apply(ls, { op: "set_text", path: "components.card.usage", value: "Use it" }).lines,
        ),
        ["components", 1, "usage"],
      ),
    ).toBe("Use it");
    expect(
      applyDesignSystemStruct(ls, {
        op: "set_text",
        path: "components.button.status",
        value: "beta",
      }),
    ).toBe("invalid");
    expect(applyDesignSystemStruct(ls, { op: "set_text", path: "prefix", value: "x" })).toBe(
      "invalid",
    );
  });

  it("set_dark creates the groups, and clear_dark removes them again", () => {
    const ls = lines();
    const r = apply(ls, { op: "set_dark", token: "motion.fast", value: "200ms" });
    const sys = dsLiveSystem(r.lines);
    expect(dsGet(sys, ["themes", "dark", "motion", "fast", "$value"])).toBe("200ms");
    expect(
      applyDesignSystemStruct(r.lines, { op: "set_dark", token: "motion.fast", value: "1s" }),
    ).toBe("invalid");
    const back = apply(r.lines, { op: "clear_dark", token: "motion.fast" });
    expect(dsGet(dsLiveSystem(back.lines), ["themes", "dark", "motion"])).toBeUndefined();
    expect(joinLines(back.lines)).toBe(joinLines(ls));
    // A value the token's type does not take, or no such token.
    expect(
      applyDesignSystemStruct(ls, { op: "set_dark", token: "motion.fast", value: "red" }),
    ).toBe("invalid");
    expect(applyDesignSystemStruct(ls, { op: "set_dark", token: "nope", value: "1s" })).toBe(
      "invalid",
    );
    // A system with no themes gets them.
    const plain = JSON.parse(ACME) as Record<string, unknown>;
    delete plain.themes;
    const p = splitLines(designSystemToLive(JSON.stringify(plain)));
    const withDark = apply(p, { op: "set_dark", token: "color.bg", value: "#000000" });
    expect(parseDesignSystem(designSystemFromLive(joinLines(withDark.lines))).ok).toBe(true);
  });

  it("add_token goes last in its group, with $type only when the group gives none", () => {
    const ls = lines();
    const r = apply(ls, { op: "add_token", group: "color", name: "line", value: "#d0d7de" });
    const sys = dsLiveSystem(r.lines);
    const color = dsGet(sys, ["tokens", "color"]) as Record<string, unknown>;
    expect(Object.keys(color).at(-1)).toBe("line");
    expect(color.line).toEqual({ $value: "#d0d7de" });
    // A group with no type: the type is written.
    const typed = apply(ls, {
      op: "add_token",
      group: "",
      name: "opacity",
      value: 0.5,
      type: "number",
    });
    expect(dsGet(dsLiveSystem(typed.lines), ["tokens", "opacity"])).toEqual({
      $value: 0.5,
      $type: "number",
    });
    // Refused: no type at all, the wrong type for the group, a name taken or not a name, a value
    // the type does not take.
    for (const op of [
      { op: "add_token", group: "", name: "x", value: 1 },
      { op: "add_token", group: "color", name: "y", value: "#fff", type: "dimension" },
      { op: "add_token", group: "color", name: "bg", value: "#fff" },
      { op: "add_token", group: "color", name: "a b", value: "#fff" },
      { op: "add_token", group: "color", name: "z", value: "12px" },
      { op: "add_token", group: "color.bg", name: "z", value: "#fff" },
    ] as DsStructOp[]) {
      expect(applyDesignSystemStruct(ls, op), JSON.stringify(op)).toBe("invalid");
    }
    // The insert is listed where it is; a lease on the token before it is not touched (only its
    // closing line takes a comma, which is not part of its value).
    const before = dsNodeAtPath(ls, ["tokens", "color", "accent", "$value"]);
    if (!before) throw new Error("no node");
    const run = diffRun(ls, r.lines);
    expect(r.touched).toEqual([{ start: run.start, end: run.end }]);
    expect(r.touched.some((t) => rangesOverlap(t, { start: before.start, end: before.end }))).toBe(
      false,
    );
  });

  it("remove_token is refused while it is in use, and takes its dark value with it", () => {
    const ls = lines();
    // color.brand.500 is the target of color.accent.
    expect(dsTokenUsers(dsLiveSystem(ls), "color.brand.500")).toEqual(["color.accent"]);
    expect(applyDesignSystemStruct(ls, { op: "remove_token", path: "color.brand.500" })).toBe(
      "in_use",
    );
    // color.accent is used by the Button's CSS.
    expect(dsTokenUsers(dsLiveSystem(ls), "color.accent")).toEqual(["Button"]);
    expect(applyDesignSystemStruct(ls, { op: "remove_token", path: "color.accent" })).toBe(
      "in_use",
    );
    // The shared CSS uses space.2 and radius.md.
    expect(dsTokenUsers(dsLiveSystem(ls), "space.2")).toEqual(["shared styles"]);
    // color.fg has a dark value and is used only by the Card (its CSS).
    expect(dsTokenUsers(dsLiveSystem(ls), "motion.ease")).toEqual([]);
    const r = apply(ls, { op: "remove_token", path: "motion.ease" });
    expect(dsGet(dsLiveSystem(r.lines), ["tokens", "motion", "ease"])).toBeUndefined();
    const dark = apply(ls, { op: "set_dark", token: "motion.ease", value: [0, 0, 1, 1] });
    const gone = apply(dark.lines, { op: "remove_token", path: "motion.ease" });
    expect(dsGet(dsLiveSystem(gone.lines), ["themes", "dark", "motion"])).toBeUndefined();
    expect(parseDesignSystem(designSystemFromLive(joinLines(gone.lines))).ok).toBe(true);
  });

  it("remove_token counts a typography token's part variables as uses, and only a typography's", () => {
    type Json = Record<string, any>;
    const withCss = (css: string, extra?: (a: Json) => void) => {
      const a = JSON.parse(ACME) as Json;
      a.css = css;
      extra?.(a);
      expect(parseDesignSystem(JSON.stringify(a)).ok).toBe(true);
      return splitLines(designSystemToLive(JSON.stringify(a)));
    };
    for (const part of [
      "font-size",
      "font-family",
      "font-weight",
      "line-height",
      "letter-spacing",
    ]) {
      const ls = withCss(`.x { y: var(--acme-font-body-${part}); }`);
      expect(dsTokenUsers(dsLiveSystem(ls), "font.body"), part).toEqual(["shared styles"]);
      expect(applyDesignSystemStruct(ls, { op: "remove_token", path: "font.body" })).toBe("in_use");
    }
    // An alias of a typography token has the parts too.
    const alias = withCss(".x { font-size: var(--acme-font-h1-font-size); }", (a) => {
      a.tokens.font.h1 = { $value: "{font.body}" };
    });
    expect(dsTokenUsers(dsLiveSystem(alias), "font.h1")).toEqual(["shared styles"]);
    // Not a part of another token's variable, nor a part a token of another type does not have.
    const other = withCss(
      ".x { y: var(--acme-font-body-font-sizes) var(--acme-motion-fast-font-size); }",
    );
    expect(dsTokenUsers(dsLiveSystem(other), "font.body")).toEqual([]);
    expect(dsTokenUsers(dsLiveSystem(other), "motion.fast")).toEqual([]);
  });

  it("lists every pure insert as a zero-length range, and maps the lines around it", () => {
    const ls = lines();
    const ops: DsStructOp[] = [
      { op: "clear_text", path: "description" },
      { op: "set_text", path: "components.card.description", value: "A card." },
      { op: "set_dark", token: "radius.md", value: "4px" },
      { op: "add_token", group: "motion", name: "slow", value: "400ms", type: "duration" },
      { op: "remove_token", path: "motion.ease" },
      { op: "clear_text", path: "components.button.usage" },
    ];
    for (const op of ops) {
      const r = apply(ls, op);
      const run = diffRun(ls, r.lines);
      expect(r.touched, op.op).toEqual([{ start: run.start, end: run.end }]);
      // Every line the run leaves is where the map says, with the same text.
      for (let i = 0; i < ls.length; i++) {
        const to = r.map[i] as number;
        if (to >= 0) expect(r.lines[to], `${op.op} ${i}`).toBe(ls[i]);
        else expect(i >= run.start && i < run.end).toBe(true);
      }
      // A lease on the guidelines' first line moves with them.
      const end = ls.indexOf("}");
      const g = mapRange({ start: end + 1, end: end + 2 }, r.map, ls.length, r.lines.length);
      expect(g && r.lines[g.start]).toBe(ls[end + 1]);
      const insert = mapRange({ start: end + 1, end: end + 1 }, r.map, ls.length, r.lines.length);
      expect(insert).toEqual({ start: r.lines.indexOf("}") + 1, end: r.lines.indexOf("}") + 1 });
    }
  });

  it("travel in struct frames, each kind with its own fields", () => {
    const ok: DsStructOp[] = [
      { op: "set_dark", token: "color.bg", value: { colorSpace: "srgb", components: [0, 0, 0] } },
      { op: "clear_dark", token: "color.bg" },
      { op: "set_text", path: "description", value: "x" },
      { op: "clear_text", path: "description" },
      { op: "add_token", group: "", name: "n", value: 1, type: "number" },
      { op: "remove_token", path: "color.bg" },
    ];
    for (const op of ok) {
      expect(liveDocClientFrameSchema.safeParse({ t: "struct", rev: 1, op }).success, op.op).toBe(
        true,
      );
      expect(
        liveDocServerFrameSchema.safeParse({ t: "struct", gen: "g", rev: 2, op, by: "s" }).success,
      ).toBe(true);
    }
    for (const op of [
      { op: "set_dark", token: "a..b", value: 1 },
      { op: "set_dark", token: "a" },
      { op: "remove_token", path: "a", extra: 1 },
      { op: "add_token", group: "a", name: "x", value: 1, type: "colour" },
    ]) {
      expect(liveDocClientFrameSchema.safeParse({ t: "struct", rev: 1, op }).success).toBe(false);
    }
  });
});

describe("colour spaces", () => {
  const close = (a: number[], b: number[], eps = 2e-4) => {
    for (const [i, x] of a.entries()) expect(Math.abs(x - (b[i] as number))).toBeLessThan(eps);
  };

  it("match CSS Color 4 reference values", () => {
    close(fromSrgb("oklab", [1, 0, 0]), [0.62796, 0.22486, 0.12585]);
    close(fromSrgb("oklch", [1, 0, 0]), [0.62796, 0.25768, 29.23389]);
    close(fromSrgb("display-p3", [1, 0, 0]), [0.91749, 0.20029, 0.13856]);
    close(fromSrgb("oklab", [1, 1, 1]), [1, 0, 0]);
    expect(fromSrgb("oklch", [0.5, 0.5, 0.5])[2]).toBe(0);
    close(fromSrgb("srgb", [0.123456789, 0, 1]), [0.12346, 0, 1], 1e-9);
  });

  it("go back to sRGB, and to and from hex", () => {
    for (const space of ["srgb", "display-p3", "oklab", "oklch"] as const) {
      for (const hex of ["#3355ff", "#000000", "#ffffff", "#8f5a2a"]) {
        const rgb = hexToSrgb(hex);
        if (!rgb) throw new Error(hex);
        expect(srgbToHex(toSrgb(space, fromSrgb(space, rgb))), `${space} ${hex}`).toBe(hex);
      }
    }
    expect(hexToSrgb("#abc")).toEqual(hexToSrgb("#aabbcc"));
    expect(hexToSrgb("red")).toBeNull();
    expect(srgbToHex([1.2, -0.1, 0.5])).toBe("#ff0080");
  });
});
