// The deck's DOM: every slide part and the notes pass the doc's Markdown and sanitizer layers, so
// hostile Markdown in a body, a column or the notes leaves only allowlisted tags, attributes and
// URLs; what the renderer adds itself (footer, number) is text; heading ids are unique per deck.
import { parseDeck } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { isSafeHref, isSafeImageSrc } from "../doc/markdown.ts";
import { CORPUS } from "../doc/testCorpus.ts";
import { buildDeck } from "./deck.ts";
import { classifySlide, FIT_STEPS, fitSlide } from "./layout.ts";

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

/** Every element under the Markdown-made parts of a deck is on the doc allowlist. */
function expectSafe(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    expect(TAGS.has(el.localName), `tag <${el.localName}>`).toBe(true);
    for (const a of Array.from(el.attributes)) {
      expect(ATTRS.has(a.name), `attribute ${a.name}`).toBe(true);
      if (a.name === "class") {
        for (const c of a.value.split(/\s+/).filter(Boolean)) {
          expect(/^(plinth-doc__|language-)/.test(c), `class ${c}`).toBe(true);
        }
      }
    }
    const href = el.getAttribute("href");
    if (href !== null) expect(isSafeHref(href), `href ${href}`).toBe(true);
    const src = el.getAttribute("src");
    if (src !== null) expect(isSafeImageSrc(src), `src ${src}`).toBe(true);
  }
}

function markdownParts(frame: HTMLElement): Element[] {
  return Array.from(
    frame.querySelectorAll(".plinth-slides__head, .plinth-slides__column, .plinth-slides__handout"),
  );
}

const deck = (text: string) => buildDeck(document, parseDeck(text));

describe("buildDeck", () => {
  it("keeps every hostile corpus entry safe in a body, a column and the notes", () => {
    for (const [name, md] of Object.entries(CORPUS)) {
      const views = deck(`## ${name}\n\n${md}\n|||\n${md}\n|||\n${md}\nNote: ${md}`);
      expect(views).toHaveLength(1);
      const v = views[0];
      if (!v) throw new Error("no slide");
      for (const part of markdownParts(v.frame)) expectSafe(part);
      expectSafe(v.notes);
      expect(v.frame.querySelector("script, style, iframe, svg, form")).toBeNull();
    }
  });

  it("shows the footer and the number as text", () => {
    const [v] = deck("---\nfooter: <b>Bold</b> & co\n---\n# A");
    const footer = v?.el.querySelector(".plinth-slides__footer");
    expect(footer?.textContent).toBe("<b>Bold</b> & co");
    expect(footer?.querySelector("b")).toBeNull();
    expect(v?.el.querySelector(".plinth-slides__number")?.textContent).toBe("1");
    const [quiet] = deck("---\npaginate: false\n---\n# A");
    expect(quiet?.el.querySelector(".plinth-slides__number")).toBeNull();
    expect(quiet?.el.querySelector(".plinth-slides__footer")).toBeNull();
  });

  it("prefixes heading ids per slide and keeps them unique across the deck", () => {
    const views = deck(
      "## Summary\n[top](#summary)\n---\n## Summary\n|||\n## Summary\n|||\n## Summary",
    );
    const ids = views.flatMap((v) => Array.from(v.el.querySelectorAll("[id]")).map((e) => e.id));
    expect(ids).toEqual(["s1-summary", "s2-summary", "s2-summary-2", "s2-summary-3"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(views[0]?.el.querySelector("a")?.getAttribute("href")).toBe("#s1-summary");
    // The doc's heading anchors are gone: a slide has nothing to link to.
    expect(document.querySelector(".plinth-doc__anchor")).toBeNull();
    expect(views.some((v) => v.el.querySelector(".plinth-doc__anchor"))).toBe(false);
  });

  it("leaves #N slide links as written and drops ids from the notes", () => {
    const [v] = deck("## A\nSee [three](#3) and [intro](#intro)\nNote:\n## Heading in notes");
    const hrefs = Array.from(v?.el.querySelectorAll("a") ?? []).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#3", "#intro"]);
    expect(v?.notes.querySelector("[id]")).toBeNull();
    expect(v?.notes.textContent).toContain("Heading in notes");
  });

  it("labels each slide for assistive technology", () => {
    const views = deck("# A\n---\n## B");
    expect(views.map((v) => v.el.getAttribute("aria-label"))).toEqual([
      "Slide 1 of 2",
      "Slide 2 of 2",
    ]);
    expect(views[0]?.el.getAttribute("aria-roledescription")).toBe("slide");
  });
});

describe("classifySlide", () => {
  const layoutOf = (md: string) => deck(md)[0]?.layout;

  it("picks each layout from what the slide holds", () => {
    expect(layoutOf("# Q4 review\n\nRevenue and hiring")).toBe("title");
    expect(layoutOf("# Q4\n\nOne\n\nTwo")).toBe("title");
    expect(layoutOf("# Q4\n\nOne\n\nTwo\n\nThree")).toBe("default");
    expect(layoutOf("## Part two")).toBe("section");
    expect(layoutOf("![chart](c.png)")).toBe("image");
    expect(layoutOf("## Revenue\n\n![chart](c.png)")).toBe("image");
    expect(layoutOf("## Revenue\n\n![a](a.png) ![b](b.png)")).toBe("default");
    expect(layoutOf("## H\n|||\na\n|||\nb")).toBe("columns");
    expect(layoutOf("## Revenue\n\n- one\n- two")).toBe("default");
    const empty = document.createElement("div");
    expect(classifySlide(empty, 0)).toBe("default");
  });
});

describe("fitSlide", () => {
  it("steps the font scale down until the body fits", () => {
    const [v] = deck("## A");
    if (!v) throw new Error("no slide");
    let calls = 0;
    const fit = fitSlide(v.el, v.body, () => ++calls < 3);
    expect(fit).toBe(FIT_STEPS[2]);
    expect(v.el.style.getPropertyValue("--fit")).toBe(String(FIT_STEPS[2]));
    expect(v.el.hasAttribute("data-overflow")).toBe(false);
  });

  it("marks the slide at the floor when it still overflows", () => {
    const [v] = deck("## A");
    if (!v) throw new Error("no slide");
    expect(fitSlide(v.el, v.body, () => true)).toBe(0.55);
    expect(v.el.getAttribute("data-overflow")).toBe("true");
    fitSlide(v.el, v.body, () => false);
    expect(v.el.hasAttribute("data-overflow")).toBe(false);
    expect(v.el.style.getPropertyValue("--fit")).toBe("1");
  });
});
