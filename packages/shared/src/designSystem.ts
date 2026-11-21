// The design system format (`plinth.design-system/1`): one JSON file, system.json, holding design
// tokens (a subset of the W3C Design Tokens Community Group format, 2025.10), a dark theme,
// guidelines (Markdown) and components (HTML and CSS examples). Pure TypeScript with no DOM: the
// Worker validates publishes and serves get_design_system with it, the renderer draws the
// reference site with it, and the editor shows its problems as the author types.
//
// The compiled CSS leaves this artifact: agents copy it into the pages they build. So every string
// that reaches CSS passes one value grammar (no `;`, braces, angle brackets, backslash, `@`, quotes
// or line breaks; no `url(`, `expression(` or comments), font family names are quoted by the
// compiler and never by the author, and the free-form CSS blocks may not hold `<`, a backslash,
// `@import`, a function that takes a URL as a string, or a url() that is not a relative path, a
// #fragment or a raster data: image. All of it is defence in depth: the CSP of the page the CSS
// lands in is what stops a load from another host.
import { LIMITS } from "./constants.ts";

export const DESIGN_SYSTEM_FORMAT = "plinth.design-system/1";

/** The token types format 1 accepts ($type). */
export const DS_TOKEN_TYPES = [
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "duration",
  "cubicBezier",
  "number",
  "shadow",
  "typography",
  "border",
] as const;
export type DsTokenType = (typeof DS_TOKEN_TYPES)[number];

export const DS_COMPONENT_STATUSES = ["stable", "beta", "deprecated"] as const;
export type DsComponentStatus = (typeof DS_COMPONENT_STATUSES)[number];

/** A problem at a path into system.json, like "tokens.color.brand.500.$value". */
export interface DsIssue {
  path: string;
  message: string;
}

export type DsWarningCode =
  | "ds_inert_markup"
  | "ds_missing_font"
  | "ds_no_dark_theme"
  | "ds_deprecated_alias";

/** A non-fatal problem: the design system is published, and the agent is told. */
export interface DsWarning extends DsIssue {
  code: DsWarningCode;
}

export interface DsFont {
  family: string;
  /** "google": a Google Fonts stylesheet; "asset": one of the design system's own font files. */
  source: "google" | "asset";
  /** The stylesheet URL (google only). */
  href: string | null;
  /** The font file's path among the version's assets (asset only). */
  src: string | null;
  weight: string | null;
  style: "normal" | "italic" | null;
}

/** One CSS custom property a composite token adds besides its own (typography parts). */
export interface DsTokenPart {
  /** "font-family", "font-size", "font-weight", "line-height", "letter-spacing". */
  name: string;
  cssVar: string;
  /** What the light block holds: `normal` when only the dark value has this part. */
  cssValue: string;
  /**
   * What the dark blocks hold, when the theme overrides the token (`normal` when the override
   * leaves this part out) or when only the dark value has the part; else null.
   */
  darkCssValue: string | null;
}

export interface DsToken {
  /** "color.brand.500" */
  path: string;
  /** "--acme-color-brand-500" */
  cssVar: string;
  type: DsTokenType;
  /** What the light block holds (var(...) for an alias). */
  cssValue: string;
  /** What the dark blocks hold, when the dark theme overrides this token; else null. */
  darkCssValue: string | null;
  /** The resolved literal, light. */
  value: string;
  /** The resolved literal in the dark theme, when it differs from value. */
  dark: string | null;
  /** The token this one's $value names, or null. */
  aliasOf: string | null;
  description: string | null;
  deprecated: boolean | string;
  parts: DsTokenPart[];
}

export interface DsExample {
  name: string;
  html: string;
  height: number;
}

export interface DsComponent {
  id: string;
  name: string;
  status: DsComponentStatus;
  description: string | null;
  usage: string | null;
  css: string | null;
  examples: DsExample[];
}

export interface DesignSystem {
  name: string;
  description: string | null;
  prefix: string;
  fonts: DsFont[];
  tokens: DsToken[];
  /** The source has themes.dark. */
  hasDarkTheme: boolean;
  guidelines: string | null;
  css: string | null;
  components: DsComponent[];
}

export type DsParseResult =
  | { ok: true; value: DesignSystem; warnings: DsWarning[] }
  | { ok: false; errors: DsIssue[] };

// ---------- rules ----------

const L = LIMITS.designSystem;
const TOP_KEYS = new Set([
  "format",
  "name",
  "description",
  "prefix",
  "fonts",
  "tokens",
  "themes",
  "guidelines",
  "css",
  "components",
]);
const GROUP_KEYS = new Set(["$type", "$description", "$deprecated", "$extensions"]);
const TOKEN_KEYS = new Set(["$value", "$type", "$description", "$deprecated", "$extensions"]);
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const FAMILY_RE = /^[A-Za-z0-9 _-]{1,64}$/;
const WEIGHT_RE = /^\d{3}( \d{3})?$/;
const GOOGLE_PREFIX = "https://fonts.googleapis.com/css2?";
const GOOGLE_BAD = /["'<>\\\s#]/;
const FONT_FILE_RE = /\.(woff2|woff|ttf|otf)$/i;
/** Asset paths, as constants.ts ASSET_PATH_RE allows them. */
const ASSET_PATH_RE =
  /^(?!\/)(?!__plinth\/)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9._\-/]+$/;
const ALIAS_RE = /^\{([A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15})\}$/;

