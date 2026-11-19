// The formatted-text model of one Markdown block, and its way back to Markdown (doc-blocks). People
// edit a doc as formatted text, never as Markdown: the renderer reads a block's tokens into the
// small model below, lets the person change it on the page, and writes it back with
// serializeBlock. Pure and zod-free, so every renderer bundle and the room can import it.
//
// The model is closed: a block is one of the kinds below, and inline content is a flat list of
// segments, each with a set of marks. Anything else inline (an image, a reference link, an
// autolink) is an atom, kept as the Markdown it was written as. A block the model cannot hold, or
// cannot write back so that it renders the same, is not editable in place (editableBlock): the
// fidelity check. Every text the editor sends satisfies parse(serialize(m)) == m, by check
// (verifyBlock) and not only by test.
//
// Parsing needs markdown-it, which this package does not carry: callers pass a `MarkdownSource`
// (an instance that records where links and images came from, see the doc renderer's
// sourceMarkdown) and a `MarkdownRender` (the instance the page is rendered with). Both see only
// the token fields this file names.

/** What a dialect of Markdown can hold, which decides what the serializer must escape. */
export interface MarkdownDialect {
  readonly name: "doc" | "commonmark";
  /** GitHub tables and ~~strikethrough~~. */
  readonly gfm: boolean;
  /** Bare URLs become links (markdown-it's linkify). */
  readonly linkify: boolean;
}

/** The doc's dialect: CommonMark with GitHub tables, strikethrough and bare-URL links, html off. */
export const DOC_DIALECT: MarkdownDialect = { name: "doc", gfm: true, linkify: true };
/** Plain CommonMark, html off. */
export const COMMONMARK_DIALECT: MarkdownDialect = {
  name: "commonmark",
  gfm: false,
  linkify: false,
};

export interface LinkMark {
  href: string;
  title: string;
  /** The destination as it was written, "(…)" included, kept while `href` is unchanged. */
  dest?: string;
}

export interface RichMarks {
  strong?: boolean;
  em?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: LinkMark;
}

/** One run of inline content. In text, "\n" is a soft line break. */
export type RichSeg =
  | { k: "text"; text: string; m: RichMarks }
  | { k: "atom"; md: string; m: RichMarks }
  | { k: "br" };

export type RichInline = RichSeg[];

export interface RichListItem {
  /** Paragraphs and nested lists. */
  blocks: RichBlock[];
}

export type RichAlign = "left" | "center" | "right" | null;

export type RichBlock =
  | { t: "paragraph"; c: RichInline }
  | { t: "heading"; level: number; setext: boolean; c: RichInline }
  | { t: "quote"; blocks: RichBlock[] }
  | { t: "bullet"; marker: "-" | "*" | "+"; tight: boolean; items: RichListItem[] }
  | { t: "ordered"; start: number; delim: "." | ")"; tight: boolean; items: RichListItem[] }
  | { t: "table"; align: RichAlign[]; head: RichInline[]; rows: RichInline[][] }
  | { t: "code"; fence: string; info: string; text: string }
  | { t: "indented"; text: string }
  | { t: "divider"; markup: string }
  | { t: "image"; alt: string; rest: string };

export type RichBlockKind = RichBlock["t"];

/** The token fields this file reads (markdown-it's Token). */
export interface MdToken {
  type: string;
  tag: string;
  attrs: [string, string][] | null;
  nesting: number;
  markup: string;
  info: string;
  content: string;
  hidden: boolean;
  children: MdToken[] | null;
  // biome-ignore lint/suspicious/noExplicitAny: markdown-it types meta as any.
  meta: any;
}

/** markdown-it's environment: the doc's reference definitions, at least. */
export interface MdEnv {
  references?: Record<string, unknown>;
  [k: string]: unknown;
}

/** An instance that parses Markdown into tokens. */
export interface MarkdownParser {
  parse(src: string, env: MdEnv): MdToken[];
}

/**
 * The parser the model is read with. Each link_open and image token it makes carries
 * `meta.plinthSource`: the Markdown it was written as (`src`), its label as written (`label`),
 * and what followed the label (`after`: "(…)" for an inline link, "[ref]", "[]" or "").
 */
export type MarkdownSource = MarkdownParser;

/** Where a link or image came from (see MarkdownSource). */
export interface SourceMeta {
  src: string;
  label: string;
  after: string;
}

const attr = (t: MdToken, name: string): string | null => {
  for (const [k, v] of t.attrs ?? []) if (k === name) return v;
  return null;
};

const sourceOf = (t: MdToken): SourceMeta | null => {
  const s = t.meta?.plinthSource;
  if (typeof s !== "object" || s === null) return null;
  if (typeof s.src !== "string" || typeof s.label !== "string" || typeof s.after !== "string") {
    return null;
  }
  return s as SourceMeta;
};

// ---------- tokens to the model ----------

/** Plain text of inline tokens, as markdown-it computes an image's alt. */
export function tokensPlainText(tokens: readonly MdToken[] | null): string {
  let out = "";
  for (const t of tokens ?? []) {
    if (t.type === "text" || t.type === "code_inline") out += t.content;
    else if (t.type === "softbreak" || t.type === "hardbreak") out += "\n";
    else if (t.type === "image") out += tokensPlainText(t.children);
  }
  return out;
}

class Unsupported extends Error {}

