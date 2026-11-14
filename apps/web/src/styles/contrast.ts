// WCAG 2.2 contrast helpers and the list of token pairs Plinth promises to keep legible.
// Used by contrast.test.ts (which parses tokens.css) and by the /design page (live values).

export type ContrastKind = "text" | "ui";

export interface ContrastPair {
  fg: string;
  bg: string;
  /** "text" needs 4.5:1 (AA, normal text); "ui" needs 3:1 (focus rings, control borders, active marks). */
  kind: ContrastKind;
  /**
   * The opaque surface under a translucent `bg` (hover and selected fills). The ratio is
   * measured against `bg` composited over it, which is what the reader sees.
   */
  over?: string;
}

export const MIN_RATIO: Record<ContrastKind, number> = { text: 4.5, ui: 3 };

const BACKGROUNDS = [
  "--color-wall",
  "--color-surface",
  "--color-surface-raised",
  "--color-surface-sunk",
  "--color-sidebar",
] as const;

const text = (fg: string, bgs: readonly string[]): ContrastPair[] =>
  bgs.map((bg) => ({ fg, bg, kind: "text" as const }));
const ui = (fg: string, bgs: readonly string[]): ContrastPair[] =>
  bgs.map((bg) => ({ fg, bg, kind: "ui" as const }));
/** Text on a translucent fill, laid over each of the given surfaces. */
const textOn = (fg: string, fill: string, surfaces: readonly string[]): ContrastPair[] =>
  surfaces.map((over) => ({ fg, bg: fill, over, kind: "text" as const }));

/** Every foreground/background combination the components use. */
export const CONTRAST_PAIRS: ContrastPair[] = [
  ...text("--color-ink", [...BACKGROUNDS, "--color-plinth", "--color-accent-soft"]),
  ...text("--color-ink-muted", [...BACKGROUNDS, "--color-plinth"]),
  ...text("--color-ink-faint", BACKGROUNDS),
  ...text("--color-ink-inverse", ["--color-ink"]),
  ...text("--color-on-primary", ["--color-primary", "--color-primary-hover"]),
  // Rows, nav items and ghost buttons on hover; the current nav item and pressed toggles.
  ...textOn("--color-ink", "--color-hover", BACKGROUNDS),
  ...textOn("--color-ink-muted", "--color-hover", BACKGROUNDS),
  ...textOn("--color-ink-faint", "--color-hover", ["--color-wall", "--color-surface"]),
  ...textOn("--color-ink", "--color-selected", BACKGROUNDS),
  ...textOn("--color-ink-muted", "--color-selected", ["--color-sidebar", "--color-wall"]),
  ...text("--color-accent-ink", [
    "--color-wall",
    "--color-surface",
    "--color-surface-raised",
    "--color-accent-soft",
  ]),
  ...text("--color-on-accent", ["--color-accent", "--color-accent-hover", "--color-accent-active"]),
  ...text("--color-on-danger", ["--color-danger", "--color-danger-hover"]),
  ...text("--color-success", ["--color-success-soft", "--color-surface", "--color-surface-raised"]),
  ...text("--color-warning", ["--color-warning-soft", "--color-surface", "--color-surface-raised"]),
  ...text("--color-danger", [
    "--color-danger-soft",
    "--color-wall",
    "--color-surface",
    "--color-surface-raised",
  ]),
  ...text("--color-ink", ["--color-success-soft", "--color-warning-soft", "--color-danger-soft"]),
  ...ui("--color-focus", [...BACKGROUNDS, "--color-accent-soft"]),
  ...ui("--color-accent", ["--color-wall", "--color-surface", "--color-surface-raised"]),
  ...ui("--color-border-control", ["--color-wall", "--color-surface", "--color-surface-raised"]),
  ...ui("--color-danger", ["--color-wall", "--color-surface", "--color-surface-raised"]),
];

export type Rgb = [number, number, number];

/**
 * Parse #rgb, #rgba, #rrggbb, #rrggbbaa or rgb(r g b) / rgb(r, g, b). Alpha is ignored (see
 * parseAlpha); returns null otherwise. Browsers serialize translucent custom properties as
 * #rrggbbaa, so the live /design page needs the long forms.
 */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex?.[1]) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** The alpha of rgb(r g b / a) or rgba(r, g, b, a); 1 for anything opaque or unknown. */
export function parseAlpha(value: string): number {
  const hex = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/.exec(
    value.trim().toLowerCase(),
  );
  if (hex) {
    const a = hex[1] ? hex[1] + hex[1] : (hex[2] ?? "ff");
    return Number.parseInt(a, 16) / 255;
  }
  const m = /^rgba?\([^/,)]+[\s,]+[^/,)]+[\s,]+[^/,)]+(?:\s*[/,]\s*([\d.]+)(%)?)?\s*\)$/.exec(
    value.trim().toLowerCase(),
  );
  if (!m?.[1]) return 1;
  const a = Number(m[1]) / (m[2] ? 100 : 1);
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
}

/** `top` (with its alpha) painted over the opaque `base`. */
export function composite(top: string, base: Rgb): Rgb | null {
  const rgb = parseColor(top);
  if (!rgb) return null;
  const a = parseAlpha(top);
  return rgb.map((c, i) => Math.round(c * a + (base[i] ?? 0) * (1 - a))) as Rgb;
}

/**
 * The colors a pair compares, resolved through `lookup` (token name to CSS value): `bg` is
 * composited over `over` when the pair has one. Null when a value is not a plain color.
 */
export function pairColors(
  pair: ContrastPair,
  lookup: (name: string) => string | undefined,
): [Rgb, Rgb] | null {
  const fg = parseColor(lookup(pair.fg) ?? "");
  const bgValue = lookup(pair.bg) ?? "";
  let bg: Rgb | null;
  if (pair.over) {
    const base = parseColor(lookup(pair.over) ?? "");
    bg = base ? composite(bgValue, base) : null;
  } else {
    bg = parseColor(bgValue);
  }
  return fg && bg ? [fg, bg] : null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Read the custom properties declared in one block of tokens.css, resolving var() references
 * within that block and the base block.
 */
export function parseTokenBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Selector not found in tokens.css: ${selector}`);
  const end = css.indexOf("}", start);
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

export function resolveToken(tokens: Record<string, string>, name: string, depth = 0): string {
  const v = tokens[name];
  if (v === undefined) throw new Error(`Unknown token ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (ref?.[1] && depth < 8) return resolveToken(tokens, ref[1], depth + 1);
  return v;
}

/** Format a ratio the way WCAG tools do: two decimals, rounded down so 4.499 never shows as 4.50. */
export function formatRatio(r: number): string {
  return (Math.floor(r * 100) / 100).toFixed(2);
}
