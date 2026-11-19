// The design system reference site, built with DOM calls. Every string the author wrote reaches
// the page through textContent, through the doc renderer's Markdown and sanitizer (guidelines,
// descriptions, usage), or through a CSSOM property (swatches and specimens, whose values passed
// the format's value grammar). The site's own chrome uses Plinth's neutral styles (ds.css), so a
// broken or low-contrast token set never makes the reference unreadable; the design system's
// tokens and CSS apply only to swatches, specimens and preview frames.
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
  /** Nested under the previous top-level entry in the navigation (one per component). */
  child?: boolean;
  build: () => HTMLElement;
}

/** The element id a hash maps to: "tokens/color" -> "ds-tokens-color". */
export const sectionId = (hash: string) => `ds-${hash.replace(/[^a-z0-9-]/gi, "-")}`;

/** Copy text; when the frame may not use the clipboard, select it so the reader can copy it. */
export function copyText(win: Window, text: string, select: Node): void {
  const fallback = () => {
    const range = win.document.createRange();
    range.selectNodeContents(select);
    const sel = win.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  try {
    const p = win.navigator.clipboard?.writeText(text);
    if (p) p.catch(fallback);
    else fallback();
  } catch {
    fallback();
  }
}

function copyButton(doc: Document, text: string, target: Node, label: string): HTMLButtonElement {
  const b = el(doc, "button", { type: "button", class: "ds-copy", "aria-label": label }, "Copy");
  b.addEventListener("click", () => {
    copyText(doc.defaultView ?? window, text, target);
    b.textContent = "Copied";
    setTimeout(() => {
      b.textContent = "Copy";
    }, 1200);
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

/** The visual sample of one token in one theme. Values are set through CSSOM properties. */
function sample(doc: Document, t: DsToken, value: string, theme: PreviewTheme): HTMLElement {
  const s = el(doc, "div", { class: `ds-sample ds-sample--${groupOf(t)}`, "data-theme": theme });
  const style = s.style;
  switch (groupOf(t)) {
    case "color":
      style.setProperty("--ds-sample", value);
      break;
    case "type": {
      s.textContent = "The quick brown fox jumps over the lazy dog";
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

function tokenRow(doc: Document, t: DsToken, dark: boolean): HTMLElement {
  const name = el(doc, "code", { class: "ds-token__var" }, `var(${t.cssVar})`);
  const row = el(doc, "tr", { class: "ds-token", "data-path": t.path });
  const samples = el(doc, "td", { class: "ds-token__samples" }, sample(doc, t, t.value, "light"));
  if (dark) samples.append(sample(doc, t, t.dark ?? t.value, "dark"));
  const info = el(
    doc,
    "td",
    { class: "ds-token__info" },
    el(doc, "div", { class: "ds-token__path" }, t.path),
    el(
      doc,
      "div",
      { class: "ds-token__name" },
      name,
      copyButton(doc, `var(${t.cssVar})`, name, `Copy var(${t.cssVar})`),
    ),
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
  const values = el(doc, "td", { class: "ds-token__values" }, el(doc, "code", {}, t.value));
  if (dark) values.append(el(doc, "code", { class: "ds-token__dark" }, t.dark ?? "same"));
  row.append(samples, info, values);
  return row;
}

function tokenTable(doc: Document, tokens: DsToken[], dark: boolean): HTMLElement {
  const head = el(
    doc,
    "tr",
    {},
    el(doc, "th", { scope: "col" }, dark ? "Light and dark" : "Sample"),
    el(doc, "th", { scope: "col" }, "Token"),
    el(doc, "th", { scope: "col" }, dark ? "Light, dark" : "Value"),
  );
  const body = el(doc, "tbody");
  for (const t of tokens) body.append(tokenRow(doc, t, dark));
  return el(
    doc,
    "div",
    { class: "ds-table", role: "region", "aria-label": "Tokens", tabindex: "0" },
    el(doc, "table", {}, el(doc, "thead", {}, head), body),
  );
}

// ---------- components ----------

function exampleBlock(
  doc: Document,
  ds: DesignSystem,
  comp: DsComponent,
  ex: DsExample,
): HTMLElement {
  const box = el(doc, "figure", {
    class: "ds-example",
    "data-view": "preview",
    "data-theme": "light",
  });
  const stage = el(doc, "div", { class: "ds-example__stage" });
  const html = el(
    doc,
    "pre",
    { class: "ds-example__code", hidden: "" },
    el(doc, "code", {}, ex.html),
  );
  const cssText = designSystemComponentCss(ds, [comp]) || "/* no CSS */";
  const css = el(
    doc,
    "pre",
    { class: "ds-example__code", hidden: "" },
    el(doc, "code", {}, cssText),
  );

  let theme: "light" | "dark" | "both" = "light";
  const draw = () => {
    stage.replaceChildren();
    const themes: PreviewTheme[] = theme === "both" ? ["light", "dark"] : [theme];
    for (const t of themes) stage.append(mountPreview(doc, ds, comp, ex, t));
    box.dataset.theme = theme;
  };

  const group = (
    label: string,
    options: [string, string][],
    pick: (v: string) => void,
    initial: string,
  ) => {
    const g = el(doc, "div", { class: "ds-seg", role: "group", "aria-label": label });
    for (const [value, text] of options) {
      const b = el(
        doc,
        "button",
        { type: "button", "data-value": value, "aria-pressed": String(value === initial) },
        text,
      );
      b.addEventListener("click", () => {
        for (const o of Array.from(g.querySelectorAll("button"))) {
          o.setAttribute("aria-pressed", String(o === b));
        }
        pick(value);
      });
      g.append(b);
    }
    return g;
  };

  const views = group(
    `${comp.name}: ${ex.name}, view`,
    [
      ["preview", "Preview"],
      ["html", "HTML"],
      ["css", "CSS"],
    ],
    (v) => {
      box.dataset.view = v;
      stage.hidden = v !== "preview";
      html.hidden = v !== "html";
      css.hidden = v !== "css";
      themes.hidden = v !== "preview";
      widths.hidden = v !== "preview";
    },
    "preview",
  );
  const themes = group(
    `${comp.name}: ${ex.name}, theme`,
    [
      ["light", "Light"],
      ["dark", "Dark"],
      ["both", "Both"],
    ],
    (v) => {
      theme = v as typeof theme;
      draw();
    },
    "light",
  );
  const widths = group(
    `${comp.name}: ${ex.name}, width`,
    [
      ["360", "360"],
      ["768", "768"],
      ["full", "Full"],
    ],
    (v) => {
      stage.style.maxWidth = v === "full" ? "" : `${v}px`;
    },
    "full",
  );

  draw();
  box.append(
    el(
      doc,
      "figcaption",
      { class: "ds-example__bar" },
      el(doc, "span", { class: "ds-example__name" }, ex.name),
      views,
      themes,
      widths,
    ),
    stage,
    html,
    css,
  );
  return box;
}

function componentSection(doc: Document, ds: DesignSystem, comp: DsComponent): HTMLElement {
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
  s.append(title, el(doc, "p", { class: "ds-muted" }, el(doc, "code", {}, comp.id)));
  if (comp.description) s.append(prose(doc, comp.description));
  if (comp.usage) s.append(el(doc, "h3", {}, "Usage"), prose(doc, comp.usage));
  for (const ex of comp.examples) s.append(exampleBlock(doc, ds, comp, ex));
  return s;
}

// ---------- the site ----------

/** Every section of the site, in navigation order. Empty token groups are left out. */
export function sections(doc: Document, ds: DesignSystem): Section[] {
  const out: Section[] = [
    {
      hash: "overview",
      label: "Overview",
      build: () => {
        const s = el(doc, "section", { class: "ds-section" }, el(doc, "h2", {}, "Overview"));
        if (ds.guidelines) s.append(prose(doc, ds.guidelines));
        else
          s.append(
            el(doc, "p", { class: "ds-muted" }, "This design system has no guidelines yet."),
          );
        if (ds.fonts.length > 0) {
          const list = el(doc, "ul", { class: "ds-fonts" });
          for (const f of ds.fonts) {
            list.append(
              el(
                doc,
                "li",
                {},
                el(doc, "strong", {}, f.family),
                f.source === "google" ? " (Google Fonts)" : ` (${f.src ?? ""})`,
              ),
            );
          }
          s.append(el(doc, "h3", {}, "Fonts"), list);
        }
        return s;
      },
    },
  ];
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
          tokenTable(doc, tokens, ds.hasDarkTheme),
        ),
    });
  }
  if (ds.components.length > 0) {
    out.push({
      hash: "components",
      label: "Components",
      build: () => {
        const s = el(doc, "section", { class: "ds-section" }, el(doc, "h2", {}, "Components"));
        const list = el(doc, "ul", { class: "ds-component-list" });
        for (const c of ds.components) {
          list.append(el(doc, "li", {}, el(doc, "a", { href: `#components/${c.id}` }, c.name)));
        }
        s.append(list);
        return s;
      },
    });
    for (const c of ds.components) {
      out.push({
        hash: `components/${c.id}`,
        label: c.name,
        child: true,
        build: () => componentSection(doc, ds, c),
      });
    }
  }
  return out;
}

/** The whole site: header, navigation and every section. */
export function renderSite(doc: Document, ds: DesignSystem): HTMLElement {
  const all = sections(doc, ds);
  const header = el(
    doc,
    "header",
    { class: "ds-header" },
    el(doc, "p", { class: "ds-eyebrow" }, "Design system"),
    el(doc, "h1", {}, ds.name),
  );
  if (ds.description) header.append(prose(doc, ds.description, "ds-lede"));
  header.append(
    el(
      doc,
      "p",
      { class: "ds-muted" },
      `${ds.tokens.length} tokens, ${ds.components.length} components. CSS variables start with `,
      el(doc, "code", {}, `--${ds.prefix}-`),
      ".",
    ),
  );
  const nav = el(doc, "nav", { class: "ds-nav", "aria-label": "Design system" });
  const list = el(doc, "ul");
  for (const s of all) {
    list.append(
      el(
        doc,
        "li",
        s.child ? { class: "ds-nav__child" } : {},
        el(doc, "a", { href: `#${s.hash}` }, s.label),
      ),
    );
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

/** The error state: the stored JSON does not parse. Each problem is text. */
export function renderProblems(
  doc: Document,
  problems: { path: string; message: string }[],
): HTMLElement {
  const list = el(doc, "ul", { class: "ds-problems" });
  for (const p of problems) {
    list.append(el(doc, "li", {}, el(doc, "code", {}, p.path || "(root)"), ` ${p.message}`));
  }
  return el(
    doc,
    "div",
    { class: "ds-error", role: "alert" },
    el(doc, "h1", {}, "This design system could not be shown"),
    el(doc, "p", {}, "Its JSON has these problems. Fix them in the editor, or ask your agent to."),
    list,
  );
}
