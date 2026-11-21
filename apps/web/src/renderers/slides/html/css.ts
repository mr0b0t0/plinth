// An HTML deck's deck.css as each slide's shadow root reads it (docs/spec.md "HTML decks"). Every
// slide renders in its own shadow root, so the deck's rules reach only that slide and never the
// renderer's controls. Two things change on the way in:
//
// - Each slide sits in its own `<html><body>` pair inside the shadow root (build.ts), so `html` and
//   `body` rules match as in a page and a `body { font-family }` rule sets the deck's defaults.
//   `:root` and `:host` name that `html`, so `:root { --x }` declares the deck's variables.
// - `@media` is read at the slide's size, not the window's, as Claude's renderer reads it: only
//   `all` and `screen`, orientation and px widths and heights apply, `prefers-reduced-motion:
//   no-preference` holds for every viewer and `reduce` for none (Plinth itself turns motion off
//   for those who ask, slides.css and base.ts). A block that holds is kept without its @media; any
//   other is dropped, so no rule ever depends on the viewer's window.
//
// The text has passed the shared deck CSS check (no backslash, no `<`, no @import, url() only for
// the deck's own files, no line break inside a string), so a quoted string never holds an escape
// and a forward scan reads it; a string still ends at a line break here, as a browser ends it.
// `@font-face` and `@page` are dropped: faces come from deck.json, and pages from the renderer.
//
// Nothing here can reach past the slide: a selector that names the shadow host or its tree from
// inside (`:host(…)`, `:host-context(…)`, `::slotted(…)`, `::part(…)`) is dropped, and the host,
// the shadow `html` and every embed frame carry their critical styles inline with !important
// (build.ts, embeds.ts), which no rule in a shadow root outranks. The only text that leaves the
// shadow root is an `@property` rule, rebuilt from its checked descriptors (propertyRule).
// A url() that names a Claude deck's `project/` path is read as the version's own (deckPath).

interface Block {
  /** The prelude, trimmed: a selector list or an at-rule's name and condition. */
  prelude: string;
  /** The block's text between its braces, or null for a statement ending in `;`. */
  body: string | null;
}

