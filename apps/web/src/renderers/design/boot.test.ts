// The design renderer, booted from a real shell's payload in a modelled frame: the canvas and its
// board frames (sandbox, loader, the ready/render handshake), virtualization, interact mode, the
// review mode that keeps covers on, printing, and the version a board's files come from. Board
// frames are modelled too: each gets its own window that records what the shell posts to it.
import {
  BOARD_IFRAME_SANDBOX,
  BOARD_MESSAGE_SOURCE,
  BOARD_PROTOCOL_VERSION,
  DESIGN_EXPORT_LAYOUT_SCRIPT,
  designExportKeepOnlyScript,
  designExportLoadedScript,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, type DesignHandle, FALLBACK } from "./boot.ts";
import { readBoardMessage } from "./frames.ts";
import { PRINT_STYLE_ID, printCss, resetPrint } from "./print.ts";

const APP = "https://plinth.example.com";
const ORIGIN = "https://abcdefghij0123456789.content.example";
const DESIGN = [
  '<link rel="stylesheet" href="brand.css">',
  '<script>document.documentElement.dataset.shared = "1"</script>',
  '<!-- artboard id="home" name="Home &lt;img src=x onerror=window.__pwned=1&gt;" size="iphone" section="Mobile" -->',
  '<main><h1 id="frag">Ship</h1><script>window.__pwned = 1</script></main>',
  '<!-- artboard id="post" name="Launch post" size="instagram-post" background="#0b0b0f" -->',
  "<div>Now live</div>",
  '<!-- artboard id="mrec" name="Ad" width="300" height="250" section="Ads" -->',
  "<a href='https://example.com'>Try</a>",
].join("\n");

