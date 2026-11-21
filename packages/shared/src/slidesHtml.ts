// An HTML deck (docs/spec.md "Slides", "HTML decks"): the slides type's second format, Claude's
// slide format beside the Markdown one. A version holds `deck.json` (the index: title, order,
// sections, cover, size, faces, designSystems), `deck.css` (shared rules) and one
// `slides/<id>.html` per slide, each a single `<section id="<id>">` on a fixed 1920x1080 canvas
// (1440x1080 at 4:3) with an `<aside>` of speaker notes. A version whose source is deck.json is an
// HTML deck; one whose source is slides.md is a Markdown deck, as before.
//
// One parser for the Worker (refusals and publish warnings) and the renderer (which builds the DOM
// from the tree this file returns, never from the markup). It is a strict tokenizer for the
// element allowlist below, not a browser's HTML parser: markup it cannot read plainly is refused,
// so the renderer never meets anything a browser could read two ways. Pure and zod-free, so the
// renderer bundle can import it; linear in its input (no backtracking regular expression runs over
// author text).

import { LIMITS } from "./constants.ts";
import { cssBlockProblem, cssUrlArgs, isPlainRelativeUrl } from "./designSystem.ts";

/** The files of an HTML deck. */
export const HTML_DECK_INDEX = "deck.json";
export const HTML_DECK_CSS = "deck.css";
export const HTML_DECK_SLIDES_DIR = "slides/";

/** The fixed canvases of an HTML deck, in CSS pixels, and the standard margin. */
export const HTML_DECK_CANVAS = {
  "16:9": { width: 1920, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
} as const;
export type HtmlDeckSize = keyof typeof HTML_DECK_CANVAS;
export const HTML_DECK_MARGIN = 128;

const KB = 1024;

/** Claude's limits for a slide and a deck, plus the byte limits Plinth reads them under. */
export const HTML_DECK_LIMITS = {
  /** Boxes (every element but inline phrases and line breaks) on one slide. */
  maxBoxes: 200,
  /** `<div>`s nested in one another. */
  maxDivDepth: 15,
  /** Pinned children (position:absolute, an x-embed, a connector with coordinates) of one parent. */
  maxPinned: 24,
  /** Bytes of one inline `<svg>`. */
  maxSvgBytes: 52 * KB,
  maxTableRows: 100,
  maxTableColumns: 24,
  /** Characters of speaker notes on one slide; the rest is cut. */
  maxNotes: 4000,
  /** Characters of slide text (notes excluded). */
  maxSlideText: 20_000,
  /** Bytes of one x-embed's page. */
  maxEmbedBytes: 16 * KB,
  maxEmbedsPerSlide: 8,
  /** Font families across `faces`. */
  maxFamilies: 4,
  /** Design systems recorded in `designSystems`. */
  maxDesignSystems: 4,
  /** Bytes of one slide file, of deck.css and of deck.json. */
  maxSlideBytes: 256 * KB,
  maxCssBytes: 256 * KB,
  maxIndexBytes: 256 * KB,
  /** Bytes of deck.json, deck.css and every slide file together. */
  maxDeckBytes: 4 * KB * KB,
  /** Problems a refusal lists. */
  maxErrors: 50,
} as const;
const L = HTML_DECK_LIMITS;

/**
 * An x-embed's frame: Plinth's fixed loader at /__plinth/frames/slides/<file> (the registry's
 * renderer.frame), framed with this sandbox only (no allow-same-origin: an opaque origin) and
 * served with a CSP that allows inline script and nothing from the network. The renderer posts the
 * embed's page to it once, after it says it is ready. Protocol version 1:
 *   loader -> parent: { source, v, type: "ready" }        posted to "*" once, on load
 *   parent -> loader: { source, v, type: "render", html } from the parent window only, once
 */
export const SLIDE_EMBED_FILE = "embed.html";
export const SLIDE_EMBED_SANDBOX = "allow-scripts";
export const SLIDE_EMBED_MESSAGE_SOURCE = "plinth-slide-embed";
export const SLIDE_EMBED_PROTOCOL_VERSION = 1;

/** A slide id, which is also its file name: `slides/<id>.html`. */
export const SLIDE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLIDE_PATH_RE = /^slides\/([A-Za-z0-9_-]{1,64})\.html$/;
/** A design system's folder under ds/, as Claude names it. */
export const DS_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FAMILY_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const GOOGLE_CSS2 = "https://fonts.googleapis.com/css2?";
const GOOGLE_QUERY_RE = /^[A-Za-z0-9+:@;,.&=_-]{1,1000}$/;
const FONT_FILE_RE = /\.(woff2|woff|ttf|otf)$/i;
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CLASS_RE = /^-?[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DATA_ATTR_RE = /^data-[a-z0-9][a-z0-9-]{0,40}$/;
const ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_:.-]{0,63}$/;

/** The slide id of a version path, or null when the path is not a slide file. */
export function slideIdOfPath(path: string): string | null {
  return SLIDE_PATH_RE.exec(path)?.[1] ?? null;
}

/** Whether a stored or sent source is an HTML deck's index: JSON, whose first character is `{`. */
export function isHtmlDeckIndex(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") continue;
    return c === "{";
  }
  return false;
}

// ---------- the tree ----------

export interface DeckText {
  kind: "text";
  text: string;
}

export interface DeckElement {
  kind: "el";
  /** The tag the renderer creates: an allowlisted HTML tag, or x-shape, x-icon, x-connector, x-embed. */
  tag: string;
  /** Allowlisted attributes, values decoded. */
  attrs: [string, string][];
  children: DeckNode[];
  /** 1-based line in the slide file. */
  line: number;
  /** An inline `<svg>`, shown as an image: its XML, a still copy without animation, its alt. */
  svg?: { xml: string; still: string; alt: string };
  /** An `<x-embed>`'s page, as written. */
  embed?: string;
}

export type DeckNode = DeckText | DeckElement;

export interface HtmlSlide {
  id: string;
  path: string;
  /** The `<section>`, without its `<aside>`. */
  section: DeckElement;
  /** Speaker notes as plain text ("" for none), at most maxNotes characters. */
  notes: string;
  /** `hidden` on the section: the slide is skipped. */
  hidden: boolean;
  /** How this slide leaves (data-transition), or null. */
  transition: "fade" | "push" | "magic" | null;
  /** The first heading's text, else the first text, cut to 60 characters ("" for none). */
  title: string;
  /** Image paths the slide shows, once each. */
  images: string[];
  /** url() paths its style attributes name, once each. */
  cssRefs: string[];
}

export interface DeckFace {
  key: string;
  family: string;
  /** A Google Fonts css2 link, or null. */
  href: string | null;
  /** A font file of the version (a design system's under ds/, or the deck's own), or null. */
  src: string | null;
}

export interface DeckSection {
  key: string;
  description: string;
  /** The id of the section's first slide, or null for an empty section. */
  start: string | null;
}

export interface HtmlDeckIndex {
  title: string | null;
  size: HtmlDeckSize;
  /** Slide ids, as deck.json lists them (ids without a file are dropped by parseHtmlDeck). */
  order: string[] | null;
  cover: string | null;
  sections: DeckSection[];
  faces: DeckFace[];
  /**
   * The design systems installed into ds/<namespace>/ (a server-side copy writes them), kept as
   * written. Plinth reads only their namespaces, to check font paths; nothing here loads anything.
   */
  designSystems: unknown[];
}

export interface HtmlDeck extends HtmlDeckIndex {
  canvas: { width: number; height: number };
  /** Every slide, in deck order (order first, then files order does not list, by id). */
  slides: HtmlSlide[];
  /** deck.css, "" for none. */
  css: string;
}

export type DeckIssueCode = "slides_setting" | "slide_markup" | "slide_empty" | "missing_file";

export interface DeckIssue {
  /** The file the problem is in (deck.json, deck.css or slides/<id>.html). */
  file: string;
  line?: number;
  message: string;
}

export interface DeckWarning extends DeckIssue {
  code: DeckIssueCode;
  ref?: string;
}

export type HtmlDeckResult =
  | { ok: true; deck: HtmlDeck; warnings: DeckWarning[] }
  | { ok: false; errors: DeckIssue[]; warnings: DeckWarning[] };

/**
 * At most 40 characters of author text, for a message, control characters as \uXXXX (as the
 * Markdown parser quotes deck text).
 */
