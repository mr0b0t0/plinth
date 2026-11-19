// `edit { on: true, focus: "first" }` (the app's `?edit`, from New and Import) on a sheet: once the
// draft is drawn, cell A2, the first data cell, takes the focus, so typing fills it; a sheet with no
// rows focuses its header's A1. In room mode it waits for the room's draft, since the grid drawn
// from the version is rebuilt when the draft arrives. A plain Edit moves no focus.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";

const APP = "https://plinth.example.com";
const BLANK = TYPE_REGISTRY.sheet.create?.content ?? "";
const HEADER_ONLY = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [{ name: "Item", type: "text" }],
});

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    if (raw !== "ping") this.sent.push(JSON.parse(raw));
  }
  close() {}
  frame(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
}

function mount(text: string, live?: "room") {
  const html = typedShellHtml(TYPE_REGISTRY.sheet, {
    title: "Untitled sheet",
    text,
    base: "",
    appOrigin: APP,
    ...(live ? { live } : {}),
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
    location: window.location,
    print: vi.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent };
}

const send = (f: ReturnType<typeof framed>, m: Record<string, unknown>) =>
  f.target.dispatchEvent(
    new MessageEvent("message", {
      data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
      origin: APP,
      source: f.parent as never,
    }),
  );
const cell = (a: string) => document.getElementById(`__plinth-cell-${a}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  FakeSocket.all = [];
  document.body.innerHTML = "";
});

describe("focus on the first cell", () => {
  it("focuses A2 of a new sheet (solo)", () => {
    mount(BLANK);
    const f = framed();
    stop = boot(f.win, { locale: "en-US" });
    send(f, { type: "edit", on: true, focus: "first" });
    expect(document.activeElement).toBe(cell("A2"));
  });

  it("focuses the header's A1 when the sheet has no rows", () => {
    mount(HEADER_ONLY);
    const f = framed();
    stop = boot(f.win, { locale: "en-US" });
    send(f, { type: "edit", on: true, focus: "first" });
    expect(document.activeElement).toBe(cell("A1"));
  });

  it("moves no focus on a plain Edit", () => {
    mount(BLANK);
    const f = framed();
    stop = boot(f.win, { locale: "en-US" });
    send(f, { type: "edit", on: true });
    expect(document.activeElement).toBe(document.body);
  });

  it("waits for the room's draft before it focuses", async () => {
    mount(BLANK, "room");
    const f = framed();
    stop = boot(f.win, {
      locale: "en-US",
      connect: () => new FakeSocket() as unknown as WebSocket,
    });
    send(f, { type: "edit", on: true, focus: "first" });
    await tick();
    expect(document.activeElement).not.toBe(cell("A2"));
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev: 1,
      base_version: 1,
      flushed_rev: 1,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: BLANK });
    await tick();
    expect(document.activeElement).toBe(cell("A2"));
  });
});