/** Characters no CSS value may hold: each could end a declaration or a block, or quote a URL. */
const CSS_VALUE_BAD = /[;{}<>\\@\r\n"'`]/;
const CSS_VALUE_BAD_WORDS = /url\(|expression\(|\/\*|\*\//i;

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9.%+\-\s,/]*\)$/i;
const COLOR_NAME_RE = /^[a-z]{3,24}$/i;
const NUMBER = String.raw`-?(?:\d+|\d*\.\d+)`;
const DIMENSION_RE = new RegExp(`^${NUMBER}(?:px|rem|em|%)$`);
const DURATION_RE = /^(?:\d+|\d*\.\d+)(?:ms|s)$/;
const BORDER_STYLES = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "outset",
  "inset",
  "none",
]);
const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  "extra-light": 200,
  "ultra-light": 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  "semi-bold": 600,
  "demi-bold": 600,
  bold: 700,
  "extra-bold": 800,
  "ultra-bold": 800,
  black: 900,
  heavy: 900,
  "extra-black": 950,
  "ultra-black": 950,
};
const COLOR_SPACES = new Set(["srgb", "display-p3", "oklch", "oklab"]);
const IDENT_RE = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
/** Markup a preview never runs or shows: said once per example. */
const INERT_MARKUP_RE = /<script|<iframe|<form|<meta|javascript:|[\s"'/]on[a-z]+\s*=/i;

/**
 * UTF-8 length of a string without TextEncoder (plain ES2023), as data.ts utf8Length counts it.
 * Its own copy: data.ts loads zod, and the design system renderer must not.
 */
function bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isAlias = (v: unknown): v is string => typeof v === "string" && ALIAS_RE.test(v);
const aliasTarget = (v: string): string => ALIAS_RE.exec(v)?.[1] ?? "";
const fmtNumber = (n: number) => String(n);

/**
 * Why a string may not reach CSS, or null when it may. Each reason is one short line: the editor
 * lists them above the source, and the skill and docs/spec.md give the full value grammar.
 */
export function cssValueProblem(s: string): string | null {
  if (s.length > L.maxValueLength) return `is longer than ${L.maxValueLength} characters`;
  if (s.trim() === "") return "is empty";
  if (CSS_VALUE_BAD.test(s)) return "has a character CSS can't use";
  if (CSS_VALUE_BAD_WORDS.test(s)) return "may not contain url(, expression( or comments";
  return null;
}

const CSS_SPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const URL_ARG_BAD = /["'()\\\s\u0000-\u001f\u007f-\u009f]/;

/**
 * The argument of every `url(` in CSS text, as a browser's tokenizer reads it, or null when one
 * cannot be read plainly: an unclosed `url(`, a backslash escape, a line break in a quoted URL,
 * anything but `)` after the closing quote, or a quote, parenthesis, space or control character
 * inside an unquoted URL. A caller refuses null. A single forward pass (the only regular expression
 * finds the literal `url(`), so its cost is linear whatever the text holds.
 */
export function cssUrlArgs(css: string): string[] | null {
  const out: string[] = [];
  // A fresh regular expression per call: lastIndex is the scan position.
  const find = /url\(/gi;
  for (let m = find.exec(css); m !== null; m = find.exec(css)) {
    let j = m.index + 4;
    while (j < css.length && CSS_SPACE.has(css[j] as string)) j++;
    const q = css[j];
    let arg: string;
    if (q === '"' || q === "'") {
      const end = css.indexOf(q, j + 1);
      if (end === -1) return null;
      arg = css.slice(j + 1, end);
      if (arg.includes("\\") || arg.includes("\n") || arg.includes("\r") || arg.includes("\f")) {
        return null;
      }
      j = end + 1;
      while (j < css.length && CSS_SPACE.has(css[j] as string)) j++;
      if (css[j] !== ")") return null;
    } else {
      const end = css.indexOf(")", j);
      if (end === -1) return null;
      let k = end;
      while (k > j && CSS_SPACE.has(css[k - 1] as string)) k--;
      arg = css.slice(j, k);
      if (URL_ARG_BAD.test(arg)) return null;
      j = end;
    }
    out.push(arg);
    find.lastIndex = j + 1;
  }
  return out;
}

const PLAIN_URL_RE =
  /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*(?:\?[A-Za-z0-9._~=&-]*)?(?:#[A-Za-z0-9._~-]*)?$/;

/**
 * Whether a URL is a plain relative path to one of the artifact's own files: path segments of
 * letters, digits and `._~-` (no `..`), then an optional query and fragment of the same. So no
 * scheme, no leading `/` (and no protocol-relative `//`), no escapes, quotes, parentheses, spaces
 * or percent-encoding.
 */
export function isPlainRelativeUrl(u: string): boolean {
  if (!PLAIN_URL_RE.test(u)) return false;
  const path = u.split(/[?#]/)[0] ?? "";
  return !path.split("/").includes("..");
}

/** Raster images inline, as a preview's `src` may hold them. */
const DATA_RASTER_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]*$/;
const FRAGMENT_RE = /^#[A-Za-z][\w-]*$/;
/**
 * CSS functions that take a URL as a bare string, so no url() check sees it, with or without a
 * vendor prefix (-webkit-cross-fade(), -moz-element()). A name that only ends in one of them
 * (my-image(), --src()) is not that function and is not matched.
 */
const CSS_STRING_URL_FN =
  /image-set\(|(?<![\w-])(?:-[a-z]+-)?(?:image|src|cross-fade|element|expression)\(/i;

/**
 * Why a free-form CSS block is refused, or null. Defence in depth: the CSP of the page the CSS ends
 * up in is the boundary that stops loads from other hosts. These checks keep the block from ending
 * a <style> element, from escaping its way past them, and from naming another host at all.
 */
function cssBlockProblem(s: string): string | null {
  if (s.includes("<")) return "may not contain <";
  if (s.includes("\\")) return "may not contain \\";
  if (/@import/i.test(s)) return "may not use @import: fonts go in fonts[]";
  if (CSS_STRING_URL_FN.test(s)) return "may load images only with url()";
  const urls = cssUrlArgs(s);
  if (urls === null) return "has a url() that is not a plain path";
  for (const u of urls) {
    if (!(isPlainRelativeUrl(u) || FRAGMENT_RE.test(u) || DATA_RASTER_RE.test(u))) {
      return `may use url() only for this design system's own files, not ${JSON.stringify(u.slice(0, 40))}`;
    }
  }
  return null;
}

// ---------- the parser ----------

interface RawToken {
  segs: string[];
  path: string;
  type: DsTokenType | null;
  value: unknown;
  description: string | null;
  deprecated: boolean | string;
}

interface Val {
  css: string;
  lit: string;
  parts: { name: string; css: string; lit: string }[];
}

type Theme = "light" | "dark";

class Issues {
  readonly errors: DsIssue[] = [];
  readonly warnings: DsWarning[] = [];
  err(path: string, message: string): void {
    if (this.errors.length < L.maxErrors) this.errors.push({ path, message });
  }
  // Every warning is kept, so a publish can say how many it left out; the format's limits bound
  // them (one per example, one per alias token, one for the theme).
  warn(code: DsWarningCode, path: string, message: string): void {
    this.warnings.push({ code, path, message });
  }
  get full(): boolean {
    return this.errors.length >= L.maxErrors;
  }
}

function text(
  c: Issues,
  path: string,
  v: unknown,
  o: { maxBytes?: number; maxChars?: number; min?: number },
): string | null {
  if (typeof v !== "string") {
    c.err(path, "must be a string");
    return null;
  }
  if ((o.min ?? 0) > 0 && v.trim().length < (o.min ?? 0)) {
    c.err(path, "may not be empty");
    return null;
  }
  if (o.maxChars !== undefined && v.length > o.maxChars) {
    c.err(path, `is longer than ${o.maxChars} characters`);
    return null;
  }
  if (o.maxBytes !== undefined && bytes(v) > o.maxBytes) {
    c.err(path, `is larger than ${Math.round(o.maxBytes / 1024)} KB`);
    return null;
  }
  return v;
}

function deprecatedOf(c: Issues, path: string, v: unknown): boolean | string {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.length <= 1000) return v;
  c.err(path, "must be true, false or a short explanation");
  return false;
}

function typeOf(c: Issues, path: string, v: unknown): DsTokenType | null {
  if (typeof v === "string" && (DS_TOKEN_TYPES as readonly string[]).includes(v)) {
    return v as DsTokenType;
  }
  c.err(path, `must be one of ${DS_TOKEN_TYPES.join(", ")}`);
  return null;
}

function walkTokens(
  c: Issues,
  node: Record<string, unknown>,
  segs: string[],
  inherited: DsTokenType | null,
  groupDeprecated: boolean | string,
  out: RawToken[],
): void {
  const at = (k: string) => ["tokens", ...segs, k].join(".");
  let type = inherited;
  let deprecated = groupDeprecated;
  if (node.$type !== undefined) type = typeOf(c, at("$type"), node.$type) ?? type;
  if (node.$description !== undefined) {
    text(c, at("$description"), node.$description, { maxBytes: L.maxDescriptionBytes });
  }
  if (node.$deprecated !== undefined)
    deprecated = deprecatedOf(c, at("$deprecated"), node.$deprecated);
  for (const [key, child] of Object.entries(node)) {
    if (c.full) return;
    if (key.startsWith("$")) {
      if (!GROUP_KEYS.has(key))
        c.err(at(key), "is not a group property ($type, $description, $deprecated)");
      continue;
    }
    if (!NAME_RE.test(key)) {
      c.err(at(key), "a name is 1 to 64 letters, digits, '-' or '_'");
      continue;
    }
    const childSegs = [...segs, key];
    if (childSegs.length > L.maxDepth) {
      c.err(at(key), `is nested deeper than ${L.maxDepth} levels`);
      continue;
    }
    if (!isObject(child)) {
      c.err(at(key), "must be a group or a token (an object with $value)");
      continue;
    }
    if (!("$value" in child)) {
      walkTokens(c, child, childSegs, type, deprecated, out);
      continue;
    }
    const tp = (k: string) => ["tokens", ...childSegs, k].join(".");
    for (const k of Object.keys(child)) {
      if (!TOKEN_KEYS.has(k))
        c.err(tp(k), "is not a token property ($value, $type, $description, $deprecated)");
    }
    if (out.length >= L.maxTokens) {
      c.err("tokens", `holds more than ${L.maxTokens} tokens`);
      return;
    }
    out.push({
      segs: childSegs,
      path: childSegs.join("."),
      type: child.$type !== undefined ? typeOf(c, tp("$type"), child.$type) : type,
      value: child.$value,
      description:
        child.$description === undefined
          ? null
          : text(c, tp("$description"), child.$description, { maxBytes: L.maxDescriptionBytes }),
      deprecated:
        child.$deprecated === undefined
          ? deprecated
          : deprecatedOf(c, tp("$deprecated"), child.$deprecated),
    });
  }
}

function walkDark(
  c: Issues,
  node: Record<string, unknown>,
  segs: string[],
  known: Map<string, RawToken>,
  out: Map<string, unknown>,
): void {
  for (const [key, child] of Object.entries(node)) {
    if (c.full) return;
    const childSegs = [...segs, key];
    const at = ["themes", "dark", ...childSegs].join(".");
    if (key.startsWith("$")) {
      c.err(at, "a theme holds only $value: types and descriptions come from tokens");
      continue;
    }
    if (!isObject(child)) {
      c.err(at, "must be a group or an object with $value");
      continue;
    }
    if (!("$value" in child)) {
      if (childSegs.length >= L.maxDepth) {
        c.err(at, `is nested deeper than ${L.maxDepth} levels`);
        continue;
      }
      walkDark(c, child, childSegs, known, out);
      continue;
    }
    const path = childSegs.join(".");
    for (const k of Object.keys(child)) {
      if (k !== "$value") c.err(`${at}.${k}`, "a theme holds only $value");
    }
    if (!known.has(path)) {
      c.err(at, `there is no token tokens.${path} to override`);
      continue;
    }
    out.set(path, child.$value);
  }
}

class Compiler {
  private readonly byPath = new Map<string, RawToken>();
  private readonly types = new Map<string, DsTokenType>();
  private readonly memo = new Map<string, Val | null>();
  readonly cssVars = new Map<string, string>();

  private readonly c: Issues;
  private readonly prefix: string;
  private readonly raw: RawToken[];
  private readonly dark: Map<string, unknown>;

  // Plain fields, no parameter properties: Node loads this file with type stripping only.
  constructor(c: Issues, prefix: string, raw: RawToken[], dark: Map<string, unknown>) {
    this.c = c;
    this.prefix = prefix;
    this.raw = raw;
    this.dark = dark;
    for (const t of raw) this.byPath.set(t.path, t);
  }

  varOf(path: string, part?: string): string {
    const t = this.byPath.get(path);
    const base = `--${this.prefix}-${(t?.segs ?? path.split(".")).join("-")}`.toLowerCase();
    return part ? `${base}-${part}` : base;
  }

  private rawFor(path: string, theme: Theme): unknown {
    if (theme === "dark" && this.dark.has(path)) return this.dark.get(path);
    return this.byPath.get(path)?.value;
  }

  private valuePath(path: string, theme: Theme): string {
    return theme === "dark" && this.dark.has(path)
      ? `themes.dark.${path}.$value`
      : `tokens.${path}.$value`;
  }

  /** Follow aliases from `start` to the token holding a literal value, or say why not. */
  chase(start: string, theme: Theme): { path: string } | { error: string } {
    let p = start;
    const seen = [p];
    for (let hops = 0; ; hops++) {
      const v = this.rawFor(p, theme);
      if (!isAlias(v)) return { path: p };
      const target = aliasTarget(v);
      if (!this.byPath.has(target)) return { error: `{${target}} is not a token` };
      if (seen.includes(target))
        return { error: `aliases form a cycle: ${[...seen, target].join(" → ")}` };
      if (hops + 1 > L.maxAliasChain)
        return { error: `the alias chain is longer than ${L.maxAliasChain}` };
      seen.push(target);
      p = target;
    }
  }

  /** Types, with alias tokens that set none taking their target's. */
  resolveTypes(): void {
    const typeOfPath = (path: string, depth: number): DsTokenType | null => {
      const known = this.types.get(path);
      if (known) return known;
      const t = this.byPath.get(path);
      if (!t) return null;
      if (t.type) return t.type;
      if (depth > L.maxAliasChain + 1 || !isAlias(t.value)) return null;
      return typeOfPath(aliasTarget(t.value), depth + 1);
    };
    for (const t of this.raw) {
      const type = typeOfPath(t.path, 0);
      if (type) {
        this.types.set(t.path, type);
        continue;
      }
      const chased = isAlias(t.value) ? this.chase(t.path, "light") : null;
      if (chased && "error" in chased) this.c.err(`tokens.${t.path}.$value`, chased.error);
      else this.c.err(`tokens.${t.path}`, "has no $type: set it on the token or a parent group");
    }
  }

  typeOf(path: string): DsTokenType | null {
    return this.types.get(path) ?? null;
  }

  /** The compiled value of a token in a theme, or null (problems reported once, at its path). */
  value(path: string, theme: Theme): Val | null {
    const key = `${theme}:${path}`;
    if (this.memo.has(key)) return this.memo.get(key) ?? null;
    this.memo.set(key, null);
    const own = theme === "light" || this.dark.has(path);
    const sink = own ? this.c : new Issues();
    const type = this.typeOf(path);
    const v = type
      ? this.compile(sink, this.valuePath(path, theme), path, type, this.rawFor(path, theme), theme)
      : null;
    this.memo.set(key, v);
    return v;
  }

  private compile(
    c: Issues,
    at: string,
    path: string,
    type: DsTokenType,
    raw: unknown,
    theme: Theme,
  ): Val | null {
    if (isAlias(raw)) {
      const target = aliasTarget(raw);
      const chased = this.chase(path, theme);
      if ("error" in chased) {
        c.err(at, chased.error);
        return null;
      }
      const targetType = this.typeOf(target);
      if (targetType !== type) {
        c.err(at, `{${target}} is a ${targetType ?? "token without a type"}, not a ${type}`);
        return null;
      }
      const final = this.value(chased.path, theme);
      if (!final) return null;
      return {
        css: `var(${this.varOf(target)})`,
        lit: final.lit,
        parts: final.parts.map((p) => ({
          name: p.name,
          css: `var(${this.varOf(target, p.name)})`,
          lit: p.lit,
        })),
      };
    }
    const simple = (css: string | null): Val | null =>
      css === null ? null : { css, lit: css, parts: [] };
    // Checked as written, before any trimming: a line break is refused, never quietly removed.
    if (typeof raw === "string" && type !== "fontFamily" && this.checked(c, at, raw) === null) {
      return null;
    }
    switch (type) {
      case "color":
        return simple(this.color(c, at, raw));
      case "dimension":
        return simple(this.dimension(c, at, raw));
      case "fontFamily":
        return simple(this.fontFamily(c, at, raw));
      case "fontWeight":
        return simple(this.fontWeight(c, at, raw));
      case "duration":
        return simple(this.duration(c, at, raw));
      case "cubicBezier":
        return simple(this.cubicBezier(c, at, raw));
      case "number":
        return simple(this.number(c, at, raw));
      case "shadow":
        return this.shadow(c, at, raw, theme);
      case "typography":
        return this.typography(c, at, path, raw, theme);
      case "border":
        return this.border(c, at, raw, theme);
    }
  }

  /** A part of a composite: a literal of `type`, or an alias of a token of that type. */
  private part(
    c: Issues,
    at: string,
    type: DsTokenType,
    raw: unknown,
    theme: Theme,
  ): { css: string; lit: string } | null {
    if (isAlias(raw)) {
      const target = aliasTarget(raw);
      if (!this.byPath.has(target)) {
        c.err(at, `{${target}} is not a token`);
        return null;
      }
      const targetType = this.typeOf(target);
      if (targetType !== type) {
        c.err(at, `{${target}} is a ${targetType ?? "token without a type"}, not a ${type}`);
        return null;
      }
      const chased = this.chase(target, theme);
      if ("error" in chased) {
        c.err(at, chased.error);
        return null;
      }
      const final = this.value(chased.path, theme);
      return final ? { css: `var(${this.varOf(target)})`, lit: final.lit } : null;
    }
    const v = this.compile(c, at, "", type, raw, theme);
    return v ? { css: v.css, lit: v.lit } : null;
  }

  private checked(c: Issues, at: string, s: string): string | null {
    const problem = cssValueProblem(s);
    if (problem) {
      c.err(at, problem);
      return null;
    }
    return s;
  }

  private color(c: Issues, at: string, raw: unknown): string | null {
    if (typeof raw === "string") {
      const s = raw.trim();
      if (this.checked(c, at, s) === null) return null;
      if (HEX_RE.test(s) || COLOR_FN_RE.test(s) || COLOR_NAME_RE.test(s)) return s;
      c.err(
        at,
        "is not a CSS color (#rgb, #rrggbb, rgb(), hsl(), oklch(), color(), or a color name)",
      );
      return null;
    }
    if (isObject(raw)) {
      const { colorSpace, components, alpha, hex } = raw;
      for (const k of Object.keys(raw)) {
        if (!["colorSpace", "components", "alpha", "hex"].includes(k)) {
          c.err(`${at}.${k}`, "is not a color property (colorSpace, components, alpha, hex)");
          return null;
        }
      }
      if (typeof colorSpace !== "string" || !COLOR_SPACES.has(colorSpace)) {
        c.err(`${at}.colorSpace`, "must be srgb, display-p3, oklch or oklab");
        return null;
      }
      if (
        !Array.isArray(components) ||
        components.length !== 3 ||
        !components.every((n) => n === "none" || (typeof n === "number" && Number.isFinite(n)))
      ) {
        c.err(`${at}.components`, 'must be three numbers (or "none")');
        return null;
      }
      if (alpha !== undefined && !(typeof alpha === "number" && alpha >= 0 && alpha <= 1)) {
        c.err(`${at}.alpha`, "must be a number from 0 to 1");
        return null;
      }
      if (hex !== undefined && !(typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex))) {
        c.err(`${at}.hex`, "must be #rrggbb");
        return null;
      }
      const a = alpha === undefined || alpha === 1 ? "" : ` / ${fmtNumber(alpha as number)}`;
      const parts = (components as (number | "none")[]).map((n) =>
        n === "none" ? "none" : fmtNumber(n),
      );
      if (colorSpace === "srgb" && typeof hex === "string" && a === "") return hex.toLowerCase();
      if (colorSpace === "oklch" || colorSpace === "oklab")
        return `${colorSpace}(${parts.join(" ")}${a})`;
      return `color(${colorSpace} ${parts.join(" ")}${a})`;
    }
    c.err(at, "must be a CSS color string or a DTCG color object");
    return null;
  }

  private dimension(c: Issues, at: string, raw: unknown): string | null {
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s === "0" || DIMENSION_RE.test(s)) return s;
      c.err(at, 'must be a number with px, rem, em or % (like "16px"), or { "value", "unit" }');
      return null;
    }
    if (isObject(raw)) {
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
        c.err(`${at}.value`, "must be a number");
        return null;
      }
      if (raw.unit !== "px" && raw.unit !== "rem") {
        c.err(`${at}.unit`, "must be px or rem");
        return null;
      }
      return `${fmtNumber(raw.value)}${raw.unit}`;
    }
    c.err(at, 'must be a dimension like "16px" or { "value": 16, "unit": "px" }');
    return null;
  }

  private fontFamily(c: Issues, at: string, raw: unknown): string | null {
    const names =
      typeof raw === "string"
        ? raw.split(",")
        : Array.isArray(raw) && raw.every((n) => typeof n === "string")
          ? (raw as string[])
          : null;
    if (!names || names.length === 0 || names.length > 16) {
      c.err(at, "must be a family name, a comma list, or an array of up to 16 names");
      return null;
    }
    const out: string[] = [];
    for (const n of names) {
      let name = n.trim();
      // Quotes around one name are the author's CSS habit: the compiler quotes names itself.
      if (/^(["']).*\1$/.test(name)) name = name.slice(1, -1).trim();
      if (this.checked(c, at, name) === null) return null;
      out.push(IDENT_RE.test(name) ? name : `"${name}"`);
    }
    return out.join(", ");
  }

  private fontWeight(c: Issues, at: string, raw: unknown): string | null {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 1000)
      return String(raw);
    if (typeof raw === "string" && Object.hasOwn(FONT_WEIGHTS, raw))
      return String(FONT_WEIGHTS[raw]);
    c.err(at, "must be a whole number from 1 to 1000 or a weight keyword (thin ... black)");
    return null;
  }

  private duration(c: Issues, at: string, raw: unknown): string | null {
    if (typeof raw === "string" && DURATION_RE.test(raw.trim())) return raw.trim();
    if (
      isObject(raw) &&
      typeof raw.value === "number" &&
      Number.isFinite(raw.value) &&
      raw.value >= 0 &&
      (raw.unit === "ms" || raw.unit === "s")
    ) {
      return `${fmtNumber(raw.value)}${raw.unit}`;
    }
    c.err(at, 'must be a duration like "200ms" or { "value": 200, "unit": "ms" }');
    return null;
  }

  private cubicBezier(c: Issues, at: string, raw: unknown): string | null {
    if (
      Array.isArray(raw) &&
      raw.length === 4 &&
      raw.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      raw[0] >= 0 &&
      raw[0] <= 1 &&
      raw[2] >= 0 &&
      raw[2] <= 1
    ) {
      return `cubic-bezier(${(raw as number[]).map(fmtNumber).join(", ")})`;
    }
    c.err(at, "must be [x1, y1, x2, y2] with x1 and x2 from 0 to 1");
    return null;
  }

  private number(c: Issues, at: string, raw: unknown): string | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return fmtNumber(raw);
    c.err(at, "must be a number");
    return null;
  }

  private keys(c: Issues, at: string, raw: Record<string, unknown>, allowed: string[]): boolean {
    for (const k of Object.keys(raw)) {
      if (!allowed.includes(k)) {
        c.err(`${at}.${k}`, `is not one of ${allowed.join(", ")}`);
        return false;
      }
    }
    return true;
  }

  private shadow(c: Issues, at: string, raw: unknown, theme: Theme): Val | null {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0 || list.length > 16) {
      c.err(at, "must be a shadow object or an array of 1 to 16");
      return null;
    }
    const css: string[] = [];
    const lit: string[] = [];
    for (const [i, s] of list.entries()) {
      const sp = Array.isArray(raw) ? `${at}[${i}]` : at;
      if (!isObject(s)) {
        c.err(sp, "must be an object { color, offsetX, offsetY, blur, spread?, inset? }");
        return null;
      }
      if (!this.keys(c, sp, s, ["color", "offsetX", "offsetY", "blur", "spread", "inset"]))
        return null;
      if (s.inset !== undefined && typeof s.inset !== "boolean") {
        c.err(`${sp}.inset`, "must be true or false");
        return null;
      }
      const color = this.part(c, `${sp}.color`, "color", s.color, theme);
      const dims: { css: string; lit: string }[] = [];
      for (const k of ["offsetX", "offsetY", "blur", "spread"] as const) {
        if (s[k] === undefined && k === "spread") {
          dims.push({ css: "0", lit: "0" });
          continue;
        }
        const d = this.part(c, `${sp}.${k}`, "dimension", s[k], theme);
        if (!d) return null;
        dims.push(d);
      }
      if (!color) return null;
      const inset = s.inset ? "inset " : "";
      css.push(`${inset}${dims.map((d) => d.css).join(" ")} ${color.css}`);
      lit.push(`${inset}${dims.map((d) => d.lit).join(" ")} ${color.lit}`);
    }
    return { css: css.join(", "), lit: lit.join(", "), parts: [] };
  }

  private typography(c: Issues, at: string, path: string, raw: unknown, theme: Theme): Val | null {
    if (!isObject(raw)) {
      c.err(
        at,
        "must be an object { fontFamily, fontSize, fontWeight?, lineHeight?, letterSpacing? }",
      );
      return null;
    }
    if (
      !this.keys(c, at, raw, [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
      ])
    ) {
      return null;
    }
    const spec: [string, string, DsTokenType, boolean][] = [
      ["fontFamily", "font-family", "fontFamily", true],
      ["fontSize", "font-size", "dimension", true],
      ["fontWeight", "font-weight", "fontWeight", false],
      ["lineHeight", "line-height", "number", false],
      ["letterSpacing", "letter-spacing", "dimension", false],
    ];
    const parts: Val["parts"] = [];
    for (const [key, name, type, required] of spec) {
      const v = raw[key];
      if (v === undefined) {
        if (required) {
          c.err(`${at}.${key}`, "is required");
          return null;
        }
        continue;
      }
      // DTCG line heights are numbers; a dimension ("24px") is taken too.
      let partType = type;
      if (key === "lineHeight") {
        const dimension = isAlias(v)
          ? this.typeOf(aliasTarget(v)) === "dimension"
          : typeof v === "string" || isObject(v);
        if (dimension) partType = "dimension";
      }
      const p = this.part(c, `${at}.${key}`, partType, v, theme);
      if (!p) return null;
      parts.push({ name, css: p.css, lit: p.lit });
    }
    const get = (name: string) => parts.find((p) => p.name === name);
    const shorthand = (pick: (p: { css: string; lit: string }, name: string) => string) => {
      const w = get("font-weight");
      const lh = get("line-height");
      const size = get("font-size");
      const family = get("font-family");
      if (!size || !family) return "";
      return `${w ? `${pick(w, "font-weight")} ` : ""}${pick(size, "font-size")}${
        lh ? `/${pick(lh, "line-height")}` : ""
      } ${pick(family, "font-family")}`;
    };
    // The shorthand reads the parts' own variables, so a dark override of a part flows into it.
    const css = path
      ? shorthand((_p, name) => `var(${this.varOf(path, name)})`)
      : shorthand((p) => p.css);
    return { css, lit: shorthand((p) => p.lit), parts };
  }

  private border(c: Issues, at: string, raw: unknown, theme: Theme): Val | null {
    if (!isObject(raw)) {
      c.err(at, "must be an object { color, width, style }");
      return null;
    }
    if (!this.keys(c, at, raw, ["color", "width", "style"])) return null;
    if (typeof raw.style !== "string" || !BORDER_STYLES.has(raw.style)) {
      c.err(`${at}.style`, `must be one of ${[...BORDER_STYLES].join(", ")}`);
      return null;
    }
    const width = this.part(c, `${at}.width`, "dimension", raw.width, theme);
    const color = this.part(c, `${at}.color`, "color", raw.color, theme);
    if (!width || !color) return null;
    return {
      css: `${width.css} ${raw.style} ${color.css}`,
      lit: `${width.lit} ${raw.style} ${color.lit}`,
      parts: [],
    };
  }
}

function parseFonts(c: Issues, v: unknown): DsFont[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    c.err("fonts", "must be an array");
    return [];
  }
  if (v.length > L.maxFonts) {
    c.err("fonts", `holds more than ${L.maxFonts} fonts`);
    return [];
  }
  const out: DsFont[] = [];
  for (const [i, f] of v.entries()) {
    const at = `fonts[${i}]`;
    if (!isObject(f)) {
      c.err(at, "must be an object { family, google } or { family, src, weight?, style? }");
      continue;
    }
    for (const k of Object.keys(f)) {
      if (!["family", "google", "src", "weight", "style"].includes(k)) {
        c.err(`${at}.${k}`, "is not one of family, google, src, weight, style");
      }
    }
    if (typeof f.family !== "string" || !FAMILY_RE.test(f.family)) {
      c.err(`${at}.family`, "must be 1 to 64 letters, digits, spaces, '-' or '_'");
      continue;
    }
    const hasGoogle = f.google !== undefined;
    const hasSrc = f.src !== undefined;
    if (hasGoogle === hasSrc) {
      c.err(
        at,
        "needs exactly one of google (a Google Fonts URL) or src (a font file among the assets)",
      );
      continue;
    }
    if (hasGoogle) {
      if (
        typeof f.google !== "string" ||
        !f.google.startsWith(GOOGLE_PREFIX) ||
        GOOGLE_BAD.test(f.google) ||
        f.google.length > 2000
      ) {
        c.err(
          `${at}.google`,
          `must start with ${GOOGLE_PREFIX} and hold no quotes, spaces, < > \\ or #`,
        );
        continue;
      }
      if (f.weight !== undefined || f.style !== undefined) {
        c.err(at, "weight and style are for src fonts: a Google Fonts URL names its own");
        continue;
      }
      out.push({
        family: f.family,
        source: "google",
        href: f.google,
        src: null,
        weight: null,
        style: null,
      });
      continue;
    }
    if (typeof f.src !== "string" || !ASSET_PATH_RE.test(f.src) || !FONT_FILE_RE.test(f.src)) {
      c.err(`${at}.src`, "must be the relative path of a .woff2, .woff, .ttf or .otf asset");
      continue;
    }
    if (f.weight !== undefined && (typeof f.weight !== "string" || !WEIGHT_RE.test(f.weight))) {
      c.err(`${at}.weight`, 'must be like "400" or "100 900"');
      continue;
    }
    if (f.style !== undefined && f.style !== "normal" && f.style !== "italic") {
      c.err(`${at}.style`, "must be normal or italic");
      continue;
    }
    out.push({
      family: f.family,
      source: "asset",
      href: null,
      src: f.src,
      weight: (f.weight as string | undefined) ?? null,
      style: (f.style as "normal" | "italic" | undefined) ?? null,
    });
  }
  return out;
}

function parseComponents(c: Issues, v: unknown): DsComponent[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    c.err("components", "must be an array");
    return [];
  }
  if (v.length > L.maxComponents) {
    c.err("components", `holds more than ${L.maxComponents} components`);
    return [];
  }
  const ids = new Set<string>();
  const out: DsComponent[] = [];
  for (const [i, comp] of v.entries()) {
    if (c.full) break;
    const at = `components[${i}]`;
    if (!isObject(comp)) {
      c.err(at, "must be an object { id, name, examples, ... }");
      continue;
    }
    for (const k of Object.keys(comp)) {
      if (!["id", "name", "status", "description", "usage", "css", "examples"].includes(k)) {
        c.err(`${at}.${k}`, "is not one of id, name, status, description, usage, css, examples");
      }
    }
    if (typeof comp.id !== "string" || !COMPONENT_ID_RE.test(comp.id)) {
      c.err(
        `${at}.id`,
        "must be lowercase letters, digits and '-', starting with a letter, at most 48",
      );
      continue;
    }
    if (ids.has(comp.id)) {
      c.err(`${at}.id`, `${comp.id} is used by an earlier component`);
      continue;
    }
    ids.add(comp.id);
    const name = text(c, `${at}.name`, comp.name, { maxChars: L.maxNameLength, min: 1 });
    let status: DsComponentStatus = "stable";
    if (comp.status !== undefined) {
      if (
        typeof comp.status === "string" &&
        (DS_COMPONENT_STATUSES as readonly string[]).includes(comp.status)
      ) {
        status = comp.status as DsComponentStatus;
      } else c.err(`${at}.status`, "must be stable, beta or deprecated");
    }
    const opt = (k: "description" | "usage") =>
      comp[k] === undefined
        ? null
        : text(c, `${at}.${k}`, comp[k], { maxBytes: L.maxComponentTextBytes });
    const description = opt("description");
    const usage = opt("usage");
    let css: string | null = null;
    if (comp.css !== undefined) {
      css = text(c, `${at}.css`, comp.css, { maxBytes: L.maxComponentCssBytes });
      const problem = css === null ? null : cssBlockProblem(css);
      if (problem) {
        c.err(`${at}.css`, problem);
        css = null;
      }
    }
    const examples: DsExample[] = [];
    if (
      !Array.isArray(comp.examples) ||
      comp.examples.length < 1 ||
      comp.examples.length > L.maxExamples
    ) {
      c.err(`${at}.examples`, `must be an array of 1 to ${L.maxExamples} examples`);
    } else {
      for (const [j, ex] of comp.examples.entries()) {
        const ep = `${at}.examples[${j}]`;
        if (!isObject(ex)) {
          c.err(ep, "must be an object { name, html, height? }");
          continue;
        }
        for (const k of Object.keys(ex)) {
          if (!["name", "html", "height"].includes(k))
            c.err(`${ep}.${k}`, "is not one of name, html, height");
        }
        const exName = text(c, `${ep}.name`, ex.name, { maxChars: L.maxExampleNameLength, min: 1 });
        const html = text(c, `${ep}.html`, ex.html, { maxBytes: L.maxExampleHtmlBytes, min: 1 });
        let height: number = L.defaultExampleHeight;
        if (ex.height !== undefined) {
          if (
            typeof ex.height === "number" &&
            Number.isInteger(ex.height) &&
            ex.height >= L.minExampleHeight &&
            ex.height <= L.maxExampleHeight
          ) {
            height = ex.height;
          } else {
            c.err(
              `${ep}.height`,
              `must be a whole number from ${L.minExampleHeight} to ${L.maxExampleHeight}`,
            );
          }
        }
        if (html !== null && INERT_MARKUP_RE.test(html)) {
          c.warn(
            "ds_inert_markup",
            `${ep}.html`,
            "Previews do not run scripts, forms or frames; that markup is removed in previews. Show states with classes instead.",
          );
        }
        if (exName !== null && html !== null) examples.push({ name: exName, html, height });
      }
    }
    if (name !== null) {
      out.push({ id: comp.id, name, status, description, usage, css, examples });
    }
  }
  return out;
}

