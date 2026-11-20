// A string scanner for HTML, for change lists. It finds the runs of text a page shows, tag names
// and the few attributes a change list mentions (link targets, image sources, stylesheets and
// scripts). It never builds a document: no DOM, no DOMParser, nothing is rendered or run, so user
// HTML is only ever read as a string on the app host. One pass, linear in the input, with no
// regular expression over more than a tag at a time. Hostile input (an unclosed comment or tag, a
// "</p>" inside a script, stray "<") ends a construct early or stays text, as a browser would
// roughly do; it never throws.
import { decodeEntities, foldSpace } from "./text.ts";

export interface HtmlTextRun {
  /** Visible text, whitespace folded, entities decoded. */
  text: string;
  /** Inside an h1 to h6. */
  heading: boolean;
  /**
   * The text of the nearest heading before this run, or "" before the first. For a heading, the
   * nearest one before it of a higher or the same level.
   */
  under: string;
  /** A heading that follows `under` at the same level ("Plot 5" after "Plot 4"), not inside it. */
  after?: true;
}

export interface HtmlScan {
  /** The <title>'s text, or null without one. */
  title: string | null;
  runs: HtmlTextRun[];
  /** Every link target (<a href>), in order. */
  links: string[];
  /** Every image source (<img src>, <source srcset> in a <picture>), in order. */
  images: string[];
  forms: number;
  /** Every script: its src, or its text. */
  scripts: string[];
  /** Every style: <style> text, stylesheet hrefs and style attributes. */
  styles: string[];
}

/** Tags whose content is raw text: never visible text, never parsed as tags. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "template",
]);
/** Tags whose content is text with character references, but no tags. */
const RCDATA = new Set(["title", "textarea"]);
/** Tags that do not break a run of text. */
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "font",
  "i",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function isAsciiAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
}

/**
 * ASCII letters lowercased and nothing else, as HTML does for tag and attribute names. Not
 * String#toLowerCase, which also maps other characters ("K", U+212A, to "k") and can change
 * a string's length ("İ", U+0130, becomes two code units).
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

interface Tag {
  name: string;
  end: boolean;
  attrs: Map<string, string>;
  /** Index just past the tag's ">". */
  next: number;
}

/** The tag that starts at `at` ("<" then a letter, or "</" then a letter), or null when unclosed. */
function readTag(s: string, at: number): Tag | null {
  let i = at + 1;
  const end = s[i] === "/";
  if (end) i++;
  const nameStart = i;
  while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">") i++;
  const name = asciiLower(s.slice(nameStart, i));
  const attrs = new Map<string, string>();
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === "/")) i++;
    if (i >= s.length) return null;
    if (s[i] === ">") return { name, end, attrs, next: i + 1 };
    const an = i;
    while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const attr = asciiLower(s.slice(an, i));
    while (i < s.length && isSpace(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < s.length && isSpace(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        if (close < 0) return null;
        value = s.slice(i + 1, close);
        i = close + 1;
      } else {
        const vs = i;
        while (i < s.length && !isSpace(s[i]) && s[i] !== ">") i++;
        value = s.slice(vs, i);
      }
    }
    if (attr !== "" && !attrs.has(attr)) attrs.set(attr, decodeEntities(value));
  }
  return null;
}

/**
 * Index of the end tag `</name` at or after `from`, or -1. The name is compared ASCII
 * case-insensitively in `s` itself: a lowercased copy of `s` can be longer, so its indices would
 * point elsewhere in `s`. `name` is lowercase ASCII.
 */
function findEndTag(s: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const at = s.indexOf("</", i);
    if (at < 0) return -1;
    i = at + 2;
    let k = 0;
    while (k < name.length && asciiLower(s[i + k] ?? "") === name[k]) k++;
    if (k < name.length) continue;
    const after = s[i + k];
    if (after === undefined || after === ">" || after === "/" || isSpace(after)) return at;
  }
}