/** A shell as the content host serves it: `version` is the one it shows (null: none). */
function mount(text = DESIGN, version: number | null = 2) {
  const html = typedShellHtml(TYPE_REGISTRY.design, {
    title: "T",
    text,
    base: "",
    appOrigin: APP,
    ...(version !== null ? { version } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

interface BoardWin {
  postMessage: ReturnType<typeof vi.fn>;
}

interface Framed {
  win: Window;
  target: EventTarget;
  parent: { postMessage: ReturnType<typeof vi.fn> };
  print: ReturnType<typeof vi.fn>;
  frames: Map<HTMLIFrameElement, BoardWin>;
  created: HTMLIFrameElement[];
  scrolls: number;
}

function framed(search = "", path = "/"): Framed {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const print = vi.fn();
  const frames = new Map<HTMLIFrameElement, BoardWin>();
  const created: HTMLIFrameElement[] = [];
  const f: Framed = {
    win: null as unknown as Window,
    target,
    parent,
    print,
    frames,
    created,
    scrolls: 0,
  };
  target.addEventListener("scroll", () => {
    f.scrolls++;
  });
  f.win = {
    document,
    parent,
    print,
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: `${ORIGIN}${path}${search}`, search },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as Window;
  return f;
}

/** The shell as the top-level document, as Plinth's capture and export browsers open it. */
function topLevel(search = "", path = "/"): Framed {
  const f = framed(search, path);
  (f.win as unknown as { parent: Window }).parent = f.win;
  return f;
}

function start(
  f: Framed,
  opts: { maxLive?: number; matchMedia?: (q: string) => boolean } = {},
): DesignHandle {
  return boot(f.win, {
    schedule: (fn) => fn(),
    location: f.win.location as unknown as { href: string; search: string },
    ...opts,
    createFrame: (doc) => {
      const el = doc.createElement("iframe");
      const w: BoardWin = { postMessage: vi.fn() };
      Object.defineProperty(el, "contentWindow", { configurable: true, get: () => w });
      // Never load anything in the test DOM: keep the URL where the test can read it.
      // happy-dom loads a connected iframe's src (and logs that it may not): an empty srcdoc
      // keeps it from trying, and src reads empty.
      el.setAttribute("srcdoc", "");
      Object.defineProperty(el, "src", {
        configurable: true,
        get: () => "",
        set: (v: string) => el.setAttribute("data-src", v),
      });
      f.frames.set(el, w);
      f.created.push(el);
      return el;
    },
  });
}

const boardMsg = (type: string) => ({
  source: BOARD_MESSAGE_SOURCE,
  v: BOARD_PROTOCOL_VERSION,
  type,
});
const fromWindow = (f: Framed, source: unknown, data: unknown, origin = "null") =>
  f.target.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
const frameFor = (id: string) =>
  document.querySelector<HTMLIFrameElement>(`.plinth-design__board[data-board="${id}"] iframe`);
const winOf = (f: Framed, id: string) => {
  const el = frameFor(id);
  const w = el ? f.frames.get(el) : undefined;
  if (!w) throw new Error(`no frame for ${id}`);
  return w;
};
const cover = (id: string) => document.getElementById(`__plinth-board-${id}`) as HTMLElement;
const canvas = () => document.querySelector(".plinth-design__canvas") as HTMLElement;
const html = () => document.documentElement;

let handle: DesignHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  document.body.innerHTML = "";
  document.getElementById(PRINT_STYLE_ID)?.remove();
  for (const a of ["data-ready", "data-boards", "data-boards-loaded", "data-zoom", "data-export"]) {
    html().removeAttribute(a);
  }
  resetPrint();
});

describe("boot", () => {
  it("shows the fallback for a payload that is not a design", () => {
    mount("<p>no boards here</p>");
    handle = start(framed());
    expect(html().getAttribute("data-ready")).toBe("error");
    expect(document.querySelector(".plinth-design__error")?.textContent).toBe(FALLBACK);
  });

  it("lays out every board under a cover, with names as text and no author markup", () => {
    mount();
    const f = framed();
    handle = start(f);
    expect(html().getAttribute("data-ready")).toBe("ok");
    expect(html().getAttribute("data-boards")).toBe("3");
    expect(document.querySelectorAll(".plinth-design__board")).toHaveLength(3);
    for (const id of ["home", "post", "mrec"]) expect(cover(id)).not.toBeNull();
    const label = document.querySelector('.plinth-design__label[data-board="home"]');
    expect(label?.querySelector(".plinth-design__label-name")?.textContent).toBe(
      "Home <img src=x onerror=window.__pwned=1>",
    );
    // The label is the name and Interact: no size, no section headings, no Boards list.
    expect(label?.textContent).toBe("Home <img src=x onerror=window.__pwned=1>Interact");
    // Nothing of the fragments or the shared section is in the shell's DOM.
    expect(document.getElementById("frag")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.body.querySelectorAll("script:not([type])")).toHaveLength(0);
    expect(html().dataset.shared).toBeUndefined();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.querySelectorAll("h2, [role=menu]")).toHaveLength(0);
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".plinth-design__toolbar button"),
        (b) => (b.hidden ? null : b.getAttribute("aria-label")),
      ).filter((l) => l !== null),
    ).toEqual(["Zoom out", "Zoom to 100%", "Zoom in", "Fit all boards"]);
  });

  it("mounts each board in an opaque sandboxed frame at the loader, its size and name", () => {
    mount();
    handle = start(framed("", "/__plinth/v/2/"));
    const frame = frameFor("post");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe(BOARD_IFRAME_SANDBOX);
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("data-src")).toBe(`${ORIGIN}/__plinth/frames/design/board.html`);
    expect(frame?.getAttribute("width")).toBe("1080");
    expect(frame?.getAttribute("height")).toBe("1080");
    expect(frame?.title).toBe("Launch post");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.tabIndex).toBe(-1);
  });

  it("posts a board its own document once, only after ready from that frame's window", () => {
    mount();
    const f = framed("", "/__plinth/v/2/");
    handle = start(f);
    const post = winOf(f, "post");
    const home = winOf(f, "home");
    // Not before ready; never for another window's ready or a malformed one.
    expect(post.postMessage).not.toHaveBeenCalled();
    fromWindow(f, { postMessage: vi.fn() }, boardMsg("ready"));
    fromWindow(f, post, { source: BOARD_MESSAGE_SOURCE, v: 2, type: "ready" });
    fromWindow(f, post, { source: "plinth-renderer", v: 1, type: "ready" });
    fromWindow(f, post, "ready");
    expect(post.postMessage).not.toHaveBeenCalled();
    fromWindow(f, post, boardMsg("ready"));
    expect(post.postMessage).toHaveBeenCalledTimes(1);
    const [msg, target] = post.postMessage.mock.calls[0] ?? [];
    expect(target).toBe("*");
    expect(msg).toMatchObject({ source: BOARD_MESSAGE_SOURCE, v: 1, type: "render" });
    expect(msg.html).toContain(`<base href="${ORIGIN}/__plinth/v/2/">`);
    expect(msg.html).toContain('<meta name="viewport" content="width=1080, initial-scale=1">');
    expect(msg.html).toContain("background:#0b0b0f");
    expect(msg.html).toContain('<link rel="stylesheet" href="brand.css">');
    expect(msg.html).toContain("<div>Now live</div>");
    expect(msg.html).not.toContain("Ship");
    // A second ready from the same frame is ignored.
    fromWindow(f, post, boardMsg("ready"));
    expect(post.postMessage).toHaveBeenCalledTimes(1);
    expect(home.postMessage).not.toHaveBeenCalled();
    // loaded counts only after render, once.
    fromWindow(f, home, boardMsg("loaded"));
    expect(html().getAttribute("data-boards-loaded")).toBe("0");
    fromWindow(f, post, boardMsg("loaded"));
    fromWindow(f, post, boardMsg("loaded"));
    expect(html().getAttribute("data-boards-loaded")).toBe("1");
    expect(readBoardMessage(boardMsg("render"))).toBeNull();
  });

  it("keeps at most the live-frame limit while panning a 60-board design, each mount a new element", () => {
    const text = Array.from(
      { length: 60 },
      (_, i) => `<!-- artboard id="b${i}" name="B${i}" size="1000x1000" -->\n<p>${i}</p>`,
    ).join("\n");
    mount(text);
    const f = framed();
    handle = start(f);
    const view = handle.view;
    if (!view || !handle.frames) throw new Error("no canvas");
    const live = () => document.querySelectorAll(".plinth-design__board iframe").length;
    expect(live()).toBeLessThanOrEqual(24);
    let max = live();
    view.zoomTo(1);
    for (let i = 0; i < 40; i++) {
      view.pan(-900, i % 7 === 0 ? -900 : 0);
      max = Math.max(max, live());
    }
    expect(max).toBeLessThanOrEqual(24);
    expect(handle.frames.liveCount()).toBe(live());
    // Remounting a board that left the screen makes a new element.
    const first = f.created[0];
    const id = first?.closest<HTMLElement>(".plinth-design__board")?.dataset.board ?? "";
    view.set({ x: 0, y: 0, scale: 1 });
    const again = frameFor(id);
    if (first && !first.isConnected) expect(again).not.toBe(first);
    expect(f.scrolls).toBeGreaterThan(0);
  });

  it("dispatches a scroll on the window after each transform, and zooms from the toolbar", () => {
    mount();
    const f = framed();
    handle = start(f);
    const before = f.scrolls;
    (document.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click();
    expect(f.scrolls).toBe(before + 1);
    const z1 = Number(html().getAttribute("data-zoom"));
    (document.querySelector('[aria-label="Zoom out"]') as HTMLButtonElement).click();
    expect(Number(html().getAttribute("data-zoom"))).toBeLessThan(z1);
    (document.querySelector('[aria-label="Zoom to 100%"]') as HTMLButtonElement).click();
    expect(html().getAttribute("data-zoom")).toBe("100");
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    expect(html().getAttribute("data-zoom")).toBe("125");
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    expect(Number(html().getAttribute("data-zoom"))).toBeLessThan(100);
  });

  it("refits on resize after the 0 key, as after the Fit button, and not after a zoom", () => {
    mount();
    const f = framed();
    handle = start(f);
    const zoom = () => Number(html().getAttribute("data-zoom"));
    // The canvas has no layout size in the test DOM, so the viewport is the window's.
    const resize = (width: number, height: number) => {
      Object.assign(f.win, { innerWidth: width, innerHeight: height });
      f.target.dispatchEvent(new Event("resize"));
    };
    const wide = zoom();
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    expect(zoom()).toBe(wide);
    resize(400, 300);
    const small = zoom();
    expect(small).toBeLessThan(wide);
    (document.querySelector('[aria-label="Fit all boards"]') as HTMLButtonElement).click();
    resize(1280, 800);
    expect(zoom()).toBe(wide);
    // A zoom by key leaves the view where the person put it.
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true }));
    const zoomed = zoom();
    resize(400, 300);
    expect(zoom()).toBe(zoomed);
  });
});

