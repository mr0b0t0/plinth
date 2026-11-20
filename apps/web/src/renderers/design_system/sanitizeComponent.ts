// The allowlist pass over a component example's HTML before it goes into a preview frame. The
// frame runs no script whatever the markup holds (sandbox without allow-scripts, and the shell's
// script-src 'self'); this pass is defense in depth, and keeps what a preview shows to markup a
// design system means: elements, classes, inline styles, form controls and simple SVG.
//
// The HTML is parsed in a <template>, whose content is inert: nothing in it loads or runs. Elements
// that could run code, load another document, submit or navigate are removed with their content;
// unknown elements are unwrapped (their children stay). The result is the serialization of the
// walked DOM, so the frame parses exactly what this pass kept.

import { cssUrlArgs, isPlainRelativeUrl } from "@plinth/shared";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

const HTML_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "button",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "meter",
  "nav",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "s",
  "samp",
  "search",
  "section",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "title",
  "desc",
]);

/**
 * SVG elements kept as text only. Their content is parsed as HTML (they are HTML integration
 * points), so after the walk their children are replaced by their text.
 */
const SVG_TEXT_ONLY = new Set(["title", "desc"]);

/**
 * Removed with everything inside them. Any other unknown element is unwrapped. `title` here is the
 * HTML element; SVG's `title` is kept as text (SVG_TEXT_ONLY).
 */
const DROP = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "link",
  "meta",
  "base",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "math",
  "head",
  "title",
  "audio",
  "video",
  "track",
  "canvas",
  "foreignobject",
  "use",
  "image",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
  "feimage",
]);

const GLOBAL_ATTRS = new Set([
  "class",
  "id",
  "style",
  "role",
  "title",
  "alt",
  "lang",
  "dir",
  "hidden",
  "tabindex",
  "type",
  "name",
  "value",
  "placeholder",
  "checked",
  "selected",
  "disabled",
  "readonly",
  "required",
  "multiple",
  "min",
  "max",
  "step",
  "rows",
  "cols",
  "for",
  "colspan",
  "rowspan",
  "scope",
  "width",
  "height",
  "srcset",
  "sizes",
  "loading",
  "src",
  "href",
  "open",
  "label",
  "list",
  "low",
  "high",
  "optimum",
  "maxlength",
  "minlength",
  "size",
  "start",
  "reversed",
  "datetime",
  "cite",
  "span",
  "media",
]);

const SVG_ATTRS = new Set([
  "viewbox",
  "xmlns",
  "preserveaspectratio",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "dx",
  "dy",
  "fx",
  "fy",
  "points",
  "pathlength",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "vector-effect",
  "focusable",
]);

