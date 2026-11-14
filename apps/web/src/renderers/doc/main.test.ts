// The doc renderer's entry: it boots from the JSON block the shell embeds, and acts on a print
// request only from the app page that frames it.
import {
  jsonForScript,
  RENDERER_MESSAGE_SOURCE,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";

// The Markdown layer is real unless a test sets `md.output`: then renderMarkdown returns that
// HTML, standing in for a Markdown pass that let something through, so the tests can prove boot()
// runs the sanitizer on whatever the Markdown layer gives it.
const md = vi.hoisted(() => ({ output: null as string | null }));
vi.mock("./markdown.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown.ts")>();
  return { ...actual, renderMarkdown: (t: string) => md.output ?? actual.renderMarkdown(t) };
});

const APP = "https://plinth.example.com";

/** Puts the root and data block of a real shell into the test document (not its script or
 * stylesheet, which happy-dom would try to fetch; the tests call boot() themselves). */
function mountShell(text: string, appOrigin = APP): void {
  const html = typedShellHtml(TYPE_REGISTRY.doc, { title: "T", text, base: "", appOrigin });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

function mountPayload(raw: string): void {
  document.body.innerHTML =
    '<main id="__plinth-doc" class="plinth-doc" tabindex="-1"></main>' +
    `<script type="application/json" id="__plinth-content">${raw}</script>`;
}

function root(): HTMLElement {
  const el = document.getElementById("__plinth-doc");
  if (!el) throw new Error("no root");
  return el;
}

let stop: (() => void) | undefined;
let print: ReturnType<typeof vi.fn>;

beforeEach(() => {
  print = vi.fn();
  window.print = print as unknown as typeof window.print;
  document.documentElement.removeAttribute("data-ready");
});

afterEach(() => {
  stop?.();
  stop = undefined;
  md.output = null;
  document.body.innerHTML = "";
});

describe("doc renderer boot", () => {
  it("renders the embedded Markdown synchronously and marks the page ready", () => {
    mountShell("# Hello\n\n</script><script>window.__pwned=1</script> text");
    stop = boot(window);
    expect(root().querySelector("h1")?.id).toBe("hello");
    expect(root().querySelector("script")).toBeNull();
    expect(root().textContent).toContain("</script><script>window.__pwned=1</script>");
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
  });

  it("sanitizes whatever the Markdown layer returns before it enters the page", () => {
    md.output =
      '<p onclick="x()" style="color:red">a</p><img src="x" onerror="alert(1)">' +
      "<script>window.__pwned=1</script>" +
      '<a href="javascript:x()">j</a><a href=" JaVaScRiPt:y()">k</a>' +
      '<iframe src="https://evil.example"></iframe><svg><script>1</script></svg>' +
      '<form action="https://evil.example"><input name="p"></form>';
    mountShell("# ignored");
    stop = boot(window);
    const r = root();
    expect(r.textContent).toContain("a");
    expect(r.querySelectorAll("script, iframe, svg, form, input, style")).toHaveLength(0);
    for (const el of r.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on"), `${el.tagName} ${attr}`).toBe(false);
        expect(attr, el.tagName).not.toBe("style");
      }
    }
    for (const el of r.querySelectorAll("[href], [src]")) {
      const url = el.getAttribute("href") ?? el.getAttribute("src") ?? "";
      expect(url).not.toMatch(/^\s*javascript:/i);
    }
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
  });

  it.each([
    ["malformed JSON", "{not json"],
    [
      "wrong version",
      jsonForScript({ v: 2, type: "doc", path: "content.md", app_origin: APP, text: "# x" }),
    ],
    [
      "wrong type",
      jsonForScript({ v: 1, type: "deck", path: "content.md", app_origin: APP, text: "# x" }),
    ],
    [
      "text not a string",
      jsonForScript({ v: 1, type: "doc", path: "content.md", app_origin: APP, text: 5 }),
    ],
    ["not an object", "null"],
  ])("shows a fallback message for a bad payload: %s", (_name, raw) => {
    mountPayload(raw);
    stop = boot(window);
    expect(root().textContent).toBe("This document could not be shown.");
    expect(root().querySelector("h1")).toBeNull();
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
  });

  it("shows the fallback when the data block is missing", () => {
    document.body.innerHTML = '<main id="__plinth-doc"></main>';
    stop = boot(window);
    expect(root().textContent).toBe("This document could not be shown.");
  });

  it("does nothing without a root element", () => {
    document.body.innerHTML = "";
    stop = boot(window);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
  });

  it("finds the root and data by id even when a heading tries to clobber them", () => {
    mountShell("# __plinth-doc\n\n# plinth-content");
    stop = boot(window);
    expect(root().querySelectorAll("h1")).toHaveLength(2);
    expect(document.querySelectorAll("#__plinth-doc")).toHaveLength(1);
  });
});

describe("doc renderer print", () => {
  const msg = { source: RENDERER_MESSAGE_SOURCE, v: 1, type: "print" };

  function post(data: unknown, init: { origin?: string; source?: Window | null } = {}): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: init.origin ?? APP,
        source: init.source === undefined ? window.parent : init.source,
      }),
    );
  }

  beforeEach(() => {
    mountShell("# Doc");
    stop = boot(window);
  });

  it("prints on a message from the parent with the app origin", () => {
    post(msg);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("ignores a print message from another origin", () => {
    post(msg, { origin: "https://evil.example" });
    post(msg, { origin: "null" });
    expect(print).not.toHaveBeenCalled();
  });

  it("ignores a print message from a window other than the parent", () => {
    // In happy-dom window.parent is window, so a framed doc is modelled with its own event
    // target and a separate parent object: only a message whose source is that parent prints.
    stop?.();
    const target = new EventTarget();
    const parent = { name: "parent" } as unknown as Window;
    const framePrint = vi.fn();
    const framed = {
      document,
      parent,
      print: framePrint,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as unknown as Window;
    stop = boot(framed);
    const send = (source: unknown) =>
      target.dispatchEvent(
        new MessageEvent("message", { data: msg, origin: APP, source: source as Window }),
      );
    send(null);
    send(framed);
    send(window);
    send({ name: "sibling" });
    expect(framePrint).not.toHaveBeenCalled();
    send(parent);
    expect(framePrint).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed messages", () => {
    for (const data of [
      null,
      "print",
      { type: "print" },
      { ...msg, source: "plinth-bridge" },
      { ...msg, v: 2 },
      { ...msg, type: "Print" },
    ]) {
      post(data);
    }
    expect(print).not.toHaveBeenCalled();
  });

  it("prints the frame on Ctrl+P and Cmd+P", () => {
    const ctrl = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", metaKey: true, cancelable: true }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", cancelable: true }));
    expect(print).toHaveBeenCalledTimes(2);
  });

  it("stops listening after cleanup", () => {
    stop?.();
    stop = undefined;
    post(msg);
    expect(print).not.toHaveBeenCalled();
  });

  it("does not listen when the payload is bad", () => {
    stop?.();
    mountPayload("{bad");
    stop = boot(window);
    post(msg);
    expect(print).not.toHaveBeenCalled();
  });
});

describe("doc renderer entry", () => {
  it("boots the page when the bundle is loaded", async () => {
    mountShell("## From the entry");
    vi.resetModules();
    await import("./main.ts");
    expect(root().querySelector("h2")?.id).toBe("from-the-entry");
  });
});
