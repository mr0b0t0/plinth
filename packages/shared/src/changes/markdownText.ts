// Markdown as a person reads it, for change lists: the top-level blocks of a text (headings,
// paragraphs, lists, quotes, code, tables, dividers, images) and the visible text of each, with
// the Markdown syntax stripped. A line scanner, linear in the input; it does not render anything
// and is close to, not exactly, CommonMark: good enough to say what changed and where.
import { decodeEntities } from "./text.ts";

export type MdBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "code"
  | "table"
  | "divider"
  | "image"
  | "definition";

export interface MdImage {
  src: string;
  alt: string;
}

/** One item of a list: its lines as written, and its visible text. */
export interface MdListItem {
  raw: string;
  text: string;
}

export interface MdBlock {
  kind: MdBlockKind;
  /** The block's lines as written, with trailing spaces dropped: its identity in a diff. */
  raw: string;
  /** Its visible text. */
  text: string;
  /** Heading level, 1 to 6. */
  level?: number;
  /** A list's items, in order. */
  items?: MdListItem[];
  images: MdImage[];
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE_RE = /^ {0,3}>/;
const DEFINITION_RE = /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*\S/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** An ATX heading's level and text, or null. */
function atxHeading(line: string): { level: number; text: string } | null {
  const t = line.replace(/^ {0,3}/, "");
  let level = 0;
  while (level < t.length && t[level] === "#") level++;
  if (level < 1 || level > 6) return null;
  const rest = t.slice(level);
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") return null;
  let text = rest.trim();
  // A closing run of #s, when a space separates it from the text.
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end === 0) text = "";
  else if (end < text.length && (text[end - 1] === " " || text[end - 1] === "\t")) {
    text = text.slice(0, end).trimEnd();
  }
  return { level, text };
}

function isDivider(line: string): boolean {
  const t = line.replace(/[ \t]/g, "");
  if (t.length < 3 || line.match(/^ {4}/)) return false;
  const c = t[0];
  if (c !== "-" && c !== "*" && c !== "_") return false;
  for (const ch of t) if (ch !== c) return false;
  return true;
}

/** A setext underline: its heading level, or 0. */
function setextLevel(line: string): number {
  const t = line.trim();
  if (line.match(/^ {4}/) || t === "") return 0;
  if (/^=+$/.test(t)) return 1;
  if (/^-+$/.test(t)) return 2;
  return 0;
}

function isTableDelimiter(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-")) return false;
  for (const ch of t) if (!"|:- \t".includes(ch)) return false;
  return t.includes("|") || /^:?-+:?$/.test(t);
}

interface Inline {
  /** Links as their text and images as their alt text. */
  text: string;
  /** The same with images left out. */
  bare: string;
  images: MdImage[];
}

/** For each index, the next index at or after it holding `ch`, or -1. One pass from the end. */
function nextOf(s: string, ch: string): Int32Array {
  const out = new Int32Array(s.length + 2).fill(-1);
  for (let i = s.length - 1; i >= 0; i--) out[i] = s[i] === ch ? i : (out[i + 1] as number);
  return out;
}

/**
 * Links ([text](url), [text][ref]) and images (![alt](src "title")) of one block's text, in one
 * linear pass: every bracket looks up the next "]", ")" and line break in precomputed tables, and
 * text is copied only once a construct is complete, so no input makes it quadratic.
 */
function scanInline(s: string): Inline {
  if (!s.includes("[")) return { text: s, bare: s, images: [] };
  const close = nextOf(s, "]");
  const paren = nextOf(s, ")");
  const nl = nextOf(s, "\n");
  const before = (end: number, from: number) =>
    end >= 0 && ((nl[from] as number) < 0 || end < (nl[from] as number));
  let text = "";
  let bare = "";
  const images: MdImage[] = [];
  let i = 0;
  let copied = 0;
  while (i < s.length) {
    const image = s[i] === "!" && s[i + 1] === "[";
    if (s[i] !== "[" && !image) {
      i++;
      continue;
    }
    const open = image ? i + 1 : i;
    const end = close[open + 1] as number;
    if (!before(end, open)) {
      i = open + 1;
      continue;
    }
    let next = -1;
    let dest = "";
    if (s[end + 1] === "(") {
      const p = paren[end + 2] as number;
      if (before(p, end + 1)) {
        next = p + 1;
        dest = s.slice(end + 2, p).trim();
      }
    } else if (!image && s[end + 1] === "[") {
      const r = close[end + 2] as number;
      if (before(r, end + 1)) next = r + 1;
    }
    if (next < 0) {
      i = open + 1;
      continue;
    }
    const label = s.slice(open + 1, end);
    const kept = s.slice(copied, i);
    text += kept + label;
    bare += image ? kept : kept + label;
    if (image) {
      const src =
        (dest.startsWith("<") ? dest.slice(1, dest.indexOf(">") >>> 0) : dest.split(/\s/)[0]) ?? "";
      images.push({ alt: label, src });
    }
    i = next;
    copied = next;
  }
  text += s.slice(copied);
  bare += s.slice(copied);
  return { text, bare, images };
}