/**
 * Parse and check a design system's JSON. Never throws: a refusal lists at most 50 problems, each
 * with its path, so an agent can fix them all in one go.
 */
export function parseDesignSystem(source: string): DsParseResult {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch (e) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `is not valid JSON (${e instanceof Error ? e.message : "parse error"})`,
        },
      ],
    };
  }
  return parseDesignSystemValue(root);
}

/**
 * Whether `value` nests at most `max` objects and arrays (the value itself counts as one), walked
 * without recursion, so a value too deep to write out with JSON.stringify is answered too.
 */
export function dsJsonDepthWithin(value: unknown, max: number = L.maxJsonDepth): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [v, depth] = top;
    if (typeof v !== "object" || v === null) continue;
    if (depth > max) return false;
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      if (typeof x === "object" && x !== null) stack.push([x, depth + 1]);
    }
  }
  return true;
}

/**
 * Check a design system that is already parsed JSON (parseDesignSystem without the parse): the
 * room checks a page edit on the value it holds, without writing it out as text first.
 */
export function parseDesignSystemValue(root: unknown): DsParseResult {
  const c = new Issues();
  if (!isObject(root)) {
    return { ok: false, errors: [{ path: "", message: "must be a JSON object" }] };
  }
  // Before anything walks it: every reader (and the page's draft) writes it out again.
  if (!dsJsonDepthWithin(root)) {
    return {
      ok: false,
      errors: [
        { path: "", message: `nests objects and arrays deeper than ${L.maxJsonDepth} levels` },
      ],
    };
  }
  for (const k of Object.keys(root)) {
    if (!TOP_KEYS.has(k)) c.err(k, `is not a design system field (${[...TOP_KEYS].join(", ")})`);
  }
  if (root.format !== DESIGN_SYSTEM_FORMAT) {
    c.err("format", `must be "${DESIGN_SYSTEM_FORMAT}"`);
  }
  const name = text(c, "name", root.name, { maxChars: L.maxNameLength, min: 1 });
  const description =
    root.description === undefined
      ? null
      : text(c, "description", root.description, { maxBytes: L.maxDescriptionBytes });
  let prefix = "ds";
  if (root.prefix !== undefined) {
    if (typeof root.prefix === "string" && PREFIX_RE.test(root.prefix)) prefix = root.prefix;
    else c.err("prefix", "must be a lowercase letter then up to 15 lowercase letters or digits");
  }
  const fonts = parseFonts(c, root.fonts);
  const guidelines =
    root.guidelines === undefined
      ? null
      : text(c, "guidelines", root.guidelines, { maxBytes: L.maxGuidelinesBytes });
  let css: string | null = null;
  if (root.css !== undefined) {
    css = text(c, "css", root.css, { maxBytes: L.maxCssBytes });
    const problem = css === null ? null : cssBlockProblem(css);
    if (problem) {
      c.err("css", problem);
      css = null;
    }
  }

  const raw: RawToken[] = [];
  if (!isObject(root.tokens)) c.err("tokens", "is required: an object of token groups");
  else walkTokens(c, root.tokens, [], null, false, raw);

  const known = new Map(raw.map((t) => [t.path, t]));
  const dark = new Map<string, unknown>();
  let hasDarkTheme = false;
  if (root.themes !== undefined) {
    if (!isObject(root.themes)) c.err("themes", "must be an object");
    else {
      for (const k of Object.keys(root.themes)) {
        if (k !== "dark") c.err(`themes.${k}`, "is not a theme: format 1 has only dark");
      }
      if (root.themes.dark !== undefined) {
        if (!isObject(root.themes.dark))
          c.err("themes.dark", "must be an object of token overrides");
        else {
          hasDarkTheme = true;
          walkDark(c, root.themes.dark, [], known, dark);
        }
      }
    }
  }

  const comp = new Compiler(c, prefix, raw, dark);
  comp.resolveTypes();
  const tokens: DsToken[] = [];
  for (const t of raw) {
    if (c.full) break;
    const cssVar = comp.varOf(t.path);
    const type = comp.typeOf(t.path);
    if (!type) continue;
    const light = comp.value(t.path, "light");
    const darkVal = hasDarkTheme ? comp.value(t.path, "dark") : null;
    const override = dark.has(t.path) ? darkVal : null;
    const parts = light ? tokenParts(light, darkVal, override !== null) : [];
    // Every variable a token adds, its typography parts included, must be its own.
    const vars = [cssVar, ...parts.map((p) => comp.varOf(t.path, p.name))];
    let clash = false;
    for (const v of vars) {
      const other = comp.cssVars.get(v);
      if (other !== undefined && other !== t.path) {
        c.err(`tokens.${t.path}`, `becomes ${v}, as tokens.${other} does: rename one of them`);
        clash = true;
      } else comp.cssVars.set(v, t.path);
    }
    if (!light || clash) continue;
    const aliasOf = isAlias(t.value) ? aliasTarget(t.value) : null;
    if (aliasOf && !t.deprecated) {
      const target = known.get(aliasOf);
      if (target?.deprecated) {
        c.warn(
          "ds_deprecated_alias",
          `tokens.${t.path}.$value`,
          `{${aliasOf}} is deprecated; point this token at its replacement`,
        );
      }
    }
    tokens.push({
      path: t.path,
      cssVar,
      type,
      cssValue: light.css,
      darkCssValue: override?.css ?? null,
      value: light.lit,
      dark: darkVal && darkVal.lit !== light.lit ? darkVal.lit : null,
      aliasOf,
      description: t.description,
      deprecated: t.deprecated,
      parts: parts.map((p) => ({ ...p, cssVar: comp.varOf(t.path, p.name) })),
    });
  }

  const components = parseComponents(c, root.components);
  if (c.errors.length > 0 || name === null) {
    return {
      ok: false,
      errors: c.errors.length > 0 ? c.errors : [{ path: "name", message: "is required" }],
    };
  }
  if (!hasDarkTheme) {
    c.warn(
      "ds_no_dark_theme",
      "themes",
      "No themes.dark: pages built on this design system will not follow dark mode. Add dark values for the colors.",
    );
  }
  return {
    ok: true,
    value: { name, description, prefix, fonts, tokens, hasDarkTheme, guidelines, css, components },
    warnings: c.warnings,
  };
}

