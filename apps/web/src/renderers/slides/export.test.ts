// The .pptx export in the frame: the lazy writer's URL next to the renderer script and its
// one-event handoff, which images go in (the artifact's own files under origin isolation, inline
// data: images always, nothing fetched under an opaque origin or from another origin), the ready
// notice, and the boot wiring: an export message from the app (parent, app origin, nonce) builds
// the file from every slide and answers with booleans and a count only.
import {
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import {
  clickDownload,
  collectImages,
  imageData,
  showReadyNotice,
  writerLoader,
  writerUrl,
} from "./export.ts";
import type { Geometry } from "./exportModel.ts";
import { PPTX_READY_EVENT, type PptxBuilder } from "./pptxModel.ts";
import { PAGE_STYLE_ID } from "./print.ts";

const APP = "https://plinth.example.com";
const SELF = "https://art1.content.example.net";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const NONCE = "abcdefghijklmnop";

afterEach(() => {
  document.head.querySelectorAll("script").forEach((s) => {
    s.remove();
  });
  document.body.innerHTML = "";
  document.getElementById(PAGE_STYLE_ID)?.remove();
  document.documentElement.removeAttribute("data-ready");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the lazy writer", () => {
  it("lives next to the renderer script, whatever the base", () => {
    expect(TYPE_REGISTRY.slides.renderer?.lazy).toEqual([
      { file: "slides-pptx.js", entry: "pptx.ts" },
    ]);
    for (const base of ["", "/__plinth/v/3", "/__content/abc123"]) {
      document.body.innerHTML = `<script src="${base}/__plinth/types/slides/slides.js"></script>`;
      expect(writerUrl(document)).toBe(`${base}/__plinth/types/slides/slides-pptx.js`);
    }
    document.body.innerHTML = '<script src="/elsewhere/slides.js"></script>';
    expect(writerUrl(document)).toBeNull();
  });

  it("adds its script once and takes the builder from its event", async () => {
    document.body.innerHTML = '<script src="/__plinth/types/slides/slides.js"></script>';
    const mounted: HTMLScriptElement[] = [];
    const load = writerLoader(document, 1000, (s) => mounted.push(s));
    const first = load();
    expect(load()).toBe(first);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.getAttribute("src")).toBe("/__plinth/types/slides/slides-pptx.js");
    // An event without a builder is not the writer.
    document.dispatchEvent(new CustomEvent(PPTX_READY_EVENT, { detail: { build: "x" } }));
    const build: PptxBuilder = async () => ({ blob: new Blob([]), imagesSkipped: 0 });
    document.dispatchEvent(new CustomEvent(PPTX_READY_EVENT, { detail: { build } }));
    await expect(first).resolves.toBe(build);
  });

  it("fails on a load error or a timeout, and tries again on the next call", async () => {
    document.body.innerHTML = '<script src="/__plinth/types/slides/slides.js"></script>';
    const mounted: HTMLScriptElement[] = [];
    const load = writerLoader(document, 50, (s) => {
      mounted.push(s);
      // The first one is in the page (and fails to load); the second never answers.
      if (mounted.length === 1) document.head.append(s);
    });
    const first = load();
    const failed = expect(first).rejects.toThrow("did not load");
    mounted[0]?.dispatchEvent(new Event("error"));
    await failed;
    expect(mounted[0]?.isConnected).toBe(false);
    vi.useFakeTimers();
    const second = load();
    expect(second).not.toBe(first);
    expect(mounted).toHaveLength(2);
    const slow = expect(second).rejects.toThrow("too long");
    vi.advanceTimersByTime(60);
    await slow;
  });
});

/** A window on the artifact's own origin whose fetch answers from `files`. */
function origin(files: Record<string, Blob>, at = SELF) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe("same-origin");
    const path = new URL(url).pathname;
    const body = files[path];
    return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
  });
  const win = {
    document: { baseURI: `${at}/` },
    location: { origin: at },
    fetch,
  } as unknown as Window;
  return { win, fetch };
}

