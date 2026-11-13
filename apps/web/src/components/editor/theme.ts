// Monaco themes built from the design tokens, so the editor follows Gallery / After hours without
// a second palette. Monaco needs literal "#rrggbb" colors, so the tokens are read from the computed
// style of an element that renders in the wanted mode.
import type { editor } from "monaco-editor/editor";
import type { Theme } from "../../lib/theme.ts";

/** Custom properties the editor theme is made from. */
export const THEME_TOKENS = {
  surface: "--color-surface",
  raised: "--color-surface-raised",
  sunk: "--color-surface-sunk",
  border: "--color-border",
  borderStrong: "--color-border-strong",
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

/** Read the theme tokens as hex colors from an element's computed style. */
export function readThemeTokens(read: (name: string) => string): ThemeTokens {
  const out = {} as ThemeTokens;
  for (const [key, prop] of Object.entries(THEME_TOKENS) as [keyof ThemeTokens, string][]) {
    out[key] = normalizeHex(read(prop));
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
    "editor.inactiveSelectionBackground": t.sunk,
    "editor.selectionHighlightBackground": alpha(t.accentSoft, "99"),
    "editor.lineHighlightBackground": alpha(t.sunk, "80"),
    "editor.lineHighlightBorder": alpha(t.sunk, "00"),
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
    "list.hoverBackground": t.sunk,
    "list.activeSelectionBackground": t.accentSoft,
    "list.activeSelectionForeground": t.ink,
    "scrollbarSlider.background": alpha(t.borderStrong, "99"),
    "scrollbarSlider.hoverBackground": t.borderStrong,
    "scrollbarSlider.activeBackground": t.inkFaint,
    "editorOverviewRuler.border": t.border,
    "diffEditor.insertedTextBackground": alpha(t.success, "33"),
    "diffEditor.removedTextBackground": alpha(t.danger, "33"),
    "diffEditor.insertedLineBackground": alpha(t.successSoft, "cc"),
    "diffEditor.removedLineBackground": alpha(t.dangerSoft, "cc"),
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