/** Splits CSS into top-level statements and blocks, skipping comments; linear in the text. */
export function splitBlocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  let start = 0;
  let prelude = "";
  const n = css.length;
  // A string ends at its closing quote, or (unclosed, as a browser reads it) at a line break.
  const skipString = (k: number): number => {
    const q = css[k];
    for (let j = k + 1; j < n; j++) {
      const d = css[j];
      if (d === q) return j + 1;
      if (d === "\n" || d === "\r" || d === "\f") return j;
    }
    return n;
  };
  while (i < n) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      prelude += css.slice(start, i);
      i = end < 0 ? n : end + 2;
      start = i;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(i);
      continue;
    }
    if (c === ";") {
      prelude += css.slice(start, i);
      if (prelude.trim() !== "") out.push({ prelude: prelude.trim(), body: null });
      prelude = "";
      i++;
      start = i;
      continue;
    }
    if (c === "{") {
      prelude += css.slice(start, i);
      // The matching brace, strings and comments skipped.
      let depth = 1;
      let k = i + 1;
      while (k < n && depth > 0) {
        const d = css[k];
        if (d === "/" && css[k + 1] === "*") {
          const end = css.indexOf("*/", k + 2);
          k = end < 0 ? n : end + 2;
          continue;
        }
        if (d === '"' || d === "'") {
          k = skipString(k);
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        k++;
      }
      out.push({ prelude: prelude.trim(), body: css.slice(i + 1, Math.max(i + 1, k - 1)) });
      prelude = "";
      i = k;
      start = i;
      continue;
    }
    if (c === "}") {
      // A stray close brace: what came before it is not a statement.
      prelude = "";
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return out;
}

const ROOT_RE = /^:(?:root|host)(?![\w(-])/i;
/** What reaches the shadow host or past the shadow tree from inside it. */
const HOST_RE = /:host|::?slotted|::?part/i;

/**
 * One selector with a leading :root or :host turned into the slide's own `html`, or null for one
 * that would select the shadow host or its tree from inside (dropped).
 */
export function scopeSelector(sel: string): string | null {
  const s = sel.trim();
  const out = ROOT_RE.test(s) ? `html${s.replace(ROOT_RE, "")}` : s;
  return HOST_RE.test(out) ? null : out;
}

/** deck.css or a style attribute with each url() of a Claude deck's `project/` path mapped. */
export function mapProjectUrls(css: string): string {
  return css.replace(/url\(\s*(["']?)project\//gi, "url($1");
}

const PROPERTY_NAME_RE = /^--[A-Za-z0-9_-]{1,64}$/;
const SYNTAX_RE = /^(["'])([A-Za-z0-9<>|+# *-]{1,64})\1$/;
const INITIAL_RE = /^[A-Za-z0-9#.%+ ()-]{1,64}$/;

/**
 * An `@property` rule rebuilt from its descriptors, or null when one is missing or not plainly
 * safe: a name of letters, digits, _ and -, a syntax string of type names and combinators, true or
 * false for inherits, and an initial value of plain tokens with balanced parentheses. It goes in
 * the document's own head, outside every shadow root, so none of the author's text is copied.
 */
export function propertyRule(name: string, body: string): string | null {
  if (!PROPERTY_NAME_RE.test(name)) return null;
  let syntax: string | null = null;
  let inherits: string | null = null;
  let initial: string | null = null;
  for (const decl of body.split(";")) {
    if (decl.trim() === "") continue;
    const colon = decl.indexOf(":");
    if (colon < 0) return null;
    const key = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (key === "syntax" && syntax === null) {
      const m = SYNTAX_RE.exec(value);
      if (!m) return null;
      syntax = (m[2] as string).trim();
    } else if (key === "inherits" && inherits === null) {
      if (!/^(?:true|false)$/i.test(value)) return null;
      inherits = value.toLowerCase();
    } else if (key === "initial-value" && initial === null) {
      if (!INITIAL_RE.test(value)) return null;
      let depth = 0;
      for (const c of value) {
        if (c === "(") depth++;
        else if (c === ")" && --depth < 0) return null;
      }
      if (depth !== 0) return null;
      initial = value;
    } else return null;
  }
  if (syntax === null || inherits === null) return null;
  if (initial === null && syntax !== "*") return null;
  const init = initial === null ? "" : ` initial-value: ${initial};`;
  return `@property ${name} { syntax: "${syntax}"; inherits: ${inherits};${init} }`;
}

/** Splits a selector list at its top-level commas (not inside parentheses or strings). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if ((c === '"' || c === "'") && depth >= 0) {
      const end = list.indexOf(c, i + 1);
      i = end < 0 ? list.length : end;
    } else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

const PX_RE = /^(\d+(?:\.\d+)?)px$/;

/** Whether one media feature holds on a slide of this size. Unknown features never hold. */
function featureHolds(feature: string, canvas: { width: number; height: number }): boolean {
  const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?))?\s*\)$/i.exec(feature.trim());
  if (!m) return false;
  const name = (m[1] ?? "").toLowerCase();
  const value = (m[2] ?? "").trim().toLowerCase();
  const px = PX_RE.exec(value);
  const n = px ? Number(px[1]) : Number.NaN;
  switch (name) {
    case "min-width":
      return n <= canvas.width;
    case "max-width":
      return n >= canvas.width;
    case "width":
      return n === canvas.width;
    case "min-height":
      return n <= canvas.height;
    case "max-height":
      return n >= canvas.height;
    case "height":
      return n === canvas.height;
    case "orientation":
      return value === (canvas.width >= canvas.height ? "landscape" : "portrait");
    case "prefers-reduced-motion":
      return value === "no-preference" || value === "";
    default:
      return false;
  }
}

/** Whether a media query list holds on a slide of this size (Claude's reading of @media). */
export function mediaHolds(query: string, canvas: { width: number; height: number }): boolean {
  return splitSelectors(query).some((q) => {
    let s = q.trim().toLowerCase();
    let negate = false;
    if (s.startsWith("not ")) {
      negate = true;
      s = s.slice(4).trim();
    }
    if (s.startsWith("only ")) s = s.slice(5).trim();
    const parts = s.split(/\s+and\s+/);
    let ok = true;
    for (const [i, part] of parts.entries()) {
      const p = part.trim();
      if (p === "") continue;
      if (p.startsWith("(")) ok &&= featureHolds(p, canvas);
      else if (i === 0) ok &&= p === "all" || p === "screen";
      else ok = false;
    }
    return negate ? !ok : ok;
  });
}

/**
 * deck.css for one slide's shadow root (see the file comment), and its `@property` rules, which
 * register custom properties for the whole document (a count-up's integer) and so go in the
 * document's own head: a shadow root's `@property` is not read.
 */
export function scopeDeckCss(
  css: string,
  canvas: { width: number; height: number },
): { css: string; properties: string[] } {
  const properties: string[] = [];
  const scoped = scopeInto(mapProjectUrls(css), canvas, properties);
  return { css: scoped, properties };
}

function scopeInto(
  css: string,
  canvas: { width: number; height: number },
  properties: string[],
): string {
  const out: string[] = [];
  for (const b of splitBlocks(css)) {
    if (b.body === null) continue;
    const at = /^@([a-z-]+)\s*/i.exec(b.prelude);
    if (!at) {
      if (b.prelude === "") continue;
      const sels = splitSelectors(b.prelude)
        .map(scopeSelector)
        .filter((x): x is string => x !== null && x !== "");
      if (sels.length > 0) out.push(`${sels.join(", ")} {${b.body}}`);
      continue;
    }
    const name = (at[1] ?? "").toLowerCase();
    const cond = b.prelude.slice(at[0].length);
    if (name === "media") {
      if (mediaHolds(cond, canvas)) out.push(scopeInto(b.body, canvas, properties));
    } else if (name === "supports" || name === "layer" || name === "starting-style") {
      out.push(`${b.prelude} {${scopeInto(b.body, canvas, properties)}}`);
    } else if (name === "keyframes" || name === "-webkit-keyframes") {
      out.push(`${b.prelude} {${b.body}}`);
    } else if (name === "property") {
      const rule = propertyRule(cond.trim(), b.body);
      if (rule) properties.push(rule);
    }
    // @font-face, @page, @container, @import (refused at publish) and anything else: dropped.
  }
  return out.join("\n");
}
