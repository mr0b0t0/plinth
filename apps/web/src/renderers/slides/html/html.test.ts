// An HTML deck in the slides renderer: deck.css scoped to each slide's shadow root and read at the
// slide's size, the DOM built from the parsed tree (never from markup), Plinth's own shapes,
// icons and connectors, fragments and paging, motion off where it must be, embeds only on stage,
// and the sample deck in docs/examples booting whole.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  parseHtmlDeck,
  SLIDE_EMBED_MESSAGE_SOURCE,
  SLIDE_EMBED_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../boot.ts";
import { STILL_ATTR } from "./base.ts";
import {
  buildHtmlSlide,
  CANVAS_PINNED,
  fragmentSteps,
  HOST_PINNED,
  htmlDeckContext,
  showSteps,
} from "./build.ts";
import { connectorSvg, coord, routePoints } from "./connectors.ts";
import {
  mapProjectUrls,
  mediaHolds,
  propertyRule,
  scopeDeckCss,
  scopeSelector,
  splitBlocks,
} from "./css.ts";
import { EMBED_FRAME_PINNED, EmbedFrames, embedLoaderUrl, isEmbedReady } from "./embeds.ts";
import { HtmlDeckRuntime } from "./runtime.ts";

const APP = "https://plinth.example.com";
const CANVAS = { width: 1920, height: 1080 };

function parsed(slides: Record<string, string>, css = "", index: Record<string, unknown> = {}) {
  const r = parseHtmlDeck({
    index: JSON.stringify({ title: "T", order: Object.keys(slides), ...index }),
    css,
    slides: new Map(Object.entries(slides).map(([id, h]) => [`slides/${id}.html`, h])),
  });
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.deck;
}