function clip(s: string, max = 40): string {
  const chars = [...s];
  let out = "";
  for (const ch of chars.slice(0, max)) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
  }
  return chars.length > max ? `${out}…` : out;
}

/** UTF-8 length without TextEncoder, as designSystem.ts counts it. */
export function utf8Bytes(s: string): number {
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

class Problems {
  readonly errors: DeckIssue[] = [];
  readonly warnings: DeckWarning[] = [];
  err(file: string, message: string, line?: number): void {
    if (this.errors.length < L.maxErrors) {
      this.errors.push({ file, message, ...(line !== undefined ? { line } : {}) });
    }
  }
  warn(code: DeckIssueCode, file: string, message: string, line?: number, ref?: string): void {
    this.warnings.push({
      code,
      file,
      message,
      ...(line !== undefined ? { line } : {}),
      ...(ref !== undefined ? { ref } : {}),
    });
  }
}

// ---------- entities ----------

/** Named entities an HTML slide may use; any other is refused (write the character or &#N;). */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "­",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  Dagger: "‡",
  permil: "‰",
  prime: "′",
  Prime: "″",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  rArr: "⇒",
  lArr: "⇐",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  micro: "µ",
  hearts: "♥",
  star: "☆",
  check: "✓",
};
/** The five an SVG (read as XML) knows. */
const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

// ---------- what a slide may hold ----------

/** HTML tags the renderer creates as they are. */
const HTML_TAGS = new Set([
  "section",
  "h1",
  "h2",
  "h3",
  "p",
  "ul",
  "ol",
  "li",
  "br",
  "b",
  "i",
  "u",
  "a",
  "span",
  "div",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "aside",
]);
const X_TAGS = new Set(["x-shape", "x-icon", "x-connector", "x-embed"]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
/** Other HTML tags, which become a plain box (Claude: "become plain boxes and text"). */
const BLOCK_FALLBACK = new Set([
  "header",
  "footer",
  "main",
  "nav",
  "article",
  "figure",
  "figcaption",
  "blockquote",
  "h4",
  "h5",
  "h6",
  "dl",
  "dt",
  "dd",
  "pre",
  "address",
  "details",
  "summary",
  "hgroup",
  "center",
]);
/** And inline ones, which become a phrase. */
const INLINE_FALLBACK: Record<string, string> = {
  strong: "b",
  em: "i",
  code: "span",
  small: "span",
  sup: "span",
  sub: "span",
  mark: "span",
  s: "span",
  del: "span",
  ins: "u",
  q: "span",
  cite: "i",
  abbr: "span",
  time: "span",
  kbd: "span",
  var: "i",
  samp: "span",
  dfn: "i",
  bdi: "span",
  bdo: "span",
  big: "span",
  tt: "span",
  strike: "span",
  label: "span",
  data: "span",
  font: "span",
};
/** Tags that run, load, submit or take input: refused wherever they appear outside an x-embed. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "canvas",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "optgroup",
  "fieldset",
  "legend",
  "datalist",
  "output",
  "link",
  "meta",
  "base",
  "template",
  "noscript",
  "html",
  "head",
  "body",
  "title",
  "math",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "portal",
  "dialog",
  "slot",
  "param",
  "map",
  "area",
  "image",
  "foreignobject",
]);
/** Boxes are every element but these phrases (Claude's 200-box cap). */
const NOT_BOXES = new Set(["b", "i", "u", "a", "span", "br", "aside", "thead", "tbody"]);
const GLOBAL_ATTRS = new Set([
  "id",
  "class",
  "style",
  "title",
  "lang",
  "dir",
  "hidden",
  "aria-label",
  "aria-hidden",
]);
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan"],
  th: ["colspan"],
  ol: ["start", "reversed"],
  "x-shape": ["kind"],
  "x-icon": ["name"],
  "x-connector": ["x1", "y1", "x2", "y2", "head", "head-start", "head-end", "route", "from"],
};

export const X_SHAPE_KINDS = [
  "rect",
  "rounded",
  "ellipse",
  "diamond",
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "line",
] as const;
export type XShapeKind = (typeof X_SHAPE_KINDS)[number];

/** Claude's icon names, which Plinth draws (renderer html/icons.ts). */
export const X_ICON_NAMES = [
  "Activity",
  "Book",
  "Chart",
  "Chat",
  "Check",
  "CheckCircle",
  "Clock",
  "Cloud",
  "Code",
  "Database",
  "Globe",
  "GraduationCap",
  "Home",
  "Key",
  "Lightbulb",
  "Lightning",
  "Link",
  "Lock",
  "PaperPlane",
  "Play",
  "Search",
  "Settings",
  "Star",
  "ThumbsUp",
  "Tool",
  "Trust",
  "Users",
  "Verified",
  "Warning",
  "Wrench",
] as const;
export type XIconName = (typeof X_ICON_NAMES)[number];

export const CONNECTOR_ROUTES = ["straight", "hv", "vh", "elbow"] as const;
export const CONNECTOR_HEADS = ["end", "both", "none"] as const;
export const CONNECTOR_HEAD_STYLES = ["none", "open", "filled"] as const;
const CONNECTOR_COORD_RE = /^-?(?:\d{1,5}|\d{0,5}\.\d{1,3})(?:px|%)?$/;

