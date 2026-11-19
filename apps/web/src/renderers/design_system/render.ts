// The design system reference site, built with DOM calls. Every string the author wrote reaches
// the page through textContent, through the doc renderer's Markdown and sanitizer (guidelines,
// descriptions, usage), or through a CSSOM property (swatches and specimens, whose values passed
// the format's value grammar). The site's own chrome uses Plinth's neutral styles (ds.css), so a
// broken or low-contrast token set never makes the reference unreadable; the design system's
// tokens and CSS apply only to swatches, specimens and preview frames.
//
// The chrome is kept to what a reader needs: a variable name copies itself when clicked, previews
// follow the reader's color scheme, code sits behind a closed disclosure, and token tables have no
// visible column headings (a group with light and dark samples labels them once, above the table).
import type { DesignSystem, DsComponent, DsExample, DsToken } from "@plinth/shared";
import { designSystemComponentCss } from "@plinth/shared";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { mountPreview, type PreviewTheme } from "./preview.ts";

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) {
    if (c === null) continue;
    node.append(typeof c === "string" ? doc.createTextNode(c) : c);
  }
  return node;
}

/** Markdown the author wrote, through the doc renderer's rules (raw HTML shows as text). */
function prose(doc: Document, md: string, extra = ""): HTMLElement {
  const box = el(doc, "div", { class: `plinth-doc ds-prose ${extra}`.trim() });
  box.append(sanitizeHtml(renderMarkdown(md), doc));
  return box;
}

/** A section of the site, reached by its hash (#tokens/color). */
export interface Section {
  hash: string;
  label: string;
  /** Listed under the navigation's Components heading (one per component). */
  child?: boolean;
  build: () => HTMLElement;
}

/** The element id a hash maps to: "tokens/color" -> "ds-tokens-color". */
export const sectionId = (hash: string) => `ds-${hash.replace(/[^a-z0-9-]/gi, "-")}`;

/**
 * Copy text, then call `done` with whether it was copied. A framed artifact may not use the
 * asynchronous clipboard (the app does not delegate it), so the fallback selects `select`, asks the
 * browser to copy the selection and clears it again. When that fails too, the text stays selected
 * so the reader can copy it.
 */
export function copyText(
  win: Window,
  text: string,
  select: Node,
  done: (ok: boolean) => void,
): void {
  const fallback = () => {
    const sel = win.getSelection();
    const range = win.document.createRange();
    range.selectNodeContents(select);
    sel?.removeAllRanges();
    sel?.addRange(range);
    let ok = false;
    try {
      ok = win.document.execCommand?.("copy") === true;
    } catch {
      ok = false;
    }
    if (ok) sel?.removeAllRanges();
    done(ok);
  };
  try {
    const p = win.navigator.clipboard?.writeText(text);
    if (p) p.then(() => done(true), fallback);
    else fallback();
  } catch {
    fallback();
  }
}

/** A token's variable name, which copies itself when clicked (no separate Copy button). */
function copyVar(doc: Document, text: string): HTMLButtonElement {
  const label = `Copy ${text}`;
  const b = el(
    doc,
    "button",
    { type: "button", class: "ds-token__var", title: "Copy", "aria-label": label },
    text,
  );
  b.addEventListener("click", () => {
    copyText(doc.defaultView ?? window, text, b, (ok) => {
      if (!ok) return;
      b.setAttribute("data-copied", "");
      b.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        b.removeAttribute("data-copied");
        b.setAttribute("aria-label", label);
      }, 1200);
    });
  });
  return b;
}

function badge(doc: Document, text: string, tone: string): HTMLElement {
  return el(doc, "span", { class: `ds-badge ds-badge--${tone}` }, text);
}

// ---------- tokens ----------

type Group = "color" | "type" | "space" | "radius" | "shadow" | "motion" | "other";

const GROUPS: { id: Group; hash: string; label: string }[] = [
  { id: "color", hash: "tokens/color", label: "Colors" },
  { id: "type", hash: "tokens/typography", label: "Typography" },
  { id: "space", hash: "tokens/space", label: "Spacing and sizes" },
  { id: "radius", hash: "tokens/radius", label: "Radii" },
  { id: "shadow", hash: "tokens/shadow", label: "Shadows" },
  { id: "motion", hash: "tokens/motion", label: "Motion" },
  { id: "other", hash: "tokens/other", label: "Other tokens" },
];

/** Which page of the site a token is shown on. */
export function groupOf(t: DsToken): Group {
  switch (t.type) {
    case "color":
      return "color";
    case "typography":
    case "fontFamily":
    case "fontWeight":
      return "type";
    case "dimension":
      return /(^|\.)(radius|radii|rounded|corner)/i.test(t.path) ? "radius" : "space";
    case "shadow":
      return "shadow";
    case "duration":
    case "cubicBezier":
      return "motion";
    default:
      return "other";
  }
}

/**
 * The visual sample of one token. Values are set through CSSOM properties. A sample with a theme
 * sits on that theme's ground (a light and dark pair); one without follows the reader's scheme.
 */
