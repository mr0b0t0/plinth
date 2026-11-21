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
// the deck's own files), so a quoted string never holds an escape and a forward scan reads it.
// `@font-face` and `@page` are dropped: faces come from deck.json, and pages from the renderer.

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
  const skipString = (k: number): number => {
    const q = css[k];
    const end = css.indexOf(q as string, k + 1);
    return end < 0 ? n : end + 1;
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

const ROOT_RE = /^:(?:root|host)(?![\w-])/i;

/** One selector with a leading :root or :host turned into the slide's own `html`. */
export function scopeSelector(sel: string): string {
  const s = sel.trim();
  return ROOT_RE.test(s) ? `html${s.replace(ROOT_RE, "")}` : s;
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
  const scoped = scopeInto(css, canvas, properties);
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
      const sels = splitSelectors(b.prelude).map(scopeSelector).join(", ");
      out.push(`${sels} {${b.body}}`);
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
    } else if (name === "property" && /^--[A-Za-z0-9_-]{1,64}$/.test(cond.trim())) {
      properties.push(`${b.prelude} {${b.body}}`);
    }
    // @font-face, @page, @container, @import (refused at publish) and anything else: dropped.
  }
  return out.join("\n");
}