describe("interact mode", () => {
  const labelOf = (id: string) =>
    document.querySelector(`.plinth-design__label[data-board="${id}"]`) as HTMLElement;
  const interactWith = (id: string) =>
    (labelOf(id).querySelector(".plinth-design__label-interact") as HTMLButtonElement).click();

  it("marks the board zoomed to by its name as the one offering Interact, until Fit", () => {
    mount();
    handle = start(framed());
    expect(document.querySelectorAll(".plinth-design__label[data-active]")).toHaveLength(0);
    (labelOf("post").querySelector(".plinth-design__label-name") as HTMLButtonElement).click();
    expect(labelOf("post").hasAttribute("data-active")).toBe(true);
    (labelOf("home").querySelector(".plinth-design__label-name") as HTMLButtonElement).click();
    expect(labelOf("post").hasAttribute("data-active")).toBe(false);
    expect(labelOf("home").hasAttribute("data-active")).toBe(true);
    (
      document.querySelector('.plinth-design__btn[aria-label="Fit all boards"]') as HTMLElement
    ).click();
    expect(document.querySelectorAll(".plinth-design__label[data-active]")).toHaveLength(0);
  });

  it("takes the cover off one board only, and Done or a background click puts it back", () => {
    mount();
    const f = framed();
    handle = start(f);
    const interact = document.querySelector(
      '.plinth-design__label[data-board="post"] .plinth-design__label-interact',
    ) as HTMLButtonElement;
    interact.click();
    expect(cover("post").hidden).toBe(true);
    expect(cover("home").hidden).toBe(false);
    expect(frameFor("post")?.tabIndex).toBe(0);
    // One control for the state: the board's label drops Interact, and the toolbar holds only
    // Done in place of the zoom controls.
    expect(labelOf("post").hasAttribute("data-interacting")).toBe(true);
    const bar = document.querySelector(".plinth-design__toolbar") as HTMLElement;
    const shown = () =>
      Array.from(bar.querySelectorAll("button"))
        .filter((b) => !b.hidden)
        .map((b) => b.getAttribute("aria-label"));
    expect(shown()).toEqual(["Done interacting"]);
    expect(document.querySelectorAll(".plinth-design__done")).toHaveLength(1);
    const done = bar.querySelector(".plinth-design__done") as HTMLButtonElement;
    done.click();
    expect(cover("post").hidden).toBe(false);
    expect(done.hidden).toBe(true);
    expect(labelOf("post").hasAttribute("data-interacting")).toBe(false);
    expect(shown()).toEqual(["Zoom out", "Zoom to 100%", "Zoom in", "Fit all boards"]);

    // A double click is not a way in: Interact is.
    cover("home").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cover("home").hidden).toBe(false);
    interactWith("home");
    expect(cover("home").hidden).toBe(true);
    canvas().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
      }),
    );
    canvas().dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
      }),
    );
    expect(cover("home").hidden).toBe(false);

    interactWith("mrec");
    expect(cover("mrec").hidden).toBe(true);
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cover("mrec").hidden).toBe(false);
  });

  it("never takes a cover off in review mode, where the bridge picks on covers", () => {
    mount();
    const f = framed("?plinth-review=1");
    handle = start(f);
    expect(document.querySelector(".plinth-design__label-interact")).toBeNull();
    cover("home").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cover("home").hidden).toBe(false);
    expect(document.getElementById("__plinth-design")?.hasAttribute("data-review")).toBe(true);
  });
});

