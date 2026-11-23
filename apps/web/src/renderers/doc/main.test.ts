// The doc renderer's entry: it boots from the JSON block the shell embeds, and acts on a print
// request only from the app page that frames it.
import {
  jsonForScript,
  RENDERER_MESSAGE_SOURCE,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, roomError } from "./boot.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

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

describe("doc renderer on-page editing (#36)", () => {
  const base = { source: RENDERER_MESSAGE_SOURCE, v: 1 };
  const NONCE = "nonce-0123456789abcdef";
  let sockets: {
    url: string;
    protocols: string[];
    sent: string[];
    onmessage?: (e: MessageEvent) => void;
  }[];
  let toApp: { mock: { calls: unknown[][] }; mockRestore: () => void };

  function post(data: unknown, origin = APP): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: window.parent }));
  }

  /** Messages the frame posted to the app, by type. */
  function posted(type: string): Record<string, unknown>[] {
    return toApp.mock.calls
      .filter((c: unknown[]) => (c[0] as Record<string, unknown>)?.type === type)
      .map((c: unknown[]) => {
        expect(c[1]).toBe(APP);
        return c[0] as Record<string, unknown>;
      });
  }

  beforeEach(() => {
    sockets = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        sent: string[] = [];
        onmessage?: (e: MessageEvent) => void;
        constructor(
          readonly url: string,
          readonly protocols: string[],
        ) {
          sockets.push(this);
        }
        send(s: string) {
          this.sent.push(s);
        }
        close() {}
      },
    );
    toApp = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    toApp.mockRestore();
  });

  it("leaves view mode exactly as it was without `live`: same DOM, no socket, no message", async () => {
    const text = "# Plinth\n\nA [ref][r].\n\n## Plinth\n\n[r]: https://example.com";
    mountShell(text);
    stop = boot(window);
    const div = document.createElement("div");
    div.append(sanitizeHtml(renderMarkdown(text), document));
    expect(root().innerHTML).toBe(div.innerHTML);
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    expect(toApp).not.toHaveBeenCalled();
  });

  it("edits alone after edit on, and answers collect with the text only in solo mode", async () => {
    mountShell("one\n\ntwo");
    stop = boot(window);
    post({ ...base, type: "collect", nonce: NONCE });
    expect(posted("draft")).toHaveLength(0);
    post({ ...base, type: "edit", on: true });
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    expect(root().classList.contains("plinth-doc--editing")).toBe(true);
    const live = posted("live").at(-1);
    expect(live).toMatchObject({ editing: true, connected: false, dirty: false });
    expect(JSON.stringify(live)).not.toContain("one");
    (root().querySelector("p") as HTMLElement).click();
    // The block opens as formatted text (no Markdown field); typing goes to the solo copy.
    const field = root().querySelector('[contenteditable="true"]') as HTMLElement;
    expect(root().querySelector("textarea")).toBeNull();
    field.textContent = "uno";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // A collect from another origin, or with a malformed nonce, is ignored.
    post({ ...base, type: "collect", nonce: NONCE }, "https://evil.example");
    post({ ...base, type: "collect", nonce: "short" });
    expect(posted("draft")).toHaveLength(0);
    post({ ...base, type: "collect", nonce: NONCE });
    expect(posted("draft")).toEqual([{ ...base, type: "draft", nonce: NONCE, text: "uno\n\ntwo" }]);
    post({ ...base, type: "edit", on: false });
    expect(root().querySelector("[contenteditable]")).toBeNull();
  });

  it("picks a block for a comment while editing, named as Ask names it, without opening it", async () => {
    mountShell("Intro\n\nSecond paragraph");
    stop = boot(window);
    post({ ...base, type: "edit", on: true });
    await Promise.resolve();
    post({ ...base, type: "pick", on: true });
    const second = root().querySelectorAll("p")[1] as HTMLElement;
    second.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    second.click();
    // The block stays as it was drawn: the press went to the pick, not the editor.
    expect(root().querySelector('[contenteditable="true"]')).toBeNull();
    expect(posted("picked")).toEqual([
      {
        ...base,
        type: "picked",
        anchor: { key: "block-2", text: "Second paragraph" },
        what: "paragraph",
      },
    ]);
    // Once only: the next press edits.
    second.click();
    expect(posted("picked")).toHaveLength(1);
    expect(root().querySelector('[contenteditable="true"]')).toBeTruthy();
  });

  it("asks the app about a block by its place in the published version, and its words", async () => {
    mountShell("Intro\n\n- first item\n\n  ```\n  fenced in a list\n  ```\n\n![Old alt](x.png)");
    stop = boot(window);
    post({ ...base, type: "edit", on: true });
    await Promise.resolve();
    const askButton = () =>
      [...root().querySelectorAll("button")].find(
        (b) => b.textContent === "Ask an agent",
      ) as HTMLElement;
    (root().querySelector("ul") as HTMLElement).click();
    askButton().click();
    expect(posted("ask")).toEqual([
      {
        ...base,
        type: "ask",
        anchor: { key: "block-2", text: "first item fenced in a list" },
        what: "list",
      },
    ]);
    const image = () => (root().querySelector("img") as HTMLElement).closest("p") as HTMLElement;
    image().click();
    askButton().click();
    expect(posted("ask").at(-1)).toEqual({
      ...base,
      type: "ask",
      anchor: { key: "block-3:image", text: "Old alt" },
      what: "image",
    });
    // Alt text changed in the draft: the block is not the published one any more. Its draft
    // words go, named after the published block above it, as not published yet ("new-…").
    image().click();
    const alt = root().querySelector(".plinth-rich__alt input") as HTMLInputElement;
    alt.value = "Draft alt";
    alt.dispatchEvent(new Event("input", { bubbles: true }));
    askButton().click();
    expect(posted("ask").at(-1)).toEqual({
      ...base,
      type: "ask",
      anchor: { key: "new-2:image", text: "Draft alt" },
      what: "image",
    });
  });

  it("with live: room, follows the live draft over the doc socket, never sending text to the app", async () => {
    const html = typedShellHtml(TYPE_REGISTRY.doc, {
      title: "T",
      text: "# Saved",
      base: "",
      appOrigin: APP,
      live: "room",
    });
    const main = /<main [^>]*><\/main>/.exec(html)?.[0] ?? "";
    const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] ?? "";
    document.body.innerHTML = main + data;
    stop = boot(window);
    expect(root().querySelector("h1")?.textContent).toContain("Saved");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toMatch(/\/__plinth\/room\/v1\/doc$/);
    expect(sockets[0]?.protocols).toEqual(["plinth.room.v1"]);
    const frame = (f: unknown) =>
      sockets[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(f) }));
    frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g",
      rev: 2,
      base_version: 1,
      flushed_rev: 2,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    frame({ t: "text", gen: "g", part: 0, of: 1, chunk: "# Draft\n\nsecret words" });
    expect(root().querySelector("h1")?.textContent).toContain("Draft");
    expect(root().classList.contains("plinth-doc--editing")).toBe(false);
    await Promise.resolve();
    const live = posted("live").at(-1);
    expect(live).toMatchObject({ connected: true, editing: false, rev: 2, base_version: 1 });
    expect(JSON.stringify(toApp.mock.calls)).not.toContain("secret");
    // In room mode collect gets no answer: draft text never leaves the frame.
    post({ ...base, type: "edit", on: true });
    post({ ...base, type: "collect", nonce: NONCE });
    expect(posted("draft")).toHaveLength(0);
    expect(root().classList.contains("plinth-doc--editing")).toBe(true);
  });

  it("with live: room, a block op whose lease request the socket took with it waits for nothing", async () => {
    vi.useFakeTimers();
    try {
      const html = typedShellHtml(TYPE_REGISTRY.doc, {
        title: "T",
        text: "",
        base: "",
        appOrigin: APP,
        live: "room",
      });
      const main = /<main [^>]*><\/main>/.exec(html)?.[0] ?? "";
      const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] ?? "";
      document.body.innerHTML = main + data;
      stop = boot(window);
      const frame = (i: number, f: unknown) =>
        sockets[i]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(f) }));
      const welcome = (i: number) => {
        frame(i, {
          t: "welcome",
          v: 1,
          you: { id: `s${i}`, email: "ada@example.org", right: "write" },
          gen: "g",
          rev: 1,
          base_version: 1,
          flushed_rev: 1,
          conflict_version: null,
          last_by_you: false,
          leases: [],
          peers: [],
        });
        frame(i, { t: "text", gen: "g", part: 0, of: 1, chunk: "one\n\ntwo\n\nthree" });
      };
      const sent = (i: number, t: string) =>
        (sockets[i]?.sent ?? []).map((s) => JSON.parse(s)).filter((f) => f.t === t);
      welcome(0);
      post({ ...base, type: "edit", on: true });
      (root().querySelector("p") as HTMLElement).click();
      expect(sent(0, "lease")).toHaveLength(1);
      frame(0, { t: "leased", lease: "l1", start: 0, end: 1, holder: "s0", by: "ada@example.org" });
      const button = root().querySelector(".plinth-doc__menu-button") as HTMLElement;
      button.click();
      const del = [...document.querySelectorAll<HTMLElement>("[role^='menuitem']")].find(
        (i) => i.textContent === "Delete",
      ) as HTMLElement;
      del.click();
      // The open block's lease is let go and the Delete's asked for; the socket drops before
      // the room answers either.
      expect(sent(0, "release")).toHaveLength(1);
      expect(sent(0, "lease")).toHaveLength(2);
      const ws = sockets[0] as unknown as { onclose: (e: { code: number }) => void };
      ws.onclose({ code: 1006 });
      expect(document.querySelector('[role="status"]')?.textContent).toContain("Not connected");
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
      welcome(1);
      // Nothing waits for the Delete: a click opens a block at once.
      (root().querySelectorAll("p")[1] as HTMLElement).click();
      // (Each frame carries its own id, which the room answers with as `re`.)
      expect(sent(1, "lease")).toEqual([
        { t: "lease", rev: 1, start: 2, end: 3, id: expect.any(Number) },
      ]);
      expect(root().textContent).toContain("one");
    } finally {
      vi.useRealTimers();
    }
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

describe("doc renderer room errors", () => {
  it("hands an edit the room refused to the editor, which keeps the typing, never only a notice", () => {
    const editor = { roomRefused: vi.fn(), notify: vi.fn() };
    roomError(editor, "invalid");
    roomError(editor, "too_large");
    expect(editor.roomRefused.mock.calls).toEqual([["invalid"], ["too_large"]]);
    expect(editor.notify).not.toHaveBeenCalled();
    // A lease that went before its frame was answered: the send was not applied either.
    roomError(editor, "not_held");
    expect(editor.roomRefused).toHaveBeenLastCalledWith("not_held");
    expect(editor.notify).not.toHaveBeenCalled();
    roomError(editor, "rate_limited");
    expect(editor.notify).toHaveBeenCalledWith(
      "Typing too fast for the room. Your text is kept and sent again.",
    );
  });
});
