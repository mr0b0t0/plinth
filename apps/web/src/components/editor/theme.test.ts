// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor, parseTokenBlock, resolveToken } from "../../styles/contrast.ts";
import {
  buildMonacoTheme,
  flattenRgb,
  MONACO_THEME_NAMES,
  normalizeHex,
  readThemeTokens,
  THEME_TOKENS,
  type ThemeTokens,
} from "./theme.ts";

// Vitest stubs CSS imports, so read tokens.css from disk (the web app's types exclude Node's).
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");

/** Token values for one mode, as the browser would compute them. */
function tokensFor(mode: "light" | "dark"): (name: string) => string {
  const block = parseTokenBlock(css, `[data-theme="${mode}"]`);
  return (name) => (block[name] ? resolveToken(block, name) : "");
}

function ratio(fg: string, bg: string): number {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) throw new Error(`bad color ${fg} / ${bg}`);
  return contrastRatio(a, b);
}

describe("normalizeHex", () => {
  it("accepts 3, 6 and 8 digit hex colors", () => {
    expect(normalizeHex(" #ABC ")).toBe("#aabbcc");
    expect(normalizeHex("#1d6c60")).toBe("#1d6c60");
    expect(normalizeHex("#1d6c60cc")).toBe("#1d6c60cc");
  });
  it("refuses everything else", () => {
    for (const v of ["", "red", "rgb(1 2 3)", "#12", "#12345", "var(--x)"]) {
      expect(normalizeHex(v)).toBeNull();
    }
  });
});

describe("flattenRgb", () => {
  it("paints a translucent color over the background", () => {
    expect(flattenRgb("rgb(0 0 0 / 0.5)", "#ffffff")).toBe("#808080");
    expect(flattenRgb("rgba(255, 255, 255, 0.1)", "#000000")).toBe("#1a1a1a");
    expect(flattenRgb("rgb(10 20 30)", null)).toBe("#0a141e");
  });
  it("flattens #rrggbbaa as browsers serialize translucent custom properties", () => {
    const tokens = readThemeTokens((name) =>
      name === "--color-surface-raised" ? "#ffffff" : name === "--color-border" ? "#00000080" : "",
    );
    expect(tokens.border).toBe("#7f7f7f");
    expect(tokens.raised).toBe("#ffffff");
  });
  it("needs a background for translucent colors and refuses anything else", () => {
    expect(flattenRgb("rgb(0 0 0 / 0.5)", null)).toBeNull();
    expect(flattenRgb("red", "#ffffff")).toBeNull();
  });
});

describe("buildMonacoTheme", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`builds the ${mode} theme from the design tokens`, () => {
      const tokens = readThemeTokens(tokensFor(mode));
      for (const key of Object.keys(THEME_TOKENS)) {
        expect(tokens[key as keyof ThemeTokens], key).toMatch(/^#[0-9a-f]{6}$/);
      }
      const theme = buildMonacoTheme(mode, tokens);
      expect(theme.base).toBe(mode === "dark" ? "vs-dark" : "vs");
      // No base-theme token colors survive (several fail contrast).
      expect(theme.inherit).toBe(false);
      expect(theme.colors["editor.background"]).toBe(tokens.raised);
      expect(theme.colors["editor.foreground"]).toBe(tokens.ink);
      expect(theme.colors.focusBorder).toBe(tokens.accent);
      for (const v of Object.values(theme.colors)) expect(v).toMatch(/^#[0-9a-f]{6,8}$/);
    });

    it(`gives every ${mode} syntax color AA contrast on the editor background`, () => {
      const tokens = readThemeTokens(tokensFor(mode));
      const theme = buildMonacoTheme(mode, tokens);
      const bg = tokens.raised ?? "";
      for (const rule of theme.rules) {
        if (!rule.foreground) continue;
        expect(ratio(`#${rule.foreground}`, bg), `${rule.token}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("leaves out colors whose token could not be read", () => {
    const tokens = readThemeTokens(() => "");
    const theme = buildMonacoTheme("light", tokens);
    expect(theme.colors).toEqual({});
    expect(theme.rules.every((r) => r.foreground === undefined)).toBe(true);
  });

  it("names one theme per mode", () => {
    expect(new Set(Object.values(MONACO_THEME_NAMES)).size).toBe(2);
  });
});
