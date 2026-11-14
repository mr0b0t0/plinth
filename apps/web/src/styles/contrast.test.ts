// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  composite,
  contrastRatio,
  MIN_RATIO,
  pairColors,
  parseAlpha,
  parseColor,
  parseTokenBlock,
  resolveToken,
} from "./contrast.ts";

// Vitest stubs CSS imports (even ?raw) to empty strings, so read the file from disk. The
// specifier is a variable because the web app's types do not include Node's.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

const MODES = {
  Gallery: '[data-theme="light"]',
  "After hours": '[data-theme="dark"]',
} as const;

describe("contrast helpers", () => {
  it("matches known WCAG ratios", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 grey
    const grey = parseColor("#767676");
    expect(grey).not.toBeNull();
    if (grey) expect(contrastRatio(grey, [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("parses hex and rgb()", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor(" #1D6C60 ")).toEqual([29, 108, 96]);
    expect(parseColor("rgb(1 2 3 / 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("reads alpha and composites translucent fills over a surface", () => {
    expect(parseAlpha("#ffffff")).toBe(1);
    expect(parseAlpha("rgb(1 2 3 / 0.07)")).toBeCloseTo(0.07, 5);
    expect(parseAlpha("rgba(1, 2, 3, 0.5)")).toBeCloseTo(0.5, 5);
    expect(parseAlpha("rgb(1 2 3 / 40%)")).toBeCloseTo(0.4, 5);
    expect(parseColor("#1c181212")).toEqual([28, 24, 18]);
    expect(parseAlpha("#1c181212")).toBeCloseTo(18 / 255, 5);
    expect(parseAlpha("#fff8")).toBeCloseTo(0x88 / 255, 5);
    expect(composite("rgb(0 0 0 / 0.5)", [255, 255, 255])).toEqual([128, 128, 128]);
    expect(composite("#102030", [255, 255, 255])).toEqual([16, 32, 48]);
  });
});

for (const [mode, selector] of Object.entries(MODES)) {
  describe(`${mode} tokens meet WCAG AA`, () => {
    const tokens = parseTokenBlock(css, selector);

    const lookup = (name: string) => resolveToken(tokens, name);

    it("defines every color the pairs refer to as a plain color", () => {
      for (const { fg, bg, over } of CONTRAST_PAIRS) {
        expect(parseColor(lookup(fg)), `${fg} in ${mode}`).not.toBeNull();
        expect(parseColor(lookup(bg)), `${bg} in ${mode}`).not.toBeNull();
        if (over) expect(parseColor(lookup(over)), `${over} in ${mode}`).not.toBeNull();
      }
    });

    it("measures text and marks against opaque colors only", () => {
      // A translucent foreground, or a translucent background without the surface under it,
      // would make the ratio meaningless.
      for (const { fg, bg, over } of CONTRAST_PAIRS) {
        expect(parseAlpha(lookup(fg)), `${fg} in ${mode} is opaque`).toBe(1);
        if (!over) expect(parseAlpha(lookup(bg)), `${bg} in ${mode} needs \`over\``).toBe(1);
        else expect(parseAlpha(lookup(over)), `${over} in ${mode} is opaque`).toBe(1);
      }
    });

    for (const pair of CONTRAST_PAIRS) {
      const { fg, bg, over, kind } = pair;
      const where = over ? `${bg} over ${over}` : bg;
      it(`${fg} on ${where} (${kind}, at least ${MIN_RATIO[kind]}:1)`, () => {
        const colors = pairColors(pair, lookup);
        if (!colors) throw new Error("unparseable color");
        expect(contrastRatio(...colors)).toBeGreaterThanOrEqual(MIN_RATIO[kind]);
      });
    }
  });
}

it("both modes define the same set of color tokens", () => {
  const names = (sel: string) =>
    Object.keys(parseTokenBlock(css, sel))
      .filter((k) => k.startsWith("--color-") || k.startsWith("--shadow-"))
      .sort();
  expect(names(MODES["After hours"])).toEqual(names(MODES.Gallery));
});
