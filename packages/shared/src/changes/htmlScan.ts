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
  /** The text of the nearest heading before this run, or "" before the first. */
  under: string;
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
  const name = s.slice(nameStart, i).toLowerCase();
  const attrs = new Map<string, string>();
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === "/")) i++;
    if (i >= s.length) return null;
    if (s[i] === ">") return { name, end, attrs, next: i + 1 };
    const an = i;
    while (i < s.length && !isSpace(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const attr = s.slice(an, i).toLowerCase();
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

/** Index of the case-insensitive end tag `</name` at or after `from`, or -1. */
function findEndTag(s: string, lower: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const at = lower.indexOf(`</${name}`, i);
    if (at < 0) return -1;
    const after = s[at + 2 + name.length];
    if (after === undefined || after === ">" || after === "/" || isSpace(after)) return at;
    i = at + 2;
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
  // Lowercased once, for end-tag searches; same length as src for every character we look for.
  const lower = src.toLowerCase();
  let text = "";
  let headingDepth = 0;
  let under = "";
  let runHeading = false;
  const flush = () => {
    const t = foldSpace(decodeEntities(text));
    text = "";
    if (t === "") return;
    out.runs.push({ text: t, heading: runHeading, under });
    if (runHeading) under = t;
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
      const close = findEndTag(src, lower, name, i);
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