/** A typography token's parts, in the order its variables list them. */
const TYPOGRAPHY_PARTS = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
] as const;

/**
 * A token's part variables: every part either theme gives it, so neither theme's font shorthand
 * reads a variable only the other one sets. A theme that leaves an optional part out sets it to
 * `normal`, which is what its shorthand resets that part to (font-family and font-size are required
 * in both). Without a dark override of the token itself, the dark blocks set only a part its light
 * value lacks (an alias whose target's dark value adds one); the rest follow their var().
 */
function tokenParts(
  light: Val,
  dark: Val | null,
  overridden: boolean,
): Omit<DsTokenPart, "cssVar">[] {
  const out: Omit<DsTokenPart, "cssVar">[] = [];
  for (const name of TYPOGRAPHY_PARTS) {
    const l = light.parts.find((p) => p.name === name);
    const d = dark?.parts.find((p) => p.name === name);
    if (!l && !d) continue;
    out.push({
      name,
      cssValue: l?.css ?? "normal",
      darkCssValue: overridden ? (d?.css ?? "normal") : l ? null : (d?.css ?? null),
    });
  }
  return out;
}

// ---------- compiled output ----------

function declarations(tokens: readonly DsToken[], theme: Theme): string {
  let out = "";
  for (const t of tokens) {
    if (theme === "light") {
      for (const p of t.parts) out += `${p.cssVar}:${p.cssValue};`;
      out += `${t.cssVar}:${t.cssValue};`;
    } else {
      for (const p of t.parts) if (p.darkCssValue !== null) out += `${p.cssVar}:${p.darkCssValue};`;
      if (t.darkCssValue !== null) out += `${t.cssVar}:${t.darkCssValue};`;
    }
  }
  return out;
}

