// HTML decks (packages/shared/src/slidesHtml.ts): the index, the slide tokenizer and its element
// allowlist, every one of Claude's caps, the CSS rules, fonts, images, warnings, and that a
// Markdown deck is read exactly as before.
import { describe, expect, it } from "vitest";
import {
  deckCssProblem,
  deckFileProblem,
  describeChanges,
  HTML_DECK_CANVAS,
  HTML_DECK_LIMITS,
  type HtmlDeckResult,
  htmlDeckTitle,
  isHtmlDeckIndex,
  parseDeck,
  parseHtmlDeck,
  pinnedClasses,
  sourcePathForText,
  TYPE_REGISTRY,
  typedShellHtml,
  versionSourcePath,
} from "../src/index.ts";

const L = HTML_DECK_LIMITS;

function deck(
  slides: Record<string, string>,
  index: Record<string, unknown> = {},
  css: string | null = null,
  paths?: string[],
): HtmlDeckResult {
  const files = new Map(Object.entries(slides).map(([id, html]) => [`slides/${id}.html`, html]));
  return parseHtmlDeck({
    index: JSON.stringify({ title: "Q3", order: Object.keys(slides), ...index }),
    css,
    slides: files,
    ...(paths ? { paths: new Set(paths) } : {}),
  });
}

const one = (html: string, css: string | null = null) => deck({ a: html }, {}, css);
const section = (inner: string, attrs = "") => `<section id="a"${attrs}>${inner}</section>`;
const errorsOf = (r: HtmlDeckResult) => (r.ok ? [] : r.errors.map((e) => e.message));
const refused = (r: HtmlDeckResult, re: RegExp) => {
  expect(r.ok, JSON.stringify(r.warnings)).toBe(false);
  expect(errorsOf(r).join("\n")).toMatch(re);
};
const okDeck = (r: HtmlDeckResult) => {
  if (!r.ok) throw new Error(errorsOf(r).join("\n"));
  return r.deck;
};