/** Scans an HTML document or fragment. */
export function scanHtml(src: string): HtmlScan {
  const out: HtmlScan = {
    title: null,
    runs: [],
    links: [],
    images: [],
    forms: 0,
    scripts: [],
    styles: [],
  };
  let text = "";
  let headingDepth = 0;
  let under = "";
  let runHeading = false;
  // The level of the heading being read, and the latest heading of each level (1 to 6).
  let level = 1;
  const latest: ({ text: string; seq: number } | null)[] = [null, null, null, null, null, null];
  let seq = 0;
  const flush = () => {
    const t = foldSpace(decodeEntities(text));
    text = "";
    if (t === "") return;
    if (!runHeading) {
      out.runs.push({ text: t, heading: false, under });
      return;
    }
    let near: { text: string; seq: number } | null = null;
    let nearLevel = 0;
    for (let l = 1; l <= level; l++) {
      const h = latest[l - 1];
      if (h && (!near || h.seq > near.seq)) {
        near = h;
        nearLevel = l;
      }
    }
    out.runs.push({
      text: t,
      heading: true,
      under: near?.text ?? "",
      ...(near && nearLevel === level ? { after: true as const } : {}),
    });
    latest[level - 1] = { text: t, seq: seq++ };
    under = t;
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      text += src.slice(i);
      break;
    }
    text += src.slice(i, lt);
    const c = src[lt + 1];
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 4);
      i = close < 0 ? src.length : close + 3;
      continue;
    }
    if (c === "!" || c === "?") {
      const close = src.indexOf(">", lt + 2);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (!(isAsciiAlpha(c) || (c === "/" && isAsciiAlpha(src[lt + 2])))) {
      text += "<";
      i = lt + 1;
      continue;
    }
    const tag = readTag(src, lt);
    if (!tag) break;
    i = tag.next;
    const { name } = tag;
    if (!INLINE.has(name)) flush();

    if (tag.end) {
      if (HEADINGS.has(name) && headingDepth > 0) {
        headingDepth--;
        if (headingDepth === 0) runHeading = false;
      }
      continue;
    }
    if (HEADINGS.has(name)) {
      if (headingDepth === 0) level = Number(name[1]);
      headingDepth++;
      runHeading = true;
    }
    if (name === "a" && tag.attrs.has("href")) out.links.push(tag.attrs.get("href") as string);
    if (name === "img") out.images.push(tag.attrs.get("src") ?? tag.attrs.get("srcset") ?? "");
    if (name === "source" && tag.attrs.has("srcset")) {
      out.images.push(tag.attrs.get("srcset") as string);
    }
    if (name === "form") out.forms++;
    if (name === "link" && /(?:^|\s)stylesheet(?:\s|$)/i.test(tag.attrs.get("rel") ?? "")) {
      out.styles.push(`link:${tag.attrs.get("href") ?? ""}`);
    }
    if (tag.attrs.has("style")) out.styles.push(`attr:${tag.attrs.get("style")}`);

    if (RAW_TEXT.has(name) || RCDATA.has(name)) {
      const close = findEndTag(src, name, i);
      const body = src.slice(i, close < 0 ? src.length : close);
      const after = close < 0 ? src.length : src.indexOf(">", close);
      i = after < 0 ? src.length : after + 1;
      if (name === "script")
        out.scripts.push(tag.attrs.has("src") ? `src:${tag.attrs.get("src")}` : body);
      else if (name === "style") out.styles.push(body);
      else if (name === "title") out.title ??= foldSpace(decodeEntities(body));
      else if (name === "textarea") {
        text = body;
        flush();
      }
    }
  }
  flush();
  return out;
}

/** Tags whose text keeps its whitespace as written. */
const PREFORMATTED = new Set(["pre", "listing"]);

/**
 * The page's markup with what a person cannot see taken out: comments, whitespace between tags,
 * how runs of whitespace in text are written (except in <pre>, <listing>, <textarea> and <xmp>),
 * the case of tag and attribute names, the order of attributes, quotes around values, spacing
 * inside a class list and how characters are encoded. Two pages with one signature differ only in
 * how they are stored; two with different ones may look different even when their text, links,
 * images, forms, styles and scripts are equal (a class, a `hidden` attribute, <b>, an image's
 * size, a video, an SVG shape). A string scan like scanHtml: linear, never throws.
 */
export function markupSignature(src: string): string {
  const out: string[] = [];
  let text = "";
  let pre = 0;
  const flush = () => {
    const t = pre > 0 ? decodeEntities(text) : foldSpace(decodeEntities(text));
    text = "";
    if (t !== "") out.push(`t${JSON.stringify(t)}`);
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      text += src.slice(i);
      break;
    }
    text += src.slice(i, lt);
    const c = src[lt + 1];
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 4);
      i = close < 0 ? src.length : close + 3;
      continue;
    }
    if (c === "!" || c === "?") {
      flush();
      const close = src.indexOf(">", lt + 2);
      const body = src.slice(lt + 1, close < 0 ? src.length : close);
      out.push(`d${JSON.stringify(foldSpace(asciiLower(body)))}`);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (!(isAsciiAlpha(c) || (c === "/" && isAsciiAlpha(src[lt + 2])))) {
      text += "<";
      i = lt + 1;
      continue;
    }
    flush();
    const tag = readTag(src, lt);
    if (!tag) {
      out.push(`u${JSON.stringify(foldSpace(src.slice(lt)))}`);
      break;
    }
    i = tag.next;
    const { name } = tag;
    const attrs = [...tag.attrs]
      .map(([k, v]): [string, string] => [k, k === "class" ? foldSpace(v) : v])
      .sort(([x], [y]) => (x < y ? -1 : 1));
    out.push(`${tag.end ? "/" : "<"}${JSON.stringify([name, attrs])}`);
    if (PREFORMATTED.has(name)) {
      if (!tag.end) pre++;
      else if (pre > 0) pre--;
    }
    if (tag.end || !(RAW_TEXT.has(name) || RCDATA.has(name))) continue;
    const close = findEndTag(src, name, i);
    const body = src.slice(i, close < 0 ? src.length : close);
    const after = close < 0 ? src.length : src.indexOf(">", close);
    i = after < 0 ? src.length : after + 1;
    // Script and style text as written (the list compares them already); text that keeps its
    // whitespace as shown; the rest (title, template, noscript, iframe fallback) folded.
    const kept =
      name === "script" || name === "style" || name === "xmp"
        ? body
        : name === "textarea"
          ? decodeEntities(body)
          : foldSpace(name === "title" ? decodeEntities(body) : body);
    out.push(`r${JSON.stringify(kept)}`);
  }
  flush();
  return out.join("\n");
}