/**
 * The design system's tokens as CSS custom properties: a :root block, then the dark theme for
 * `prefers-color-scheme: dark` (unless the page set data-theme="light") and for
 * data-theme="dark". The light/dark pattern every Plinth page uses.
 */
export function designSystemCss(ds: Pick<DesignSystem, "tokens">): string {
  const light = declarations(ds.tokens, "light");
  const dark = declarations(ds.tokens, "dark");
  const out = [`:root{${light}}`];
  if (dark) {
    out.push(`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`);
    out.push(`:root[data-theme="dark"]{${dark}}`);
  }
  return out.join("\n");
}

/** The Google Fonts stylesheets to add as <link rel="stylesheet">, in order, without repeats. */
export function designSystemFontLinks(ds: Pick<DesignSystem, "fonts">): string[] {
  return [...new Set(ds.fonts.flatMap((f) => (f.href ? [f.href] : [])))];
}

const FONT_FORMATS: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/**
 * @font-face rules for the fonts stored as the design system's own files. Only for the design
 * system's own pages: another artifact cannot load these files.
 */
export function designSystemFontFaces(ds: Pick<DesignSystem, "fonts">): string {
  return ds.fonts
    .flatMap((f) => {
      if (!f.src) return [];
      const ext = f.src.slice(f.src.lastIndexOf(".") + 1).toLowerCase();
      return [
        `@font-face{font-family:"${f.family}";src:url("${f.src}") format("${FONT_FORMATS[ext] ?? "woff2"}");` +
          `font-weight:${f.weight ?? "400"};font-style:${f.style ?? "normal"};font-display:swap}`,
      ];
    })
    .join("\n");
}