function mount(slides: Record<string, string>, css = "", view?: "overview") {
  const html = typedShellHtml(TYPE_REGISTRY.slides, {
    title: "T",
    text: JSON.stringify({ title: "T", order: Object.keys(slides) }),
    base: "",
    appOrigin: APP,
    path: "deck.json",
    files: {
      "deck.css": css,
      ...Object.fromEntries(Object.entries(slides).map(([id, h]) => [`slides/${id}.html`, h])),
    },
    ...(view ? { view } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

function framed() {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const win = {
    document,
    parent,
    print: vi.fn(),
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => window.getSelection(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent };
}

const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));
const hosts = () => Array.from(document.querySelectorAll<HTMLElement>(".plinth-slides__slide"));
const shadowOf = (n: number) => hosts()[n - 1]?.shadowRoot as ShadowRoot;
const current = () => document.documentElement.getAttribute("data-slide");

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.head.querySelectorAll("style, link").forEach((e) => {
    e.remove();
  });
  document.documentElement.removeAttribute("data-format");
});

describe("deck.css in a slide", () => {
  it("names the slide's own html for :root and :host, and leaves html and body as they are", () => {
    expect(scopeSelector(":root")).toBe("html");
    expect(scopeSelector(":root .x")).toBe("html .x");
    expect(scopeSelector(":host")).toBe("html");
    expect(scopeSelector("body")).toBe("body");
    expect(scopeSelector(".card p")).toBe(".card p");
  });

  it("reads @media at the slide's size, not the window's", () => {
    expect(mediaHolds("screen", CANVAS)).toBe(true);
    expect(mediaHolds("print", CANVAS)).toBe(false);
    expect(mediaHolds("(min-width: 1200px)", CANVAS)).toBe(true);
    expect(mediaHolds("(max-width: 600px)", CANVAS)).toBe(false);
    expect(mediaHolds("screen and (orientation: landscape)", CANVAS)).toBe(true);
    expect(mediaHolds("(orientation: portrait)", CANVAS)).toBe(false);
    expect(mediaHolds("(prefers-reduced-motion: no-preference)", CANVAS)).toBe(true);
    expect(mediaHolds("(prefers-reduced-motion: reduce)", CANVAS)).toBe(false);
    expect(mediaHolds("(prefers-color-scheme: dark)", CANVAS)).toBe(false);
    expect(mediaHolds("not print", CANVAS)).toBe(true);
    expect(mediaHolds("print, (min-width: 10px)", CANVAS)).toBe(true);
  });

  it("keeps rules and keyframes, unwraps media that holds, drops @font-face and @page", () => {
    const css = [
      "/* a { } */ :root { --accent: #f80 }",
      ".a { color: red; content: '}' }",
      "@media (max-width: 800px) { .phone { display: none } }",
      "@media (min-width: 800px) { .wide { gap: 4px } }",
      "@keyframes rise { from { opacity: 0 } to { opacity: 1 } }",
      "@font-face { font-family: X; src: url(x.woff2) }",
      "@page { size: A4 }",
      "@property --n { syntax: '<integer>'; inherits: false; initial-value: 0 }",
    ].join("\n");
    const { css: out, properties } = scopeDeckCss(css, CANVAS);
    expect(out).toContain("html { --accent: #f80 }");
    expect(out).toContain(".a { color: red; content: '}' }");
    expect(out).not.toContain(".phone");
    expect(out).toContain(".wide { gap: 4px }");
    expect(out).not.toContain("@media");
    expect(out).toContain("@keyframes rise");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain("@page");
    expect(out).not.toContain("@property");
    expect(properties).toHaveLength(1);
    expect(properties[0]).toBe(
      '@property --n { syntax: "<integer>"; inherits: false; initial-value: 0; }',
    );
    expect(splitBlocks("a { } } b { }").map((b) => b.prelude)).toEqual(["a", "b"]);
  });
});

describe("deck.css cannot reach past its slide", () => {
  it("rebuilds @property from its descriptors, so no text of it reaches the document as written", () => {
    const payload =
      '@property --x { syntax: "<integer>\n}.plinth-slides__controls{display:none}"; inherits: false; initial-value: 0 }';
    const { properties } = scopeDeckCss(payload, CANVAS);
    expect(properties).toEqual([]);
    expect(properties.join("")).not.toContain("plinth-slides__controls");
    // The same payload without the line break still fails the descriptor checks.
    expect(
      propertyRule(
        "--x",
        ' syntax: "<integer>}.plinth-slides__controls{display:none}"; inherits: false; initial-value: 0 ',
      ),
    ).toBeNull();
    expect(propertyRule("--x", "syntax: '*'; inherits: true")).toBe(
      '@property --x { syntax: "*"; inherits: true; }',
    );
    expect(
      propertyRule("--x", "syntax: '<color>'; inherits: false; initial-value: rgb(0 0 0)"),
    ).toBe('@property --x { syntax: "<color>"; inherits: false; initial-value: rgb(0 0 0); }');
    expect(
      propertyRule("--x", "syntax: '<length>'; inherits: false; initial-value: 0}a{b"),
    ).toBeNull();
    expect(
      propertyRule("--x", "syntax: '<length>'; inherits: false; initial-value: calc(1px"),
    ).toBeNull();
    expect(propertyRule("--x", "syntax: '<length>'; inherits: false")).toBeNull();
    expect(propertyRule("--x", "syntax: '<length>'; inherits: maybe; initial-value: 0")).toBeNull();
    expect(
      propertyRule("--x", "syntax: '<length>'; inherits: false; initial-value: 0; color: red"),
    ).toBeNull();
    expect(propertyRule("x", "syntax: '*'; inherits: true")).toBeNull();
  });

  it("ends a string at a line break, as a browser does", () => {
    const blocks = splitBlocks('.a { content: "x\n} .b { color: red }');
    expect(blocks.map((b) => b.prelude)).toEqual([".a", ".b"]);
  });

  it("drops selectors that name the shadow host or its tree from inside", () => {
    expect(scopeSelector(":host-context(*)")).toBeNull();
    expect(scopeSelector(":host(.x)")).toBeNull();
    expect(scopeSelector("html :HOST")).toBeNull();
    expect(scopeSelector("::slotted(p)")).toBeNull();
    expect(scopeSelector("x::part(a)")).toBeNull();
    const { css } = scopeDeckCss(
      ":host-context(*) { position: fixed !important } :host(.a), .ok { color: red } ::slotted(*) { color: blue }",
      CANVAS,
    );
    expect(css).not.toMatch(/:host|slotted/);
    expect(css).toContain(".ok { color: red }");
    expect(css).not.toContain("blue");
  });

  it("drops :host anywhere: inside :is(), :where(), :not(), :has() and in nested rules", () => {
    for (const sel of [
      ":is(:host) .x",
      ".a:where(:host-context(*))",
      "p:not(:host)",
      "div:has(::slotted(p))",
    ]) {
      expect(scopeSelector(sel), sel).toBeNull();
    }
    const { css } = scopeDeckCss(
      [
        ".a { color: red; :is(&, :host) { contain: none !important } }",
        ".b { @media (min-width: 1px) { :host { position: fixed !important } } }",
        ".c { color: green; .d & { color: blue } }",
        "@supports (display: grid) { .e { :where(:host) { z-index: 9 } } .f { color: teal } }",
      ].join("\n"),
      CANVAS,
    );
    expect(css).not.toMatch(/:host|contain: none|position: fixed|z-index/);
    // Nesting without the host is kept as written.
    expect(css).toContain(".c { color: green; .d & { color: blue } }");
    expect(css).toContain(".f { color: teal }");
  });

  it("keeps the host, the canvas, the shadow html and an embed frame's critical styles inline and !important", () => {
    const deck = parsed(
      {
        a: '<section id="a"><x-embed style="position:absolute; left:0; top:0; width:10px; height:10px"></x-embed></section>',
      },
      [
        ":host { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important }",
        ":host-context(*) { position: fixed !important }",
        ":root { contain: none !important; overflow: visible !important }",
        "x-embed > iframe { pointer-events: auto !important }",
        "section { counter-increment: page }",
      ].join("\n"),
    );
    const { ctx } = htmlDeckContext(document, deck);
    expect(ctx.css).not.toContain(":host-context");
    const { view, parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    const host = view.el;
    for (const [k, v] of Object.entries(HOST_PINNED)) {
      expect(host.style.getPropertyValue(k)).toBe(v);
      expect(host.style.getPropertyPriority(k)).toBe("important");
    }
    const canvas = view.frame.querySelector(".plinth-slides__canvas") as HTMLElement;
    for (const k of Object.keys(CANVAS_PINNED)) {
      expect(canvas.style.getPropertyPriority(k)).toBe("important");
    }
    const html = parts.root.querySelector("html") as HTMLElement;
    expect(html.style.getPropertyValue("contain")).toBe("strict");
    expect(html.style.getPropertyPriority("contain")).toBe("important");
    expect(html.style.getPropertyPriority("overflow")).toBe("important");
    // The counter still starts at the slide's place, beside the pinned styles.
    expect(html.style.getPropertyValue("counter-reset")).toBe("page 0");
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as unknown as Window;
    const frames = new EmbedFrames(
      win,
      "https://a1.content.example/__plinth/frames/slides/embed.html",
    );
    document.body.append(view.frame);
    frames.set(parts.embeds, true);
    const iframe = parts.root.querySelector("x-embed > iframe") as HTMLIFrameElement;
    for (const [k, v] of Object.entries(EMBED_FRAME_PINNED)) {
      expect(iframe.style.getPropertyValue(k)).toBe(v);
      expect(iframe.style.getPropertyPriority(k)).toBe("important");
    }
    frames.stop();
    view.frame.remove();
  });

  it("reads a Claude deck's project/ paths in url() as the version's own", () => {
    expect(mapProjectUrls("a { background: url(project/ds/b/bg.png) }")).toBe(
      "a { background: url(ds/b/bg.png) }",
    );
    expect(mapProjectUrls("a{background:url( 'project/x.png')}")).toBe(
      "a{background:url('x.png')}",
    );
    expect(mapProjectUrls("a{background:url(images/project/x.png)}")).toBe(
      "a{background:url(images/project/x.png)}",
    );
    const deck = parsed(
      {
        a: '<section id="a"><div id="d" style="background-image: url(project/ds/b/hero.png)"></div></section>',
      },
      ".x { background: url(project/ds/b/bg.png) }",
    );
    const { ctx } = htmlDeckContext(document, deck);
    expect(ctx.css).toContain("url(ds/b/bg.png)");
    const { parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    expect(parts.root.querySelector("#d")?.getAttribute("style")).toBe(
      "background-image: url(ds/b/hero.png)",
    );
  });

  it("draws nothing for an icon name that is only an object key", () => {
    const deck = parsed({
      a: '<section id="a"><x-icon name="constructor"></x-icon><x-icon name="__proto__"></x-icon></section>',
    });
    const { ctx } = htmlDeckContext(document, deck);
    const { parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    expect(parts.root.querySelectorAll("x-icon svg")).toHaveLength(2);
    expect(parts.root.querySelectorAll("x-icon svg path")).toHaveLength(0);
  });

  it("never marks an HTML slide as overflowing: it is a fixed canvas that clips", () => {
    const deck = parsed({
      a: '<section id="a"><div style="width: 4000px; height: 3000px">big</div><img src="images/p.png" style="position:absolute; left:1500px; top:0; width:1000px"></section>',
    });
    const rt = new HtmlDeckRuntime(window, deck, { motionOff: true, noEmbeds: true });
    const v = rt.views[0];
    if (!v) throw new Error("no view");
    document.body.append(v.frame);
    v.el.setAttribute("data-overflow", "true");
    rt.layout(v);
    expect(v.el.hasAttribute("data-overflow")).toBe(false);
    rt.still();
    expect(v.el.hasAttribute("data-overflow")).toBe(false);
    rt.stop();
    v.frame.remove();
  });
});

describe("a slide built from its tree", () => {
  it("puts the slide in a shadow root with the deck's rules, and runs nothing", () => {
    const deck = parsed(
      {
        a: '<section id="a" class="dark"><h1>Hi <b>there</b></h1><a href="https://x.example">x</a><a href="#b">b</a><img src="images/p.png" alt="P"></section>',
        b: '<section id="b"><p>two</p></section>',
      },
      "body { font-family: Inter } .dark { background: #111 }",
    );
    const { ctx } = htmlDeckContext(document, deck);
    const { view, parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    expect(view.el.dataset.format).toBe("html");
    expect(view.el.querySelector("*")).toBeNull();
    const root = parts.root;
    expect(root.querySelector("style")?.textContent).toContain("body { font-family: Inter }");
    expect(root.querySelector("style")?.textContent).toContain(":host([data-still])");
    expect(root.querySelector("html > body > section#a.dark h1 b")?.textContent).toBe("there");
    const [web, slide] = Array.from(root.querySelectorAll("a"));
    expect(web?.getAttribute("target")).toBe("_blank");
    expect(web?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(slide?.getAttribute("href")).toBe("#2");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("images/p.png");
    expect(root.querySelector("script")).toBeNull();
  });

  it("shows an inline svg as a picture, draws icons, and keeps an embed's page out of the DOM", () => {
    const deck = parsed({
      a: '<section id="a"><svg viewBox="0 0 10 10" aria-label="Dot"><circle r="4"><animate attributeName="r" from="1" to="4" dur="1s"/></circle></svg><x-icon name="Check"></x-icon><x-embed style="position:absolute; left:0; top:0; width:10px; height:10px"><script>window.x = 1</script></x-embed></section>',
    });
    const { ctx } = htmlDeckContext(document, deck);
    const { view, parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    const img = parts.root.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("Dot");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(decodeURIComponent(img?.getAttribute("src") ?? "")).toContain("<animate");
    expect(parts.root.querySelector("svg circle")).toBeNull();
    expect(parts.root.querySelector("x-icon svg path")?.getAttribute("d")).toMatch(/^M/);
    expect(parts.embeds).toHaveLength(1);
    expect(parts.embeds[0]?.page).toBe("<script>window.x = 1</script>");
    expect(parts.root.querySelector("x-embed")?.childNodes.length).toBe(0);
    expect(parts.root.querySelector("script")).toBeNull();
    expect(view.notes.childNodes.length).toBe(0);
  });

  it("orders fragments by data-fragment-index, then as they appear, and shows them by steps", () => {
    const deck = parsed({
      a: '<section id="a"><p class="fragment" id="p1">1</p><p class="fragment" data-fragment-index="2" id="p2">2</p><p class="fragment" data-fragment-index="1" id="p3">3</p><p class="fragment" data-fragment-index="1" id="p4">4</p></section>',
    });
    const { ctx } = htmlDeckContext(document, deck);
    const { parts } = buildHtmlSlide(ctx, deck.slides[0] as never, 1);
    const steps = fragmentSteps(parts.section);
    expect(steps.map((g) => g.map((e) => e.id))).toEqual([["p3", "p4"], ["p2"], ["p1"]]);
    showSteps(steps, 1);
    expect(parts.section.querySelectorAll(".visible")).toHaveLength(2);
    expect(parts.section.querySelector("#p3")?.classList.contains("current-fragment")).toBe(true);
    showSteps(steps, Number.POSITIVE_INFINITY);
    expect(parts.section.querySelectorAll(".visible")).toHaveLength(4);
  });

  it("starts each slide's own counter at its place in the deck", () => {
    const deck = parsed(
      { a: '<section id="a"></section>', b: '<section id="b"></section>' },
      "section { counter-increment: page; } .n::after { content: counter(page) }",
    );
    const { ctx } = htmlDeckContext(document, deck);
    const { parts } = buildHtmlSlide(ctx, deck.slides[1] as never, 2);
    expect(parts.root.querySelector("html")?.style.getPropertyValue("counter-reset")).toBe(
      "page 1",
    );
  });
});

describe("connectors", () => {
  it("reads px and % coordinates and routes", () => {
    expect(coord("50%", 400)).toBe(200);
    expect(coord("12px", 400)).toBe(12);
    expect(coord("7", 400)).toBe(7);
    expect(Number.isNaN(coord("a", 1))).toBe(true);
    expect(routePoints([0, 0], [10, 20], "hv")).toEqual([
      [0, 0],
      [10, 0],
      [10, 20],
    ]);
    expect(routePoints([0, 0], [10, 20], "vh")).toEqual([
      [0, 0],
      [0, 20],
      [10, 20],
    ]);
    expect(routePoints([0, 0], [100, 20], "elbow")).toEqual([
      [0, 0],
      [50, 0],
      [50, 20],
      [100, 20],
    ]);
    expect(routePoints([0, 0], [10, 100], "elbow")).toEqual([
      [0, 0],
      [0, 50],
      [10, 50],
      [10, 100],
    ]);
  });

  it("draws a line in currentColor with constant-size heads", () => {
    const svg = connectorSvg(
      document,
      [
        [0, 0],
        [100, 0],
      ],
      { width: 2, dash: "dashed", start: "open", end: "filled" },
    );
    const line = svg.querySelector("polyline");
    expect(line?.getAttribute("stroke")).toBe("currentColor");
    expect(line?.getAttribute("stroke-dasharray")).toBe("6 4");
    // The line stops short of the filled head, whose tip is the end point.
    expect(line?.getAttribute("points")).toBe("0,0 93.6,0");
    expect(svg.querySelector("polygon")?.getAttribute("points")).toContain("100,0");
    expect(svg.querySelectorAll("polyline")).toHaveLength(2);
  });
});

describe("embeds", () => {
  it("open Plinth's loader, sandboxed with allow-scripts only, and answer only their own frame", () => {
    expect(embedLoaderUrl({ href: "https://a1.content.example/__plinth/v/3/" })).toBe(
      "https://a1.content.example/__plinth/frames/slides/embed.html",
    );
    expect(embedLoaderUrl({ href: "https://app.example/__content/abcdefghij0123456789/x" })).toBe(
      "https://app.example/__content/abcdefghij0123456789/__plinth/frames/slides/embed.html",
    );
    expect(
      isEmbedReady({
        source: SLIDE_EMBED_MESSAGE_SOURCE,
        v: SLIDE_EMBED_PROTOCOL_VERSION,
        type: "ready",
      }),
    ).toBe(true);
    expect(isEmbedReady({ source: "other", v: 1, type: "ready" })).toBe(false);
    const target = new EventTarget();
    const win = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as unknown as Window;
    const frames = new EmbedFrames(
      win,
      "https://a1.content.example/__plinth/frames/slides/embed.html",
    );
    const box = document.createElement("x-embed");
    document.body.append(box);
    // The frame's own window, as a browser gives it once the element is in the document.
    const post = vi.fn();
    const own = { postMessage: post } as unknown as Window;
    const getter = vi
      .spyOn(HTMLIFrameElement.prototype, "contentWindow", "get")
      .mockReturnValue(own);
    frames.set([{ box, page: "<p>live</p>" }], true);
    const iframe = box.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("src")).toBe(
      "https://a1.content.example/__plinth/frames/slides/embed.html",
    );
    const ready = {
      source: SLIDE_EMBED_MESSAGE_SOURCE,
      v: SLIDE_EMBED_PROTOCOL_VERSION,
      type: "ready",
    };
    target.dispatchEvent(new MessageEvent("message", { data: ready, source: window }));
    expect(post).not.toHaveBeenCalled();
    target.dispatchEvent(new MessageEvent("message", { data: ready, source: own }));
    target.dispatchEvent(new MessageEvent("message", { data: ready, source: own }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ type: "render", html: "<p>live</p>" });
    expect(post.mock.calls[0]?.[1]).toBe("*");
    frames.set([{ box, page: "" }], false);
    expect(box.querySelector("iframe")).toBeNull();
    frames.stop();
    getter.mockRestore();
  });
});

describe("an HTML deck in the renderer", () => {
  const SLIDES = {
    a: '<section id="a"><h1 class="rise">One</h1><aside>Notes one</aside></section>',
    b: '<section id="b" data-transition="fade"><p class="fragment">first</p><p class="fragment">second</p></section>',
    c: '<section id="c"><x-embed style="position:absolute; left:0; top:0; width:100px; height:100px"><p>live</p></x-embed></section>',
    hidden: '<section id="hidden" hidden><p>skipped</p></section>',
  };

  it("shows every slide but a hidden one, in shadow roots, with no Plinth number or footer", () => {
    mount(SLIDES, "body { color: #222 }");
    const f = framed();
    stop = boot(f.win, { still: false });
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(document.documentElement.getAttribute("data-format")).toBe("html");
    expect(hosts()).toHaveLength(3);
    expect(document.querySelector(".plinth-slides__number, .plinth-slides__footer")).toBeNull();
    expect(shadowOf(1).querySelector("section")?.id).toBe("a");
    expect(document.querySelector(".plinth-slides__handout")?.textContent).toBe("Notes one");
    expect(f.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ready", count: 3 }),
      APP,
    );
  });

  it("steps through a slide's fragments before it moves on, and shows a slide whole going back", () => {
    mount(SLIDES);
    const f = framed();
    stop = boot(f.win, { still: false });
    const visible = () => shadowOf(2).querySelectorAll(".fragment.visible").length;
    key(f.target, "ArrowRight");
    expect(current()).toBe("2");
    expect(visible()).toBe(0);
    key(f.target, "ArrowRight");
    expect(current()).toBe("2");
    expect(visible()).toBe(1);
    key(f.target, "ArrowRight");
    expect(visible()).toBe(2);
    key(f.target, "ArrowLeft");
    expect(visible()).toBe(1);
    key(f.target, "ArrowRight");
    key(f.target, "ArrowRight");
    expect(current()).toBe("3");
    key(f.target, "ArrowLeft");
    expect(current()).toBe("2");
    expect(visible()).toBe(2);
    // Home and digits go straight to a slide, never stepping.
    key(f.target, "Home");
    expect(current()).toBe("1");
  });

  it("plays motion only on stage and mounts an embed only there", () => {
    mount(SLIDES);
    const f = framed();
    stop = boot(f.win, { still: false });
    expect(hosts()[0]?.hasAttribute(STILL_ATTR)).toBe(false);
    expect(hosts()[1]?.hasAttribute(STILL_ATTR)).toBe(true);
    const frame = () => shadowOf(3).querySelector("x-embed iframe");
    expect(frame()).toBeNull();
    key(f.target, "End");
    expect(frame()?.getAttribute("sandbox")).toBe("allow-scripts");
    key(f.target, "o");
    expect(frame()).toBeNull();
    // The overview shows every slide whole and still.
    expect(hosts().every((h) => h.hasAttribute(STILL_ATTR))).toBe(true);
    expect(shadowOf(2).querySelectorAll(".fragment.visible")).toHaveLength(2);
  });

  it("is a still at the top (a thumbnail capture): no motion, every step, no embed", () => {
    mount(SLIDES);
    const f = framed();
    stop = boot(f.win, { still: true });
    expect(hosts().every((h) => h.hasAttribute(STILL_ATTR))).toBe(true);
    expect(shadowOf(2).querySelectorAll(".fragment.visible")).toHaveLength(2);
    key(f.target, "End");
    expect(shadowOf(3).querySelector("x-embed iframe")).toBeNull();
  });

  it("shows every step in an audience window, which its presenter's window moves", () => {
    mount(SLIDES);
    const f = framed();
    stop = boot(f.win, { still: false });
    f.target.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "plinth-renderer", v: 1, type: "paired" },
        origin: APP,
        source: f.parent as unknown as Window,
      }),
    );
    key(f.target, "ArrowRight");
    expect(current()).toBe("2");
    expect(shadowOf(2).querySelectorAll(".fragment.visible")).toHaveLength(2);
    key(f.target, "ArrowRight");
    expect(current()).toBe("3");
  });

  it("gives presenter view its own copies, the current one stepping with the deck", () => {
    mount(SLIDES);
    const f = framed();
    stop = boot(f.win, { still: false });
    key(f.target, "ArrowRight");
    key(f.target, "s");
    const pane = document.querySelector(
      ".plinth-slides__pane--current .plinth-slides__slide",
    ) as HTMLElement;
    expect(pane.shadowRoot?.querySelector("section")?.id).toBe("b");
    expect(pane.hasAttribute(STILL_ATTR)).toBe(false);
    const next = document.querySelector(
      ".plinth-slides__pane--next .plinth-slides__slide",
    ) as HTMLElement;
    expect(next.hasAttribute(STILL_ATTR)).toBe(true);
    key(f.target, "ArrowRight");
    const live = document.querySelector(
      ".plinth-slides__pane--current .plinth-slides__slide",
    ) as HTMLElement;
    expect(live.shadowRoot?.querySelectorAll(".fragment.visible")).toHaveLength(1);
    expect(document.querySelector(".plinth-slides__notes")?.textContent).toBe("");
  });

  it("shows the fallback for a deck the parser refuses", () => {
    mount({ a: '<section id="a"><script>x</script></section>' });
    stop = boot(framed().win, { still: false });
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
  });
});

describe("the skill's HTML deck example", () => {
  it("is a deck Plinth accepts with no warning", () => {
    const skill = readFileSync(
      path.join(process.cwd(), "../../integrations/skill/plinth-artifacts/SKILL.md"),
      "utf8",
    );
    const section = skill.slice(skill.indexOf("### HTML decks (Claude's slide format)"));
    const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
    const example = JSON.parse(json) as {
      content: string;
      assets: { path: string; content: string }[];
    };
    const files = new Map(example.assets.map((a) => [a.path, a.content]));
    const r = parseHtmlDeck({
      index: example.content,
      css: files.get("deck.css") ?? null,
      slides: new Map([...files].filter(([p]) => p.startsWith("slides/"))),
      paths: new Set(["deck.json", ...files.keys()]),
    });
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("the sample deck", () => {
  it("passes the parser with no warning and boots all 11 slides", () => {
    // Vitest runs in apps/web.
    const dir = path.join(process.cwd(), "../../docs/examples/plinth-deck");
    const paths = new Set<string>();
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else paths.add(path.relative(dir, p).split(path.sep).join("/"));
      }
    };
    walk(dir);
    const slides: Record<string, string> = {};
    for (const p of paths)
      if (p.startsWith("slides/")) slides[p] = readFileSync(path.join(dir, p), "utf8");
    const index = readFileSync(path.join(dir, "deck.json"), "utf8");
    const css = readFileSync(path.join(dir, "deck.css"), "utf8");
    const r = parseHtmlDeck({ index, css, slides: new Map(Object.entries(slides)), paths });
    expect(r.warnings).toEqual([]);
    expect(r.ok && r.deck.slides).toHaveLength(11);
    const html = typedShellHtml(TYPE_REGISTRY.slides, {
      title: "Plinth",
      text: index,
      base: "",
      appOrigin: APP,
      path: "deck.json",
      files: { "deck.css": css, ...slides },
    });
    const main = /<main [^>]*><\/main>/.exec(html)?.[0] ?? "";
    const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] ?? "";
    document.body.innerHTML = main + data;
    stop = boot(framed().win, { still: false });
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(hosts()).toHaveLength(11);
    expect(
      document.head.querySelector(
        'link[rel="stylesheet"][href^="https://fonts.googleapis.com/css2?"]',
      ),
    ).not.toBeNull();
  });
});
