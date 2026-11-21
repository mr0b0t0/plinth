// A design system's side of the whole-draft review (common/review.ts), and the fonts a drawing
// uses. Each pane draws the reference site of one side (the page changes, or vN) read-only, with
// that version's files: its examples' frames get that version as their base (preview.ts), and its
// own font files are loaded from /__plinth/v/<n>/. Tokens, components, the header and the
// guidelines' blocks that differ from the base are marked, and each change item brings the pane to
// the row or section it names. Both sides are compared as projections (designSystemLive.ts), so a
// version that only spells the same JSON another way shows no change.
import {
  type ChangeItem,
  type DesignSystem,
  designSystemFontFaces,
  designSystemFontLinks,
  dsLiveSystem,
  parseDesignSystemValue,
  splitLines,
} from "@plinth/shared";
import { fileUrl } from "../common/files.ts";
import {
  bringIntoPane,
  CHANGED_ATTR,
  type ItemWords,
  markChangedChildren,
  type ReviewPane,
} from "../common/review.ts";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import type { PreviewTheme } from "./preview.ts";
import { renderProblems, renderSite, sectionId } from "./render.ts";

/** A draft's (or a version's) live form as the system it parses to, with its problems. */
export function systemOf(live: string): {
  ds: DesignSystem | null;
  problems: { path: string; message: string }[];
} {
  const value = dsLiveSystem(splitLines(live));
  if (!value) return { ds: null, problems: [] };
  const r = parseDesignSystemValue(value);
  return r.ok ? { ds: r.value, problems: [] } : { ds: null, problems: r.errors };
}

/** `ds`'s fonts with their own files at version `version`'s path (null: the page's own). */
function pinnedFonts(ds: DesignSystem, version: number | null): DesignSystem {
  if (version === null) return ds;
  return {
    ...ds,
    fonts: ds.fonts.map((f) => (f.src ? { ...f, src: fileUrl(version, f.src) } : f)),
  };
}

/**
 * Load `ds`'s fonts on the page, replacing those `owner` loaded before: its Google Fonts
 * stylesheets, and @font-face rules for its own font files, from version `version` (or the page's
 * own files). Two drawings of the same family on one page share whichever rule came last.
 */
export function applyFonts(
  doc: Document,
  ds: DesignSystem,
  version: number | null,
  owner: string,
): void {
  for (const n of Array.from(doc.head.querySelectorAll(`[data-ds-fonts="${owner}"]`))) n.remove();
  for (const href of designSystemFontLinks(ds)) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.referrerPolicy = "no-referrer";
    link.dataset.dsFonts = owner;
    doc.head.append(link);
  }
  const faces = designSystemFontFaces(pinnedFonts(ds, version));
  if (faces) {
    const style = doc.createElement("style");
    style.textContent = faces;
    style.dataset.dsFonts = owner;
    doc.head.append(style);
  }
}

/** Mark what the site of `b` shows differently from `a` (the base). */
function markChanges(doc: Document, site: HTMLElement, a: DesignSystem, b: DesignSystem): void {
  if (a.name !== b.name || (a.description ?? "") !== (b.description ?? "")) {
    site.querySelector(".ds-header")?.setAttribute(CHANGED_ATTR, "");
  }
  const old = new Map(a.tokens.map((t) => [t.path, JSON.stringify(t)]));
  for (const t of b.tokens) {
    if (old.get(t.path) === JSON.stringify(t)) continue;
    site
      .querySelector(`.ds-token[data-path="${CSS.escape(t.path)}"]`)
      ?.setAttribute(CHANGED_ATTR, "");
  }
  const comps = new Map(a.components.map((c) => [c.id, JSON.stringify(c)]));
  for (const c of b.components) {
    if (comps.get(c.id) === JSON.stringify(c)) continue;
    site
      .querySelector(`#${CSS.escape(sectionId(`components/${c.id}`))} > h2`)
      ?.setAttribute(CHANGED_ATTR, "");
  }
  const g = site.querySelector(`#${CSS.escape(sectionId("overview"))} > .plinth-doc`);
  if (g && (a.guidelines ?? "") !== (b.guidelines ?? "")) {
    // The guidelines' blocks, as the doc's pane marks them.
    const was = doc.createElement("div");
    was.append(sanitizeHtml(renderMarkdown(a.guidelines ?? ""), doc));
    markChangedChildren(was, g);
  }
}

/** Where a change item points in a drawn site: its token's row, its component, or its part. */
function siteGoto(site: HTMLElement): (item: ChangeItem) => boolean {
  return (item) => {
    let target: Element | null = null;
    const token = /^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(?::| (?:changed|added|removed|is))/.exec(
      item.what,
    );
    if (item.where === "Tokens" && token) {
      target = site.querySelector(`.ds-token[data-path="${CSS.escape(token[1] as string)}"]`);
    }
    const comp = /^Component “(.+)”$/.exec(item.where);
    if (!target && comp) {
      for (const h of Array.from(site.querySelectorAll(".ds-component > h2"))) {
        if ((h.textContent ?? "").startsWith(comp[1] as string)) target = h;
      }
    }
    if (!target && item.where.startsWith("Guidelines")) {
      target = site.querySelector(`#${CSS.escape(sectionId("overview"))}`);
    }
    if (!target && item.where === "") target = site.querySelector(".ds-header");
    if (!target) return false;
    bringIntoPane(target);
    return true;
  };
}

/** The design system's pane of the review. */
export function systemPane(doc: Document, theme: () => PreviewTheme): ReviewPane {
  let panes = 0;
  return {
    render(el, text, version, base) {
      const side = systemOf(text);
      if (!side.ds) {
        el.replaceChildren(renderProblems(doc, side.problems));
        return null;
      }
      const site = renderSite(doc, side.ds, theme(), { fileVersion: version });
      site.classList.add("ds-site--pane");
      applyFonts(doc, side.ds, version, `pane-${++panes % 2}`);
      if (base !== null) {
        const before = systemOf(base).ds;
        if (before) markChanges(doc, site, before, side.ds);
      }
      el.replaceChildren(site);
      return siteGoto(site);
    },
    // A component's change names the component ("Button: description changed"), so it never
    // reads like the system's own description or status.
    describe(item) {
      const comp = /^Component “(.+)”$/.exec(item.where);
      if (!comp) return null;
      const what = item.what.charAt(0).toLowerCase() + item.what.slice(1);
      const words: ItemWords = { label: `${comp[1]}: ${what}` };
      if (item.before !== undefined) words.before = item.before;
      if (item.after !== undefined) words.after = item.after;
      return words;
    },
  };
}
