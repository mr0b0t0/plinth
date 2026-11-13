// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  contrastRatio,
  MIN_RATIO,
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
});

for (const [mode, selector] of Object.entries(MODES)) {
  describe(`${mode} tokens meet WCAG AA`, () => {
    const tokens = parseTokenBlock(css, selector);

    it("defines every color the pairs refer to as a plain color", () => {
      for (const { fg, bg } of CONTRAST_PAIRS) {
        expect(parseColor(resolveToken(tokens, fg)), `${fg} in ${mode}`).not.toBeNull();
        expect(parseColor(resolveToken(tokens, bg)), `${bg} in ${mode}`).not.toBeNull();
      }
    });

    for (const { fg, bg, kind } of CONTRAST_PAIRS) {
      it(`${fg} on ${bg} (${kind}, at least ${MIN_RATIO[kind]}:1)`, () => {
        const a = parseColor(resolveToken(tokens, fg));
        const b = parseColor(resolveToken(tokens, bg));
        if (!a || !b) throw new Error("unparseable color");
        expect(contrastRatio(a, b)).toBeGreaterThanOrEqual(MIN_RATIO[kind]);
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