function inlineFromTokens(children: readonly MdToken[]): RichInline {
  const out: RichInline = [];
  const marks: RichMarks = {};
  let linkify = 0;
  for (let i = 0; i < children.length; i++) {
    const t = children[i] as MdToken;
    const m = (): RichMarks => ({ ...marks });
    switch (t.type) {
      case "text":
        out.push({ k: "text", text: t.content, m: m() });
        break;
      case "softbreak":
        out.push({ k: "text", text: "\n", m: m() });
        break;
      case "hardbreak":
        out.push({ k: "br" });
        break;
      case "code_inline":
        out.push({ k: "text", text: t.content, m: { ...m(), code: true } });
        break;
      case "strong_open":
        marks.strong = true;
        break;
      case "strong_close":
        delete marks.strong;
        break;
      case "em_open":
        marks.em = true;
        break;
      case "em_close":
        delete marks.em;
        break;
      case "s_open":
        marks.strike = true;
        break;
      case "s_close":
        delete marks.strike;
        break;
      case "link_open": {
        if (t.markup === "linkify") {
          // A bare URL: plain text in the model, so typing one is never undone.
          linkify++;
          break;
        }
        if (t.markup === "autolink") {
          const text = children[i + 1];
          const close = children[i + 2];
          if (text?.type !== "text" || close?.type !== "link_close") throw new Unsupported();
          out.push({ k: "atom", md: `<${text.content}>`, m: m() });
          i += 2;
          break;
        }
        const src = sourceOf(t);
        if (!src) throw new Unsupported();
        if (src.after.startsWith("(") && src.after.endsWith(")")) {
          if (marks.link) throw new Unsupported();
          marks.link = {
            href: attr(t, "href") ?? "",
            title: attr(t, "title") ?? "",
            dest: src.after,
          };
          break;
        }
        // A reference link: kept whole, as written.
        let depth = 1;
        let j = i + 1;
        for (; j < children.length; j++) {
          const c = children[j] as MdToken;
          if (c.type === "link_open") depth++;
          else if (c.type === "link_close" && --depth === 0) break;
        }
        out.push({ k: "atom", md: src.src, m: m() });
        i = j;
        break;
      }
      case "link_close":
        if (linkify > 0) linkify--;
        else delete marks.link;
        break;
      case "image": {
        const src = sourceOf(t);
        if (!src) throw new Unsupported();
        out.push({ k: "atom", md: src.src, m: m() });
        break;
      }
      default:
        throw new Unsupported();
    }
  }
  return out;
}

interface Cursor {
  tokens: readonly MdToken[];
  i: number;
}

function expect(c: Cursor, type: string): MdToken {
  const t = c.tokens[c.i];
  if (!t || t.type !== type) throw new Unsupported();
  c.i++;
  return t;
}

function inlineAt(c: Cursor): MdToken {
  return expect(c, "inline");
}

/** One block at the cursor. `top`: at the top level, where an image alone is an image block. */
function blockAt(c: Cursor, top: boolean): { block: RichBlock; hidden: boolean } {
  const t = c.tokens[c.i];
  if (!t) throw new Unsupported();
  switch (t.type) {
    case "paragraph_open": {
      c.i++;
      const inline = inlineAt(c);
      expect(c, "paragraph_close");
      const kids = inline.children ?? [];
      const only = kids.filter((k) => !(k.type === "text" && k.content.trim() === ""));
      if (top && only.length === 1 && only[0]?.type === "image" && kids.length === 1) {
        const src = sourceOf(only[0]);
        if (!src) throw new Unsupported();
        const alt = tokensPlainText(only[0].children);
        // A shortcut or collapsed reference names its definition by its label: keep that name, so
        // a new alt text does not change which image it is.
        const rest = src.after === "" || src.after === "[]" ? `[${src.label}]` : src.after;
        return { block: { t: "image", alt, rest }, hidden: t.hidden };
      }
      return { block: { t: "paragraph", c: inlineFromTokens(kids) }, hidden: t.hidden };
    }
    case "heading_open": {
      c.i++;
      const inline = inlineAt(c);
      expect(c, "heading_close");
      const level = Number(t.tag.slice(1));
      const setext = t.markup === "=" || t.markup === "-";
      return {
        block: { t: "heading", level, setext, c: inlineFromTokens(inline.children ?? []) },
        hidden: false,
      };
    }
    case "blockquote_open": {
      c.i++;
      const blocks: RichBlock[] = [];
      while (c.tokens[c.i]?.type !== "blockquote_close") {
        blocks.push(blockAt(c, false).block);
      }
      c.i++;
      return { block: { t: "quote", blocks }, hidden: false };
    }
    case "bullet_list_open":
    case "ordered_list_open": {
      c.i++;
      const items: RichListItem[] = [];
      let tight = true;
      const close = t.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
      while (c.tokens[c.i]?.type !== close) {
        expect(c, "list_item_open");
        const blocks: RichBlock[] = [];
        while (c.tokens[c.i]?.type !== "list_item_close") {
          const { block, hidden } = blockAt(c, false);
          if (block.t === "paragraph") {
            if (!hidden) tight = false;
          } else if (!isList(block)) throw new Unsupported();
          blocks.push(block);
        }
        c.i++;
        items.push({ blocks });
      }
      c.i++;
      if (t.type === "bullet_list_open") {
        const marker = t.markup;
        if (marker !== "-" && marker !== "*" && marker !== "+") throw new Unsupported();
        return { block: { t: "bullet", marker, tight, items }, hidden: false };
      }
      const delim = t.markup;
      if (delim !== "." && delim !== ")") throw new Unsupported();
      const start = Number(attr(t, "start") ?? "1");
      return { block: { t: "ordered", start, delim, tight, items }, hidden: false };
    }
    case "table_open": {
      c.i++;
      const align: RichAlign[] = [];
      const head: RichInline[] = [];
      const rows: RichInline[][] = [];
      expect(c, "thead_open");
      expect(c, "tr_open");
      while (c.tokens[c.i]?.type === "th_open") {
        const th = c.tokens[c.i] as MdToken;
        c.i++;
        align.push(alignOf(th));
        head.push(inlineFromTokens(inlineAt(c).children ?? []));
        expect(c, "th_close");
      }
      expect(c, "tr_close");
      expect(c, "thead_close");
      if (c.tokens[c.i]?.type === "tbody_open") {
        c.i++;
        while (c.tokens[c.i]?.type === "tr_open") {
          c.i++;
          const row: RichInline[] = [];
          while (c.tokens[c.i]?.type === "td_open") {
            c.i++;
            row.push(inlineFromTokens(inlineAt(c).children ?? []));
            expect(c, "td_close");
          }
          expect(c, "tr_close");
          rows.push(row);
        }
        expect(c, "tbody_close");
      }
      expect(c, "table_close");
      return { block: { t: "table", align, head, rows }, hidden: false };
    }
    case "fence":
      c.i++;
      return {
        block: { t: "code", fence: t.markup, info: t.info, text: t.content },
        hidden: false,
      };
    case "code_block":
      c.i++;
      return { block: { t: "indented", text: t.content }, hidden: false };
    case "hr":
      c.i++;
      return { block: { t: "divider", markup: t.markup }, hidden: false };
    default:
      throw new Unsupported();
  }
}