/** SVG elements an inline drawing may hold, in their XML spelling. Anything else is refused. */
const SVG_TAGS = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "marker",
  "clipPath",
  "mask",
  "pattern",
  "use",
  "symbol",
  "title",
  "desc",
  "style",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "mpath",
  "metadata",
];
const SVG_BY_LOWER = new Map(SVG_TAGS.map((t) => [t.toLowerCase(), t]));
const SVG_ANIMATION = new Set(["animate", "animateMotion", "animateTransform", "set"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
/** Only local references: url(#id) and href="#id". */
const LOCAL_REF_RE = /^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

// ---------- the tokenizer ----------

interface RawTag {
  name: string;
  /** As written (SVG keeps its case). */
  rawName: string;
  attrs: [string, string][];
  selfClosing: boolean;
  start: number;
  end: number;
}

/** One pass over a slide file. Every method moves forward; nothing backtracks. */
class Reader {
  i = 0;
  private lineAt = 0;
  private line = 1;
  readonly s: string;
  readonly file: string;
  readonly p: Problems;
  constructor(s: string, file: string, p: Problems) {
    this.s = s;
    this.file = file;
    this.p = p;
  }

  /** The 1-based line of offset `at` (at never decreases between calls). */
  lineOf(at: number): number {
    if (at < this.lineAt) {
      this.lineAt = 0;
      this.line = 1;
    }
    for (let k = this.lineAt; k < at && k < this.s.length; k++) if (this.s[k] === "\n") this.line++;
    this.lineAt = Math.max(this.lineAt, at);
    return this.line;
  }

  get done(): boolean {
    return this.i >= this.s.length;
  }

  /** Decodes entities in a text run; null after reporting one that is not allowed. */
  decode(raw: string, at: number, xml: boolean): string | null {
    if (!raw.includes("&")) return raw;
    let out = "";
    let k = 0;
    while (k < raw.length) {
      const amp = raw.indexOf("&", k);
      if (amp < 0) {
        out += raw.slice(k);
        break;
      }
      out += raw.slice(k, amp);
      const semi = raw.indexOf(";", amp + 1);
      const body = semi > amp && semi - amp <= 33 ? raw.slice(amp + 1, semi) : null;
      if (body === null) {
        if (xml) {
          this.p.err(this.file, "an & in an <svg> must be written &amp;", this.lineOf(at + amp));
          return null;
        }
        out += "&";
        k = amp + 1;
        continue;
      }
      let ch: string | undefined;
      const num = /^#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(body);
      if (num) {
        const code = num[1] !== undefined ? Number.parseInt(num[1], 16) : Number(num[2]);
        if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
          ch = String.fromCodePoint(code);
        }
      } else if (xml ? XML_ENTITIES.has(body) : Object.hasOwn(HTML_ENTITIES, body)) {
        ch = HTML_ENTITIES[body];
      }
      if (ch === undefined) {
        this.p.err(
          this.file,
          xml
            ? `&${clip(body, 20)}; is not an entity an <svg> knows: write the character itself or &#N;`
            : `&${clip(body, 20)}; is not an entity Slides reads: write the character itself or &#N;`,
          this.lineOf(at + amp),
        );
        return null;
      }
      out += ch;
      k = semi + 1;
    }
    return out;
  }

  /**
   * The tag at `i` (which holds "<" followed by a letter or "/"), or null after reporting why it
   * cannot be read. Moves past the tag.
   */
  tag(xml: boolean): (RawTag & { close: boolean }) | null {
    const s = this.s;
    const start = this.i;
    let k = start + 1;
    const close = s[k] === "/";
    if (close) k++;
    const nameStart = k;
    while (k < s.length && /[A-Za-z0-9:-]/.test(s[k] as string)) k++;
    const rawName = s.slice(nameStart, k);
    if (rawName === "" || !/^[A-Za-z]/.test(rawName)) {
      this.p.err(this.file, "a tag that cannot be read", this.lineOf(start));
      return null;
    }
    const attrs: [string, string][] = [];
    const seen = new Set<string>();
    let selfClosing = false;
    for (;;) {
      while (k < s.length && /\s/.test(s[k] as string)) k++;
      if (k >= s.length) {
        this.p.err(this.file, `<${clip(rawName, 20)}> is not closed with >`, this.lineOf(start));
        return null;
      }
      if (s[k] === ">") {
        k++;
        break;
      }
      if (s[k] === "/" && s[k + 1] === ">") {
        selfClosing = true;
        k += 2;
        break;
      }
      if (close) {
        this.p.err(this.file, `</${clip(rawName, 20)}> holds attributes`, this.lineOf(start));
        return null;
      }
      const an = k;
      while (k < s.length && !/[\s/>="'<`]/.test(s[k] as string)) k++;
      const name = s.slice(an, k);
      if (!ATTR_NAME_RE.test(name)) {
        this.p.err(
          this.file,
          `an attribute of <${clip(rawName, 20)}> cannot be read`,
          this.lineOf(start),
        );
        return null;
      }
      while (k < s.length && /\s/.test(s[k] as string)) k++;
      let value = "";
      if (s[k] === "=") {
        k++;
        while (k < s.length && /\s/.test(s[k] as string)) k++;
        const q = s[k];
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, k + 1);
          if (end < 0) {
            this.p.err(this.file, `the ${clip(name, 20)} value is not closed`, this.lineOf(start));
            return null;
          }
          const raw = s.slice(k + 1, end);
          if (raw.includes("<")) {
            this.p.err(
              this.file,
              `the ${clip(name, 20)} value holds <: write &lt;`,
              this.lineOf(start),
            );
            return null;
          }
          const decoded = this.decode(raw, k + 1, xml);
          if (decoded === null) return null;
          value = decoded;
          k = end + 1;
        } else {
          const vs = k;
          while (k < s.length && !/[\s>"'<=`]/.test(s[k] as string)) k++;
          if (k === vs || xml) {
            this.p.err(
              this.file,
              xml
                ? `the ${clip(name, 20)} value in an <svg> needs quotes`
                : `the ${clip(name, 20)} value cannot be read`,
              this.lineOf(start),
            );
            return null;
          }
          const decoded = this.decode(s.slice(vs, k), vs, xml);
          if (decoded === null) return null;
          value = decoded;
        }
      } else if (xml) {
        this.p.err(
          this.file,
          `the ${clip(name, 20)} attribute in an <svg> needs a value`,
          this.lineOf(start),
        );
        return null;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        this.p.err(
          this.file,
          `<${clip(rawName, 20)}> has ${clip(name, 20)} twice`,
          this.lineOf(start),
        );
        return null;
      }
      seen.add(key);
      attrs.push([xml ? name : key, value]);
    }
    this.i = k;
    return {
      name: rawName.toLowerCase(),
      rawName,
      attrs,
      selfClosing,
      close,
      start,
      end: k,
    };
  }

  /** Skips a comment at `i` (`<!--`); false after reporting one that is not closed. */
  comment(): boolean {
    const end = this.s.indexOf("-->", this.i + 4);
    if (end < 0) {
      this.p.err(this.file, "a comment is not closed with -->", this.lineOf(this.i));
      return false;
    }
    this.i = end + 3;
    return true;
  }

  /** Everything up to `</name` (case-insensitive), or null when it is never closed. */
  rawUntil(name: string): { text: string; start: number } | null {
    const lower = this.s.toLowerCase();
    const at = lower.indexOf(`</${name}`, this.i);
    if (at < 0) return null;
    const text = this.s.slice(this.i, at);
    const start = this.i;
    this.i = at;
    return { text, start };
  }
}

// ---------- CSS checks ----------

/**
 * Why deck CSS (deck.css, a style attribute, an svg's <style>) is refused, or null: the design
 * system parser's rules (no <, no backslash, no @import, no image-set() or other string URL
 * functions, url() only as a plain relative path), and no data: URLs either, since a deck's images
 * are its own files. `localOnly`: an <svg>'s CSS, whose url() may only name #ids.
 */
export function deckCssProblem(css: string, localOnly = false): string | null {
  if (/@import/i.test(css)) return "may not use @import: fonts go in deck.json faces";
  if (/-moz-binding|behavior\s*:/i.test(css)) return "may not use -moz-binding or behavior";
  const base = cssBlockProblem(css);
  if (base) {
    return base.replace("this design system's own files", "the deck's own files");
  }
  for (const u of cssUrlArgs(css) ?? []) {
    if (localOnly && !LOCAL_REF_RE.test(u)) return "may use url() only for #ids inside the <svg>";
    if (u.toLowerCase().startsWith("data:")) {
      return "may not use data: URLs: add the image to the version and name its path";
    }
  }
  return null;
}

/** The url() paths of deck CSS that name the version's own files, once each, without query. */
export function deckCssFiles(css: string): string[] {
  const out = new Set<string>();
  for (const u of cssUrlArgs(css) ?? []) {
    if (!isPlainRelativeUrl(u)) continue;
    const file = normalizePath(u.split(/[?#]/)[0] ?? "");
    if (file) out.add(file);
  }
  return [...out];
}

/** A plain relative path with "." segments dropped, or "" when it climbs or is empty. */
function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return "";
    parts.push(seg);
  }
  return parts.join("/");
}

/** Whether an inline style or deck.css rule body pins its box (position:absolute or fixed). */
const PINNED_RE = /(?:^|[;{\s])position\s*:\s*(?:absolute|fixed)\b/i;
export function stylePins(style: string): boolean {
  return PINNED_RE.test(style);
}

/**
 * Classes deck.css pins on their own (`.name { position:absolute }`, also in a list of such
 * selectors), so the 24-pinned-children cap counts boxes pinned by class. Only plain one-class
 * selectors are read: the cap is a guard, not a cascade.
 */
export function pinnedClasses(css: string): Set<string> {
  const out = new Set<string>();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let k = 0;
  while (k < noComments.length) {
    const open = noComments.indexOf("{", k);
    if (open < 0) break;
    const close = noComments.indexOf("}", open + 1);
    if (close < 0) break;
    const prelude = noComments.slice(noComments.lastIndexOf("}", open) + 1, open);
    const body = noComments.slice(open + 1, close);
    if (stylePins(body)) {
      for (const sel of prelude.split(",")) {
        const m = /^\s*\.(-?[A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(sel);
        if (m?.[1]) out.add(m[1]);
      }
    }
    k = close + 1;
  }
  return out;
}

// ---------- links and images ----------

/** A link a slide may hold: https, http, mailto, or #N / #<slide id> to page the deck. */
function linkProblem(href: string): string | null {
  const h = href.trim();
  if (/^#[A-Za-z0-9_-]{1,64}$/.test(h)) return null;
  if (/^(https?:\/\/|mailto:)[^\s<>"'`\\]+$/i.test(h)) return null;
  return "is not an https, http or mailto link, or #N to another slide";
}

/** Why an image src is refused, or null: only a plain relative path to one of the version's files. */
function srcProblem(src: string): string | null {
  const s = src.trim();
  if (s.startsWith("/_blob/") || s.startsWith("_blob/")) {
    return "is a Claude upload address: add the image to the version and name its path, such as images/cover.jpg";
  }
  if (/^data:/i.test(s)) return "is a data: URL: add the image to the version and name its path";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) {
    return "is a URL: slides show only the version's own files, such as images/cover.jpg";
  }
  if (!isPlainRelativeUrl(s) || s.includes("?") || s.includes("#") || normalizePath(s) === "") {
    return "is not a plain path to one of the version's files (letters, digits, ._~- and /)";
  }
  return null;
}

// ---------- one slide ----------

interface SlideCtx {
  file: string;
  p: Problems;
  r: Reader;
  pinnedByClass: ReadonlySet<string>;
  boxes: number;
  textChars: number;
  embeds: number;
  images: Set<string>;
  cssRefs: Set<string>;
  converted: Set<string>;
  title: string;
  firstText: string;
}

function attrValue(attrs: readonly [string, string][], name: string): string | undefined {
  for (const [k, v] of attrs) if (k === name) return v;
  return undefined;
}

/** Keeps the attributes a tag may carry, checking each; false after refusing one. */
function keepAttrs(c: SlideCtx, tag: string, raw: RawTag, line: number): [string, string][] | null {
  const out: [string, string][] = [];
  const own = TAG_ATTRS[tag] ?? [];
  for (const [name, value] of raw.attrs) {
    if (name.startsWith("on")) {
      c.p.err(
        c.file,
        `<${raw.name}> has an event handler (${clip(name, 20)}): no script runs on a slide`,
        line,
      );
      return null;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser ignores them in a URL.
    if (/^\s*javascript:/i.test(value.replace(/[\u0000-\u0020]/g, ""))) {
      c.p.err(c.file, `<${raw.name}> ${clip(name, 20)} is a javascript: URL`, line);
      return null;
    }
    if (name === "style") {
      const problem = deckCssProblem(value);
      if (problem) {
        c.p.err(c.file, `the style of <${raw.name}> ${problem}`, line);
        return null;
      }
      for (const f of deckCssFiles(value)) c.cssRefs.add(f);
      out.push([name, value]);
      continue;
    }
    if (name === "id") {
      if (ELEMENT_ID_RE.test(value)) out.push([name, value]);
      continue;
    }
    if (name === "class") {
      const kept = value.split(/\s+/).filter((t) => CLASS_RE.test(t));
      if (kept.length > 0) out.push([name, kept.slice(0, 32).join(" ")]);
      continue;
    }
    if (DATA_ATTR_RE.test(name)) {
      out.push([name, value.slice(0, 1024)]);
      continue;
    }
    if (GLOBAL_ATTRS.has(name) || own.includes(name)) {
      if (name === "href") {
        const problem = linkProblem(value);
        if (problem) {
          c.p.err(c.file, `the link ${JSON.stringify(clip(value))} ${problem}`, line);
          return null;
        }
      }
      if (name === "src") {
        const problem = srcProblem(value);
        if (problem) {
          c.p.err(c.file, `the image ${JSON.stringify(clip(value))} ${problem}`, line);
          return null;
        }
        c.images.add(normalizePath(value.trim()));
        out.push([name, normalizePath(value.trim())]);
        continue;
      }
      if (name === "colspan" || name === "start") {
        if (!/^\d{1,3}$/.test(value.trim())) continue;
      }
      if (
        (name === "width" || name === "height") &&
        !/^\d{1,5}(?:\.\d{1,3})?$/.test(value.trim())
      ) {
        continue;
      }
      out.push([name, value.slice(0, 1024)]);
    }
    // Any other attribute is dropped: the renderer never sets one it did not list.
  }
  return out;
}

function isPinned(c: SlideCtx, el: DeckElement): boolean {
  if (el.tag === "x-embed") return true;
  if (el.tag === "x-connector") return attrValue(el.attrs, "x1") !== undefined;
  const style = attrValue(el.attrs, "style");
  if (style && stylePins(style)) return true;
  const cls = attrValue(el.attrs, "class");
  return !!cls && cls.split(" ").some((k) => c.pinnedByClass.has(k));
}

/** Reads the inline <svg> whose open tag was just read; the element, or null after refusing it. */
function readSvg(c: SlideCtx, open: RawTag, line: number): DeckElement | null {
  const r = c.r;
  interface SvgEl {
    name: string;
    attrs: [string, string][];
    children: (SvgEl | string)[];
  }
  const svgAttrs = (raw: RawTag): [string, string][] | null => {
    const out: [string, string][] = [];
    for (const [name, value] of raw.attrs) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) {
        c.p.err(c.file, `an <svg> has an event handler (${clip(name, 20)})`, r.lineOf(raw.start));
        return null;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser ignores them in a URL.
      if (/javascript:/i.test(value.replace(/[\u0000-\u0020]/g, ""))) {
        c.p.err(c.file, "an <svg> holds a javascript: URL", r.lineOf(raw.start));
        return null;
      }
      if (lower === "href" || lower === "xlink:href") {
        if (!LOCAL_REF_RE.test(value.trim())) {
          c.p.err(
            c.file,
            "an <svg> may reference only its own #ids (no URLs)",
            r.lineOf(raw.start),
          );
          return null;
        }
      }
      if (lower === "attributename" && /^(?:xlink:)?href$/i.test(value.trim())) {
        c.p.err(c.file, "an <svg> may not animate an href", r.lineOf(raw.start));
        return null;
      }
      if (/url\(/i.test(value)) {
        const urls = cssUrlArgs(value);
        if (urls === null || urls.some((u) => !LOCAL_REF_RE.test(u))) {
          c.p.err(
            c.file,
            "an <svg> may use url() only for its own #ids (no URLs)",
            r.lineOf(raw.start),
          );
          return null;
        }
      }
      if (lower === "style") {
        const problem = deckCssProblem(value, true);
        if (problem) {
          c.p.err(c.file, `a style in an <svg> ${problem}`, r.lineOf(raw.start));
          return null;
        }
      }
      if (lower === "xmlns" || lower === "xmlns:xlink") continue;
      out.push([name, value]);
    }
    return out;
  };
  const rootAttrs = svgAttrs(open);
  if (!rootAttrs) return null;
  const root: SvgEl = { name: "svg", attrs: rootAttrs, children: [] };
  const stack: SvgEl[] = [root];
  if (!open.selfClosing) {
    while (stack.length > 0) {
      if (r.done) {
        c.p.err(c.file, "an <svg> is not closed with </svg>", line);
        return null;
      }
      const s = r.s;
      const top = stack[stack.length - 1] as SvgEl;
      const lt = s.indexOf("<", r.i);
      if (lt < 0 || lt > r.i) {
        const end = lt < 0 ? s.length : lt;
        const text = r.decode(s.slice(r.i, end), r.i, true);
        if (text === null) return null;
        if (text.trim() !== "") top.children.push(text);
        r.i = end;
        continue;
      }
      if (s.startsWith("<!--", r.i)) {
        if (!r.comment()) return null;
        continue;
      }
      if (s.startsWith("<![CDATA[", r.i)) {
        const end = s.indexOf("]]>", r.i + 9);
        if (end < 0) {
          c.p.err(c.file, "a CDATA section in an <svg> is not closed", r.lineOf(r.i));
          return null;
        }
        top.children.push(s.slice(r.i + 9, end));
        r.i = end + 3;
        continue;
      }
      if (!/^<\/?[A-Za-z]/.test(s.slice(r.i, r.i + 3))) {
        c.p.err(c.file, "an < in an <svg> must be written &lt;", r.lineOf(r.i));
        return null;
      }
      const t = r.tag(true);
      if (!t) return null;
      const canonical = SVG_BY_LOWER.get(t.name);
      if (t.close) {
        if (canonical !== top.name) {
          c.p.err(
            c.file,
            `</${clip(t.rawName, 20)}> does not close <${top.name}> in an <svg>`,
            r.lineOf(t.start),
          );
          return null;
        }
        stack.pop();
        continue;
      }
      if (!canonical || canonical === "svg") {
        c.p.err(
          c.file,
          t.name === "foreignobject" || t.name === "script" || t.name === "image" || t.name === "a"
            ? `an <svg> may not hold <${clip(t.rawName, 20)}>`
            : `<${clip(t.rawName, 20)}> is not an SVG element Slides draws`,
          r.lineOf(t.start),
        );
        return null;
      }
      const attrs = svgAttrs(t);
      if (!attrs) return null;
      const el: SvgEl = { name: canonical, attrs, children: [] };
      top.children.push(el);
      if (canonical === "style" && !t.selfClosing) {
        const raw = r.rawUntil("style");
        if (!raw) {
          c.p.err(c.file, "a <style> in an <svg> is not closed", r.lineOf(t.start));
          return null;
        }
        let css = raw.text;
        if (css.trim().startsWith("<![CDATA[") && css.trim().endsWith("]]>")) {
          css = css.trim().slice(9, -3);
        } else {
          const decoded = r.decode(css, raw.start, true);
          if (decoded === null) return null;
          css = decoded;
        }
        const problem = deckCssProblem(css, true);
        if (problem) {
          c.p.err(c.file, `a <style> in an <svg> ${problem}`, r.lineOf(t.start));
          return null;
        }
        el.children.push(css);
        const close = r.tag(true);
        if (!close?.close || close.name !== "style") return null;
        continue;
      }
      if (!t.selfClosing) stack.push(el);
    }
  }
  const bytes = utf8Bytes(r.s.slice(open.start, r.i));
  if (bytes > L.maxSvgBytes) {
    c.p.err(
      c.file,
      `an <svg> is ${Math.ceil(bytes / KB)} KB; one may be at most ${L.maxSvgBytes / KB} KB (draw it as an image file instead)`,
      line,
    );
    return null;
  }
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const usesXlink = (e: SvgEl): boolean =>
    e.attrs.some(([n]) => n.toLowerCase().startsWith("xlink:")) ||
    e.children.some((ch) => typeof ch !== "string" && usesXlink(ch));
  const serialize = (e: SvgEl, still: boolean, top: boolean): string => {
    if (still && SVG_ANIMATION.has(e.name)) return "";
    let out = `<${e.name}`;
    if (top) {
      out += ` xmlns="${SVG_NS}"`;
      if (usesXlink(e)) out += ` xmlns:xlink="${XLINK_NS}"`;
    }
    for (const [n, v] of e.attrs) out += ` ${n}="${esc(v)}"`;
    out += ">";
    if (top && still) out += "<style>*{animation:none!important;transition:none!important}</style>";
    for (const ch of e.children)
      out += typeof ch === "string" ? esc(ch) : serialize(ch, still, false);
    return `${out}</${e.name}>`;
  };
  // The <img> that shows it takes the drawing's own box: its style, class, id, size and label.
  const keep: [string, string][] = [];
  for (const [n, v] of rootAttrs) {
    const lower = n.toLowerCase();
    if (lower === "style" || lower === "class" || lower === "id") keep.push([lower, v]);
    if (
      (lower === "width" || lower === "height") &&
      /^\d{1,5}(?:\.\d{1,3})?(?:px)?$/.test(v.trim())
    ) {
      keep.push([lower, v.trim().replace(/px$/, "")]);
    }
  }
  const alt =
    attrValue(
      rootAttrs.map(([n, v]): [string, string] => [n.toLowerCase(), v]),
      "aria-label",
    ) ?? "";
  return {
    kind: "el",
    tag: "svg",
    attrs: keep,
    children: [],
    line,
    svg: { xml: serialize(root, false, true), still: serialize(root, true, true), alt },
  };
}

/** Text a node holds, for notes and titles (br as a line break). */
function textOf(n: DeckNode): string {
  if (n.kind === "text") return n.text;
  if (n.tag === "br") return "\n";
  if (n.embed !== undefined || n.svg) return "";
  const parts = n.children.map(textOf).join("");
  return n.tag === "p" || n.tag === "li" || n.tag === "div" ? `${parts}\n` : parts;
}

/**
 * Parses one slide file. `id` is the file's slide id; the section must carry it. Refusals and
 * warnings go to `p`; the slide, or null when it was refused.
 */
function parseSlide(
  file: string,
  id: string,
  text: string,
  p: Problems,
  pinnedByClass: ReadonlySet<string>,
): HtmlSlide | null {
  const errorsBefore = p.errors.length;
  if (utf8Bytes(text) > L.maxSlideBytes) {
    p.err(file, `is over ${L.maxSlideBytes / KB} KB: split the slide`);
    return null;
  }
  const r = new Reader(text, file, p);
  const c: SlideCtx = {
    file,
    p,
    r,
    pinnedByClass,
    boxes: 0,
    textChars: 0,
    embeds: 0,
    images: new Set(),
    cssRefs: new Set(),
    converted: new Set(),
    title: "",
    firstText: "",
  };
  const doc: DeckElement = { kind: "el", tag: "#root", attrs: [], children: [], line: 1 };
  interface Open {
    el: DeckElement;
    /** The tag as written (a fallback tag closes by its own name). */
    name: string;
    divDepth: number;
  }
  const stack: Open[] = [{ el: doc, name: "#root", divDepth: 0 }];
  const top = () => stack[stack.length - 1] as Open;
  // Optional end tags, as HTML has them: an <li>, a <p> or a cell ends where its next sibling or its
  // parent's end begins.
  const implied: Record<string, readonly string[]> = {
    li: ["li"],
    p: [
      "p",
      "div",
      "ul",
      "ol",
      "li",
      "table",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "hr",
      "section",
      "aside",
      ...BLOCK_FALLBACK,
    ],
    td: ["td", "th", "tr"],
    th: ["td", "th", "tr"],
    tr: ["tr"],
  };
  const closeImplied = (opening: string) => {
    for (;;) {
      const t = top();
      const ends = implied[t.name];
      if (!ends?.includes(opening)) return;
      stack.pop();
    }
  };
  while (!r.done) {
    const s = r.s;
    const lt = s.indexOf("<", r.i);
    if (lt !== r.i) {
      const end = lt < 0 ? s.length : lt;
      const raw = s.slice(r.i, end);
      const decoded = r.decode(raw, r.i, false);
      if (decoded === null) return null;
      r.i = end;
      if (decoded.trim() === "") {
        if (stack.length > 1 && decoded !== "") top().el.children.push({ kind: "text", text: " " });
        continue;
      }
      if (stack.length === 1) {
        p.err(file, "holds text outside its <section>", r.lineOf(end));
        return null;
      }
      top().el.children.push({ kind: "text", text: decoded });
      continue;
    }
    if (s.startsWith("<!--", r.i)) {
      if (!r.comment()) return null;
      continue;
    }
    if (s.startsWith("<!", r.i) || s.startsWith("<?", r.i)) {
      p.err(
        file,
        "holds a <!DOCTYPE> or other declaration: a slide file is one <section>",
        r.lineOf(r.i),
      );
      return null;
    }
    if (!/^<\/?[A-Za-z]/.test(s.slice(r.i, r.i + 3))) {
      // A "<" that starts no tag is text, as a browser reads it.
      if (stack.length === 1) {
        p.err(file, "holds text outside its <section>", r.lineOf(r.i));
        return null;
      }
      top().el.children.push({ kind: "text", text: "<" });
      r.i++;
      continue;
    }
    const t = r.tag(false);
    if (!t) return null;
    const line = r.lineOf(t.start);
    // A line-break opportunity changes nothing a slide shows.
    if (t.name === "wbr") continue;
    if (t.close) {
      closeImplied(`/${t.name}`);
      // An end tag closes an open element by name; implied ends close on the way.
      let k = stack.length - 1;
      while (k > 0 && (stack[k] as Open).name !== t.name && implied[(stack[k] as Open).name]) k--;
      if (k === 0 || (stack[k] as Open).name !== t.name) {
        p.err(file, `</${clip(t.name, 20)}> closes nothing that is open`, line);
        return null;
      }
      stack.length = k;
      continue;
    }
    if (t.name === "svg") {
      if (stack.length === 1) {
        p.err(file, "holds an <svg> outside its <section>", line);
        return null;
      }
      c.boxes++;
      const el = readSvg(c, t, line);
      if (!el) return null;
      top().el.children.push(el);
      continue;
    }
    if (FORBIDDEN_TAGS.has(t.name)) {
      p.err(
        file,
        t.name === "script"
          ? "holds a <script>: no script runs on a slide (live code goes in an <x-embed>)"
          : t.name === "style"
            ? "holds a <style>: shared rules go in deck.css, one box's in its style attribute"
            : `holds <${t.name}>, which a slide cannot show`,
        line,
      );
      return null;
    }
    let tag = t.name;
    if (!HTML_TAGS.has(tag) && !X_TAGS.has(tag)) {
      if (BLOCK_FALLBACK.has(tag)) tag = "div";
      else if (Object.hasOwn(INLINE_FALLBACK, tag)) tag = INLINE_FALLBACK[tag] as string;
      else {
        p.err(file, `<${clip(t.name, 20)}> is not a tag Slides reads`, line);
        return null;
      }
      if (!c.converted.has(t.name)) {
        c.converted.add(t.name);
        p.warn(
          "slide_markup",
          file,
          `<${t.name}> shows as a plain ${tag === "div" ? "box" : "phrase"} (line ${line})`,
          line,
        );
      }
    }
    if (tag === "section" && stack.length > 1) {
      p.err(file, "holds a <section> inside its <section>", line);
      return null;
    }
    if (stack.length === 1 && tag !== "section") {
      p.err(file, `holds <${clip(t.name, 20)}> outside its <section>`, line);
      return null;
    }
    if (stack.length === 1 && doc.children.some((ch) => ch.kind === "el")) {
      p.err(file, "holds more than one <section>: one slide per file", line);
      return null;
    }
    closeImplied(tag);
    const attrs = keepAttrs(c, tag, t, line);
    if (!attrs) return null;
    const el: DeckElement = { kind: "el", tag, attrs, children: [], line };
    const parent = top();
    if (tag === "x-embed") {
      if (parent.el.tag !== "section") {
        p.err(file, "has an <x-embed> that is not a direct child of the <section>", line);
        return null;
      }
      c.embeds++;
      if (c.embeds > L.maxEmbedsPerSlide) {
        p.err(file, `has more than ${L.maxEmbedsPerSlide} <x-embed>s`, line);
        return null;
      }
      let page = "";
      if (!t.selfClosing) {
        const raw = r.rawUntil("x-embed");
        if (!raw) {
          p.err(file, "has an <x-embed> that is not closed with </x-embed>", line);
          return null;
        }
        page = raw.text;
        const close = r.tag(false);
        if (!close?.close) return null;
      }
      const bytes = utf8Bytes(page);
      if (bytes > L.maxEmbedBytes) {
        p.err(
          file,
          `has an <x-embed> of ${Math.ceil(bytes / KB)} KB; one may be at most ${L.maxEmbedBytes / KB} KB`,
          line,
        );
        return null;
      }
      el.embed = page;
      c.boxes++;
      parent.el.children.push(el);
      continue;
    }
    if (!NOT_BOXES.has(tag) && tag !== "section") c.boxes++;
    if (tag === "x-shape") {
      const kind = attrValue(attrs, "kind") ?? "rect";
      if (!(X_SHAPE_KINDS as readonly string[]).includes(kind)) {
        p.err(
          file,
          `<x-shape kind="${clip(kind, 20)}"> is not a shape Slides draws (${X_SHAPE_KINDS.join(", ")})`,
          line,
        );
        return null;
      }
    }
    if (tag === "x-icon") {
      const name = attrValue(attrs, "name") ?? "";
      if (!(X_ICON_NAMES as readonly string[]).includes(name)) {
        p.warn(
          "slide_markup",
          file,
          `<x-icon name="${clip(name, 20)}"> is not an icon Slides draws, so it shows nothing (line ${line})`,
          line,
        );
      }
    }
    if (tag === "x-connector") {
      const coords = ["x1", "y1", "x2", "y2"].map((k) => attrValue(attrs, k));
      const given = coords.filter((v) => v !== undefined).length;
      if (given !== 0 && given !== 4) {
        p.err(file, "has an <x-connector> with some of x1, y1, x2, y2 but not all four", line);
        return null;
      }
      if (coords.some((v) => v !== undefined && !CONNECTOR_COORD_RE.test(v.trim()))) {
        p.err(file, "has an <x-connector> coordinate that is not a number of px or %", line);
        return null;
      }
      const route = attrValue(attrs, "route");
      const head = attrValue(attrs, "head");
      if (route !== undefined && !(CONNECTOR_ROUTES as readonly string[]).includes(route)) {
        p.warn(
          "slide_markup",
          file,
          `<x-connector route="${clip(route, 20)}"> is drawn straight (line ${line})`,
          line,
        );
      }
      if (head !== undefined && !(CONNECTOR_HEADS as readonly string[]).includes(head)) {
        p.warn(
          "slide_markup",
          file,
          `<x-connector head="${clip(head, 20)}"> gets a head at its end (line ${line})`,
          line,
        );
      }
    }
    parent.el.children.push(el);
    const divDepth = parent.divDepth + (tag === "div" ? 1 : 0);
    if (divDepth > L.maxDivDepth) {
      p.err(
        file,
        `nests more than ${L.maxDivDepth} <div>s: split the slide or flatten its boxes`,
        line,
      );
      return null;
    }
    if (!VOID_TAGS.has(tag) && !t.selfClosing) stack.push({ el, name: t.name, divDepth });
    else if (t.selfClosing && !VOID_TAGS.has(tag) && !X_TAGS.has(tag)) {
      p.err(file, `<${clip(t.name, 20)}/> must be written <${t.name}></${t.name}>`, line);
      return null;
    }
    if (c.boxes > L.maxBoxes) {
      p.err(file, `has more than ${L.maxBoxes} boxes: split the slide`, line);
      return null;
    }
  }
  // Implied ends at the end of the file, then everything must be closed.
  while (stack.length > 1 && implied[top().name]) stack.pop();
  if (stack.length > 1) {
    p.err(file, `<${top().name}> is not closed`, top().el.line);
    return null;
  }
  const sections = doc.children.filter((ch): ch is DeckElement => ch.kind === "el");
  const section = sections[0];
  if (!section) {
    p.err(file, `holds no <section id="${id}">`);
    return null;
  }
  const sid = attrValue(section.attrs, "id");
  if (sid !== id) {
    p.err(
      file,
      `its <section> must have id="${id}" (the file name), not ${sid === undefined ? "none" : JSON.stringify(clip(sid))}`,
      section.line,
    );
    return null;
  }

  // Notes, the x-* contents, the pinned counts, the tables and the text.
  const notes: string[] = [];
  let asides = 0;
  const lastEl = [...section.children]
    .reverse()
    .find((ch) => ch.kind === "el" || ch.text.trim() !== "");
  section.children = section.children.filter((ch) => {
    if (ch.kind !== "el" || ch.tag !== "aside") return true;
    asides++;
    if (ch !== lastEl) {
      p.warn(
        "slide_markup",
        file,
        `an <aside> is not the section's last child; its text is read as speaker notes (line ${ch.line})`,
        ch.line,
      );
    }
    notes.push(
      textOf(ch)
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );
    return false;
  });
  if (asides > 1) {
    p.warn(
      "slide_markup",
      file,
      "has more than one <aside>: their text is joined as the speaker notes",
    );
  }
  let noteText = notes.filter((n) => n !== "").join("\n\n");
  if ([...noteText].length > L.maxNotes) {
    p.warn(
      "slide_markup",
      file,
      `has speaker notes over ${L.maxNotes} characters; the rest is cut`,
    );
    noteText = [...noteText].slice(0, L.maxNotes).join("");
  }

  const walk = (el: DeckElement, inAside: boolean): boolean => {
    let pinned = 0;
    if (el.tag === "table") {
      let rows = 0;
      const countRows = (e: DeckElement): boolean => {
        for (const ch of e.children) {
          if (ch.kind !== "el") continue;
          if (ch.tag === "thead" || ch.tag === "tbody") {
            if (!countRows(ch)) return false;
            continue;
          }
          if (ch.tag !== "tr") continue;
          rows++;
          let cols = 0;
          for (const cell of ch.children) {
            if (cell.kind !== "el" || (cell.tag !== "td" && cell.tag !== "th")) continue;
            cols += Math.max(1, Number(attrValue(cell.attrs, "colspan") ?? "1") || 1);
          }
          if (cols > L.maxTableColumns) {
            p.err(
              file,
              `has a table row of ${cols} columns; a table may have at most ${L.maxTableColumns}`,
              ch.line,
            );
            return false;
          }
        }
        return true;
      };
      if (!countRows(el)) return false;
      if (rows > L.maxTableRows) {
        p.err(
          file,
          `has a table of ${rows} rows; a table may have at most ${L.maxTableRows}: split it`,
          el.line,
        );
        return false;
      }
    }
    if (
      (el.tag === "x-shape" || el.tag === "x-icon" || el.tag === "x-connector") &&
      el.children.some((ch) => ch.kind === "el" || ch.text.trim() !== "")
    ) {
      p.warn(
        "slide_markup",
        file,
        `<${el.tag}> holds no content; what is inside it is dropped (line ${el.line})`,
        el.line,
      );
      el.children = [];
    }
    for (const ch of el.children) {
      if (ch.kind === "text") {
        c.textChars += ch.text.length;
        if (!inAside && c.firstText === "" && ch.text.trim() !== "") c.firstText = ch.text.trim();
        continue;
      }
      if (isPinned(c, ch)) pinned++;
      if (c.title === "" && /^h[1-3]$/.test(ch.tag))
        c.title = textOf(ch).replace(/\s+/g, " ").trim();
      if (!walk(ch, inAside)) return false;
    }
    if (pinned > L.maxPinned) {
      p.err(
        file,
        `<${el.tag === "section" ? "section" : el.tag}> on line ${el.line} pins ${pinned} children; one box may pin at most ${L.maxPinned}: split them across sibling boxes`,
        el.line,
      );
      return false;
    }
    return true;
  };
  if (!walk(section, false)) return null;
  if (c.textChars > L.maxSlideText) {
    p.err(
      file,
      `holds ${c.textChars} characters of text; a slide may hold at most ${L.maxSlideText}: split it`,
    );
    return null;
  }
  if (p.errors.length > errorsBefore) return null;

  const transitionRaw = attrValue(section.attrs, "data-transition");
  let transition: HtmlSlide["transition"] = null;
  if (transitionRaw === "fade" || transitionRaw === "push" || transitionRaw === "magic") {
    transition = transitionRaw;
  } else if (transitionRaw !== undefined && transitionRaw !== "" && transitionRaw !== "none") {
    p.warn(
      "slide_markup",
      file,
      `data-transition="${clip(transitionRaw, 20)}" is not fade, push or magic; the slide cuts`,
    );
  }
  if (section.children.every((ch) => ch.kind === "text" && ch.text.trim() === "")) {
    p.warn("slide_empty", file, "is empty: give its <section> content or take it out of order");
  }
  const title = [...(c.title || c.firstText).replace(/\s+/g, " ")].slice(0, 60).join("");
  return {
    id,
    path: file,
    section,
    notes: noteText,
    hidden: section.attrs.some(([k]) => k === "hidden"),
    transition,
    title,
    images: [...c.images],
    cssRefs: [...c.cssRefs],
  };
}

// ---------- the index ----------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The families a Google Fonts css2 link names. */
export function googleFamilies(href: string): string[] {
  const q = href.slice(GOOGLE_CSS2.length);
  const out: string[] = [];
  for (const part of q.split("&")) {
    if (!part.startsWith("family=")) continue;
    const name = (part.slice(7).split(":")[0] ?? "").replace(/\+/g, " ").trim();
    if (name) out.push(name);
  }
  return out;
}

function parseIndex(text: string, p: Problems): HtmlDeckIndex | null {
  const file = HTML_DECK_INDEX;
  if (utf8Bytes(text) > L.maxIndexBytes) {
    p.err(file, `is over ${L.maxIndexBytes / KB} KB`);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    p.err(file, `is not JSON (${clip(e instanceof Error ? e.message : "parse error", 80)})`);
    return null;
  }
  if (!isObject(raw)) {
    p.err(file, "must be a JSON object");
    return null;
  }
  const before = p.errors.length;
  let title: string | null = null;
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string") p.err(file, "title must be a string");
    else if (raw.title.trim() !== "" && raw.title.trim() !== "Untitled") {
      title = raw.title.trim().slice(0, LIMITS.maxTitleLength);
    }
  }
  let size: HtmlDeckSize = "16:9";
  if (raw.size !== undefined) {
    if (raw.size === "16:9" || raw.size === "4:3") size = raw.size;
    else p.err(file, 'size is "16:9" (the default) or "4:3"');
  }
  let order: string[] | null = null;
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) p.err(file, "order must be a list of slide ids");
    else {
      const seen = new Set<string>();
      order = [];
      for (const id of raw.order) {
        if (typeof id !== "string" || !SLIDE_ID_RE.test(id)) {
          p.err(
            file,
            `order holds ${JSON.stringify(clip(String(id)))}, which is not a slide id ([A-Za-z0-9_-], 1 to 64)`,
          );
          continue;
        }
        if (seen.has(id)) {
          p.err(file, `order lists ${id} twice`);
          continue;
        }
        seen.add(id);
        order.push(id);
      }
    }
  }
  let cover: string | null = null;
  if (raw.cover !== undefined && raw.cover !== null) {
    if (typeof raw.cover !== "string" || !SLIDE_ID_RE.test(raw.cover)) {
      p.warn("slides_setting", file, "cover is not a slide id; it is ignored");
    } else cover = raw.cover;
  }
  const sections: DeckSection[] = [];
  if (raw.sections !== undefined) {
    if (!isObject(raw.sections))
      p.warn("slides_setting", file, "sections must be an object; it is ignored");
    else {
      for (const [key, v] of Object.entries(raw.sections)) {
        if (!isObject(v)) {
          p.warn(
            "slides_setting",
            file,
            `sections.${clip(key, 20)} is not an object; it is ignored`,
          );
          continue;
        }
        const start = typeof v.start === "string" && SLIDE_ID_RE.test(v.start) ? v.start : null;
        sections.push({
          key: key.slice(0, 64),
          description: typeof v.description === "string" ? v.description.slice(0, 500) : "",
          start,
        });
      }
    }
  }
  const faces: DeckFace[] = [];
  let families = 0;
  if (raw.faces !== undefined) {
    if (!isObject(raw.faces))
      p.warn("slides_setting", file, "faces must be an object; it is ignored");
    else {
      for (const [key, v] of Object.entries(raw.faces)) {
        const at = `faces.${clip(key, 30)}`;
        if (!isObject(v) || typeof v.family !== "string" || !FAMILY_RE.test(v.family)) {
          p.warn(
            "slides_setting",
            file,
            `${at} needs a family (a letter, then letters, digits, spaces, _ or -, at most 40); it is ignored`,
          );
          continue;
        }
        const hasHref = v.href !== undefined;
        const hasSrc = v.src !== undefined;
        if (hasHref === hasSrc) {
          p.warn(
            "slides_setting",
            file,
            `${at} needs href (a Google Fonts css2 link) or src (a font file), one of them; it is ignored`,
          );
          continue;
        }
        if (hasHref) {
          const href = v.href;
          if (
            typeof href !== "string" ||
            !href.startsWith(GOOGLE_CSS2) ||
            href.length > 1024 ||
            !GOOGLE_QUERY_RE.test(href.slice(GOOGLE_CSS2.length))
          ) {
            p.warn(
              "slides_setting",
              file,
              `${at}.href must be a ${GOOGLE_CSS2}… link of at most 1024 characters, with no % escapes or quotes; it is ignored`,
            );
            continue;
          }
          const n = Math.max(1, googleFamilies(href).length);
          if (families + n > L.maxFamilies) {
            p.warn(
              "slides_setting",
              file,
              `${at} would make more than ${L.maxFamilies} font families; it is ignored`,
            );
            continue;
          }
          families += n;
          faces.push({ key, family: v.family, href, src: null });
          continue;
        }
        const src = v.src;
        if (
          typeof src !== "string" ||
          !isPlainRelativeUrl(src) ||
          src.includes("?") ||
          src.includes("#") ||
          !FONT_FILE_RE.test(src)
        ) {
          p.warn(
            "slides_setting",
            file,
            `${at}.src must be the path of a .woff2, .woff, .ttf or .otf file of this version (such as ds/brand/fonts/Brand.woff2); it is ignored`,
          );
          continue;
        }
        if (families + 1 > L.maxFamilies) {
          p.warn(
            "slides_setting",
            file,
            `${at} would make more than ${L.maxFamilies} font families; it is ignored`,
          );
          continue;
        }
        families++;
        faces.push({ key, family: v.family, href: null, src: normalizePath(src) });
      }
    }
  }
  let designSystems: unknown[] = [];
  if (raw.designSystems !== undefined) {
    const list = Array.isArray(raw.designSystems)
      ? raw.designSystems
      : isObject(raw.designSystems)
        ? Object.values(raw.designSystems)
        : null;
    if (!list) p.warn("slides_setting", file, "designSystems must be a list; it is ignored");
    else {
      if (list.length > L.maxDesignSystems) {
        p.warn(
          "slides_setting",
          file,
          `designSystems lists more than ${L.maxDesignSystems}; the rest are ignored`,
        );
      }
      designSystems = list.slice(0, L.maxDesignSystems).filter((d, i) => {
        const ok = isObject(d) && typeof d.namespace === "string" && DS_FOLDER_RE.test(d.namespace);
        if (!ok)
          p.warn(
            "slides_setting",
            file,
            `designSystems[${i}] needs a namespace ([a-z0-9][a-z0-9_-], at most 64); it is ignored`,
          );
        return ok;
      });
    }
  }
  if (p.errors.length > before) return null;
  return { title, size, order, cover, sections, faces, designSystems };
}

/** The deck's title, for the version: deck.json's title, or null. */
export function htmlDeckTitle(indexText: string): string | null {
  const p = new Problems();
  return parseIndex(indexText, p)?.title ?? null;
}

/** The slide files a deck index names, as paths, in order (for readers that fetch them). */
export function htmlDeckFilesOf(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of paths)
    if (path === HTML_DECK_CSS || slideIdOfPath(path) !== null) out.push(path);
  return out.sort();
}

export interface HtmlDeckInput {
  /** deck.json's text. */
  index: string;
  /** deck.css's text, or null when the version has none. */
  css: string | null;
  /** Every slides/<id>.html of the version, by path. */
  slides: ReadonlyMap<string, string>;
  /** Every path of the version, to report images, fonts and CSS files it lacks. Absent: not checked. */
  paths?: ReadonlySet<string>;
}

/**
 * Reads an HTML deck: refuses what no renderer may show (with every problem, file and line), and
 * lists what still shows but differently as warnings. Never throws.
 */
export function parseHtmlDeck(input: HtmlDeckInput): HtmlDeckResult {
  const p = new Problems();
  const index = parseIndex(input.index, p);
  let total = utf8Bytes(input.index);
  const css = input.css ?? "";
  if (input.css !== null) {
    total += utf8Bytes(css);
    if (utf8Bytes(css) > L.maxCssBytes) p.err(HTML_DECK_CSS, `is over ${L.maxCssBytes / KB} KB`);
    else {
      const problem = deckCssProblem(css);
      if (problem) p.err(HTML_DECK_CSS, problem);
      if (/@font-face/i.test(css)) {
        p.warn(
          "slides_setting",
          HTML_DECK_CSS,
          "declares @font-face, which slides do not load: name the face in deck.json faces",
        );
      }
    }
  }
  for (const t of input.slides.values()) total += utf8Bytes(t);
  if (total > L.maxDeckBytes) {
    p.err(
      HTML_DECK_INDEX,
      `the deck's files hold ${Math.ceil(total / KB / KB)} MB of text; a deck may hold at most ${L.maxDeckBytes / KB / KB} MB: split it`,
    );
  }
  const pinnedByClass = pinnedClasses(css);
  const byId = new Map<string, string>();
  for (const path of input.slides.keys()) {
    const id = slideIdOfPath(path);
    if (id !== null) byId.set(id, path);
  }
  const ids: string[] = [];
  const listed = new Set<string>();
  for (const id of index?.order ?? []) {
    listed.add(id);
    if (byId.has(id)) ids.push(id);
    else
      p.warn(
        "slides_setting",
        HTML_DECK_INDEX,
        `order lists ${id}, which has no slides/${id}.html; it is skipped`,
        undefined,
        `slides/${id}.html`,
      );
  }
  const unlisted = [...byId.keys()].filter((id) => !listed.has(id)).sort();
  if (index?.order && unlisted.length > 0) {
    p.warn(
      "slides_setting",
      HTML_DECK_INDEX,
      `${unlisted
        .map((id) => `slides/${id}.html`)
        .slice(0, 5)
        .join(
          ", ",
        )}${unlisted.length > 5 ? ` and ${unlisted.length - 5} more` : ""} ${unlisted.length === 1 ? "is" : "are"} not in order and show${unlisted.length === 1 ? "s" : ""} last`,
    );
  }
  ids.push(...unlisted);
  if (ids.length > LIMITS.maxSlides) {
    p.err(
      HTML_DECK_INDEX,
      `A deck holds at most ${LIMITS.maxSlides} slides; this one has ${ids.length}. Split it into two decks`,
    );
  }
  const slides: HtmlSlide[] = [];
  if (p.errors.length === 0) {
    for (const id of ids) {
      const path = byId.get(id) as string;
      const s = parseSlide(path, id, input.slides.get(path) ?? "", p, pinnedByClass);
      if (s) slides.push(s);
    }
  }
  if (index && p.errors.length === 0) {
    if (slides.length === 0) {
      p.err(
        HTML_DECK_INDEX,
        "The deck has no slides: add slides/<id>.html files and list their ids in order",
      );
    }
    const known = new Set(slides.map((s) => s.id));
    if (index.cover && !known.has(index.cover)) {
      p.warn(
        "slides_setting",
        HTML_DECK_INDEX,
        `cover names ${index.cover}, which is not a slide of the deck`,
      );
    }
    for (const sec of index.sections) {
      if (sec.start && !known.has(sec.start)) {
        p.warn(
          "slides_setting",
          HTML_DECK_INDEX,
          `sections.${clip(sec.key, 20)}.start names ${sec.start}, which is not a slide of the deck`,
        );
      }
    }
  }
  if (input.paths && p.errors.length === 0) {
    const has = input.paths;
    const missing = (file: string, ref: string, what: string) =>
      p.warn(
        "missing_file",
        file,
        `${what} ${ref}, which is not in this version: add it or fix the path`,
        undefined,
        ref,
      );
    for (const f of index?.faces ?? [])
      if (f.src && !has.has(f.src)) missing(HTML_DECK_INDEX, f.src, `faces.${f.key} names`);
    for (const ref of deckCssFiles(css))
      if (!has.has(ref)) missing(HTML_DECK_CSS, ref, "deck.css names");
    for (const s of slides) {
      for (const img of s.images) if (!has.has(img)) missing(s.path, img, "The slide shows");
      for (const ref of s.cssRefs)
        if (!has.has(ref)) missing(s.path, ref, "A style on the slide names");
    }
  }
  if (!index || p.errors.length > 0) return { ok: false, errors: p.errors, warnings: p.warnings };
  return {
    ok: true,
    deck: { ...index, canvas: HTML_DECK_CANVAS[index.size], slides, css },
    warnings: p.warnings,
  };
}

/** A short message for a refused deck: the first problem, and how many more. */
export function htmlDeckIssueSummary(errors: readonly DeckIssue[]): string {
  const first = errors[0];
  if (!first) return "The HTML deck could not be read";
  const where = `${first.file}${first.line !== undefined ? ` (line ${first.line})` : ""}`;
  const more =
    errors.length > 1
      ? ` (and ${errors.length - 1} more problem${errors.length === 2 ? "" : "s"} in details.issues)`
      : "";
  return `${where} ${first.message}${more}`;
}

/**
 * Which files an HTML deck's version may hold besides deck.json: slides/<id>.html for slides,
 * deck.css, images and fonts anywhere, and a design system's CSS and JSON under ds/<folder>/. A
 * Markdown deck holds only images. The reason a path cannot be in the version, or null.
 */
export function deckFileProblem(
  format: "markdown" | "html",
  path: string,
  contentType: string,
): string | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const image = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(type);
  if (format === "markdown") {
    return image
      ? null
      : `${path}: a Markdown deck's files are images (png, jpg, gif, webp, avif, svg); deck.css, slides/<id>.html and fonts belong to an HTML deck, whose source is deck.json`;
  }
  if (image) return null;
  if (
    /^(font\/(woff2|woff|ttf|otf)|application\/(font-woff2?|x-font-ttf|x-font-otf|vnd\.ms-fontobject))$/.test(
      type,
    )
  ) {
    return null;
  }
  if (type === "text/html") {
    return slideIdOfPath(path) !== null
      ? null
      : `${path}: an HTML deck's slides are slides/<id>.html (the id is [A-Za-z0-9_-], 1 to 64)`;
  }
  if (type === "text/css") {
    return path === HTML_DECK_CSS || path.startsWith("ds/")
      ? null
      : `${path}: an HTML deck's shared rules are deck.css`;
  }
  if (type === "application/json") {
    return path.startsWith("ds/")
      ? null
      : `${path}: an HTML deck's JSON files are under ds/<folder>/ (a design system's tokens)`;
  }
  return `${path}: an HTML deck's files are slides/<id>.html, deck.css, images and fonts`;
}