describe("printing", () => {
  const printMsg = { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "print" };

  it("prints once every board has loaded, one named page per size, then restores", async () => {
    mount();
    const f = framed();
    handle = start(f, { maxLive: 1 });
    expect(document.querySelectorAll(".plinth-design__board iframe")).toHaveLength(1);
    // From another window, or the parent at another origin: ignored.
    f.target.dispatchEvent(
      new MessageEvent("message", { data: printMsg, origin: APP, source: window }),
    );
    f.target.dispatchEvent(
      new MessageEvent("message", {
        data: printMsg,
        origin: "https://evil.example",
        source: f.parent as unknown as Window,
      }),
    );
    expect(document.getElementById("__plinth-design")?.hasAttribute("data-print")).toBe(false);
    f.target.dispatchEvent(
      new MessageEvent("message", {
        data: printMsg,
        origin: APP,
        source: f.parent as unknown as Window,
      }),
    );
    const root = document.getElementById("__plinth-design") as HTMLElement;
    expect(root.hasAttribute("data-print")).toBe(true);
    // Every board is mounted for print, whatever the limit.
    expect(document.querySelectorAll(".plinth-design__board iframe")).toHaveLength(3);
    expect(f.print).not.toHaveBeenCalled();
    for (const id of ["home", "post", "mrec"]) {
      const w = winOf(f, id);
      fromWindow(f, w, boardMsg("ready"));
      fromWindow(f, w, boardMsg("loaded"));
    }
    await vi.waitFor(() => expect(f.print).toHaveBeenCalledTimes(1));
    const css = document.getElementById(PRINT_STYLE_ID)?.textContent ?? "";
    expect(css).toContain("@page s393x852 { size: 393px 852px; margin: 0; }");
    expect(css).toContain("@page s1080x1080 { size: 1080px 1080px; margin: 0; }");
    expect(css).toContain(
      '.plinth-design__board[data-size="s300x250"] { page: s300x250; break-after: page; }',
    );
    f.target.dispatchEvent(new Event("afterprint"));
    expect(root.hasAttribute("data-print")).toBe(false);
  });

  it("builds one page rule per distinct size", () => {
    const css = printCss([
      { width: 300, height: 250 },
      { width: 300, height: 250 },
      { width: 1080, height: 1080 },
    ]);
    expect(css.match(/@page/g)).toHaveLength(2);
  });
});