describe("the deck index", () => {
  it("reads title, order, size, cover, sections and faces", () => {
    const d = okDeck(
      deck(
        {
          cover: section("<h1>Hi</h1>").replace('id="a"', 'id="cover"'),
          plan: section("<p>x</p>").replace('id="a"', 'id="plan"'),
        },
        {
          size: "4:3",
          cover: "cover",
          sections: { s1: { description: "Numbers", start: "plan" } },
          faces: {
            inter: {
              family: "Inter",
              href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600",
            },
            brand: { family: "Brand Sans", src: "ds/brand/fonts/Brand.woff2" },
          },
          designSystems: [{ title: "Brand", namespace: "brand", artifact: "x", version: null }],
          v: 5,
          lists: "css",
          format: { v: 1, shared: ["deck.css"] },
        },
      ),
    );
    expect(d.title).toBe("Q3");
    expect(d.size).toBe("4:3");
    expect(d.canvas).toEqual(HTML_DECK_CANVAS["4:3"]);
    expect(d.slides.map((s) => s.id)).toEqual(["cover", "plan"]);
    expect(d.cover).toBe("cover");
    expect(d.sections).toEqual([{ key: "s1", description: "Numbers", start: "plan" }]);
    expect(d.faces.map((f) => f.family)).toEqual(["Inter", "Brand Sans"]);
    expect(d.faces[1]?.src).toBe("ds/brand/fonts/Brand.woff2");
    expect(d.designSystems).toHaveLength(1);
  });

  it("is a 1920x1080 canvas by default and names its title for the version", () => {
    const d = okDeck(one(section("<p>x</p>")));
    expect(d.canvas).toEqual({ width: 1920, height: 1080 });
    expect(htmlDeckTitle(JSON.stringify({ title: " Launch " }))).toBe("Launch");
    expect(htmlDeckTitle(JSON.stringify({ title: "Untitled" }))).toBeNull();
  });

  it("refuses an index that is not a JSON object or has a bad order or size", () => {
    const bad = (index: string) =>
      parseHtmlDeck({
        index,
        css: null,
        slides: new Map([["slides/a.html", section("<p>x</p>")]]),
      });
    refused(bad("{ not json"), /is not JSON/);
    refused(bad("[1]"), /must be a JSON object/);
    refused(bad(JSON.stringify({ order: "a" })), /order must be a list/);
    refused(bad(JSON.stringify({ order: ["a", "a"] })), /lists a twice/);
    refused(bad(JSON.stringify({ order: ["../x"] })), /not a slide id/);
    refused(bad(JSON.stringify({ size: "21:9" })), /size is/);
    refused(bad(JSON.stringify({ title: 5 })), /title must be a string/);
  });

  it("warns about order ids without a file, files order leaves out, and a bad cover", () => {
    const r = parseHtmlDeck({
      index: JSON.stringify({ order: ["a", "ghost"], cover: "nope" }),
      css: null,
      slides: new Map([
        ["slides/a.html", section("<p>a</p>")],
        ["slides/b.html", section("<p>b</p>").replace('id="a"', 'id="b"')],
      ]),
    });
    const d = okDeck(r);
    expect(d.slides.map((s) => s.id)).toEqual(["a", "b"]);
    const msgs = r.warnings.map((w) => w.message).join("\n");
    expect(msgs).toMatch(/order lists ghost/);
    expect(msgs).toMatch(/slides\/b\.html is not in order and shows last/);
    expect(msgs).toMatch(/cover names nope/);
  });

  it("refuses a deck with no slides or more than 500", () => {
    refused(parseHtmlDeck({ index: "{}", css: null, slides: new Map() }), /no slides/);
    const many = new Map<string, string>();
    for (let i = 0; i <= 500; i++) many.set(`slides/s${i}.html`, `<section id="s${i}"></section>`);
    refused(parseHtmlDeck({ index: "{}", css: null, slides: many }), /at most 500 slides/);
  });

  it("keeps at most 4 font families and ignores faces that break a rule", () => {
    const r = deck(
      { a: section("<p>x</p>") },
      {
        faces: {
          two: {
            family: "Inter",
            href: "https://fonts.googleapis.com/css2?family=Inter&family=Lora",
          },
          three: { family: "Rubik", src: "fonts/Rubik.woff2" },
          four: { family: "Oswald", src: "fonts/Oswald.ttf" },
          five: { family: "Domine", src: "fonts/Domine.otf" },
          other: { family: "Bad", href: "https://evil.example/font.css" },
          escaped: { family: "Esc", href: "https://fonts.googleapis.com/css2?family=A%20B" },
          blob: { family: "Blob", src: "/_blob/abc" },
          both: {
            family: "Both",
            href: "https://fonts.googleapis.com/css2?family=X",
            src: "a.woff2",
          },
        },
      },
    );
    const d = okDeck(r);
    expect(d.faces.map((f) => f.key)).toEqual(["two", "three", "four"]);
    expect(r.warnings.filter((w) => w.code === "slides_setting")).toHaveLength(5);
  });

  it("is told apart from Markdown by its first character, and stored as deck.json", () => {
    expect(isHtmlDeckIndex('  \n{"order":[]}')).toBe(true);
    expect(isHtmlDeckIndex("﻿{}")).toBe(true);
    expect(isHtmlDeckIndex("# Deck\n\n---\n\n## Two")).toBe(false);
    const def = TYPE_REGISTRY.slides;
    expect(sourcePathForText(def, "{}")).toBe("deck.json");
    expect(sourcePathForText(def, Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe(
      "deck.json",
    );
    expect(sourcePathForText(def, "# Hi")).toBe("slides.md");
    expect(sourcePathForText(TYPE_REGISTRY.doc, "{}")).toBe("content.md");
    expect(versionSourcePath(def, new Set(["deck.json", "slides/a.html"]))).toBe("deck.json");
    expect(versionSourcePath(def, [{ path: "slides.md" }])).toBe("slides.md");
    expect(versionSourcePath(def, new Set(["slides.md", "deck.json"]))).toBe("slides.md");
  });
});

describe("a slide file", () => {
  it("is one <section> whose id is the file name", () => {
    expect(okDeck(one(section("<h1>Hello</h1><aside>Say hi</aside>"))).slides[0]?.notes).toBe(
      "Say hi",
    );
    refused(one("<p>x</p>"), /outside its <section>/);
    refused(one(`${section("")}${section("")}`), /more than one <section>/);
    refused(one('<section id="b"></section>'), /id="a"/);
    refused(one(`text ${section("")}`), /outside its <section>/);
    refused(one(`<!doctype html>${section("")}`), /DOCTYPE/);
    refused(one(section('<section id="x"></section>')), /inside its <section>/);
  });

  it("refuses script, handlers, javascript: URLs, frames, forms and <style>", () => {
    refused(one(section("<script>alert(1)</script>")), /<script>/);
    refused(one(section('<p onclick="x()">a</p>')), /event handler/);
    refused(one(section('<p ONCLICK="x()">a</p>')), /event handler/);
    refused(one(section('<a href="javascript:alert(1)">a</a>')), /javascript: URL/);
    refused(one(section('<a href=" java\tscript:alert(1)">a</a>')), /javascript: URL/);
    refused(one(section('<iframe src="x"></iframe>')), /<iframe>/);
    refused(one(section("<form></form>")), /<form>/);
    refused(one(section("<input>")), /<input>/);
    refused(one(section("<style>p{}</style>")), /<style>/);
    refused(one(section("<object></object>")), /<object>/);
    refused(one(section("<video src=x></video>")), /<video>/);
    refused(one(section("<blink>a</blink>")), /not a tag Slides reads/);
    refused(one(section("<my-widget></my-widget>")), /not a tag Slides reads/);
  });

  it("refuses an image that is not one of the version's files", () => {
    refused(one(section('<img src="https://example.com/a.png">')), /is a URL/);
    refused(one(section('<img src="//example.com/a.png">')), /is a URL/);
    refused(one(section('<img src="data:image/png;base64,AAAA">')), /data: URL/);
    refused(one(section('<img src="/_blob/abc">')), /Claude upload address/);
    refused(one(section('<img src="../secret.png">')), /not a plain path/);
    refused(one(section('<img src="a.png?x=1">')), /not a plain path/);
    const d = okDeck(one(section('<img src="./images/a.png" alt="A">')));
    expect(d.slides[0]?.images).toEqual(["images/a.png"]);
  });

  it("keeps only allowed links: https, http, mailto and #N or a slide id", () => {
    okDeck(
      one(
        section(
          '<a href="https://plinth.example">a</a><a href="#3">b</a><a href="#plan">c</a><a href="mailto:a@b.c">d</a>',
        ),
      ),
    );
    refused(one(section('<a href="ftp://x">a</a>')), /is not an https/);
    refused(one(section('<a href="data:text/html,x">a</a>')), /is not an https/);
  });

  it("checks style attributes with the deck CSS rules", () => {
    refused(
      one(section('<p style="background:url(https://evil.example/x.png)">a</p>')),
      /own files/,
    );
    refused(
      one(section('<p style="background:url(data:image/png;base64,AA)">a</p>')),
      /data: URLs/,
    );
    refused(one(section('<p style="width:expression(alert(1))">a</p>')), /url\(\)|images only/);
    refused(one(section('<p style="behavior:url(x.htc)">a</p>')), /behavior/);
    refused(one(section('<p style="color:\\72 ed">a</p>')), /may not contain \\/);
    const d = okDeck(one(section('<p style="background:url(images/bg.png)">a</p>')));
    expect(d.slides[0]?.cssRefs).toEqual(["images/bg.png"]);
  });

  it("drops attributes it does not list and keeps data-*", () => {
    const d = okDeck(
      one(
        section('<p class="x 1bad" data-fragment-index="2" srcset="a" tabindex="3" id="ok">t</p>'),
      ),
    );
    const p = d.slides[0]?.section.children.find((c) => c.kind === "el");
    expect(p?.kind === "el" && p.attrs).toEqual([
      ["class", "x"],
      ["data-fragment-index", "2"],
      ["id", "ok"],
    ]);
  });

  it("turns other HTML tags into plain boxes and phrases, with one warning per tag", () => {
    const r = one(
      section("<blockquote><strong>a</strong> <em>b</em> <strong>c</strong></blockquote>"),
    );
    const d = okDeck(r);
    const box = d.slides[0]?.section.children[0];
    expect(box?.kind === "el" && box.tag).toBe("div");
    expect(
      box?.kind === "el" && box.children.map((c) => (c.kind === "el" ? c.tag : "#text")),
    ).toEqual(["b", "#text", "i", "#text", "b"]);
    expect(r.warnings.filter((w) => w.code === "slide_markup").map((w) => w.message)).toHaveLength(
      3,
    );
  });

  it("reads implied end tags as HTML does, and refuses markup it cannot read", () => {
    const d = okDeck(one(section("<ul><li>a<li>b</ul><p>one<p>two")));
    const ul = d.slides[0]?.section.children[0];
    expect(ul?.kind === "el" && ul.children.filter((c) => c.kind === "el")).toHaveLength(2);
    refused(one(section("<div><p>a</div></p>")), /closes nothing/);
    refused(one(section("<div>")), /not closed/);
    refused(one(section("<div/>")), /must be written/);
    refused(one(section('<p class="a>x</p>')), /not closed|cannot be read/);
    refused(one(section("<p>&bogus;</p>")), /not an entity/);
    expect(
      okDeck(one(section("<p>a &lt; b &amp; &#8212; &mdash; c &check;</p>"))).slides[0]?.title,
    ).toBe("a < b & — — c ✓");
  });

  it("reads notes from the last <aside>, cut at 4,000 characters", () => {
    const long = "word ".repeat(1000);
    const r = one(section(`<h1>T</h1><aside>${long}</aside>`));
    expect([...(okDeck(r).slides[0]?.notes ?? "")].length).toBe(L.maxNotes);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/over 4000 characters/);
    const two = one(section("<aside>one</aside><p>x</p><aside>two</aside>"));
    expect(okDeck(two).slides[0]?.notes).toBe("one\n\ntwo");
    expect(two.warnings.map((w) => w.message).join()).toMatch(/not the section's last child/);
  });

  it("knows a hidden slide, its transition and its title", () => {
    const s = okDeck(one(section("<h2>Plan</h2>", ' hidden data-transition="push"'))).slides[0];
    expect(s?.hidden).toBe(true);
    expect(s?.transition).toBe("push");
    expect(s?.title).toBe("Plan");
    const r = one(section("<p>x</p>", ' data-transition="spin"'));
    expect(okDeck(r).slides[0]?.transition).toBeNull();
    expect(r.warnings[0]?.message).toMatch(/not fade, push or magic/);
  });
});

describe("Claude's caps", () => {
  it("allows 200 boxes and refuses 201", () => {
    okDeck(one(section("<p>x</p>".repeat(L.maxBoxes))));
    refused(one(section("<p>x</p>".repeat(L.maxBoxes + 1))), /more than 200 boxes/);
    // Phrases and breaks are not boxes.
    okDeck(one(section(`<p>${"<b>a</b><br>".repeat(300)}</p>`)));
  });

  it("allows 15 nested divs and refuses 16", () => {
    const nest = (n: number) => `${"<div>".repeat(n)}x${"</div>".repeat(n)}`;
    okDeck(one(section(nest(L.maxDivDepth))));
    refused(one(section(nest(L.maxDivDepth + 1))), /more than 15 <div>s/);
  });

  it("allows 24 pinned children of one box and refuses 25, by style or by a deck.css class", () => {
    const pins = (n: number, how: string) =>
      `<div style="position:relative">${`<p ${how}>x</p>`.repeat(n)}</div>`;
    okDeck(one(section(pins(L.maxPinned, 'style="position:absolute"'))));
    refused(
      one(section(pins(L.maxPinned + 1, 'style="position: absolute; left:0"'))),
      /pins 25 children/,
    );
    const css = ".tag, .chip { position: absolute; top: 0 }";
    expect([...pinnedClasses(css)]).toEqual(["tag", "chip"]);
    refused(one(section(pins(L.maxPinned + 1, 'class="chip"')), css), /pins 25 children/);
    // Connectors with coordinates count; flow ones do not.
    const lines = (n: number) =>
      '<x-connector x1="0" y1="0" x2="10" y2="10"></x-connector>'.repeat(n);
    refused(one(section(lines(L.maxPinned + 1))), /pins 25 children/);
    okDeck(one(section('<x-connector style="width:96px"></x-connector>'.repeat(30))));
  });

  it("allows an SVG of 52 KB and refuses a bigger one", () => {
    const pad = (bytes: number) =>
      `<svg viewBox="0 0 10 10"><desc>${"a".repeat(bytes)}</desc></svg>`;
    const base = pad(0).length;
    okDeck(one(section(pad(L.maxSvgBytes - base))));
    refused(one(section(pad(L.maxSvgBytes - base + 1))), /at most 52 KB/);
  });

  it("refuses SVG script, handlers, foreignObject, images, links and URLs", () => {
    const svg = (inner: string, attrs = "") =>
      section(`<svg viewBox="0 0 10 10"${attrs}>${inner}</svg>`);
    refused(one(svg("<script>alert(1)</script>")), /may not hold <script>/);
    refused(one(svg('<rect onload="x()"/>')), /event handler/);
    refused(one(svg("<foreignObject></foreignObject>")), /may not hold <foreignObject>/);
    refused(one(svg('<image href="a.png"/>')), /may not hold <image>/);
    refused(one(svg('<a href="https://x"><rect/></a>')), /may not hold <a>/);
    refused(one(svg('<use href="https://evil.example/s.svg#x"/>')), /own #ids/);
    refused(
      one(svg('<rect fill="url(https://evil.example/p)"/>')),
      /url\(\) only for its own #ids/,
    );
    refused(
      one(svg('<animate attributeName="href" to="javascript:x"/>')),
      /javascript:|animate an href/,
    );
    refused(one(svg("<style>@import url(x.css);</style>")), /@import/);
    refused(one(svg("<p>x</p>")), /not an SVG element/);
    refused(one(svg("<rect/>", " width=10")), /needs quotes/);
    refused(one(svg("<desc>&nbsp;</desc>")), /an <svg> knows/);
  });

  it("shows an inline SVG as a picture of its XML, with a still copy and its label", () => {
    const d = okDeck(
      one(
        section(
          '<svg viewBox="0 0 100 50" width="100" height="50" aria-label="Revenue" style="position:absolute; left:10px" class="chart"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"><animate attributeName="opacity" from="0" to="1" dur="1s"/></rect><use href="#g"/></svg>',
        ),
      ),
    );
    const el = d.slides[0]?.section.children[0];
    if (el?.kind !== "el" || !el.svg) throw new Error("no svg");
    expect(el.tag).toBe("svg");
    expect(el.attrs).toEqual([
      ["width", "100"],
      ["height", "50"],
      ["style", "position:absolute; left:10px"],
      ["class", "chart"],
    ]);
    expect(el.svg.alt).toBe("Revenue");
    expect(el.svg.xml).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 50"/,
    );
    expect(el.svg.xml).toContain("<linearGradient");
    expect(el.svg.xml).toContain("<animate");
    expect(el.svg.still).not.toContain("<animate");
    expect(el.svg.still).toContain("animation:none!important");
  });

  it("refuses tables over 100 rows or 24 columns", () => {
    const table = (rows: number, cols: number) =>
      `<table>${`<tr>${"<td>x</td>".repeat(cols)}</tr>`.repeat(rows)}</table>`;
    okDeck(one(section(table(L.maxTableRows, 1))));
    refused(one(section(table(L.maxTableRows + 1, 1))), /101 rows/);
    okDeck(one(section(table(1, L.maxTableColumns))));
    refused(one(section(table(1, L.maxTableColumns + 1))), /25 columns/);
    refused(
      one(section('<table><tr><td colspan="20">x</td><td colspan="5">y</td></tr></table>')),
      /25 columns/,
    );
  });

  it("refuses more than 20,000 characters of text on a slide", () => {
    okDeck(one(section(`<p>${"a".repeat(L.maxSlideText)}</p>`)));
    refused(one(section(`<p>${"a".repeat(L.maxSlideText + 1)}</p>`)), /20000/);
  });

  it("allows 8 embeds of 16 KB, direct children of the section, and refuses past that", () => {
    const embed = (page = "<p>live</p>") =>
      `<x-embed style="position:absolute; left:0; top:0; width:100px; height:100px">${page}</x-embed>`;
    const d = okDeck(
      one(section(embed("<script>let a = 1 < 2;</script>").repeat(L.maxEmbedsPerSlide))),
    );
    const first = d.slides[0]?.section.children[0];
    expect(first?.kind === "el" && first.embed).toBe("<script>let a = 1 < 2;</script>");
    refused(one(section(embed().repeat(L.maxEmbedsPerSlide + 1))), /more than 8 <x-embed>s/);
    refused(one(section(embed("a".repeat(L.maxEmbedBytes + 1)))), /at most 16 KB/);
    refused(one(section(`<div>${embed()}</div>`)), /not a direct child/);
    refused(one(section("<x-embed>never closed")), /not closed/);
  });

  it("refuses a slide file over 256 KB and a deck over 4 MB of text", () => {
    refused(one(section(`<p>${"a".repeat(L.maxSlideBytes)}</p>`)), /over 256 KB/);
    const big: Record<string, string> = {};
    for (let i = 0; i < 17; i++)
      big[`s${i}`] = `<section id="s${i}"><p>${"a".repeat(250 * 1024)}</p></section>`;
    refused(deck(big), /at most 4 MB/);
  });

  it("checks x-shape kinds, x-icon names and x-connector coordinates", () => {
    okDeck(one(section('<x-shape kind="arrow-right"></x-shape><x-shape></x-shape>')));
    refused(one(section('<x-shape kind="star"></x-shape>')), /not a shape Slides draws/);
    const icon = one(section('<x-icon name="Check"></x-icon><x-icon name="Rocket"></x-icon>'));
    okDeck(icon);
    expect(icon.warnings.map((w) => w.message).join()).toMatch(/Rocket.*shows nothing/);
    refused(one(section('<x-connector x1="0" y1="0" x2="10"></x-connector>')), /not all four/);
    refused(
      one(section('<x-connector x1="a" y1="0" x2="10" y2="1"></x-connector>')),
      /not a number/,
    );
    okDeck(one(section('<x-connector x1="10%" y1="0px" x2="-5" y2="12.5"></x-connector>')));
    const content = one(section("<x-shape>inside</x-shape>"));
    expect(content.warnings.map((w) => w.message).join()).toMatch(/holds no content/);
  });
});

describe("deck.css", () => {
  it("passes the design system's CSS rules, without data: URLs", () => {
    expect(
      deckCssProblem("body { font-family: Inter; } .card { background: url(images/a.png) }"),
    ).toBeNull();
    expect(deckCssProblem("@import url(x.css);")).toMatch(/@import/);
    expect(deckCssProblem(".a { background: url(https://evil.example/x) }")).toMatch(/own files/);
    expect(deckCssProblem(".a { background: image-set('x.png' 1x) }")).toMatch(/url\(\)/);
    expect(deckCssProblem(".a { content: '\\2022' }")).toMatch(/\\/);
    expect(deckCssProblem(".a { background: url(data:image/png;base64,AA) }")).toMatch(/data:/);
    expect(deckCssProblem("</style><script>")).toMatch(/</);
    refused(one(section("<p>x</p>"), "@import url(x.css);"), /@import/);
  });

  it("warns about @font-face and missing files the deck names", () => {
    const r = deck(
      { a: section('<img src="images/a.png" alt=""><p style="background:url(bg.png)">x</p>') },
      { faces: { f: { family: "F", src: "fonts/F.woff2" } } },
      "@font-face { font-family: X; src: url(x.woff2) } .a { background: url(images/b.png) }",
      ["deck.json", "slides/a.html", "deck.css"],
    );
    okDeck(r);
    const missing = r.warnings.filter((w) => w.code === "missing_file").map((w) => w.ref);
    expect(missing.sort()).toEqual(
      ["bg.png", "fonts/F.woff2", "images/a.png", "images/b.png", "x.woff2"].sort(),
    );
    expect(r.warnings.map((w) => w.message).join()).toMatch(/@font-face/);
  });
});

describe("which files a deck version holds", () => {
  it("keeps a Markdown deck to images, and an HTML deck's files in their places", () => {
    expect(deckFileProblem("markdown", "a.png", "image/png")).toBeNull();
    expect(deckFileProblem("markdown", "slides/a.html", "text/html")).toMatch(/HTML deck/);
    expect(deckFileProblem("markdown", "deck.css", "text/css")).toMatch(/HTML deck/);
    expect(deckFileProblem("html", "slides/a.html", "text/html; charset=utf-8")).toBeNull();
    expect(deckFileProblem("html", "page.html", "text/html")).toMatch(/slides\/<id>\.html/);
    expect(deckFileProblem("html", "slides/a b.html", "text/html")).toMatch(/slides\/<id>\.html/);
    expect(deckFileProblem("html", "deck.css", "text/css")).toBeNull();
    expect(deckFileProblem("html", "theme.css", "text/css")).toMatch(/deck\.css/);
    expect(deckFileProblem("html", "ds/brand/tokens.json", "application/json")).toBeNull();
    expect(deckFileProblem("html", "data.json", "application/json")).toMatch(/ds\//);
    expect(deckFileProblem("html", "ds/brand/fonts/B.woff2", "font/woff2")).toBeNull();
    expect(deckFileProblem("html", "app.js", "text/javascript")).toMatch(/slides\/<id>\.html/);
  });
});

describe("comparing two HTML deck versions", () => {
  it("names the title, size, fonts and slides added, removed or moved", () => {
    const a = JSON.stringify({
      title: "Q3",
      order: ["cover", "plan", "risks"],
      faces: { i: { family: "Inter" } },
    });
    const b = JSON.stringify({
      title: "Q4",
      size: "4:3",
      order: ["plan", "cover", "next"],
      faces: { l: { family: "Lora" } },
    });
    const items = describeChanges("slides", a, b).items.map((i) => `${i.kind}: ${i.what}`);
    expect(items).toEqual([
      "changed: Title changed",
      "changed: Size changed",
      "added: Font “Lora” added",
      "removed: Font “Inter” removed",
      "added: Slide “next” added",
      "removed: Slide “risks” removed",
      "moved: Slide order changed",
    ]);
    expect(describeChanges("slides", "# Talk", a).items.map((i) => i.what)).toEqual([
      "Deck format changed",
    ]);
  });
});

describe("Markdown decks, unchanged", () => {
  it("parse as before and are never read as an HTML deck", () => {
    const md = "# Title\n\nSub\n\n---\n\n## Two\n\nNote: hi";
    expect(isHtmlDeckIndex(md)).toBe(false);
    const p = parseDeck(md);
    expect(p.slides).toHaveLength(2);
    expect(p.slides[1]?.notes).toBe("hi");
  });

  it("keep their shell's bytes: no path or files in a Markdown deck's payload", () => {
    const o = { title: "T", text: "# A", base: "", appOrigin: "https://app.example" };
    const shell = typedShellHtml(TYPE_REGISTRY.slides, o);
    expect(shell).toContain('"path":"slides.md"');
    expect(shell).not.toContain('"files"');
    // Files are carried only with deck.json as the path.
    expect(
      typedShellHtml(TYPE_REGISTRY.slides, { ...o, files: { "slides/a.html": "x" } }),
    ).not.toContain('"files"');
    const html = typedShellHtml(TYPE_REGISTRY.slides, {
      ...o,
      text: "{}",
      path: "deck.json",
      files: { "slides/a.html": '<section id="a"></section></script>' },
    });
    expect(html).toContain('"path":"deck.json"');
    expect(html).toContain('"files":{"slides/a.html":"\\u003csection');
    expect(html).not.toContain("</section></script>");
  });
});