function sample(doc: Document, t: DsToken, value: string, theme: PreviewTheme | null): HTMLElement {
  const attrs: Attrs = { class: `ds-sample ds-sample--${groupOf(t)}` };
  if (theme) attrs["data-theme"] = theme;
  const s = el(doc, "div", attrs);
  const style = s.style;
  switch (groupOf(t)) {
    case "color":
      style.setProperty("--ds-sample", value);
      break;
    case "type": {
      // A block child carries the ellipsis: text-overflow does nothing on a flex container.
      s.append(el(doc, "span", { class: "ds-sample__text" }, "The quick brown fox"));
      if (t.type === "typography") style.font = value;
      else if (t.type === "fontFamily") style.fontFamily = value;
      else style.fontWeight = value;
      break;
    }
    case "space": {
      const bar = el(doc, "span", { class: "ds-sample__bar" });
      bar.style.width = value;
      s.append(bar);
      break;
    }
    case "radius":
      style.borderRadius = value;
      break;
    case "shadow":
      style.boxShadow = value;
      break;
    case "motion":
      s.append(el(doc, "span", { class: "ds-sample__dot" }));
      if (t.type === "duration") style.setProperty("--ds-duration", value);
      else style.setProperty("--ds-easing", value);
      break;
    default:
      if (t.type === "border") style.border = value;
      else s.textContent = value;
  }
  return s;
}

/**
 * One token: its samples, path, variable and value. A token whose dark value differs gets a light
 * and a dark sample, each on its theme's ground; one that is the same in both shows once, on the
 * reader's.
 */
function tokenRow(doc: Document, t: DsToken): HTMLElement {
  const row = el(doc, "tr", { class: "ds-token", "data-path": t.path });
  const pair = el(doc, "div", { class: "ds-token__pair" });
  if (t.dark === null) pair.append(sample(doc, t, t.value, null));
  else pair.append(sample(doc, t, t.value, "light"), sample(doc, t, t.dark, "dark"));
  const values = el(doc, "div", { class: "ds-token__values" }, el(doc, "code", {}, t.value));
  if (t.dark !== null) values.append(el(doc, "code", { class: "ds-token__dark" }, t.dark));
  const info = el(
    doc,
    "td",
    { class: "ds-token__info" },
    el(doc, "div", { class: "ds-token__path" }, t.path),
    el(doc, "div", { class: "ds-token__line" }, copyVar(doc, `var(${t.cssVar})`), values),
  );
  if (t.description) info.append(el(doc, "div", { class: "ds-token__desc" }, t.description));
  if (t.deprecated) {
    info.append(
      el(
        doc,
        "div",
        { class: "ds-token__deprecated" },
        badge(doc, "Deprecated", "warn"),
        typeof t.deprecated === "string" ? ` ${t.deprecated}` : "",
      ),
    );
  }
  if (t.aliasOf) info.append(el(doc, "div", { class: "ds-token__alias" }, `Alias of ${t.aliasOf}`));
  row.append(el(doc, "td", { class: "ds-token__samples" }, pair), info);
  return row;
}

/**
 * One group's tokens: the samples, then each token's name, variable and value. The column headings
 * are for screen readers only, as the section heading names the group. When a token in the group
 * has a light and a dark sample, a small "Light" and "Dark" above the samples says which is which.
 */
function tokenTable(doc: Document, group: Group, tokens: DsToken[]): HTMLElement {
  const head = el(
    doc,
    "tr",
    {},
    el(doc, "th", { scope: "col" }, "Sample"),
    el(doc, "th", { scope: "col" }, "Token"),
  );
  const body = el(doc, "tbody");
  for (const t of tokens) body.append(tokenRow(doc, t));
  const cols = el(doc, "colgroup", {}, el(doc, "col", { class: "ds-col-sample" }), el(doc, "col"));
  const box = el(doc, "div", { class: `ds-table ds-table--${group}` });
  if (tokens.some((t) => t.dark !== null)) {
    box.append(
      el(
        doc,
        "div",
        { class: "ds-themes", "aria-hidden": "true" },
        el(doc, "span", {}, "Light"),
        el(doc, "span", {}, "Dark"),
      ),
    );
  }
  box.append(
    el(doc, "table", {}, cols, el(doc, "thead", { class: "ds-visually-hidden" }, head), body),
  );
  return box;
}

// ---------- components ----------

/** Redraws one example's preview in a theme; set per stage by exampleBlock. */
const redraws = new WeakMap<Element, (theme: PreviewTheme) => void>();

/** Code behind a disclosure, closed until the reader opens it. */
function codeBlock(doc: Document, label: string, text: string): HTMLElement {
  return el(
    doc,
    "details",
    { class: "ds-code" },
    el(doc, "summary", {}, label),
    el(doc, "pre", { class: "ds-example__code" }, el(doc, "code", {}, text)),
  );
}

