// Monaco themes built from the design tokens, so the editor follows Gallery / After hours without
// a second palette. Monaco needs literal "#rrggbb" colors, so the tokens are read from the computed
// style of an element that renders in the wanted mode. Translucent tokens (the hairlines are
// rgb(... / alpha)) are flattened onto the editor background first.
import type { editor } from "monaco-editor/editor";
import type { Theme } from "../../lib/theme.ts";

/** Custom properties the editor theme is made from. */
export const THEME_TOKENS = {
  surface: "--color-surface",
  raised: "--color-surface-raised",
  sunk: "--color-surface-sunk",
  border: "--color-border",
  borderStrong: "--color-border-strong",
  selected: "--color-selected",
  ink: "--color-ink",
  inkMuted: "--color-ink-muted",
  inkFaint: "--color-ink-faint",
  accent: "--color-accent",
  accentSoft: "--color-accent-soft",
  accentInk: "--color-accent-ink",
  success: "--color-success",
  successSoft: "--color-success-soft",
  warning: "--color-warning",
  danger: "--color-danger",
  dangerSoft: "--color-danger-soft",
} as const;

/** Token values as hex, or null when a token could not be read (its Monaco color is left out). */
export type ThemeTokens = Record<keyof typeof THEME_TOKENS, string | null>;

/** "#abc", "#aabbcc" or "#aabbccdd" as lowercase "#rrggbb"/"#rrggbbaa"; null for anything else. */
export function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

/**
 * "rgb(r g b / a)" or "rgba(r, g, b, a)" painted over the opaque `base` ("#rrggbb"), as
 * "#rrggbb"; null for anything else.
 */
export function flattenRgb(value: string, base: string | null): string | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)(%)?)?\s*\)$/.exec(
    value.trim().toLowerCase(),
  );
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  const under = base ? [1, 3, 5].map((i) => Number.parseInt(base.slice(i, i + 2), 16)) : null;
  if (a < 1 && !under) return null;
  const channel = (i: number) => {
    const c = Number(m[i + 1]);
    const v = under ? c * a + (under[i] ?? 0) * (1 - a) : c;
    return Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Read the theme tokens as hex colors from an element's computed style. */
export function readThemeTokens(read: (name: string) => string): ThemeTokens {
  const out = {} as ThemeTokens;
  const raised = normalizeHex(read(THEME_TOKENS.raised));
  for (const [key, prop] of Object.entries(THEME_TOKENS) as [keyof ThemeTokens, string][]) {
    const value = read(prop);
    const hex = normalizeHex(value);
    // Browsers may serialize a translucent color as "#rrggbbaa": flatten it too.
    out[key] =
      hex && hex.length === 9
        ? flattenRgb(
            `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(" ")} / ${
              Number.parseInt(hex.slice(7, 9), 16) / 255
            })`,
            raised?.slice(0, 7) ?? null,
          )
        : (hex ?? flattenRgb(value, raised));
  }
  return out;
}

/** A hex color with an alpha channel ("#rrggbb" + "aa"). */
const alpha = (hex: string | null, a: string) => (hex ? `${hex.slice(0, 7)}${a}` : null);
/** Monaco token rules take colors without the "#". */
const bare = (hex: string | null) => (hex ? hex.slice(1, 7) : undefined);

export const MONACO_THEME_NAMES: Record<Theme, string> = {
  light: "plinth-gallery",
  dark: "plinth-after-hours",
};

export function buildMonacoTheme(mode: Theme, t: ThemeTokens): editor.IStandaloneThemeData {
  const rule = (token: string, color: string | null, fontStyle?: string) => ({
    token,
    ...(color ? { foreground: bare(color) } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  });
  const colors: Record<string, string | null> = {
    focusBorder: t.accent,
    "editor.background": t.raised,
    "editor.foreground": t.ink,
    "editorLineNumber.foreground": t.inkFaint,
    "editorLineNumber.activeForeground": t.ink,
    "editorCursor.foreground": t.accent,
    "editor.selectionBackground": t.accentSoft,
    "editor.inactiveSelectionBackground": t.selected,
    "editor.selectionHighlightBackground": alpha(t.accentSoft, "99"),
    "editor.lineHighlightBackground": t.selected ? alpha(t.selected, "99") : null,
    "editor.lineHighlightBorder": alpha(t.raised, "00"),
    "editorIndentGuide.background1": t.border,
    "editorIndentGuide.activeBackground1": t.borderStrong,
    "editorWhitespace.foreground": t.border,
    "editorBracketMatch.background": t.accentSoft,
    "editorBracketMatch.border": t.accent,
    "editorGutter.background": t.raised,
    "editorWidget.background": t.raised,
    "editorWidget.foreground": t.ink,
    "editorWidget.border": t.borderStrong,
    "editorSuggestWidget.background": t.raised,
    "editorSuggestWidget.border": t.borderStrong,
    "editorSuggestWidget.foreground": t.ink,
    "editorSuggestWidget.selectedBackground": t.accentSoft,
    "editorSuggestWidget.highlightForeground": t.accentInk,
    "editorHoverWidget.background": t.raised,
    "editorHoverWidget.border": t.borderStrong,
    "input.background": t.surface,
    "input.foreground": t.ink,
    "input.border": t.borderStrong,
    "list.hoverBackground": t.selected,
    "list.activeSelectionBackground": t.accentSoft,
    "list.activeSelectionForeground": t.ink,
    "scrollbarSlider.background": alpha(t.borderStrong, "99"),
    "scrollbarSlider.hoverBackground": t.borderStrong,
    "scrollbarSlider.activeBackground": t.inkFaint,
    "editorOverviewRuler.border": t.border,
    // Light tints so syntax colours keep 4.5:1 on changed lines too.
    "diffEditor.insertedTextBackground": alpha(t.success, "1f"),
    "diffEditor.removedTextBackground": alpha(t.danger, "1f"),
    "diffEditor.insertedLineBackground": alpha(t.successSoft, "80"),
    "diffEditor.removedLineBackground": alpha(t.dangerSoft, "80"),
    "diffEditor.border": t.border,
    "diffEditor.diagonalFill": alpha(t.border, "99"),
  };
  // inherit: false, so no base-theme rule (several fail WCAG AA contrast) survives. Every token
  // falls back to the ink color unless a rule below gives it a token color with AA contrast on the
  // editor background.
  return {
    base: mode === "dark" ? "vs-dark" : "vs",
    inherit: false,
    rules: [
      rule("", t.ink),
      rule("invalid", t.danger),
      rule("comment", t.inkFaint, "italic"),
      rule("annotation", t.inkMuted),
      rule("tag", t.accentInk),
      rule("metatag", t.inkMuted),
      rule("delimiter", t.inkMuted),
      rule("operator", t.inkMuted),
      rule("attribute.name", t.inkMuted),
      rule("attribute.value", t.warning),
      rule("string", t.warning),
      rule("key", t.inkMuted),
      rule("keyword", t.accentInk),
      rule("predefined", t.accentInk),
      rule("constant", t.success),
      rule("number", t.success),
      rule("type", t.success),
      rule("regexp", t.danger),
      rule("variable", t.ink),
    ],
    colors: Object.fromEntries(
      Object.entries(colors).filter((e): e is [string, string] => e[1] !== null),
    ),
  };
}