/** The shared CSS and each component's own, each under a comment naming it. */
export function designSystemComponentCss(
  ds: Pick<DesignSystem, "css" | "components">,
  components: readonly DsComponent[] = ds.components,
): string {
  const parts: string[] = [];
  if (ds.css) parts.push(`/* shared */\n${ds.css}`);
  for (const comp of components) if (comp.css) parts.push(`/* ${comp.id} */\n${comp.css}`);
  return parts.join("\n");
}

// ---------- the reference on HTML pages ----------

/** `<meta name="plinth-design-system" content="<id>[@<version>]">` names a page's design system. */
export const DESIGN_SYSTEM_META = "plinth-design-system";

const REF_RE = /^([a-z0-9]{20})(?:@([1-9]\d{0,8}))?$/;
const HAS_META_RE = /plinth-design-system/i;

const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";

/** Whether `<name` starts a tag at `at` (ASCII case-insensitive, then a space, `/` or `>`). */
function tagAt(s: string, at: number, name: string): boolean {
  for (let k = 0; k < name.length; k++) {
    if ((s.charCodeAt(at + 1 + k) | 0x20) !== name.charCodeAt(k)) return false;
  }
  const next = s[at + 1 + name.length];
  return isSpace(next) || next === "/" || next === ">";
}

/**
 * A start tag's attributes from `i` (just past its name) to its `>`, the way an HTML tokenizer
 * reads them: names lowercased, values quoted or not, the first of a repeated name kept. Null when
 * the input ends inside the tag, which a browser drops. Each character is read once.
 */
