// The design system renderer's entry and site: it boots from the JSON block the shell embeds,
// renders every section, shows one short line for JSON it cannot use, and puts every author
// string on the page as text.
import { jsonForScript, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // Guidelines go through the doc renderer's Markdown, right under the header: the overview has
    // no heading of its own over theirs.
    const overview = document.getElementById(sectionId("overview"));
    expect(overview?.getAttribute("aria-label")).toBe("Overview");
    expect(overview?.firstElementChild?.classList.contains("plinth-doc")).toBe(true);
    expect(overview?.querySelector(":scope > h2")).toBeNull();
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
    // A pair sits on each theme's ground; a token that is the same in both, on the reader's.
    expect(samples.map((s) => s.getAttribute("data-theme"))).toEqual(["light", "dark"]);
    const brand = rows[0]?.querySelectorAll(".ds-sample") ?? [];
    expect(brand).toHaveLength(1);
    expect(brand[0]?.hasAttribute("data-theme")).toBe(false);
  });

  it("keeps the token tables' column headings for screen readers only", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const head = root().querySelector("#ds-tokens-color thead");
    expect(head?.className).toBe("ds-visually-hidden");
    expect([...(head?.querySelectorAll("th[scope=col]") ?? [])].map((t) => t.textContent)).toEqual([
      "Sample",
      "Token",
    ]);
    // The value shares a line with the variable, in the token's cell.
    const bg = root().querySelector('.ds-token[data-path="color.bg"]');
    expect(bg?.querySelectorAll("td")).toHaveLength(2);
    expect(bg?.querySelector(".ds-token__line .ds-token__values")).not.toBeNull();
  });

  it("labels light and dark samples once, only in a group that has a pair", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const themes = root().querySelectorAll("#ds-tokens-color .ds-themes");
    expect(themes).toHaveLength(1);
    expect(themes[0]?.getAttribute("aria-hidden")).toBe("true");
    expect([...(themes[0]?.children ?? [])].map((s) => s.textContent)).toEqual(["Light", "Dark"]);
    expect(root().querySelector("#ds-tokens-space .ds-themes")).toBeNull();
  });

  it("shows a type specimen in a block that can end in an ellipsis", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const specimen = root().querySelector('.ds-token[data-path="font.body"] .ds-sample--type');
    expect(specimen?.hasAttribute("data-theme")).toBe(false);
    expect(specimen?.children).toHaveLength(1);
    expect(specimen?.firstElementChild?.className).toBe("ds-sample__text");
  });

  it("marks the navigation link of the section in view", () => {
    type Report = (entries: { target: Element; isIntersecting: boolean }[]) => void;
    const seen: Element[] = [];
    const observer: { report: Report } = { report: () => undefined };
    const report: Report = (entries) => observer.report(entries);
    const original = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(cb: Report) {
        observer.report = cb;
      }
      observe(el: Element) {
        seen.push(el);
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      mountShell(JSON.stringify(FIXTURE));
      stop = boot(window);
      const current = () =>
        [...root().querySelectorAll(".ds-nav a[aria-current]")].map((a) => a.textContent);
      expect(seen.map((s) => s.getAttribute("data-hash"))).toContain("components/button");
      const at = (hash: string) => seen.find((s) => s.getAttribute("data-hash") === hash);
      report([{ target: at("overview") as Element, isIntersecting: true }]);
      expect(current()).toEqual(["Overview"]);
      report([
        { target: at("overview") as Element, isIntersecting: false },
        { target: at("components/button") as Element, isIntersecting: true },
      ]);
      expect(current()).toEqual(["Button"]);
    } finally {
      window.IntersectionObserver = original;
    }
  });

  it("renders each component's description, usage, then its examples in preview frames, with no source code", () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const button = document.getElementById("ds-components-button") as HTMLElement;
    const frames = button.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frames[0]?.dataset.theme).toBe("light");
    // People never see source code: agents read the HTML and CSS with get_design_system.
    expect(button.querySelectorAll("details, pre, code")).toHaveLength(0);
    expect(button.textContent).not.toContain("acme-btn");
    // Reading order: heading, description, usage, then the examples.
    expect(
      [...button.children].map(
        (c) => c.tagName.toLowerCase() + (c.className ? `.${c.className.split(" ").pop()}` : ""),
      ),
    ).toEqual(["h2", "div.ds-prose", "h3", "div.ds-prose", "figure.ds-example"]);
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
      await vi.waitFor(() => expect(name?.hasAttribute("data-copied")).toBe(true));
      expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("copies through the selection when the frame may not use the clipboard, and clears it", async () => {
    mountShell(JSON.stringify(FIXTURE));
    stop = boot(window);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("blocked by permissions policy")) },
    });
    const execCommand = document.execCommand;
    const selected: string[] = [];
    let works = true;
    document.execCommand = ((cmd: string) => {
      selected.push(`${cmd}:${window.getSelection()?.toString()}`);
      return works;
    }) as typeof document.execCommand;
    try {
      const name = root().querySelector<HTMLButtonElement>(
        '.ds-token[data-path="color.bg"] button.ds-token__var',
      );
      name?.click();
      await vi.waitFor(() => expect(name?.hasAttribute("data-copied")).toBe(true));
      expect(selected).toEqual(["copy:var(--acme-color-bg)"]);
      expect(window.getSelection()?.toString()).toBe("");

      // When the browser refuses that too, the text stays selected for the reader, and nothing
      // says "Copied".
      const fg = root().querySelector<HTMLButtonElement>(
        '.ds-token[data-path="color.fg"] button.ds-token__var',
      );
      works = false;
      fg?.click();
      await vi.waitFor(() => expect(selected).toHaveLength(2));
      expect(window.getSelection()?.toString()).toBe("var(--acme-color-fg)");
      expect(fg?.hasAttribute("data-copied")).toBe(false);
    } finally {
      document.execCommand = execCommand;
      window.getSelection()?.removeAllRanges();
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

  it("lists the problems an agent needs to fix, names no editor, and sets data-ready=error", () => {
    mountShell(JSON.stringify({ ...FIXTURE, format: "plinth.design-system/9" }));
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
    const error = root().querySelector(".ds-error");
    expect(error?.querySelector("p")?.textContent).toBe(
      "This design system has problems an agent needs to fix:",
    );
    expect([...root().querySelectorAll(".ds-error__list li")].map((l) => l.textContent)).toEqual([
      'format must be "plinth.design-system/1"',
    ]);
    expect(root().textContent).not.toMatch(/editor/i);
    expect(root().querySelectorAll("h1")).toHaveLength(0);
    // Without the room's draft (not an owner or editor here), there is nothing to ask from the page.
    expect(root().querySelector("button")).toBeNull();
  });

  it("offers Ask an agent on the error page to the owner and editors, posting `ask`", () => {
    const text = JSON.stringify({ ...FIXTURE, format: "plinth.design-system/9" });
    const html = typedShellHtml(TYPE_REGISTRY.design_system, {
      title: "T",
      text,
      base: "",
      appOrigin: APP,
      live: "room",
    });
    const main = /<main [^>]*><\/main>/.exec(html)?.[0] ?? "";
    const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] ?? "";
    document.body.innerHTML = main + data;
    const posted: unknown[] = [];
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation((m: unknown) => {
      posted.push(m);
    });
    // No socket in the test: the room client's first connection fails and stays quiet.
    const ws = vi.spyOn(window, "WebSocket").mockImplementation((() => {
      throw new Error("no sockets here");
    }) as never);
    try {
      stop = boot(window);
      const ask = [...root().querySelectorAll("button")].find(
        (b) => b.textContent === "Ask an agent",
      );
      expect(ask).toBeTruthy();
      ask?.click();
      expect(posted).toContainEqual(
        expect.objectContaining({
          type: "ask",
          anchor: { key: "system:problems", text: "Problems" },
        }),
      );
    } finally {
      spy.mockRestore();
      ws.mockRestore();
    }
  });

  it("tells the app an invalid system is not edited on the page, and stays as it is", async () => {
    const KEY = "K".repeat(43);
    mountShell(JSON.stringify({ ...FIXTURE, format: "plinth.design-system/9" }));
    const posted: Record<string, unknown>[] = [];
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation((m: unknown) => {
      posted.push(m as Record<string, unknown>);
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    try {
      // A viewer's frame has no key: it tells the app nothing.
      stop = boot(window);
      await flush();
      expect(posted.filter((m) => m.type === "live")).toHaveLength(0);
      stop();
      // An owner's or editor's frame (the app put its key in the address) says why.
      window.location.hash = `#plinth-k=${KEY}`;
      stop = boot(window);
      await flush();
      const live = posted.filter((m) => m.type === "live");
      expect(live.at(-1)).toMatchObject({ key: KEY, editing: false, unavailable: "invalid" });
      // Edit mode asked for anyway: nothing changes on the page.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "plinth-renderer", v: 1, type: "edit", on: true },
          origin: APP,
          source: window.parent as never,
        }),
      );
      await flush();
      expect(posted.filter((m) => m.type === "live").at(-1)).toMatchObject({
        editing: false,
        unavailable: "invalid",
      });
      expect(root().querySelector(".ds-error")).toBeTruthy();
    } finally {
      spy.mockRestore();
      window.location.hash = "";
    }
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
