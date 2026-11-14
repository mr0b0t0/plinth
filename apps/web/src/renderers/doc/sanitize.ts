// The DOM allowlist pass between markdown.ts and the page. markdown.ts already emits only these
// tags and attributes; this pass makes that a property of the page rather than of the parser, so a
// markdown-it bug or a future rule cannot put a script, a handler or a style into a doc. The HTML
// is parsed in a <template>, whose content is inert: nothing in it loads or runs.
import { isSafeHref, isSafeImageSrc } from "./markdown.ts";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const REL = "noopener noreferrer nofollow";

const TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "div",
  "span",
]);

/** Elements removed with everything inside them; any other unknown element is unwrapped. */
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
  "noscript",
  "noembed",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "link",
  "meta",
  "base",
  "title",
  "head",
]);

const CLASS_PREFIXES = ["plinth-doc__", "language-"];

/** Whether attribute `name` with `value` may stay on element `tag`. */
function allowed(tag: string, name: string, value: string): boolean {
  switch (name) {
    case "id":
      return value !== "" && !value.startsWith("_");
    case "title":
    case "aria-label":
      return true;
    case "href":
      return tag === "a" && isSafeHref(value);
    case "target":
      return tag === "a" && value === "_blank";
    case "rel":
      return tag === "a";
    case "src":
      return tag === "img" && isSafeImageSrc(value);
    case "alt":
      return tag === "img";
    case "loading":
      return tag === "img" && (value === "lazy" || value === "eager");
    case "decoding":
      return tag === "img" && (value === "async" || value === "sync" || value === "auto");
    case "start":
      return tag === "ol" && /^\d{1,9}$/.test(value);
    case "role":
      return value === "region";
    case "tabindex":
      return value === "0" || value === "-1";
    default:
      return false;
  }
}

function cleanAttributes(el: Element): void {
  const tag = el.localName;
  for (const { name, value } of Array.from(el.attributes)) {
    if (name === "class") {
      const kept = value
        .split(/\s+/)
        .filter((c) => c !== "" && CLASS_PREFIXES.some((p) => c.startsWith(p)));
      if (kept.length > 0) el.setAttribute("class", kept.join(" "));
      else el.removeAttribute("class");
    } else if (!allowed(tag, name, value)) {
      el.removeAttribute(name);
    }
  }
  // A new tab never gets a handle on this page, whatever rel the input had.
  if (el.getAttribute("target") === "_blank") el.setAttribute("rel", REL);
  else el.removeAttribute("rel");
}

function cleanChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue; // text
    if (node.nodeType !== 1) {
      node.parentNode?.removeChild(node); // comments, processing instructions
      continue;
    }
    const el = node as Element;
    const tag = el.localName;
    if (el.namespaceURI !== HTML_NS || !TAGS.has(tag)) {
      if (DROP.has(tag) || el.namespaceURI !== HTML_NS) {
        el.remove();
      } else {
        cleanChildren(el);
        el.replaceWith(...Array.from(el.childNodes));
      }
      continue;
    }
    cleanAttributes(el);
    cleanChildren(el);
  }
}

/** Parses `html` and returns only its allowlisted elements, attributes and URLs. */
export function sanitizeHtml(html: string, doc: Document): DocumentFragment {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  cleanChildren(fragment);
  return fragment;
}