describe("where a board's files come from", () => {
  const baseOf = (f: Framed, id: string) => {
    const w = winOf(f, id);
    fromWindow(f, w, boardMsg("ready"));
    const msg = w.postMessage.mock.calls[0]?.[0] as { html: string } | undefined;
    return /<base href="([^"]*)">/.exec(msg?.html ?? "")?.[1];
  };

  it("pins boards to the shown version at the artifact root, not the current one", () => {
    // v1 opened at /: the root serves whatever is current when a board mounts, so the base is
    // v1's own path, and a board that mounts after v2 is published still loads v1's files.
    mount(DESIGN, 1);
    const f = framed("", "/");
    handle = start(f);
    expect(baseOf(f, "post")).toBe(`${ORIGIN}/__plinth/v/1/`);
  });

  it("keeps the pinned version when a board falls out of the live frames and comes back", () => {
    mount(DESIGN, 1);
    const f = framed("", "/");
    handle = start(f, { maxLive: 1 });
    const frames = handle.frames;
    if (!frames) throw new Error("no frames");
    frames.show(["post"]);
    const first = frameFor("post");
    expect(first).not.toBeNull();
    frames.show(["home"]);
    expect(frameFor("post")).toBeNull();
    frames.show(["post"]);
    const again = frameFor("post");
    expect(again).not.toBeNull();
    expect(again).not.toBe(first);
    expect(baseOf(f, "post")).toBe(`${ORIGIN}/__plinth/v/1/`);
  });

  it("keeps the artifact's path prefix under the path fallback", () => {
    const id = "abcdefghij0123456789";
    mount(DESIGN, 3);
    const f = framed("", `/__content/${id}/`);
    handle = start(f);
    expect(baseOf(f, "post")).toBe(`${ORIGIN}/__content/${id}/__plinth/v/3/`);
  });

  it.each([
    ["no version", null],
    ["version 0", 0],
    ["a negative version", -1],
    ["a fraction", 1.5],
    ["ten digits", 1_000_000_000],
  ])("mounts no board and shows the error for %s", (_label, version) => {
    mount(DESIGN, version);
    const f = framed("", "/");
    handle = start(f);
    expect(html().getAttribute("data-ready")).toBe("error");
    expect(document.body.textContent).toContain(FALLBACK);
    expect(f.created).toHaveLength(0);
  });

  it("refuses a version that is not a number", () => {
    mount(DESIGN, 1);
    const data = document.getElementById("__plinth-content");
    if (!data) throw new Error("no payload");
    data.textContent = JSON.stringify({ ...JSON.parse(data.textContent ?? "{}"), version: "1" });
    const f = framed("", "/");
    handle = start(f);
    expect(html().getAttribute("data-ready")).toBe("error");
    expect(f.created).toHaveLength(0);
  });

  it("has no single-board view: ?plinth-board=<id> still shows the canvas", () => {
    mount();
    handle = start(framed("?plinth-board=post"));
    expect(document.getElementById("__plinth-design")?.getAttribute("data-mode")).toBe("canvas");
    expect(document.querySelectorAll(".plinth-design__board")).toHaveLength(3);
    expect(cover("post")).not.toBeNull();
  });
});

