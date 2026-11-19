// The design system renderer's entry and site: it boots from the JSON block the shell embeds,
// renders every section, shows readable problems for JSON it cannot use, and puts every author
// string on the page as text.
import { jsonForScript, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, describe, expect, it } from "vitest";
import { boot } from "./boot.ts";
import { groupOf, sectionId } from "./render.ts";
import { FIXTURE } from "./testFixture.ts";

const APP = "https://plinth.example.com";

/** The root and data block of a real shell, in the test document. */
function mountShell(text: string): void {
  const html = typedShellHtml(TYPE_REGISTRY.design_system, {
    title: "T",
    text,
    base: "",
    appOrigin: APP,
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

function mountPayload(raw: string): void {
  document.body.innerHTML =
    '<main id="__plinth-design_system" class="plinth-design_system" tabindex="-1"></main>' +
    `<script type="application/json" id="__plinth-content">${raw}</script>`;
}

const root = () => document.getElementById("__plinth-design_system") as HTMLElement;
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
  for (const n of document.head.querySelectorAll("link, style")) n.remove();
  document.documentElement.removeAttribute("data-ready");
});

describe("boot", () => {
  it("renders the site and sets data-ready=ok", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(root().querySelector("h1")?.textContent).toBe("Acme UI");
    const nav = [...root().querySelectorAll(".ds-nav a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(nav).toEqual([
      ["Overview", "#overview"],
      ["Colors", "#tokens/color"],
      ["Typography", "#tokens/typography"],
      ["Spacing and sizes", "#tokens/space"],
      ["Radii", "#tokens/radius"],
      ["Shadows", "#tokens/shadow"],
      ["Motion", "#tokens/motion"],
      ["Other tokens", "#tokens/other"],
      ["Button", "#components/button"],
      ["Badge", "#components/badge"],
    ]);
    // Components are listed under a heading in the navigation, not a page of their own.
    expect(root().querySelector(".ds-nav__group .ds-nav__label")?.textContent).toBe("Components");
    expect(root().querySelectorAll(".ds-nav__group a")).toHaveLength(2);
    for (const [, href] of nav) {
      expect(document.getElementById(sectionId((href ?? "").slice(1))), href ?? "").not.toBeNull();
    }
    // Guidelines go through the doc renderer's Markdown.
    expect(root().querySelector("#ds-overview .plinth-doc h1")?.textContent).toMatch(
      /^Using Acme UI/,
    );
    // The fonts: one Google Fonts stylesheet, one @font-face block.
    const links = [...document.head.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
      l.getAttribute("href"),
    );
    expect(links).toEqual([FIXTURE.fonts[0]?.google]);
    expect(document.head.querySelector("style")?.textContent).toContain('font-family:"Acme Mono"');
  });

  it("leaves the overview out when there are no guidelines", () => {
    mountShell(JSON.stringify({ ...FIXTURE, guidelines: undefined }));
    stop = boot(window);
    expect(document.getElementById(sectionId("overview"))).toBeNull();
    expect(root().querySelector(".ds-nav a")?.textContent).toBe("Colors");
  });

  it("a malformed hash neither throws nor stops navigation and printing", () => {
    const print = window.print;
    let printed = 0;
    window.print = () => {
      printed++;
    };
    try {
      window.location.hash = "#%E0%A4";
      mountShell(JSON.stringify(FIXTURE));
      stop = boot(window);
      expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
      expect(printed).toBe(1);
      const target = document.getElementById(sectionId("components/button")) as HTMLElement;
      let scrolled = 0;
      target.scrollIntoView = () => {
        scrolled++;
      };
      window.location.hash = "#components/button";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(scrolled).toBeGreaterThan(0);
    } finally {
      window.print = print;
      window.location.hash = "";
    }
  });

  it("lists color tokens with their variable, values, deprecation and an alias note", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const rows = [...root().querySelectorAll("#ds-tokens-color .ds-token")];
    expect(rows.map((r) => r.getAttribute("data-path"))).toEqual([
      "color.brand.500",
      "color.bg",
      "color.fg",
      "color.accent",
      "color.old",
    ]);
    const bg = rows[1] as HTMLElement;
    expect(bg.querySelector(".ds-token__var")?.textContent).toBe("var(--acme-color-bg)");
    expect([...bg.querySelectorAll(".ds-token__values code")].map((c) => c.textContent)).toEqual([
      "#ffffff",
      "#0d1117",
    ]);
    const samples = [...bg.querySelectorAll<HTMLElement>(".ds-sample")];
    expect(samples.map((s) => s.style.getPropertyValue("--ds-sample"))).toEqual([
      "#ffffff",
      "#0d1117",
    ]);
    expect(rows[3]?.querySelector(".ds-token__alias")?.textContent).toBe(
      "Alias of color.brand.500",
    );
    expect(rows[4]?.querySelector(".ds-token__deprecated")?.textContent).toBe("Deprecated Use fg");
  });

  it("renders each component's examples in preview frames, with its HTML and CSS behind disclosures", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const button = document.getElementById("ds-components-button") as HTMLElement;
    const frames = button.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frames[0]?.dataset.theme).toBe("light");
    const codes = [...button.querySelectorAll<HTMLDetailsElement>("details.ds-code")];
    expect(codes.map((d) => [d.querySelector("summary")?.textContent, d.open])).toEqual([
      ["HTML", false],
      ["CSS", false],
    ]);
    expect(codes[0]?.querySelector(".ds-example__code")?.textContent).toBe(
      '<button class="acme-btn acme-btn--primary">Save</button>',
    );
    // No view, theme or width switches.
    expect(button.querySelectorAll("button")).toHaveLength(0);
    const badge = document.getElementById("ds-components-badge") as HTMLElement;
    expect(badge.querySelector(".ds-badge")?.textContent).toBe("Beta");
  });

  it("shows previews in the reader's color scheme and follows a change", () => {
    let dark = true;
    const listeners: (() => void)[] = [];
    const matchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      get matches() {
        return q === "(prefers-color-scheme: dark)" && dark;
      },
      addEventListener: (_: string, f: () => void) => listeners.push(f),
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      mountShell(JSON.stringify(FIXTURE));
      stop = boot(window);
      const themes = () =>
        [...document.querySelectorAll<HTMLIFrameElement>("#ds-components-button iframe")].map(
          (f) => f.dataset.theme,
        );
      expect(themes()).toEqual(["dark"]);
      dark = false;
      for (const f of listeners) f();
      expect(themes()).toEqual(["light"]);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("copies a token's variable when its name is clicked", async () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    try {
      const name = root().querySelector<HTMLButtonElement>(
        '.ds-token[data-path="color.bg"] button.ds-token__var',
      );
      expect(name?.getAttribute("aria-label")).toBe("Copy var(--acme-color-bg)");
      name?.click();
      expect(copied).toEqual(["var(--acme-color-bg)"]);
      expect(name?.hasAttribute("data-copied")).toBe(true);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("puts every author string on the page as text", () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const text = JSON.stringify({
      ...FIXTURE,
      name: evil,
      description: evil,
      tokens: {
        ...FIXTURE.tokens,
        color: { ...FIXTURE.tokens.color, bg: { $value: "#ffffff", $description: evil } },
      },
      components: [
        {
          id: "x",
          name: evil,
          description: evil,
          usage: evil,
          examples: [{ name: evil, html: "<b>x</b>" }],
        },
      ],
    });
    mountShell(text);
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(root().querySelector("h1")?.textContent).toBe(evil);
    expect(root().querySelectorAll("img")).toHaveLength(0);
    expect(root().querySelectorAll("[onerror]")).toHaveLength(0);
    expect(root().textContent).toContain(evil);
  });

  it("shows the problems and sets data-ready=error for JSON it cannot use", () => {
    mountShell(JSON.stringify({ ...FIXTURE, format: "plinth.design-system/9" }));
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
    expect(root().querySelector(".ds-error h1")?.textContent).toBe(
      "This design system could not be shown",
    );
    expect(root().querySelector(".ds-problems li")?.textContent).toBe(
      'format must be "plinth.design-system/1"',
    );
  });

  it("refuses a payload for another type or that is not JSON", () => {
    mountPayload(
      jsonForScript({ v: 1, type: "doc", path: "content.md", app_origin: APP, text: "{}" }),
    );
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
    mountPayload("{ nope");
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
  });
});

describe("groupOf", () => {
  it("puts dimensions named for corners on the radius page", () => {
    const t = (path: string, type: string) => ({ path, type }) as Parameters<typeof groupOf>[0];
    expect(groupOf(t("radius.md", "dimension"))).toBe("radius");
    expect(groupOf(t("space.2", "dimension"))).toBe("space");
    expect(groupOf(t("font.mono", "fontFamily"))).toBe("type");
    expect(groupOf(t("line", "border"))).toBe("other");
  });
});