function alignOf(t: MdToken): RichAlign {
  const style = attr(t, "style") ?? "";
  const cls = attr(t, "class") ?? "";
  const m = /text-align:(left|center|right)/.exec(style) ?? /align-(left|center|right)/.exec(cls);
  return (m?.[1] as RichAlign) ?? null;
}

const isList = (b: RichBlock): b is Extract<RichBlock, { t: "bullet" | "ordered" }> =>
  b.t === "bullet" || b.t === "ordered";

/** The one block a Markdown text holds, read from `source`'s tokens; null if it is not one. */
export function blockFromSource(
  text: string,
  source: MarkdownSource,
  env: MdEnv,
): RichBlock | null {
  try {
    const tokens = source.parse(text, { ...env, references: { ...(env.references ?? {}) } });
    const c: Cursor = { tokens, i: 0 };
    if (tokens.length === 0) return null;
    const { block } = blockAt(c, true);
    if (c.i !== tokens.length) return null;
    return normalizeBlock(block);
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

// ---------- normalizing ----------

const sameLink = (a: LinkMark | undefined, b: LinkMark | undefined) =>
  a === b || (!!a && !!b && a.href === b.href && a.title === b.title);

export function sameMarks(a: RichMarks, b: RichMarks): boolean {
  return (
    !!a.strong === !!b.strong &&
    !!a.em === !!b.em &&
    !!a.strike === !!b.strike &&
    !!a.code === !!b.code &&
    sameLink(a.link, b.link)
  );
}

function cleanMarks(m: RichMarks): RichMarks {
  const out: RichMarks = {};
  if (m.strong) out.strong = true;
  if (m.em) out.em = true;
  if (m.strike) out.strike = true;
  if (m.code) out.code = true;
  if (m.link) out.link = m.link;
  return out;
}

/** Context for whitespace and breaks: a paragraph, a one-line heading or a table cell. */
type InlineContext = "flow" | "line";

/**
 * The inline content as markdown-it would read it back: adjacent runs with the same marks joined,
 * white space at the start and end of every line dropped, no empty lines, no break at either end,
 * marks never starting or ending on white space, and (in a one-line context) no line breaks.
 */
export function normalizeInline(c: RichInline, ctx: InlineContext = "flow"): RichInline {
  // 1. Lines: per-line trim, empty lines dropped, breaks at the ends dropped.
  const segs: RichSeg[] = [];
  for (const s of c) {
    if (s.k === "br") {
      if (ctx === "line") segs.push({ k: "text", text: " ", m: {} });
      else segs.push(s);
      continue;
    }
    if (s.k === "atom") {
      segs.push({ k: "atom", md: s.md, m: cleanMarks({ ...s.m, code: false }) });
      continue;
    }
    let text = s.text.replace(/\r\n?/g, "\n");
    if (s.m.code) text = text.replace(/\n/g, " ");
    else if (ctx === "line") text = text.replace(/\n/g, " ");
    if (text !== "") segs.push({ k: "text", text, m: cleanMarks(s.m) });
  }
  // Split texts at line breaks so each line can be trimmed on its own.
  const pieces: RichSeg[] = [];
  for (const s of segs) {
    if (s.k === "text" && !s.m.code && s.text.includes("\n")) {
      const parts = s.text.split("\n");
      parts.forEach((p, i) => {
        if (i > 0) pieces.push({ k: "text", text: "\n", m: {} });
        if (p !== "") pieces.push({ k: "text", text: p, m: s.m });
      });
    } else pieces.push(s);
  }
  const isNl = (s: RichSeg | undefined) => s?.k === "text" && s.text === "\n" && !s.m.code;
  const isEnd = (s: RichSeg | undefined) => s === undefined || isNl(s) || s.k === "br";
  // Trim white space next to line ends (and the block's ends).
  for (let i = 0; i < pieces.length; i++) {
    const s = pieces[i] as RichSeg;
    if (s.k !== "text" || s.m.code || isNl(s)) continue;
    let text = s.text;
    if (isEnd(pieces[i - 1])) text = text.replace(/^[ \t]+/, "");
    if (isEnd(pieces[i + 1])) text = text.replace(/[ \t]+$/, "");
    pieces[i] = { ...s, text };
  }
  let list = pieces.filter((s) => !(s.k === "text" && s.text === ""));
  // No empty lines, no break right after a hard break, none at either end.
  const lines: RichSeg[] = [];
  for (const s of list) {
    const prev = lines.at(-1);
    if (isNl(s) || s.k === "br") {
      if (prev === undefined || isNl(prev) || prev.k === "br") {
        if (s.k === "br" && prev && isNl(prev)) lines[lines.length - 1] = s;
        continue;
      }
    }
    lines.push(s);
  }
  while (lines.length > 0 && (isNl(lines.at(-1)) || lines.at(-1)?.k === "br")) lines.pop();
  list = lines;
  // 2. RichMarks never start or end on white space (except code and links).
  const out: RichSeg[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] as RichSeg;
    if (s.k !== "text" || s.m.code || isNl(s) || (!s.m.strong && !s.m.em && !s.m.strike)) {
      out.push(s);
      continue;
    }
    const prev = list[i - 1];
    const next = list[i + 1];
    const keepsStart = prev && prev.k !== "br" && !isNl(prev) && sharesFlankingMark(prev, s);
    const keepsEnd = next && next.k !== "br" && !isNl(next) && sharesFlankingMark(next, s);
    let text = s.text;
    let lead = "";
    let trail = "";
    if (!keepsStart) {
      lead = /^\s*/.exec(text)?.[0] ?? "";
      text = text.slice(lead.length);
    }
    if (!keepsEnd) {
      trail = /\s*$/.exec(text)?.[0] ?? "";
      text = text.slice(0, text.length - trail.length);
    }
    const bare: RichMarks = s.m.link ? { link: s.m.link } : {};
    if (lead) out.push({ k: "text", text: lead, m: bare });
    if (text) out.push({ k: "text", text, m: s.m });
    else if (!lead && !trail) out.push(s);
    if (trail) out.push({ k: "text", text: trail, m: bare });
  }
  // 3. Join neighbours with the same marks.
  const joined: RichSeg[] = [];
  for (const s of out) {
    const prev = joined.at(-1);
    if (prev?.k === "text" && s.k === "text" && !isNl(prev) && !isNl(s) && sameMarks(prev.m, s.m)) {
      joined[joined.length - 1] = { ...prev, text: prev.text + s.text };
    } else if (prev?.k === "text" && s.k === "text" && sameMarks(prev.m, s.m) && prev.m.code) {
      joined[joined.length - 1] = { ...prev, text: prev.text + s.text };
    } else joined.push(s);
  }
  // A line break carries no marks.
  return joined.map((s) => (isNl(s) ? { k: "text", text: "\n", m: {} } : s));
}

function sharesFlankingMark(a: RichSeg, b: Extract<RichSeg, { k: "text" }>): boolean {
  if (a.k === "br") return false;
  const m = a.m;
  return (!!b.m.strong && !!m.strong) || (!!b.m.em && !!m.em) || (!!b.m.strike && !!m.strike);
}

function normalizeItems(items: readonly RichListItem[]): RichListItem[] {
  return items.map((it) => ({
    blocks: it.blocks.map(normalizeBlock).filter((b) => !(b.t === "paragraph" && b.c.length === 0)),
  }));
}

/** A list with one item of at most one block has no blank line to be loose by: it is tight. */
function tightness(items: readonly RichListItem[], tight: boolean): boolean {
  return tight || (items.length <= 1 && (items[0]?.blocks.length ?? 0) <= 1);
}

/** The fence a code block is written with: long enough for its text, never clashing with info. */
function codeFence(fence: string, info: string, text: string): string {
  let ch = fence[0] === "~" ? "~" : "`";
  if (ch === "`" && info.includes("`")) ch = "~";
  const re = ch === "`" ? /^ {0,3}(`+)/ : /^ {0,3}(~+)/;
  let run = 0;
  for (const l of text.split("\n")) run = Math.max(run, re.exec(l)?.[1]?.length ?? 0);
  const len = Math.max(3, fence[0] === ch ? fence.length : 3, run + 1);
  return ch.repeat(len);
}

/** A block as markdown-it would read it back (see normalizeInline). */
export function normalizeBlock(b: RichBlock): RichBlock {
  switch (b.t) {
    case "paragraph":
      return { t: "paragraph", c: normalizeInline(b.c) };
    case "heading":
      return {
        t: "heading",
        level: Math.min(6, Math.max(1, Math.trunc(b.level))),
        setext: b.setext && b.level <= 2,
        c: normalizeInline(b.c, b.setext && b.level <= 2 ? "flow" : "line"),
      };
    case "quote":
      return {
        t: "quote",
        blocks: b.blocks
          .map(normalizeBlock)
          .filter((x) => !(x.t === "paragraph" && x.c.length === 0)),
      };
    case "bullet": {
      const items = normalizeItems(b.items);
      return { ...b, tight: tightness(items, b.tight), items };
    }
    case "ordered": {
      const items = normalizeItems(b.items);
      return {
        ...b,
        start: Math.max(0, Math.trunc(b.start)),
        tight: tightness(items, b.tight),
        items,
      };
    }
    case "table": {
      const n = b.head.length;
      const cell = (c: RichInline | undefined) => normalizeInline(c ?? [], "line");
      return {
        t: "table",
        align: Array.from({ length: n }, (_, i) => b.align[i] ?? null),
        head: b.head.map(cell),
        rows: b.rows.map((r) => Array.from({ length: n }, (_, i) => cell(r[i]))),
      };
    }
    case "code": {
      const raw = b.text.replace(/\r\n?/g, "\n");
      const text = raw === "" || raw.endsWith("\n") ? raw : `${raw}\n`;
      const info = b.info.replace(/[\r\n]+/g, " ");
      return { t: "code", fence: codeFence(b.fence, info, text), info, text };
    }
    case "indented": {
      const lines = b.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
      return { t: "indented", text: lines.length ? `${lines.join("\n")}\n` : "" };
    }
    case "divider":
    case "image":
      return b;
  }
}

/** A canonical text for comparing models (a link's `dest` is how it was written, not what). */
export function blockKey(b: RichBlock): string {
  return JSON.stringify(b, (k, v) => (k === "dest" ? undefined : v));
}

export function sameBlock(a: RichBlock, b: RichBlock): boolean {
  return blockKey(normalizeBlock(a)) === blockKey(normalizeBlock(b));
}

/** Whether a block holds no text a person wrote (an empty paragraph, heading, list or quote). */
export function isEmptyBlock(b: RichBlock): boolean {
  switch (b.t) {
    case "paragraph":
    case "heading":
      return normalizeInline(b.c).length === 0;
    case "quote":
      return b.blocks.every(isEmptyBlock);
    case "bullet":
    case "ordered":
      return b.items.every((it) => it.blocks.every(isEmptyBlock));
    case "code":
    case "indented":
      return b.text.trim() === "";
    default:
      return false;
  }
}

// ---------- the model to Markdown ----------

const ENTITY_RE = /&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/g;
const URL_RUN_RE = /(?<![A-Za-z0-9.+-])(?:https?:\/\/|mailto:)[^\s<]*/gi;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/** Escapes inline syntax in one line of text (no line breaks). */
function escapeInlineText(text: string, d: MarkdownDialect, inTable: boolean): string {
  const runs: [number, number][] = [];
  if (d.linkify) {
    for (const m of text.matchAll(URL_RUN_RE)) runs.push([m.index, m.index + m[0].length]);
  }
  let out = "";
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    while (r < runs.length && (runs[r] as [number, number])[1] <= i) r++;
    const run = runs[r];
    const inUrl = run !== undefined && run[0] <= i && i < run[1];
    if (inUrl && ch !== "<" && !(inTable && ch === "|")) {
      out += ch;
      continue;
    }
    switch (ch) {
      case "\\":
      case "*":
      case "`":
      case "[":
      case "]":
      case "<":
        out += `\\${ch}`;
        break;
      case "_": {
        const prev = text[i - 1];
        const next = text[i + 1];
        const intraword =
          prev !== undefined && next !== undefined && ALNUM_RE.test(prev) && ALNUM_RE.test(next);
        out += intraword ? ch : "\\_";
        break;
      }
      case "~":
        out += d.gfm ? "\\~" : ch;
        break;
      case "|":
        out += d.gfm || inTable ? "\\|" : ch;
        break;
      default:
        out += ch;
    }
  }
  return out.replace(ENTITY_RE, "\\&");
}