describe("the export layout (the server's PNG and PDF)", () => {
  const root = () => document.getElementById("__plinth-design") as HTMLElement;
  const print = (q: string) => q === "print";
  /** Evaluate one of the export browser's page expressions here, as its browser would. */
  const evaluate = (expression: string): unknown => new Function(`return ${expression}`)();

  it("mounts every board at 100% with one named page per size, and never prints itself", () => {
    mount();
    const f = topLevel("", "/__plinth/v/2/");
    handle = start(f, { maxLive: 1, matchMedia: print });
    expect(root().getAttribute("data-mode")).toBe("export");
    expect(root().hasAttribute("data-print")).toBe(true);
    expect(html().hasAttribute("data-export")).toBe(true);
    expect(evaluate(DESIGN_EXPORT_LAYOUT_SCRIPT)).toBe(true);
    expect(html().getAttribute("data-ready")).toBe("ok");
    expect(html().getAttribute("data-boards")).toBe("3");
    // No canvas, chrome or covers: only the boards, in source order.
    expect(document.querySelector(".plinth-design__canvas")).toBeNull();
    expect(document.querySelector(".plinth-design__toolbar")).toBeNull();
    expect(document.querySelector(".plinth-design__cover")).toBeNull();
    expect(
      [...document.querySelectorAll<HTMLElement>(".plinth-design__board")].map(
        (b) => b.dataset.board,
      ),
    ).toEqual(["home", "post", "mrec"]);
    // Every board is mounted, whatever the live-frame limit, each in its opaque frame.
    const iframes = document.querySelectorAll<HTMLIFrameElement>(".plinth-design__board iframe");
    expect(iframes).toHaveLength(3);
    for (const el of iframes) expect(el.getAttribute("sandbox")).toBe(BOARD_IFRAME_SANDBOX);
    const css = document.getElementById(PRINT_STYLE_ID)?.textContent ?? "";
    expect(css).toContain("@page s393x852 { size: 393px 852px; margin: 0; }");
    expect(css).toContain("@page s1080x1080 { size: 1080px 1080px; margin: 0; }");
    expect(css).toContain("@page s300x250 { size: 300px 250px; margin: 0; }");
    // Loaded boards are counted for the export's browser.
    expect(html().getAttribute("data-boards-loaded")).toBe("0");
    expect(evaluate(designExportLoadedScript(null, 3))).toBe(false);
    for (const id of ["home", "post", "mrec"]) {
      const w = winOf(f, id);
      fromWindow(f, w, boardMsg("ready"));
      fromWindow(f, w, boardMsg("loaded"));
    }
    expect(html().getAttribute("data-boards-loaded")).toBe("3");
    expect(evaluate(designExportLoadedScript(null, 3))).toBe(true);
    // The app's print message does nothing here: the export's own browser prints.
    f.target.dispatchEvent(
      new MessageEvent("message", {
        data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "print" },
        origin: APP,
        source: f.parent as unknown as Window,
      }),
    );
    expect(f.print).not.toHaveBeenCalled();
  });

  it("lets the export keep one board on the page and wait for that board alone", () => {
    mount();
    const f = topLevel("", "/__plinth/v/2/");
    handle = start(f, { matchMedia: print });
    expect(evaluate(designExportKeepOnlyScript("post"))).toBe(true);
    expect(
      [...document.querySelectorAll<HTMLElement>(".plinth-design__board")].map(
        (b) => b.dataset.board,
      ),
    ).toEqual(["post"]);
    expect(evaluate(designExportLoadedScript("post", 1))).toBe(false);
    const w = winOf(f, "post");
    fromWindow(f, w, boardMsg("ready"));
    fromWindow(f, w, boardMsg("loaded"));
    expect(evaluate(designExportLoadedScript("post", 1))).toBe(true);
    // A board the version lacks is reported, and no other board is left in its place.
    expect(evaluate(designExportKeepOnlyScript("nope"))).toBe(false);
    expect(document.querySelectorAll(".plinth-design__board")).toHaveLength(0);
  });

  it("is never selected by an address: a URL or a framed shell shows the canvas", () => {
    for (const [f, matchMedia] of [
      // The old export address, on screen: the canvas.
      [topLevel("?plinth-print=1&plinth-board=post"), () => false],
      // In the app the shell is a frame: print media at boot (a person printing) is no export.
      [framed("?plinth-print=1"), print],
    ] as const) {
      mount();
      handle = start(f, { matchMedia });
      expect(root().getAttribute("data-mode")).toBe("canvas");
      expect(html().hasAttribute("data-export")).toBe(false);
      expect(document.querySelectorAll(".plinth-design__board")).toHaveLength(3);
      handle.stop();
      handle = undefined;
      document.body.innerHTML = "";
    }
  });

  it("shows the canvas top-level on screen, as a thumbnail captures it", () => {
    mount();
    handle = start(topLevel("", "/__plinth/v/2/"), { matchMedia: () => false });
    expect(root().getAttribute("data-mode")).toBe("canvas");
    expect(html().hasAttribute("data-export")).toBe(false);
  });
});