function readAttributes(s: string, i: number): { attrs: Map<string, string>; end: number } | null {
  const attrs = new Map<string, string>();
  const n = s.length;
  for (;;) {
    while (i < n && (isSpace(s[i]) || s[i] === "/")) i++;
    if (i >= n) return null;
    if (s[i] === ">") return { attrs, end: i + 1 };
    const nameStart = i;
    i++; // A name's first character may be "=".
    while (i < n && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const name = s.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < n && isSpace(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        if (close < 0) return null;
        value = s.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(s[i]) && s[i] !== ">") i++;
        value = s.slice(valueStart, i);
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
}

/**
 * The design system an HTML page names in its head, or null. The first such meta wins. It runs on
 * every HTML publish and every get_artifact of an HTML page, so it is one forward pass over at
 * most 256 KB, with no regular expression that can backtrack: comments are skipped (an unclosed
 * one runs to the end, as in a browser), and the scan stops at <body>.
 */
export function parseDesignSystemRef(html: string): { id: string; version: number | null } | null {
  const s = html.slice(0, 256 * 1024);
  if (!HAS_META_RE.test(s)) return null;
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) return null;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (tagAt(s, lt, "body")) return null;
    if (!tagAt(s, lt, "meta")) {
      i = lt + 1;
      continue;
    }
    const tag = readAttributes(s, lt + 5);
    if (!tag) return null;
    i = tag.end;
    if (tag.attrs.get("name")?.trim().toLowerCase() !== DESIGN_SYSTEM_META) continue;
    const ref = REF_RE.exec((tag.attrs.get("content") ?? "").trim());
    if (!ref) return null;
    return { id: ref[1] as string, version: ref[2] ? Number(ref[2]) : null };
  }
}