describe("images", () => {
  it("passes inline PNG, JPEG and GIF data through, fetched or not", async () => {
    const { win, fetch } = origin({});
    expect(await imageData(win, PNG, false)).toBe(PNG);
    expect(await imageData(win, PNG, true)).toBe(PNG);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the artifact's own raster files as data: URLs", async () => {
    const { win, fetch } = origin({ "/img/a.png": new Blob(["png"], { type: "image/png" }) });
    expect(await imageData(win, "img/a.png", false)).toBe("data:image/png;base64,cG5n");
    expect(fetch).toHaveBeenCalledWith(`${SELF}/img/a.png`, { credentials: "same-origin" });
    expect(await imageData(win, "img/missing.png", false)).toBeNull();
  });

  it("fetches nothing under an opaque origin, from another origin, or that is not an image", async () => {
    const { win, fetch } = origin({ "/a.txt": new Blob(["x"], { type: "text/plain" }) });
    expect(await imageData(win, "img/a.png", true)).toBeNull();
    expect(await imageData(win, "https://evil.example/a.png", false)).toBeNull();
    expect(await imageData(win, "//evil.example/a.png", false)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await imageData(win, "a.txt", false)).toBeNull();
  });

  it("collects each source once, and only inline ones under an opaque origin", async () => {
    const { win, fetch } = origin({ "/x.png": new Blob(["png"], { type: "image/png" }) });
    const model = {
      title: "t",
      width: 13.333,
      height: 7.5,
      theme: "light" as const,
      slides: [
        {
          n: 1,
          notes: "",
          background: "FFFFFF",
          items: [
            { kind: "image" as const, box: { x: 0, y: 0, w: 1, h: 1 }, src: "x.png", alt: "" },
            { kind: "image" as const, box: { x: 0, y: 0, w: 1, h: 1 }, src: "x.png", alt: "" },
            { kind: "image" as const, box: { x: 0, y: 0, w: 1, h: 1 }, src: PNG, alt: "" },
          ],
        },
      ],
    };
    const all = await collectImages(win, model, false);
    expect([...all.keys()]).toEqual(["x.png", PNG]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const opaque = await collectImages(win, model, true);
    expect([...opaque.keys()]).toEqual([PNG]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("saving", () => {
  it("downloads with an <a download> and offers a Download button until dismissed", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const root = document.createElement("main");
    document.body.append(root);
    clickDownload(document, "blob:x", "Q4.pptx");
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")).toBeNull();

    showReadyNotice(document, root, "blob:x", "Q4 <b>.pptx");
    const bar = root.querySelector(".plinth-slides__ready");
    expect(bar?.querySelector(".plinth-slides__ready-text")?.textContent).toBe(
      "Q4 <b>.pptx is ready",
    );
    expect(bar?.querySelector("b")).toBeNull();
    const [download, dismiss] = Array.from(bar?.querySelectorAll("button") ?? []);
    download?.click();
    expect(click).toHaveBeenCalledTimes(2);
    dismiss?.click();
    expect(root.querySelector(".plinth-slides__ready")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("replaces an older notice and goes by itself", () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const root = document.createElement("main");
    showReadyNotice(document, root, "blob:1", "a.pptx", 1000);
    showReadyNotice(document, root, "blob:2", "a.pptx", 1000);
    expect(root.querySelectorAll(".plinth-slides__ready")).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    vi.advanceTimersByTime(1000);
    expect(root.querySelector(".plinth-slides__ready")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:2");
  });
});

// ---------- boot ----------

const DECK = ["# One", "Note: Say hi.", "---", "## Two", "![pic](pic.png)"].join("\n");

function mount(text = DECK) {
  const html = typedShellHtml(TYPE_REGISTRY.slides, {
    title: "Q4 review",
    text,
    base: "",
    appOrigin: APP,
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.title = "Q4 review";
  document.body.innerHTML = main + data;
}

function framed() {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const { fetch } = origin(
    { "/pic.png": new Blob(["png"], { type: "image/png" }) },
    window.location.origin,
  );
  const win = {
    document,
    parent,
    print: vi.fn(),
    innerWidth: 1280,
    innerHeight: 800,
    location: { origin: window.location.origin },
    fetch,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    getSelection: () => window.getSelection(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  const send = (data: unknown, from = APP, source: unknown = parent) =>
    target.dispatchEvent(
      new MessageEvent("message", { data, origin: from, source: source as Window }),
    );
  return { win, parent, fetch, send };
}

/** Every element laid out: slides at full canvas size, everything else a small box on them. */
const geometry: Geometry = {
  rect: (el) =>
    el.localName === "section"
      ? { left: 0, top: 0, width: 1280, height: 720 }
      : { left: 80, top: 64, width: 400, height: 40 },
  style: (el) => window.getComputedStyle(el),
};

const exportMsg = (nonce = NONCE) => ({
  source: RENDERER_MESSAGE_SOURCE,
  v: RENDERER_PROTOCOL_VERSION,
  type: "export",
  format: "pptx",
  nonce,
});

describe("boot: export", () => {
  it("builds every slide into the file and answers the app with booleans and a count", async () => {
    mount();
    const f = framed();
    const build = vi.fn<PptxBuilder>(async () => ({ blob: new Blob(["pk"]), imagesSkipped: 0 }));
    const save = vi.fn();
    const stop = boot(f.win, { loadWriter: async () => build, save, opaque: false, geometry });
    f.send(exportMsg());
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [model, images] = build.mock.calls[0] ?? [];
    expect(model?.slides.map((s) => s.notes)).toEqual(["Say hi.", ""]);
    expect(model?.title).toBe("Q4 review");
    expect([...(images?.keys() ?? [])]).toEqual(["pic.png"]);
    expect(save.mock.calls[0]?.[1]).toBe("Q4 review.pptx");
    expect(f.parent.postMessage).toHaveBeenLastCalledWith(
      {
        source: RENDERER_MESSAGE_SOURCE,
        v: RENDERER_PROTOCOL_VERSION,
        type: "exported",
        nonce: NONCE,
        ok: true,
        images_skipped: 0,
        opaque: false,
      },
      APP,
    );
    // The measure pass leaves the screen view as it was.
    const root = document.getElementById("__plinth-slides");
    expect(root?.hasAttribute("data-export")).toBe(false);
    expect(root?.dataset.mode).toBe("deck");
    stop();
  });

  it("acts only on a well-formed request from its parent at the app origin", async () => {
    mount();
    const f = framed();
    const load = vi.fn(
      async () => (async () => ({ blob: new Blob([]), imagesSkipped: 0 })) as PptxBuilder,
    );
    const stop = boot(f.win, { loadWriter: load, save: vi.fn() });
    f.send(exportMsg(), "https://evil.example");
    f.send(exportMsg(), APP, {});
    f.send(exportMsg("short"));
    f.send({ ...exportMsg(), format: "key" });
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
    stop();
  });

  it("under an opaque origin fetches no file and says why images were left out", async () => {
    mount();
    const f = framed();
    const build = vi.fn<PptxBuilder>(async (_m, images) => ({
      blob: new Blob([]),
      imagesSkipped: images.size === 0 ? 1 : 0,
    }));
    const stop = boot(f.win, {
      loadWriter: async () => build,
      save: vi.fn(),
      opaque: true,
      geometry,
    });
    f.send(exportMsg());
    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(f.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "exported", ok: true, images_skipped: 1, opaque: true }),
        APP,
      ),
    );
    expect(f.fetch).not.toHaveBeenCalled();
    stop();
  });

  it("makes the file once when asked again while it runs, and answers the newest nonce", async () => {
    mount();
    const f = framed();
    let finish: (v: { blob: Blob; imagesSkipped: number }) => void = () => undefined;
    const build = vi.fn<PptxBuilder>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const save = vi.fn();
    const stop = boot(f.win, { loadWriter: async () => build, save, opaque: false, geometry });
    const exportedCalls = () =>
      f.parent.postMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === "exported");
    f.send(exportMsg());
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    // The app gave up waiting, and the person asked again.
    const NEWER = "qrstuvwxyzABCDEF";
    f.send(exportMsg(NEWER));
    await new Promise((r) => setTimeout(r, 10));
    expect(exportedCalls()).toEqual([]);
    finish({ blob: new Blob(["pk"]), imagesSkipped: 0 });
    await vi.waitFor(() => expect(exportedCalls()).toHaveLength(1));
    expect(exportedCalls()[0]?.[0]).toMatchObject({ type: "exported", nonce: NEWER, ok: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    // Once it is done, a new request makes a new file.
    f.send(exportMsg());
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    finish({ blob: new Blob(["pk"]), imagesSkipped: 0 });
    await vi.waitFor(() => expect(exportedCalls()).toHaveLength(2));
    expect(exportedCalls()[1]?.[0]).toMatchObject({ nonce: NONCE });
    stop();
  });

  it("reports at most the version file cap of images left out", async () => {
    mount();
    const f = framed();
    const build = vi.fn<PptxBuilder>(async () => ({ blob: new Blob([]), imagesSkipped: 5000 }));
    const stop = boot(f.win, { loadWriter: async () => build, save: vi.fn(), geometry });
    f.send(exportMsg());
    await vi.waitFor(() =>
      expect(f.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "exported",
          ok: true,
          images_skipped: LIMITS.maxAssetsCeiling,
        }),
        APP,
      ),
    );
    stop();
  });

  it("answers ok: false when the writer fails", async () => {
    mount();
    const f = framed();
    const stop = boot(f.win, {
      loadWriter: async () => {
        throw new Error("no writer");
      },
      save: vi.fn(),
    });
    f.send(exportMsg());
    await vi.waitFor(() =>
      expect(f.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "exported", nonce: NONCE, ok: false, images_skipped: 0 }),
        APP,
      ),
    );
    stop();
  });
});
