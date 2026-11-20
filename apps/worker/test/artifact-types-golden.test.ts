// Golden output of the per-type rules a publish goes through (services/artifactTypes.ts and the
// title a version takes), recorded before those rules moved behind the per-type hooks. Every
// accepted input and every refusal (code, message and details) must stay as it was: agents act on
// these messages. A type PR adds its own cases below the html and doc ones.
import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { checkAsset, resolveSource } from "../src/services/artifactTypes.ts";
import { titleFromSource } from "../src/services/stage.ts";
import golden from "./fixtures/artifact-types-golden.json";

function outcome(f: () => unknown): unknown {
  try {
    const r = f();
    if (r && typeof r === "object" && "def" in r) {
      const { def, text } = r as { def: { id: string }; text: string };
      return { ok: { type: def.id, text } };
    }
    return { ok: r ?? null };
  } catch (e) {
    const err = e as { code?: string; message: string; details?: unknown };
    return { error: { code: err.code, message: err.message, details: err.details ?? null } };
  }
}

const DOC = "<!doctype html><html><body>x</body></html>";
const BOARD = '<!-- artboard name="Home" size="iphone" -->\n<p>x</p>';
type Golden = "html" | "doc" | "design";
const sourceCases: [string, Record<string, unknown>, Golden | null][] = [
  ["publish default html", { html: "<p>x</p>" }, null],
  ["publish html with content", { content: "# x" }, null],
  ["publish html without html", {}, null],
  ["publish explicit html", { type: "html", html: DOC }, null],
  ["publish doc", { type: "doc", content: "# Plan\n\nText" }, null],
  ["publish doc with html", { type: "doc", html: "<p>x</p>" }, null],
  ["publish doc without content", { type: "doc" }, null],
  ["publish doc with a whole document", { type: "doc", content: DOC }, null],
  ["publish doc with <html>", { type: "doc", content: "  <HTML lang=en>" }, null],
  ["publish doc mentioning html", { type: "doc", content: "Use <html> tags" }, null],
  ["publish unknown type", { type: "deck", content: "x" }, null],
  ["publish prototype key", { type: "toString", content: "x" }, null],
  ["update html", { html: "<p>y</p>" }, "html"],
  ["update html with content", { content: "# y" }, "html"],
  ["update html without html", {}, "html"],
  ["update doc", { content: "# y" }, "doc"],
  ["update doc with html", { html: "<p>y</p>" }, "doc"],
  ["update doc without content", {}, "doc"],
  ["update doc with a whole document", { content: DOC }, "doc"],
  ["update doc ignores type", { type: "html", content: "# y" }, "doc"],
  // The design type (type-design): artboards in design.html.
  ["publish design", { type: "design", content: BOARD }, null],
  ["publish design with html", { type: "design", html: BOARD }, null],
  ["publish design without a board", { type: "design", content: "<p>x</p>" }, null],
  ["publish design with a whole document", { type: "design", content: DOC }, null],
  [
    "publish design with two problems",
    { type: "design", content: '<!-- artboard size="iphone" -->\n<!-- artboard name="B" -->' },
    null,
  ],
  ["update design", { content: BOARD }, "design"],
  ["update design with html", { html: BOARD }, "design"],
];

const assetCases: [string, Golden, string, string][] = [
  ["html index.html", "html", "index.html", "text/html"],
  ["html script", "html", "app.js", "text/javascript"],
  ["html image", "html", "img/a.png", "image/png"],
  ["doc index.html", "doc", "index.html", "text/html"],
  ["doc content.md", "doc", "content.md", "text/markdown"],
  ["doc image", "doc", "img/a.png", "image/png"],
  ["doc svg", "doc", "a.svg", "image/svg+xml"],
  ["doc script", "doc", "app.js", "text/javascript"],
  ["doc css", "doc", "a.css", "text/css"],
  ["design design.html", "design", "design.html", "text/html"],
  ["design index.html", "design", "index.html", "text/html"],
  ["design image", "design", "img/a.png", "image/png"],
  ["design css", "design", "a.css", "text/css"],
  ["design script", "design", "app.js", "text/javascript"],
  ["design video", "design", "intro.mp4", "video/mp4"],
  ["design font", "design", "brand.woff2", "font/woff2"],
  ["design json", "design", "data.json", "application/json"],
  ["design html page", "design", "page.html", "text/html"],
];

const titleCases: [string, Golden, string][] = [
  ["html title", "html", "<html><head><title> My  &amp; page </title></head></html>"],
  ["html entities", "html", "<TITLE>&lt;a&gt; &quot;b&quot; &#39;c&#39;</TITLE>"],
  ["html empty title", "html", "<title>   </title>"],
  ["html no title", "html", "<p>none</p>"],
  ["html unclosed", "html", "<title>open"],
  ["html long", "html", `<title>${"t".repeat(400)}</title>`],
  ["html late title", "html", `${" ".repeat(70 * 1024)}<title>late</title>`],
  ["doc heading", "doc", "intro\n# Plan  \n\n# Second"],
  ["doc empty heading", "doc", "#  \n# Real"],
  ["doc no heading", "doc", "## Sub\ntext"],
  ["doc hash without space", "doc", "#Plan"],
  ["doc long", "doc", `# ${"d".repeat(400)}`],
  ["doc late heading", "doc", `${"x\n".repeat(250)}# Late`],
  ["design shared title", "design", `<title>Launch kit</title>\n${BOARD}`],
  ["design first board", "design", `<link rel="stylesheet" href="a.css">\n${BOARD}`],
  ["design unparsed", "design", "<p>no boards</p>"],
];

function record() {
  return {
    resolveSource: Object.fromEntries(
      sourceCases.map(([name, input, current]) => [
        name,
        outcome(() => resolveSource(input, current)),
      ]),
    ),
    checkAsset: Object.fromEntries(
      assetCases.map(([name, type, path, ct]) => [
        name,
        outcome(() => checkAsset(TYPE_REGISTRY[type], path, ct)),
      ]),
    ),
    titleFromSource: Object.fromEntries(
      titleCases.map(([name, type, text]) => [
        name,
        outcome(() => titleFromSource(TYPE_REGISTRY[type], text)),
      ]),
    ),
  };
}

describe("per-type publish rules golden", () => {
  it("accepts and refuses exactly as before, with the same messages", () => {
    expect(record()).toEqual(golden);
  });
});
