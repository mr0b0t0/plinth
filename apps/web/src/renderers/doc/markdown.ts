// Markdown for the doc type (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md). The
// source is untrusted. markdown-it runs with html off, so every tag in the source shows as text;
// links and images pass an allowlist instead of markdown-it's denylist; and the output carries only
// what doc.css styles. sanitize.ts checks the result again before it reaches the page.
//
// Dialect: CommonMark plus GitHub tables, strikethrough and bare-URL links. No highlighting, math,
// footnotes, task lists or front matter.
import MarkdownItParser, { type MarkdownIt, type StateCore, type Token } from "markdown-it";

const REL = "noopener noreferrer nofollow";

// Any C0 or C1 control character, DEL included. A destination holding one is refused outright:
// browsers drop tabs and newlines inside schemes ("java\tscript:"), so stripping them would hide one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Whitespace and invisible characters, removed before the scheme is read.
const INVISIBLE_RE = /[\s\u200b-\u200f\u2060\ufeff]/g;
// The scheme, if any: a colon before the first "/", "?" or "#".
const SCHEME_RE = /^([^/?#]*):/;
const LINK_SCHEMES = new Set(["http", "https", "mailto"]);
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,/;

/** The URL as the checks read it (lowercased, invisible characters gone), or null if refused. */
function canonical(url: string): string | null {
  if (CONTROL_RE.test(url)) return null;
  const s = url.replace(INVISIBLE_RE, "").toLowerCase();
  if (s === "" || s.includes("\\") || s.includes("%5c")) return null;
  return s;
}

/** Whether a scheme-less URL is a path on this origin (not "//host", which names another host). */
function isRelative(s: string): boolean {
  return !s.startsWith("//") && !SCHEME_RE.test(s);
}

/** Links: http, https, mailto, a #fragment, or a relative path. */
export function isSafeHref(url: string): boolean {
  const s = canonical(url);
  if (s === null) return false;
  if (s.startsWith("#")) return true;
  const scheme = SCHEME_RE.exec(s)?.[1];
  if (scheme !== undefined) return LINK_SCHEMES.has(scheme);
  return isRelative(s);
}

/** Images: a relative path (the artifact's own files) or an inline raster data: URL. */
export function isSafeImageSrc(url: string): boolean {
  const s = canonical(url);
  if (s === null || s.startsWith("#")) return false;
  if (DATA_IMAGE_RE.test(s)) return true;
  return isRelative(s);
}

/** Plain text of inline tokens, as markdown-it computes an image's alt. */
function plainText(tokens: readonly Token[] | null): string {
  let out = "";
  for (const t of tokens ?? []) {
    if (t.type === "text" || t.type === "code_inline") out += t.content;
    else if (t.type === "softbreak" || t.type === "hardbreak") out += " ";
    else if (t.type === "image") out += plainText(t.children);
  }
  return out;
}

/** A heading id: Unicode letters and digits joined by "-", never starting with "_". */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "section";
}

/** Heading ids taken so far, and the next suffix to try per base (so repeats stay linear). */
interface Slugs {
  used: Set<string>;
  next: Map<string, number>;
}

function uniqueSlug(text: string, slugs: Slugs): string {
  const base = slugify(text);
  let id = base;
  let n = slugs.next.get(base) ?? 1;
  while (slugs.used.has(id)) id = `${base}-${n++}`;
  slugs.next.set(base, n);
  slugs.used.add(id);
  return id;
}

function newTab(t: Token): void {
  t.attrSet("target", "_blank");
  t.attrSet("rel", REL);
}

/** Applies the URL rules to one inline run: drops bad links, turns external images into links. */
function rewriteInline(children: Token[], state: StateCore): Token[] {
  const out: Token[] = [];
  const kept: boolean[] = [];
  let depth = 0;
  const text = (content: string): Token => {
    const t = new state.Token("text", "", 0);
    t.content = content;
    return t;
  };
  for (const c of children) {
    if (c.type === "link_open") {
      const href = String(c.attrGet("href") ?? "");
      const ok = isSafeHref(href);
      kept.push(ok);
      if (ok) {
        depth++;
        if (!href.startsWith("#")) newTab(c);
        out.push(c);
      }
    } else if (c.type === "link_close") {
      if (kept.pop()) {
        depth--;
        out.push(c);
      }
    } else if (c.type === "image") {
      const src = String(c.attrGet("src") ?? "");
      if (isSafeImageSrc(src)) {
        c.attrSet("loading", "lazy");
        c.attrSet("decoding", "async");
        out.push(c);
        continue;
      }
      const alt = plainText(c.children);
      if (/^https?:/i.test(src) && isSafeHref(src)) {
        // The content CSP would block another host's image, so it becomes a link to it instead.
        const label = `${alt || "Image"} ↗`;
        if (depth > 0) {
          out.push(text(label));
        } else {
          const open = new state.Token("link_open", "a", 1);
          open.attrSet("href", src);
          newTab(open);
          out.push(open, text(label), new state.Token("link_close", "a", -1));
        }
      } else if (alt) {
        out.push(text(alt));
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Heading ids, table alignment classes and the inline URL rules, in one pass over the tokens. */
function docRule(state: StateCore): void {
  const used: Slugs = { used: new Set(), next: new Map() };
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.type === "heading_open" && /^h[1-4]$/.test(t.tag)) {
      const id = uniqueSlug(plainText(tokens[i + 1]?.children ?? null), used);
      t.attrSet("id", id);
      for (let j = i + 1; j < tokens.length; j++) {
        const close = tokens[j];
        if (close?.type === "heading_close") {
          close.meta = { anchor: id };
          break;
        }
      }
    } else if (t.type === "th_open" || t.type === "td_open") {
      const align = /text-align:(left|center|right)/.exec(String(t.attrGet("style") ?? ""))?.[1];
      t.attrs = (t.attrs ?? []).filter(([name]) => name !== "style");
      if (align) t.attrSet("class", `plinth-doc__align-${align}`);
    } else if (t.type === "inline" && t.children) {
      t.children = rewriteInline(t.children, state);
    }
  }
}

function createMarkdown(): MarkdownIt {
  const md = new MarkdownItParser({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  const { escapeHtml } = md.utils;
  // markdown-it calls this on the normalized URL. It must admit both kinds; docRule then applies
  // the rule for the kind the URL turned out to be.
  md.validateLink = (url) => isSafeHref(url) || isSafeImageSrc(url);
  md.core.ruler.push("plinth_doc", docRule);

  const r = md.renderer.rules;
  r.heading_close = (tokens, idx, options, _env, self) => {
    const id = (tokens[idx]?.meta as { anchor?: string } | null)?.anchor;
    const anchor = id
      ? `<a class="plinth-doc__anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a>`
      : "";
    return anchor + self.renderToken(tokens, idx, options);
  };
  r.table_open = () => '<div class="plinth-doc__table" role="region" tabindex="0"><table>\n';
  r.table_close = () => "</table></div>\n";
  r.s_open = () => "<del>";
  r.s_close = () => "</del>";
  r.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang =
      md.utils
        .unescapeAll(t?.info ?? "")
        .trim()
        .split(/\s+/)[0] ?? "";
    const cls = /^[a-z0-9_+-]{1,40}$/i.test(lang)
      ? ` class="language-${escapeHtml(lang.toLowerCase())}"`
      : "";
    return `<pre tabindex="0"><code${cls}>${escapeHtml(t?.content ?? "")}</code></pre>\n`;
  };
  r.code_block = (tokens, idx) =>
    `<pre tabindex="0"><code>${escapeHtml(tokens[idx]?.content ?? "")}</code></pre>\n`;
  return md;
}

let instance: MarkdownIt | null = null;

/** The doc's HTML. Safe by construction; sanitize.ts still checks it before insertion. */
export function renderMarkdown(src: string): string {
  instance ??= createMarkdown();
  return instance.render(src);
}