function exampleBlock(
  doc: Document,
  ds: DesignSystem,
  comp: DsComponent,
  ex: DsExample,
  theme: PreviewTheme,
): HTMLElement {
  const stage = el(doc, "div", { class: "ds-example__stage" });
  const draw = (t: PreviewTheme) => {
    // A design system without a dark theme is only ever shown light.
    const shown: PreviewTheme = ds.hasDarkTheme ? t : "light";
    if (stage.firstElementChild?.getAttribute("data-theme") === shown) return;
    stage.replaceChildren(mountPreview(doc, ds, comp, ex, shown));
  };
  redraws.set(stage, draw);
  draw(theme);
  return el(
    doc,
    "figure",
    { class: "ds-example" },
    el(doc, "figcaption", { class: "ds-example__name" }, ex.name),
    stage,
    codeBlock(doc, "HTML", ex.html),
  );
}

/** Shows every preview under `root` in a theme: the reader's color scheme, as the site follows. */
export function setPreviewTheme(root: ParentNode, theme: PreviewTheme): void {
  for (const stage of Array.from(root.querySelectorAll(".ds-example__stage"))) {
    redraws.get(stage)?.(theme);
  }
}

function componentSection(
  doc: Document,
  ds: DesignSystem,
  comp: DsComponent,
  theme: PreviewTheme,
): HTMLElement {
  const s = el(doc, "section", { class: "ds-section ds-component" });
  const title = el(doc, "h2", {}, comp.name, " ");
  if (comp.status !== "stable")
    title.append(
      badge(
        doc,
        comp.status === "beta" ? "Beta" : "Deprecated",
        comp.status === "beta" ? "info" : "warn",
      ),
    );
  s.append(title);
  if (comp.description) s.append(prose(doc, comp.description));
  // The component's CSS sits under its description, apart from each example's HTML.
  const css = designSystemComponentCss(ds, [comp]);
  if (css) s.append(codeBlock(doc, "CSS", css));
  if (comp.usage) s.append(el(doc, "h3", {}, "Usage"), prose(doc, comp.usage));
  for (const ex of comp.examples) s.append(exampleBlock(doc, ds, comp, ex, theme));
  return s;
}

// ---------- the site ----------

/**
 * Every section of the site, in navigation order. The overview is there when the design system
 * has guidelines, right under the header and with no heading of its own (the guidelines bring
 * theirs), and empty token groups are left out.
 */
export function sections(
  doc: Document,
  ds: DesignSystem,
  theme: PreviewTheme = "light",
): Section[] {
  const out: Section[] = [];
  const guidelines = ds.guidelines;
  if (guidelines) {
    out.push({
      hash: "overview",
      label: "Overview",
      build: () =>
        el(
          doc,
          "section",
          { class: "ds-section ds-overview", "aria-label": "Overview" },
          prose(doc, guidelines),
        ),
    });
  }
  for (const g of GROUPS) {
    const tokens = ds.tokens.filter((t) => groupOf(t) === g.id);
    if (tokens.length === 0) continue;
    out.push({
      hash: g.hash,
      label: g.label,
      build: () =>
        el(
          doc,
          "section",
          { class: "ds-section" },
          el(doc, "h2", {}, g.label),
          tokenTable(doc, g.id, tokens),
        ),
    });
  }
  for (const c of ds.components) {
    out.push({
      hash: `components/${c.id}`,
      label: c.name,
      child: true,
      build: () => componentSection(doc, ds, c, theme),
    });
  }
  return out;
}

/** The whole site: header, navigation and every section, with previews in `theme`. */
export function renderSite(
  doc: Document,
  ds: DesignSystem,
  theme: PreviewTheme = "light",
): HTMLElement {
  const all = sections(doc, ds, theme);
  const header = el(doc, "header", { class: "ds-header" }, el(doc, "h1", {}, ds.name));
  if (ds.description) header.append(prose(doc, ds.description, "ds-lede"));
  const nav = el(doc, "nav", { class: "ds-nav", "aria-label": "Design system" });
  const list = el(doc, "ul");
  let components: HTMLUListElement | null = null;
  for (const s of all) {
    const item = el(doc, "li", {}, el(doc, "a", { href: `#${s.hash}` }, s.label));
    if (!s.child) {
      list.append(item);
      continue;
    }
    if (!components) {
      components = el(doc, "ul");
      list.append(
        el(
          doc,
          "li",
          { class: "ds-nav__group" },
          el(doc, "span", { class: "ds-nav__label" }, "Components"),
          components,
        ),
      );
    }
    components.append(item);
  }
  nav.append(list);
  const content = el(doc, "div", { class: "ds-content" });
  for (const s of all) {
    const node = s.build();
    node.id = sectionId(s.hash);
    node.setAttribute("data-hash", s.hash);
    content.append(node);
  }
  return el(
    doc,
    "div",
    { class: "ds-site" },
    header,
    el(doc, "div", { class: "ds-layout" }, nav, content),
  );
}

/**
 * The error state: the JSON does not parse. One short line, as the doc type's: the editor lists the
 * problems above the source, and the Worker returns them to the agent that tried to publish.
 */
export function renderProblems(doc: Document): HTMLElement {
  return el(
    doc,
    "p",
    { class: "ds-error", role: "alert" },
    "This design system could not be shown.",
  );
}
