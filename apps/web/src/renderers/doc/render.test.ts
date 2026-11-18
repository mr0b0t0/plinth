// The doc renderer's Markdown layer. User Markdown is untrusted: whatever it contains, the output
// may hold only the tags and attributes below, and every href and src must pass the URL rules.
// The allowlists are restated here (not imported) so a change to the renderer cannot quietly widen
// what these tests accept.
import { describe, expect, it } from "vitest";
import { isSafeHref, isSafeImageSrc, renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { CORPUS } from "./testCorpus.ts";

const TAGS = new Set(
  "p h1 h2 h3 h4 h5 h6 a strong em del code pre blockquote ul ol li hr br table thead tbody tr th td img div span".split(
    " ",
  ),
);
const ATTRS = new Set(
  "id class href target rel src alt title start aria-label role tabindex loading decoding".split(
    " ",
  ),
);

function parse(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

function elements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll("*"));
}

/** Every element, attribute and URL in the fragment is on the allowlist. */
function expectSafe(root: ParentNode): void {
  for (const el of elements(root)) {
    expect(TAGS.has(el.localName), `tag <${el.localName}>`).toBe(true);
    for (const a of Array.from(el.attributes)) {
      expect(ATTRS.has(a.name), `attribute ${a.name} on <${el.localName}>`).toBe(true);
      expect(a.name.startsWith("on")).toBe(false);
      if (a.name === "class") {
        for (const c of a.value.split(/\s+/).filter(Boolean)) {
          expect(/^(plinth-doc__|language-)/.test(c), `class ${c}`).toBe(true);
        }
      }
      if (a.name === "start") expect(el.localName).toBe("ol");
    }
    const href = el.getAttribute("href");
    if (href !== null) {
      expect(el.localName).toBe("a");
      expect(isSafeHref(href), `href ${href}`).toBe(true);
      expect(/^\s*(javascript|vbscript|data|file):/i.test(href)).toBe(false);
      expect(href.startsWith("//")).toBe(false);
    }
    const src = el.getAttribute("src");
    if (src !== null) {
      expect(el.localName).toBe("img");
      expect(isSafeImageSrc(src), `src ${src}`).toBe(true);
      expect(/^https?:/i.test(src)).toBe(false);
    }
  }
}

function render(md: string): DocumentFragment {
  return parse(renderMarkdown(md));
}

describe("doc renderer: XSS corpus", () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    it(`keeps output on the allowlist: ${name}`, () => {
      const raw = render(md);
      expectSafe(raw);
      expect(raw.querySelector("script, iframe, style, svg")).toBeNull();
      // The sanitizer pass keeps a safe tree safe.
      expectSafe(sanitizeHtml(renderMarkdown(md), document));
    });
  }

  it("shows raw HTML as text", () => {
    const f = render("<script>window.__pwned = 1</script>");
    expect(f.querySelector("script")).toBeNull();
    expect(f.textContent).toContain("<script>window.__pwned = 1</script>");
  });

  it("renders a rejected link as its text, not as a link", () => {
    const f = render("[click](javascript:alert(1)) and [ok](https://example.com)");
    const links = Array.from(f.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(f.textContent).toContain("click");
  });

  it("drops a reference link to a bad scheme", () => {
    const f = render("[x][r]\n\n[r]: javascript:alert(1)");
    expect(f.querySelector("a")).toBeNull();
  });

  it("does not show an svg data image", () => {
    const f = render("![x](data:image/svg+xml;base64,PHN2Zz4=)");
    expect(f.querySelector("img")).toBeNull();
  });
});

describe("doc renderer: URL rules", () => {
  it.each([
    "https://example.com/a?b#c",
    "http://example.com",
    "mailto:a@example.com",
    "#section",
    "notes.md",
    "./img/a.png",
    "../up",
    "/root/path",
    "?q=1",
  ])("allows the link %s", (u) => {
    expect(isSafeHref(u)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "vbscript:x",
    "data:text/html,x",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "ftp://example.com",
    "//evil.example",
    " //evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "foo:bar",
    "a\u0000b",
    "",
  ])("refuses the link %j", (u) => {
    expect(isSafeHref(u)).toBe(false);
  });

  it.each([
    "pic.png",
    "img/a b.png",
    "./a.webp",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,AAAA",
    "data:image/gif;base64,AAAA",
    "data:image/webp;base64,AAAA",
    "data:image/avif;base64,AAAA",
  ])("allows the image %s", (u) => {
    expect(isSafeImageSrc(u)).toBe(true);
  });

  it.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "data:image/svg+xml;base64,AAAA",
    "data:image/png,raw",
    "data:text/html;base64,AAAA",
    "javascript:alert(1)",
    "mailto:a@example.com",
    "#top",
    "//evil.example/a.png",
    "",
  ])("refuses the image %j", (u) => {
    expect(isSafeImageSrc(u)).toBe(false);
  });
});