/** Escapes what would start a block at the start of a line (after the line's own prefix). */
function escapeLineStart(line: string): string {
  if (line === "") return line;
  if (/^[#>+=-]/.test(line)) return `\\${line}`;
  const ordered = /^(\d{1,9})([.)])/.exec(line);
  if (ordered) return `${ordered[1]}\\${line.slice((ordered[1] as string).length)}`;
  // ~~~ opens a code fence in every dialect, even where ~ is not otherwise syntax.
  if (line.startsWith("~")) return `\\${line}`;
  return line;
}

type Mark = "link" | "strike" | "strong" | "em" | "code";
const ORDER: readonly Mark[] = ["link", "strike", "strong", "em", "code"];

function hasMark(m: RichMarks, k: Mark): boolean {
  return k === "link" ? m.link !== undefined : !!m[k];
}

function linkDest(l: LinkMark): string {
  const url = l.href;
  const target = /^[^\s<>()\\]*$/.test(url) ? url : `<${url.replace(/[<>\\]/g, "\\$&")}>`;
  const title = l.title ? ` "${l.title.replace(/["\\]/g, "\\$&")}"` : "";
  return `(${target}${title})`;
}

function codeSpan(text: string, inTable: boolean): string {
  const body = inTable ? text.replace(/\|/g, "\\|") : text;
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  const pad =
    body.startsWith("`") ||
    body.endsWith("`") ||
    (body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "");
  return pad ? `${fence} ${body} ${fence}` : `${fence}${body}${fence}`;
}

/**
 * RichInline content as Markdown lines. RichMarks nest in one fixed order (link, strike, strong, em, code),
 * emphasis is always `*…*` (CommonMark reads no intraword underscores as emphasis, so "un" +
 * *believ* + "able" must be `un*believ*able`), and a hard break is `\` at the end of a line.
 */
function serializeInline(
  c: RichInline,
  d: MarkdownDialect,
  opts: { lineStart: boolean; inTable?: boolean },
): string[] {
  const inTable = opts.inTable ?? false;
  const lines: string[] = [""];
  const open: Mark[] = [];
  let openLink: LinkMark | undefined;
  /** Text written on this line so far, before line-start escaping. */
  let fresh = true;
  const write = (s: string) => {
    lines[lines.length - 1] += s;
  };
  const writeText = (s: string) => {
    let t = escapeInlineText(s, d, inTable);
    if (fresh && opts.lineStart) t = escapeLineStart(t);
    if (t !== "") fresh = false;
    write(t);
  };
  const close = (k: Mark) => {
    if (k === "link") {
      write(`]${openLink?.dest ?? linkDest(openLink as LinkMark)}`);
      openLink = undefined;
    } else if (k === "strike") write("~~");
    else if (k === "strong") write("**");
    else if (k === "em") write("*");
  };
  const openMark = (k: Mark, m: RichMarks) => {
    if (k === "link") {
      const line = lines[lines.length - 1] as string;
      // "!" right before "[" would make the link an image.
      if (line.endsWith("!") && !/(^|[^\\])(\\\\)*\\!$/.test(line)) {
        lines[lines.length - 1] = `${line.slice(0, -1)}\\!`;
      }
      write("[");
      openLink = m.link;
    } else if (k === "strike") {
      if (!d.gfm) throw new Unsupported();
      write("~~");
    } else if (k === "strong") write("**");
    else if (k === "em") write("*");
    fresh = false;
  };
  const target = (m: RichMarks): Mark[] => ORDER.filter((k) => k !== "code" && hasMark(m, k));
  const sync = (m: RichMarks) => {
    const want = target(m);
    let keep = 0;
    while (
      keep < open.length &&
      keep < want.length &&
      open[keep] === want[keep] &&
      (open[keep] !== "link" || sameLink(openLink, m.link))
    ) {
      keep++;
    }
    while (open.length > keep) close(open.pop() as Mark);
    for (let i = keep; i < want.length; i++) {
      openMark(want[i] as Mark, m);
      open.push(want[i] as Mark);
    }
  };
  const isBreak = (s: RichSeg | undefined) =>
    s !== undefined && (s.k === "br" || (s.k === "text" && s.text === "\n" && !s.m.code));
  let last: RichMarks = {};
  for (let i = 0; i < c.length; i++) {
    const s = c[i] as RichSeg;
    if (isBreak(s)) {
      // A mark stays open over a line break only when the text after it has the mark too: a
      // delimiter at the start of the next line could not close it.
      let j = i + 1;
      while (isBreak(c[j])) j++;
      const next = c[j];
      const after: RichMarks = next && next.k !== "br" ? next.m : {};
      const common: RichMarks = {};
      if (last.strong && after.strong) common.strong = true;
      if (last.em && after.em) common.em = true;
      if (last.strike && after.strike) common.strike = true;
      if (last.link && sameLink(last.link, after.link)) common.link = last.link;
      sync(common);
      last = common;
      if (s.k === "br") write("\\");
      lines.push("");
      fresh = true;
      continue;
    }
    if (s.k === "br") continue;
    last = s.m;
    sync(s.m);
    if (s.k === "atom") {
      write(s.md);
      fresh = false;
    } else if (s.m.code) {
      write(codeSpan(s.text, inTable));
      fresh = false;
    } else writeText(s.text);
  }
  sync({});
  return lines;
}

const indent = (lines: string[], first: string, rest: string): string[] =>
  lines.map((l, i) => (i === 0 ? first + l : l === "" ? "" : rest + l));

function serializeItems(
  items: readonly RichListItem[],
  tight: boolean,
  marker: (i: number) => string,
  d: MarkdownDialect,
): string[] {
  const out: string[] = [];
  items.forEach((it, i) => {
    if (i > 0 && !tight) out.push("");
    const m = marker(i);
    const body: string[] = [];
    it.blocks.forEach((b, j) => {
      if (j > 0 && !tight) body.push("");
      body.push(...serializeLines(b, d));
    });
    if (body.length === 0) out.push(m);
    else out.push(...indent(body, `${m} `, " ".repeat(m.length + 1)));
  });
  return out;
}

function serializeLines(b: RichBlock, d: MarkdownDialect): string[] {
  switch (b.t) {
    case "paragraph":
      return serializeInline(b.c, d, { lineStart: true });
    case "heading": {
      if (b.setext) {
        const lines = serializeInline(b.c, d, { lineStart: true });
        return [...lines, b.level === 1 ? "===" : "---"];
      }
      let text = (serializeInline(b.c, d, { lineStart: false })[0] ?? "").trimEnd();
      // A closing run of #s would be read as the heading's end.
      text = text.replace(/(^|\s)(#+)$/, "$1\\$2");
      return [`${"#".repeat(b.level)}${text === "" ? "" : ` ${text}`}`];
    }
    case "quote": {
      const body: string[] = [];
      b.blocks.forEach((x, i) => {
        if (i > 0) body.push("");
        body.push(...serializeLines(x, d));
      });
      if (body.length === 0) return [">"];
      return body.map((l) => (l === "" ? ">" : `> ${l}`));
    }
    case "bullet":
      return serializeItems(b.items, b.tight, () => b.marker, d);
    case "ordered":
      return serializeItems(b.items, b.tight, (i) => `${b.start + i}${b.delim}`, d);
    case "table": {
      if (!d.gfm) throw new Unsupported();
      const cell = (c: RichInline) =>
        serializeInline(c, d, { lineStart: false, inTable: true }).join(" ");
      const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const rule = b.align.map((a) =>
        a === "left" ? ":--" : a === "center" ? ":-:" : a === "right" ? "--:" : "---",
      );
      return [row(b.head.map(cell)), row(rule), ...b.rows.map((r) => row(r.map(cell)))];
    }
    case "code": {
      const body = b.text === "" ? [] : b.text.replace(/\n$/, "").split("\n");
      const fence = codeFence(b.fence, b.info, b.text);
      return [`${fence}${b.info}`, ...body, fence];
    }
    case "indented": {
      const body = b.text.replace(/\n$/, "").split("\n");
      return body.map((l) => (l.trim() === "" ? "" : `    ${l}`));
    }
    case "divider":
      return [b.markup];
    case "image": {
      const alt = serializeInline(
        [{ k: "text", text: b.alt.replace(/\s+/g, " ").trim(), m: {} }],
        d,
        {
          lineStart: false,
        },
      ).join(" ");
      return [`![${alt}]${b.rest}`];
    }
  }
}

/**
 * A block as Markdown, with no trailing newline. An empty paragraph, heading, list, quote or code
 * block is "", which removes it. Throws for what the dialect cannot hold (a table, strikethrough
 * outside GFM); verifyBlock turns that into a refusal.
 */
export function serializeBlock(block: RichBlock, d: MarkdownDialect = DOC_DIALECT): string {
  const b = normalizeBlock(block);
  if (isEmptyBlock(b)) return "";
  return serializeLines(b, d).join("\n");
}

// ---------- the fidelity check and the verify step ----------

/** The parts of a token that decide what it renders, as a flat list for comparing. */
function signature(tokens: readonly MdToken[], out: string[] = []): string[] {
  let text: string | null = null;
  const flush = () => {
    if (text !== null) out.push(`text:${text}`);
    text = null;
  };
  for (const t of tokens) {
    if (t.type === "text") {
      text = (text ?? "") + t.content;
      continue;
    }
    flush();
    if (t.type === "image") {
      out.push(
        `image:${attr(t, "src") ?? ""}:${attr(t, "title") ?? ""}:${tokensPlainText(t.children)}`,
      );
      continue;
    }
    // Emphasis written with * or _ (and a code span's fence) renders the same; the number of an
    // ordered list item after its list's start is not rendered.
    const markup = /^(em|strong)_(open|close)$|^code_inline$|^list_item/.test(t.type)
      ? ""
      : t.markup;
    const attrs = JSON.stringify([...(t.attrs ?? [])].sort((a, b) => a[0].localeCompare(b[0])));
    const leaf = t.type === "code_inline" || t.type === "fence" || t.type === "code_block";
    out.push(
      [
        t.type,
        t.tag,
        t.nesting,
        t.hidden ? 1 : 0,
        attrs,
        markup,
        t.type === "fence" ? t.info : "",
        leaf ? t.content : "",
      ].join("\u0001"),
    );
    if (t.type === "inline" && t.children) {
      out.push("(");
      signature(t.children, out);
      out.push(")");
    }
  }
  flush();
  return out;
}

/** Whether two Markdown texts render the same with `render` (see signature). */
export function sameRendering(a: string, b: string, render: MarkdownParser, env: MdEnv): boolean {
  const fresh = (): MdEnv => ({ ...env, references: { ...(env.references ?? {}) } });
  const x = signature(render.parse(a, fresh()));
  const y = signature(render.parse(b, fresh()));
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

export interface MarkdownTools {
  source: MarkdownSource;
  render: MarkdownParser;
  dialect: MarkdownDialect;
}

/** Whether a text defines reference links itself (which the model would drop). */
function definesReferences(text: string, source: MarkdownSource): boolean {
  const env: MdEnv = {};
  source.parse(text, env);
  return Object.keys(env.references ?? {}).length > 0;
}

/**
 * The fidelity check before a lease: the block's model if the block can be edited in place, else
 * null. It must be one block the model holds, define no references inside it, and be written back
 * by serializeBlock into Markdown that renders exactly as the original does (with `render`, the
 * page's own instance, and the doc's `env`) and reads back into the same model.
 */
export function editableBlock(text: string, tools: MarkdownTools, env: MdEnv): RichBlock | null {
  const block = blockFromSource(text, tools.source, env);
  if (!block) return null;
  if (definesReferences(text, tools.source)) return null;
  let out: string;
  try {
    out = serializeBlock(block, tools.dialect);
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
  if (out === "" || !sameRendering(text, out, tools.render, env)) return null;
  const again = blockFromSource(out, tools.source, env);
  if (!again || !sameBlock(block, again)) return null;
  return block;
}

/**
 * The verify step after each edit: the Markdown to send for `block` if it reads back into the
 * same model, else null (a mark combination CommonMark cannot express, say). "" (an empty block)
 * always verifies.
 */
export function verifyBlock(block: RichBlock, tools: MarkdownTools, env: MdEnv): string | null {
  let out: string;
  try {
    out = serializeBlock(block, tools.dialect);
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
  if (out === "") return "";
  const again = blockFromSource(out, tools.source, env);
  if (!again || !sameBlock(block, again)) return null;
  if (definesReferences(out, tools.source)) return null;
  return out;
}

// ---------- editing helpers ----------

/** A segment's length in the editor's flat text: text by its characters, an atom or break as 1. */
export function segLength(s: RichSeg): number {
  return s.k === "text" ? s.text.length : 1;
}

export function inlineLength(c: RichInline): number {
  let n = 0;
  for (const s of c) n += segLength(s);
  return n;
}

/** Splits inline content at a flat offset. */
export function splitInline(c: RichInline, at: number): [RichInline, RichInline] {
  const a: RichInline = [];
  const b: RichInline = [];
  let pos = 0;
  for (const s of c) {
    const len = segLength(s);
    if (pos + len <= at) a.push(s);
    else if (pos >= at) b.push(s);
    else if (s.k === "text") {
      a.push({ ...s, text: s.text.slice(0, at - pos) });
      b.push({ ...s, text: s.text.slice(at - pos) });
    } else b.push(s);
    pos += len;
  }
  return [a, b];
}

export type ToggleMark = "strong" | "em" | "strike" | "code";

/** Whether every text character in [from, to) has `mark` (false for an empty range). */
export function rangeHasMark(c: RichInline, from: number, to: number, mark: ToggleMark | "link") {
  let any = false;
  let pos = 0;
  for (const s of c) {
    const len = segLength(s);
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + len);
    if (a < b && s.k !== "br") {
      if (s.k === "text" && s.text.slice(a - pos, b - pos).trim() === "" && mark !== "link") {
        pos += len;
        continue;
      }
      any = true;
      if (!hasMark(s.m, mark)) return false;
    }
    pos += len;
  }
  return any;
}

/** Sets or clears a mark (or a link, with `link`) on [from, to). */
export function applyMark(
  c: RichInline,
  from: number,
  to: number,
  mark: ToggleMark | "link",
  on: boolean,
  link?: LinkMark,
): RichInline {
  const [head, rest] = splitInline(c, from);
  const [mid, tail] = splitInline(rest, to - from);
  const changed = mid.map((s): RichSeg => {
    if (s.k === "br") return s;
    if (s.k === "atom" && mark === "code") return s;
    const m: RichMarks = { ...s.m };
    if (mark === "link") {
      if (on && link) m.link = link;
      else delete m.link;
    } else if (on) m[mark] = true;
    else delete m[mark];
    return { ...s, m } as RichSeg;
  });
  return [...head, ...changed, ...tail];
}

/** The plain text of inline content (atoms as their Markdown). */
export function inlinePlainText(c: RichInline): string {
  return c.map((s) => (s.k === "br" ? "\n" : s.k === "atom" ? s.md : s.text)).join("");
}

// ---------- recording where links and images came from ----------

interface InlineState {
  pos: number;
  src: string;
  tokens: MdToken[];
}

type InlineRule = (state: InlineState, silent: boolean) => boolean;

/** The parts of a markdown-it instance recordSources wraps. */
export interface RecordableMarkdown {
  inline: {
    ruler: {
      __rules__: { name: string; fn: InlineRule }[];
      at(name: string, fn: InlineRule): void;
    };
  };
  helpers: {
    parseLinkLabel(state: InlineState, start: number, disableNested?: boolean): number;
  };
}

/**
 * Makes `md` a MarkdownSource: its link and image rules then put `meta.plinthSource` on every
 * link_open and image token, with the Markdown the link was written as. It changes no output.
 */
export function recordSources(md: RecordableMarkdown): void {
  for (const name of ["link", "image"] as const) {
    const rule = md.inline.ruler.__rules__.find((r) => r.name === name);
    if (!rule) throw new Error(`markdown-it has no ${name} rule`);
    const original = rule.fn;
    md.inline.ruler.at(name, (state, silent) => {
      const start = state.pos;
      const n = state.tokens.length;
      if (!original(state, silent)) return false;
      if (silent) return true;
      const image = name === "image";
      const labelStart = start + (image ? 2 : 1);
      const end = state.pos;
      const labelEnd = md.helpers.parseLinkLabel(state, start + (image ? 1 : 0), !image);
      state.pos = end;
      const tok = state.tokens.slice(n).find((t) => t.type === (image ? "image" : "link_open"));
      if (tok && labelEnd >= labelStart) {
        const meta: SourceMeta = {
          src: state.src.slice(start, end),
          label: state.src.slice(labelStart, labelEnd),
          after: state.src.slice(labelEnd + 1, end),
        };
        tok.meta = { ...(tok.meta ?? {}), plinthSource: meta };
      }
      return true;
    });
  }
}