// Any C0 or C1 control character, DEL included: a URL holding one is refused outright.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE_RE = /[\s​-‏⁠﻿]/g;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]*$/i;
/** CSS functions that can load a URL: url() is checked, the others are never kept. */
const STYLE_BAD_RE = /\\|image-set\(|image\(|cross-fade\(|element\(|expression\(|@import|src\(/i;
const FRAGMENT_URL_RE = /^url\(#[A-Za-z][\w-]*\)$/;

/** Whether a src may stay: a relative path to the artifact's own files, or an inline raster image. */
export function isSafePreviewSrc(url: string): boolean {
  if (CONTROL_RE.test(url)) return false;
  const s = url.replace(INVISIBLE_RE, "");
  if (s === "") return false;
  if (DATA_IMAGE_RE.test(s)) return true;
  const lower = s.toLowerCase();
  if (lower.includes("\\") || lower.includes("%5c") || lower.includes("%2e")) return false;
  if (lower.startsWith("/") || lower.startsWith("#")) return false;
  // No scheme: a colon before the first "/", "?" or "#".
  if (/^[^/?#]*:/.test(lower)) return false;
  return !lower.split(/[/?#]/).includes("..");
}

function safeSrcset(value: string): boolean {
  const candidates = value.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "");
  return candidates.length > 0 && candidates.every((u) => u !== "" && isSafePreviewSrc(u));
}

/**
 * Whether a style attribute may stay: no escapes or URL-taking functions other than url(), and
 * every url() read as the browser reads it (cssUrlArgs) and holding a plain relative path to the
 * artifact's own files or an inline raster image. A url() that cannot be read plainly drops it.
 */
function safeStyle(value: string): boolean {
  if (STYLE_BAD_RE.test(value)) return false;
  const urls = cssUrlArgs(value);
  if (urls === null) return false;
  return urls.every((u) => (isPlainRelativeUrl(u) || DATA_IMAGE_RE.test(u)) && isSafePreviewSrc(u));
}

/**
 * Whether an SVG attribute's value may stay. Presentation attributes (fill, mask, clip-path...) are
 * CSS values, so the same escapes and URL-taking functions are refused as in style, and a url()
 * may only name a fragment of this document: url(#grad).
 */
function safePresentation(value: string): boolean {
  if (STYLE_BAD_RE.test(value)) return false;
  return !/url\(/i.test(value) || FRAGMENT_URL_RE.test(value.trim());
}

/** Whether attribute `name` with `value` may stay on `el`. href and src are rewritten by the caller. */
function allowed(el: Element, name: string, value: string): boolean {
  if (name.startsWith("on") || name.includes(":")) return false;
  if (name === "formaction" || name === "action" || name === "target" || name === "srcdoc") {
    return false;
  }
  if (name.startsWith("aria-") || name.startsWith("data-")) return true;
  if (name === "style") return safeStyle(value);
  if (name === "srcset") return safeSrcset(value);
  if (name === "open") return el.localName === "details";
  const svg = el.namespaceURI === SVG_NS;
  if (svg && SVG_ATTRS.has(name)) return safePresentation(value);
  return GLOBAL_ATTRS.has(name);
}

function cleanAttributes(el: Element): void {
  for (const { name, value } of Array.from(el.attributes)) {
    const n = name.toLowerCase();
    if (!allowed(el, n, value)) {
      el.removeAttribute(name);
      continue;
    }
    if (n === "href") {
      // Only in-page fragments: a preview never navigates anywhere.
      if (!/^#[A-Za-z0-9_-]*$/.test(value.trim())) el.setAttribute(name, "#");
    } else if (n === "src") {
      if (!isSafePreviewSrc(value)) el.removeAttribute(name);
    }
  }
}

function keepTag(el: Element): boolean {
  const tag = el.localName.toLowerCase();
  if (el.namespaceURI === HTML_NS) return HTML_TAGS.has(tag);
  if (el.namespaceURI === SVG_NS) return SVG_TAGS.has(tag);
  return false;
}

function cleanChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue; // text
    if (node.nodeType !== 1) {
      node.parentNode?.removeChild(node); // comments, processing instructions, CDATA
      continue;
    }
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    const svgText = el.namespaceURI === SVG_NS && SVG_TEXT_ONLY.has(tag);
    if (
      (DROP.has(tag) && !svgText) ||
      (el.namespaceURI !== HTML_NS && el.namespaceURI !== SVG_NS)
    ) {
      el.remove();
      continue;
    }
    if (!keepTag(el)) {
      // form, and any element not on the list: unwrapped, its children kept.
      cleanChildren(el);
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    cleanAttributes(el);
    if (tag === "dialog") el.removeAttribute("open");
    cleanChildren(el);
    // Text only: whatever markup survived the walk inside it becomes its text.
    if (svgText) {
      const text = el.textContent ?? "";
      el.textContent = text;
    }
  }
}

/** The example's HTML with only allowlisted elements, attributes and URLs, as HTML text. */
export function sanitizeComponentHtml(html: string, doc: Document): string {
  const template = doc.createElement("template");
  template.innerHTML = html;
  cleanChildren(template.content);
  const out = doc.createElement("div");
  out.append(template.content);
  return out.innerHTML;
}