// ---------- editing on the page: the editable values ----------
//
// People change a design system on its page one JSON value at a time (designSystemLive.ts): a
// token's light or dark $value, a token's $description, the system's name and description, and a
// component's description, usage and status. Everything else (types, names, component HTML and
// CSS, the root CSS, format, prefix and fonts) stays with agents. Each change is checked here
// against the same rules as a publish, on the whole system, so a draft can always be published.

/** A JSON path into system.json: object keys, and an array index for a component. */
export type DsPath = readonly (string | number)[];

/** What one editable value is. */
export type DsNodeKind =
  | "name"
  | "description"
  | "token_value"
  | "dark_value"
  | "token_description"
  | "component_text"
  | "component_status";

/** A token or group name (one path segment), as the format takes it. */
export function isDsName(s: string): boolean {
  return NAME_RE.test(s) && !s.startsWith("$");
}

/** The token an alias value names ("{color.brand.500}" gives "color.brand.500"), or null. */
export function dsAliasOf(v: unknown): string | null {
  return isAlias(v) ? aliasTarget(v) : null;
}

/** The value at `path` in `root`, or undefined (own properties only). */
export function dsGet(root: unknown, path: DsPath): unknown {
  let at: unknown = root;
  for (const seg of path) {
    if (typeof seg === "number") {
      if (!Array.isArray(at) || seg < 0 || seg >= at.length) return undefined;
      at = at[seg];
    } else {
      if (!isObject(at) || !Object.hasOwn(at, seg)) return undefined;
      at = at[seg];
    }
  }
  return at;
}

/** Sets an object's own property as data, so a key like "__proto__" stays a key. */
export function dsSetOwn(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `root` with `value` at `path` (undefined removes the key), copying only the objects and arrays on
 * the way, so the input is unchanged. A new key goes last in its object. Null when a step of the
 * path is missing (only the last key may be new).
 */
export function dsWith(root: unknown, path: DsPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [seg, ...rest] = path;
  if (typeof seg === "number") {
    if (!Array.isArray(root) || seg < 0 || seg >= root.length) return null;
    const next = rest.length === 0 ? value : dsWith(root[seg], rest, value);
    if (next === null && rest.length > 0) return null;
    const copy = [...root];
    copy[seg] = next;
    return copy;
  }
  if (!isObject(root) || seg === undefined) return null;
  if (rest.length > 0 && !Object.hasOwn(root, seg)) return null;
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(root)) {
    if (k === seg && rest.length === 0) {
      if (value !== undefined) dsSetOwn(copy, k, value);
      continue;
    }
    dsSetOwn(copy, k, k === seg ? dsWith(root[k], rest, value) : root[k]);
  }
  if (rest.length > 0 && copy[seg] === null) return null;
  if (rest.length === 0 && value !== undefined && !Object.hasOwn(root, seg)) {
    dsSetOwn(copy, seg, value);
  }
  return copy;
}

/** A path as the parser's problems name it: "tokens.color.brand.500.$value", "components[1].usage". */
export function dsPathText(path: DsPath): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** Whether `segs` names a token in `group` (an object holding $value), every segment a name. */
function isTokenAt(group: unknown, segs: readonly (string | number)[]): boolean {
  if (segs.length === 0 || segs.length > L.maxDepth) return false;
  if (!segs.every((s) => typeof s === "string" && isDsName(s))) return false;
  const t = dsGet(group, segs);
  return isObject(t) && Object.hasOwn(t, "$value");
}

/** Which editable value `path` is in `root`, or null: anything else stays with agents. */
export function dsEditableKind(root: unknown, path: DsPath): DsNodeKind | null {
  if (!isObject(root)) return null;
  const last = path[path.length - 1];
  if (path.length === 1) {
    if (last === "name") return "name";
    if (last === "description") return "description";
    return null;
  }
  if (path[0] === "tokens") {
    const segs = path.slice(1, -1);
    if (last === "$value" && isTokenAt(root.tokens, segs)) return "token_value";
    if (last === "$description" && isTokenAt(root.tokens, segs)) return "token_description";
    return null;
  }
  if (path[0] === "themes" && path[1] === "dark" && last === "$value") {
    const segs = path.slice(2, -1);
    return isTokenAt(dsGet(root, ["themes", "dark"]), segs) && isTokenAt(root.tokens, segs)
      ? "dark_value"
      : null;
  }
  if (path[0] === "components" && path.length === 3 && typeof path[1] === "number") {
    if (!isObject(dsGet(root, ["components", path[1]]))) return null;
    if (last === "description" || last === "usage") return "component_text";
    if (last === "status") return "component_status";
  }
  return null;
}

/** The first problem in `errors`, preferring one at or under `at`. */
function firstAt(errors: readonly DsIssue[], at: string): DsIssue | null {
  const under = (p: string) => p === at || p.startsWith(`${at}.`) || p.startsWith(`${at}[`);
  return errors.find((e) => under(e.path)) ?? errors[0] ?? null;
}

/**
 * Why `value` may not be put at `path` of the design system `root` (with its guidelines as a
 * string, or absent), or null when it may. `path` must name an editable value (dsEditableKind)
 * once it is set, so an optional text that is absent may be set too. The new system is checked
 * whole, as a publish checks it: the value grammar for the token's type (which may come from its
 * groups), aliases (the target exists, has the same type, makes no cycle), the length of every
 * text, and the component statuses. Linear in the system.
 */
export function dsValueProblem(root: unknown, path: DsPath, value: unknown): DsIssue | null {
  const at = dsPathText(path);
  const next = dsWith(root, path, value);
  const kind = next === null ? null : dsEditableKind(next, path);
  if (next === null || kind === null) return { path: at, message: "can't be changed on the page" };
  if (kind === "name") {
    if (typeof value !== "string" || value.trim() === "") {
      return { path: at, message: "may not be empty" };
    }
    if (value.length > L.maxNameLength) {
      return { path: at, message: `is longer than ${L.maxNameLength} characters` };
    }
  } else if (kind === "description" || kind === "token_description" || kind === "component_text") {
    const max = kind === "component_text" ? L.maxComponentTextBytes : L.maxDescriptionBytes;
    if (typeof value !== "string") return { path: at, message: "must be a string" };
    if (bytes(value) > max) {
      return { path: at, message: `is larger than ${Math.round(max / 1024)} KB` };
    }
  } else if (kind === "component_status") {
    if (
      typeof value !== "string" ||
      !(DS_COMPONENT_STATUSES as readonly string[]).includes(value)
    ) {
      return { path: at, message: "must be stable, beta or deprecated" };
    }
  }
  const r = parseDesignSystemValue(next);
  return r.ok ? null : firstAt(r.errors, at);
}

/**
 * The type a token at `segs` (its path under tokens) declares, from its own $type or its groups',
 * or null when none gives one (an alias then takes its target's).
 */
export function dsDeclaredType(root: unknown, segs: readonly string[]): DsTokenType | null {
  let type: DsTokenType | null = null;
  let at: unknown = isObject(root) ? root.tokens : undefined;
  for (let i = 0; i <= segs.length; i++) {
    if (!isObject(at)) return type;
    const t = at.$type;
    if (typeof t === "string" && (DS_TOKEN_TYPES as readonly string[]).includes(t)) {
      type = t as DsTokenType;
    }
    const seg = segs[i];
    if (seg !== undefined) at = Object.hasOwn(at, seg) ? at[seg] : undefined;
  }
  return type;
}
