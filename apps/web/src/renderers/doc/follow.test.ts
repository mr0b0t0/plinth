// Live views in the doc renderer: a newer version shown in place keeps the reader's place, is
// fetched from the frame's own origin, answers the app only at the app origin, is refused while
// anything is edited, and becomes the text solo editing starts from.
import { RENDERER_MESSAGE_SOURCE, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { readingPlace, restorePlace, showVersion } from "./follow.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

const APP = "https://plinth.example.com";
const NONCE = "nonce-0123456789abcdef";
const base = { source: RENDERER_MESSAGE_SOURCE, v: 1 };

function mountShell(text: string): void {
  const html = typedShellHtml(TYPE_REGISTRY.doc, { title: "T", text, base: "", appOrigin: APP });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

/** The shell with its doc rendered, as boot leaves it. */
function mountRendered(text: string): void {
  mountShell(text);
  root().replaceChildren(sanitizeHtml(renderMarkdown(text), document));
}

/** A heading's own text, without its anchor link. */
const h1 = () => root().querySelector("h1")?.firstChild?.textContent;

function root(): HTMLElement {
  const el = document.getElementById("__plinth-doc");
  if (!el) throw new Error("no root");
  return el;
}

/** Give each top-level block a top, relative to the viewport, from `tops` (by index). */
function layout(tops: (el: Element, i: number) => number): void {
  Array.from(root().children).forEach((el, i) => {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ top: tops(el, i), bottom: tops(el, i) + 20 }) as DOMRect;
  });
}

let scrollBy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollBy = vi.fn();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the reader's place", () => {
  it("is the first block at or below the viewport top, by its heading", () => {
    mountRendered("# Top\n\nintro\n\n## Middle\n\none\n\ntwo\n\n## End\n\nlast");
    expect(root().children[2]?.id).toBe("middle");
    // h1, p, h2#middle, p, p, h2#end, p: the viewport top sits inside "one".
    layout((_, i) => [-400, -300, -120, -10, 30, 80, 120][i] ?? 0);
    const place = readingPlace(window, root());
    expect(place).toEqual({ heading: "middle", skip: 2, offset: 30 });
    // After the re-render "Middle" gained a paragraph: the same block (two after it) is found,
    // and the window scrolls so it is where it was.
    layout((_, i) => [-400, -300, -120, -40, 60, 190][i] ?? 0);
    restorePlace(window, root(), place as NonNullable<typeof place>);
    expect(scrollBy).toHaveBeenCalledWith(0, 30);
  });

  it("is nothing to keep at the top of the page", () => {
    mountRendered("# Top\n\nintro");
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    expect(readingPlace(window, root())).toBeNull();
  });
});

describe("showVersion", () => {
  it("fetches the version's Markdown from its own origin and renders it, keeping the place", async () => {
    mountRendered("# One\n\nfirst");
    const fetch = vi.fn(async () => new Response("# Two\n\nsecond", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    layout((_, i) => [10, 40][i] ?? 0);
    const text = await showVersion(window, root(), 2, "content.md");
    expect(text).toBe("# Two\n\nsecond");
    expect(fetch).toHaveBeenCalledWith("/__plinth/v/2/content.md", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(h1()).toBe("Two");
    expect(root().textContent).toContain("second");
  });

  it("renders through the sanitizer, as at boot", async () => {
    mountRendered("# One");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response('# Two\n\n<img src=x onerror="alert(1)"><script>x()</script>'),
      ),
    );
    expect(await showVersion(window, root(), 2, "content.md")).not.toBeNull();
    expect(root().querySelector("script")).toBeNull();
    expect(root().querySelector("[onerror]")).toBeNull();
  });

  it("shows nothing new when the request fails or is refused, or the file name is odd", async () => {
    mountRendered("# One");
    for (const reply of [
      async () => new Response("Your access expired", { status: 401 }),
      async () => new Response("No such version", { status: 404 }),
      async () => {
        throw new TypeError("offline");
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn(reply));
      expect(await showVersion(window, root(), 2, "content.md")).toBeNull();
      expect(h1()).toBe("One");
    }
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await showVersion(window, root(), 2, "../x")).toBeNull();
    expect(await showVersion(window, root(), 0, "content.md")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("boot: version messages from the app", () => {
  let stop: (() => void) | undefined;
  let toApp: { mock: { calls: unknown[][] }; mockRestore: () => void };

  function post(data: unknown, origin = APP): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: window.parent }));
  }

  const answers = (type: string) =>
    toApp.mock.calls
      .filter((c: unknown[]) => (c[0] as Record<string, unknown>)?.type === type)
      .map((c: unknown[]) => {
        expect(c[1]).toBe(APP);
        return c[0] as Record<string, unknown>;
      });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    toApp = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    toApp.mockRestore();
  });

  it("shows the version in place and answers shown, only for the app origin and a valid message", async () => {
    mountShell("# One");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# Two")),
    );
    stop = boot(window);
    post({ ...base, type: "version", n: 2, nonce: NONCE }, "https://evil.example");
    post({ ...base, type: "version", n: 0, nonce: NONCE });
    post({ ...base, type: "version", n: 2, nonce: "short" });
    await settle();
    expect(answers("shown")).toEqual([]);
    expect(h1()).toBe("One");

    post({ ...base, type: "version", n: 2, nonce: NONCE });
    await settle();
    expect(answers("shown")).toEqual([{ ...base, type: "shown", n: 2, nonce: NONCE, ok: true }]);
    expect(h1()).toBe("Two");
  });

  it("answers ok: false when the version cannot be fetched", async () => {
    mountShell("# One");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    stop = boot(window);
    post({ ...base, type: "version", n: 2, nonce: NONCE });
    await settle();
    expect(answers("shown")).toEqual([{ ...base, type: "shown", n: 2, nonce: NONCE, ok: false }]);
    expect(h1()).toBe("One");
  });

  it("is refused while editing, and solo editing afterwards starts from the version on screen", async () => {
    mountShell("one");
    const fetch = vi.fn(async () => new Response("two"));
    vi.stubGlobal("fetch", fetch);
    stop = boot(window);
    post({ ...base, type: "edit", on: true });
    await settle();
    post({ ...base, type: "version", n: 2, nonce: NONCE });
    await settle();
    expect(answers("shown")).toEqual([{ ...base, type: "shown", n: 2, nonce: NONCE, ok: false }]);
    expect(fetch).not.toHaveBeenCalled();

    // Done editing, nothing changed: the next version shows in place, and editing starts from it.
    post({ ...base, type: "edit", on: false });
    await settle();
    const next = "nonce-fedcba9876543210";
    post({ ...base, type: "version", n: 2, nonce: next });
    await settle();
    expect(answers("shown").at(-1)).toEqual({
      ...base,
      type: "shown",
      n: 2,
      nonce: next,
      ok: true,
    });
    expect(root().textContent).toContain("two");
    post({ ...base, type: "edit", on: true });
    await settle();
    post({ ...base, type: "collect", nonce: NONCE });
    expect(answers("draft").at(-1)).toEqual({ ...base, type: "draft", nonce: NONCE, text: "two" });
  });
});