describe("doc renderer: features", () => {
  it("gives headings unique slug ids and anchors", () => {
    const f = render(
      "# Hello, World!\n\n## Hello world\n\n## Hello world\n\n### Überblick 2\n\n#### ???\n\n##### Five",
    );
    const ids = Array.from(f.querySelectorAll("h1, h2, h3, h4")).map((h) => h.id);
    expect(ids).toEqual([
      "hello-world",
      "hello-world-1",
      "hello-world-2",
      "überblick-2",
      "section",
    ]);
    const h1 = f.querySelector("h1");
    const anchor = h1?.querySelector("a.plinth-doc__anchor");
    expect(anchor?.getAttribute("href")).toBe("#hello-world");
    expect(anchor?.getAttribute("aria-label")).toBe("Link to this section");
    expect(anchor?.textContent).toBe("#");
    expect(anchor?.hasAttribute("target")).toBe(false);
    expect(f.querySelector("h5")?.id).toBe("");
    expect(f.querySelector("h5 a")).toBeNull();
    expectSafe(f);
  });

  it("never gives a heading an id that starts with __", () => {
    const f = render("# __plinth-doc\n\n# __plinth-content");
    for (const h of Array.from(f.querySelectorAll("h1"))) expect(h.id.startsWith("_")).toBe(false);
  });

  it("dedupes against ids already taken by a suffix", () => {
    const f = render("# A\n\n# A-1\n\n# A");
    expect(Array.from(f.querySelectorAll("h1")).map((h) => h.id)).toEqual(["a", "a-1", "a-2"]);
  });

  it("opens external links in a new tab, but not fragment links", () => {
    const f = render(
      "[ext](https://example.com) [mail](mailto:a@example.com) [rel](notes.md) [frag](#x)",
    );
    const [ext, mail, rel, frag] = Array.from(f.querySelectorAll("a"));
    for (const a of [ext, mail, rel]) {
      expect(a?.getAttribute("target")).toBe("_blank");
      expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
    expect(frag?.getAttribute("href")).toBe("#x");
    expect(frag?.hasAttribute("target")).toBe(false);
    expect(frag?.hasAttribute("rel")).toBe(false);
  });

  it("wraps tables in a scroll region with alignment classes", () => {
    const f = render("| L | C | R | N |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |");
    const wrap = f.querySelector("div.plinth-doc__table");
    expect(wrap?.getAttribute("role")).toBe("region");
    expect(wrap?.getAttribute("tabindex")).toBe("0");
    expect(wrap?.firstElementChild?.localName).toBe("table");
    const th = Array.from(f.querySelectorAll("th"));
    expect(th.map((c) => c.className)).toEqual([
      "plinth-doc__align-left",
      "plinth-doc__align-center",
      "plinth-doc__align-right",
      "",
    ]);
    expect(f.querySelectorAll("td.plinth-doc__align-center")).toHaveLength(1);
    expect(f.querySelector("[style]")).toBeNull();
    expectSafe(f);
  });

  it("escapes code and keeps a safe language class", () => {
    const f = render('```ts\nconst a = "<b>&</b>";\n```\n\n```"><script>x</script> extra\ny\n```');
    const [first, second] = Array.from(f.querySelectorAll("pre"));
    expect(first?.getAttribute("tabindex")).toBe("0");
    const code = first?.querySelector("code");
    expect(code?.className).toBe("language-ts");
    expect(code?.textContent).toBe('const a = "<b>&</b>";\n');
    expect(code?.children).toHaveLength(0);
    const hostile = second?.querySelector("code");
    expect(hostile?.getAttribute("class") ?? "").toMatch(/^(language-[a-z0-9_+-]+)?$/);
    expect(f.querySelector("script")).toBeNull();
    expectSafe(f);
  });

  it("gives indented code blocks the same pre", () => {
    const f = render("para\n\n    indented <b>\n");
    expect(f.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
    expect(f.querySelector("pre code")?.textContent).toBe("indented <b>\n");
  });

  it("links bare URLs", () => {
    const f = render("See https://example.com/page or write to team@example.com.");
    const hrefs = Array.from(f.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/page", "mailto:team@example.com"]);
    for (const a of Array.from(f.querySelectorAll("a"))) {
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });

  it("keeps relative and data:image/png images", () => {
    const f = render(
      '![Chart](images/chart.png "Q3")\n\n![dot](data:image/png;base64,iVBORw0KGgo=)',
    );
    const imgs = Array.from(f.querySelectorAll("img"));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "images/chart.png",
      "data:image/png;base64,iVBORw0KGgo=",
    ]);
    expect(imgs[0]?.getAttribute("alt")).toBe("Chart");
    expect(imgs[0]?.getAttribute("title")).toBe("Q3");
    expect(imgs[0]?.getAttribute("loading")).toBe("lazy");
    expectSafe(f);
  });

  it("turns an https image into a new-tab link labelled with its alt text", () => {
    const f = render("![The *chart*](https://example.com/c.png)");
    expect(f.querySelector("img")).toBeNull();
    const a = f.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/c.png");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a?.textContent).toBe("The chart ↗");
  });

  it("does not nest links for an external image inside a link", () => {
    const f = render("[![a](https://evil.example/i.png)](https://example.com)");
    expect(f.querySelectorAll("a a")).toHaveLength(0);
    expect(f.querySelector("img")).toBeNull();
    expect(f.textContent).toContain("a ↗");
  });

  it("renders strikethrough as del, and ordered list starts", () => {
    const f = render("~~gone~~\n\n3. three\n4. four");
    expect(f.querySelector("del")?.textContent).toBe("gone");
    expect(f.querySelector("ol")?.getAttribute("start")).toBe("3");
    expectSafe(f);
  });

  // Size scaling, not wall-clock time: absolute bounds flake under parallel test load and on slow
  // runners. After a warm-up (the first call also pays for JIT compilation), doubling the input
  // must not much more than double the Markdown time; quadratic behaviour would quadruple it. Each
  // size takes the best of two runs to shed GC pauses. Absolute bounds run only with
  // PLINTH_PERF=1 (a browser parses the output in tens of milliseconds; happy-dom is far slower).
  it("renders a 1 MB mixed document in time linear in its size", () => {
    const block = [
      "## Section heading",
      "",
      "Some **bold** and *italic* text with a [link](https://example.com) and `code`.",
      "",
      "| a | b | c |",
      "| --- | :-: | --: |",
      "| 1 | 2 | 3 |",
      "",
      "```js",
      "const x = 1 < 2 && 3 > 2;",
      "```",
      "",
      "- item one",
      "- item two with https://example.org",
      "",
      "> a quote",
      "",
      "![img](img/a.png)",
      "",
    ].join("\n");
    const sized = (bytes: number) => block.repeat(Math.ceil(bytes / block.length));
    const best = (md: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 2; i++) {
        const t = performance.now();
        renderMarkdown(md);
        min = Math.min(min, performance.now() - t);
      }
      return min;
    };
    renderMarkdown(sized(256 * 1024));
    const half = best(sized(512 * 1024));
    const md = sized(1024 * 1024);
    expect(md.length).toBeGreaterThanOrEqual(1024 * 1024);
    const full = best(md);
    expect(full / half).toBeLessThan(3);

    const start = performance.now();
    const html = renderMarkdown(md);
    const markdownMs = performance.now() - start;
    const frag = sanitizeHtml(html, document);
    const totalMs = performance.now() - start;
    expect(frag.querySelectorAll("h2").length).toBeGreaterThan(1000);
    expect(frag.querySelectorAll("[id^='section-heading']").length).toBeGreaterThan(1000);
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.PLINTH_PERF === "1") {
      expect(markdownMs).toBeLessThan(600);
      expect(totalMs).toBeLessThan(6000);
    }
  }, 30_000);
});