/** Images in Markdown text: ![alt](src "title"). */
export function inlineImages(text: string): MdImage[] {
  return scanInline(text).images.map((img) => ({ ...img, alt: inlineText(img.alt) }));
}

/** The text a line of Markdown shows, with its inline syntax stripped. */
export function inlineText(text: string): string {
  return decodeEntities(
    scanInline(text)
      .text.replace(/<((?:https?|mailto):[^<>\s]*)>/gi, "$1")
      .replace(/`+([^`\n]*?)`+/g, "$1")
      .replace(/~~/g, "")
      .replace(/(?<![\\*])\*+(?=\S)|(?<=[^\s\\])\*+/g, "")
      .replace(/(?<![\w\\])_+(?=\S)|(?<=[^\s\\])_+(?!\w)/g, "")
      .replace(/\\([!-/:-@[-`{-~])/g, "$1"),
  );
}

/** A list line's text with its marker and task box stripped. */
function listLineText(l: string): string {
  return inlineText(
    l.replace(/^\s*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/, "").replace(/^\[[ xX]\][ \t]+/, ""),
  );
}

/** A list's items: each line with a marker starts one, and the lines after it continue it. */
function listItems(lines: string[]): MdListItem[] {
  const out: { raw: string[]; text: string[] }[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (LIST_RE.test(l) || !last) out.push({ raw: [l.trimEnd()], text: [listLineText(l)] });
    else {
      last.raw.push(l.trimEnd());
      last.text.push(listLineText(l));
    }
  }
  return out.map((x) => ({ raw: x.raw.join("\n"), text: x.text.join(" ") }));
}

function blockText(kind: MdBlockKind, lines: string[]): string {
  switch (kind) {
    case "list":
      return lines.map(listLineText).join(" ");
    case "quote":
      return lines.map((l) => inlineText(l.replace(/^(?:\s{0,3}>[ \t]?)+/, ""))).join(" ");
    case "table":
      return lines
        .filter((l) => !isTableDelimiter(l))
        .map((l) =>
          l
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => inlineText(c.trim()))
            .join(" · "),
        )
        .join(" / ");
    case "definition":
      return "";
    default:
      return lines.map((l) => inlineText(l.trim())).join(" ");
  }
}

function classify(lines: string[]): MdBlockKind {
  const first = lines[0] ?? "";
  if (LIST_RE.test(first)) return "list";
  if (QUOTE_RE.test(first)) return "quote";
  if (lines.length > 1 && first.includes("|") && isTableDelimiter(lines[1] ?? "")) return "table";
  if (lines.every((l) => DEFINITION_RE.test(l))) return "definition";
  const inline = scanInline(lines.join(" "));
  return inline.images.length > 0 && inline.bare.trim() === "" ? "image" : "paragraph";
}

/** The top-level blocks of a Markdown text, in order. */
export function markdownBlocks(src: string): MdBlock[] {
  const lines = src.split(/\r\n|\r|\n/);
  const out: MdBlock[] = [];
  const push = (kind: MdBlockKind, group: string[], extra: Partial<MdBlock> = {}) => {
    const raw = group.map((l) => l.trimEnd()).join("\n");
    const text = extra.text ?? blockText(kind, group);
    const images = kind === "code" ? [] : inlineImages(group.join("\n"));
    out.push({ kind, raw, text, images, ...extra });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const group = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i] as string;
        group.push(l);
        i++;
        const t = l.trim();
        if (
          t.length >= marker.length &&
          t[0] === marker[0] &&
          [...t].every((c) => c === marker[0])
        ) {
          break;
        }
      }
      const body = group.slice(1);
      const closed = body.length > 0 && FENCE_RE.test(body[body.length - 1] as string);
      push("code", group, { text: (closed ? body.slice(0, -1) : body).join("\n").trim() });
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      push("heading", [line], { level: atx.level, text: inlineText(atx.text) });
      i++;
      continue;
    }
    if (isDivider(line)) {
      push("divider", [line], { text: "" });
      i++;
      continue;
    }
    const group = [line];
    i++;
    let setext = 0;
    while (i < lines.length) {
      const l = lines[i] as string;
      if (isBlank(l)) break;
      const level = group.length > 0 && !LIST_RE.test(group[0] as string) ? setextLevel(l) : 0;
      if (level > 0 && !QUOTE_RE.test(group[0] as string)) {
        setext = level;
        group.push(l);
        i++;
        break;
      }
      if (FENCE_RE.test(l) || atxHeading(l) || isDivider(l)) break;
      group.push(l);
      i++;
    }
    if (setext > 0) {
      push("heading", group, {
        level: setext,
        text: group
          .slice(0, -1)
          .map((l) => inlineText(l.trim()))
          .join(" "),
      });
    } else {
      const kind = classify(group);
      push(kind, group, kind === "list" ? { items: listItems(group) } : {});
    }
  }
  return out;
}
