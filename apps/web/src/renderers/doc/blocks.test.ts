// Block-by-block rendering (#36) must give exactly the page a whole-document render gives: the
// same HTML, the same heading ids and reference links, through the same sanitizer, with the line
// ranges kept outside the DOM.
import { describe, expect, it } from "vitest";
import { BlockCache, parseBlocks, rangeOf, reconcile } from "./blocks.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { CORPUS } from "./testCorpus.ts";

const DOCS: Record<string, string> = {
  ...CORPUS,
  empty: "",
  "only blank lines": "\n\n\n",
  everything: [
    "# Plinth",
    "",
    "Intro with a [ref][r] and **bold**.",
    "",
    "## Plinth",
    "",
    "- one",
    "- two",
    "",
    "  continued",
    "",
    "1. first",
    "2. second",
    "",
    "> quote",
    "> more",
    "",
    "| a | b |",
    "| --- | :-: |",
    "| 1 | 2 |",
    "",
    "```js",
    "const x = 1;",
    "",
    "```",
    "",
    "    indented code",
    "",
    "---",
    "",
    "# Plinth",
    "",
    "[r]: https://example.com",
    "",
    "Trailing ![img](a.png) text",
  ].join("\n"),
  "reference defined first": "[r]: https://example.com\n\n[link][r]\n",
  "lazy paragraph": "> quote\nlazy line\n\npara",
  "setext heading": "Title\n=====\n\ntext",
};

function html(frag: DocumentFragment): string {
  const div = document.createElement("div");
  div.append(frag);
  return div.innerHTML;
}

describe("parseBlocks", () => {
  for (const [name, md] of Object.entries(DOCS)) {
    it(`joins to the whole-document render: ${name}`, () => {
      const blocks = parseBlocks(md);
      expect(blocks.map((b) => b.html).join("")).toBe(renderMarkdown(md));
      // Each block through the sanitizer, joined, equals the whole render through it.
      const joined = blocks.map((b) => html(sanitizeHtml(b.html, document))).join("");
      expect(joined).toBe(html(sanitizeHtml(renderMarkdown(md), document)));
      // Ranges are ordered, inside the text and never overlapping.
      const lines = md.split("\n").length;
      let prev = 0;
      for (const b of blocks) {
        expect(b.start).toBeGreaterThanOrEqual(prev);
        expect(b.end).toBeGreaterThanOrEqual(b.start);
        expect(b.end).toBeLessThanOrEqual(lines);
        prev = b.end;
      }
    });
  }

  it("shares heading ids and reference links across blocks", () => {
    const blocks = parseBlocks(DOCS.everything as string);
    const all = blocks.map((b) => b.html).join("");
    expect(all).toContain('id="plinth"');
    expect(all).toContain('id="plinth-1"');
    expect(all).toContain('id="plinth-2"');
    expect(all).toContain('href="https://example.com"');
  });

  it("gives every non-blank line to a block, reference definitions included", () => {
    const md = DOCS.everything as string;
    const lines = md.split("\n");
    const blocks = parseBlocks(md);
    lines.forEach((line, n) => {
      if (line.trim() === "") return;
      expect(
        blocks.some((b) => b.start <= n && n < b.end),
        `line ${n}: ${line}`,
      ).toBe(true);
    });
    const ref = blocks.find((b) => b.start <= 32 && 32 < b.end);
    expect(ref?.html).toContain("<h1");
    const first = parseBlocks(DOCS["reference defined first"] as string);
    expect(first[0]?.start).toBe(0);
  });
});

describe("BlockCache and reconcile", () => {
  it("records ranges in a WeakMap, adds no data-* attribute and reuses unchanged blocks", () => {
    const root = document.createElement("main");
    const cache = new BlockCache(document);
    const render = (md: string) => {
      const nodes = parseBlocks(md).flatMap((b) => cache.nodes(b));
      cache.commit();
      reconcile(root, nodes);
    };
    render("# A\n\npara one\n\n![i](a.png)");
    const img = root.querySelector("img");
    const h1 = root.querySelector("h1") as Element;
    expect(rangeOf(h1)).toEqual({ start: 0, end: 1 });
    expect(root.innerHTML).not.toContain("data-");
    expect(root.innerHTML).toBe(
      html(sanitizeHtml(renderMarkdown("# A\n\npara one\n\n![i](a.png)"), document)),
    );

    render("# A\n\npara one, edited\nover two lines\n\n![i](a.png)");
    // The heading and the image are the same nodes; only the paragraph was rebuilt.
    expect(root.querySelector("h1")).toBe(h1);
    expect(root.querySelector("img")).toBe(img);
    expect(rangeOf(root.querySelector("img")?.parentElement as Element)).toEqual({
      start: 5,
      end: 6,
    });
    expect(root.querySelector("p")?.textContent).toContain("edited");
  });

  it("never detaches a node that stays, so a focused field keeps focus", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const a = document.createElement("p");
    const field = document.createElement("textarea");
    const b = document.createElement("p");
    reconcile(root, [a, field, b]);
    field.focus();
    expect(document.activeElement).toBe(field);
    const c = document.createElement("p");
    const d = document.createElement("p");
    reconcile(root, [c, field, d]);
    expect(Array.from(root.childNodes)).toEqual([c, field, d]);
    expect(document.activeElement).toBe(field);
    root.remove();
  });
});
