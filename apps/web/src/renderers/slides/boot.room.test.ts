// A deck in room mode (the draft socket, modelled with a fake socket): a block open when the socket
// drops is taken again where it was, not on another slide that holds the same lines; and outside
// edit mode the deck follows the live draft only while nobody presents or leads, showing the
// published deck while the app has it full screen, in presenter view and while a presenter leads
// the room.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { EDIT_DEBOUNCE_MS } from "./edit.ts";
import type { FollowSocket } from "./follow.ts";

const APP = "https://plinth.example.com";
const YOU = { id: "s1", email: "ada@example.org", right: "write" as const };

class FakeSocket implements FollowSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    if (raw !== "ping") this.sent.push(JSON.parse(raw));
  }
  close() {}
  frame(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
  drop(code = 1006) {
    this.onclose?.({ code } as CloseEvent);
  }
}

/** The newest socket whose address ends with `kind` ("doc" or "slides"). */
const sock = (kind: "doc" | "slides") => {
  const s = FakeSocket.all.filter((x) => x.url.endsWith(kind)).at(-1);
  if (!s) throw new Error(`no ${kind} socket`);
  return s;
};

function mount(text: string, follow?: "present") {
  const html = typedShellHtml(TYPE_REGISTRY.slides, {
    title: "T",
    text,
    base: "",
    appOrigin: APP,
    live: "room",
    ...(follow ? { follow } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

let target = new EventTarget();
let parent = { postMessage: vi.fn() };
const app = (m: Record<string, unknown>) =>
  target.dispatchEvent(
    new MessageEvent("message", {
      data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
      origin: APP,
      source: parent as unknown as Window,
    }),
  );

function framedWin(): Window {
  target = new EventTarget();
  parent = { postMessage: vi.fn() };
  return {
    document,
    parent,
    print: vi.fn(),
    origin: "https://abc.content.example",
    location: { protocol: "https:", host: "abc.content.example", hash: "" },
    innerWidth: 1280,
    innerHeight: 900,
    getSelection: () => window.getSelection(),
    getComputedStyle: (e: Element) => window.getComputedStyle(e),
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
}

/** The room welcomes the doc socket with `text` as the draft, and says whether it holds edits. */
function welcomeDoc(s: FakeSocket, text: string, dirty: boolean, gen = "g1") {
  s.frame({
    t: "welcome",
    v: 1,
    you: YOU,
    gen,
    rev: 3,
    base_version: 1,
    flushed_rev: 3,
    conflict_version: null,
    last_by_you: false,
    leases: [],
    peers: [],
  });
  s.frame({ t: "text", gen, part: 0, of: 1, chunk: text });
  s.frame({ t: "status", dirty, editors: [YOU.email], last_edit_at: null, last_by_you: false });
}

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  document.documentElement.removeAttribute("data-ready");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start(text: string, follow?: "present") {
  mount(text, follow);
  stop = boot(framedWin(), {
    measure: () => false,
    connect: (url) => new FakeSocket(url),
    connectDoc: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
}

/** The first slide's title as the deck shows it. */
const title = () =>
  document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide h1')?.textContent;

describe("taking a block again after a reconnect", () => {
  it("leases the block where it was, not the first slide holding the same lines", () => {
    const deck = "# Intro\n---\n## Agenda\n---\n# Middle\n---\n## Agenda";
    start(deck);
    welcomeDoc(sock("doc"), deck, false);
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 4 });
    const h2 = document.querySelector(
      '.plinth-slides__frame[data-n="4"] .plinth-slides__slide h2',
    ) as HTMLElement;
    h2.click();
    const first = sock("doc");
    expect(first.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 6, end: 7 });
    first.frame({ t: "leased", lease: "l1", start: 6, end: 7, holder: YOU.id, by: YOU.email });
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    ed.textContent = "Agenda (Q4)";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    // The socket drops before the debounce sends the text.
    first.drop();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(first.sent.some((f) => f.t === "edit")).toBe(false);
    vi.advanceTimersByTime(2000);
    const again = sock("doc");
    expect(again).not.toBe(first);
    welcomeDoc(again, deck, true, "g2");
    expect(again.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 6, end: 7 });
    again.frame({ t: "leased", lease: "l2", start: 6, end: 7, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(again.sent.at(-1)).toEqual({ t: "edit", lease: "l2", seq: 1, text: "## Agenda (Q4)" });
  });
});

describe("outside edit mode", () => {
  const DECK = "# One\n---\n# Two";

  /** A co-editor retitles slide 1 in the draft. */
  const coEdit = (s: FakeSocket, rev: number, text: string) =>
    s.frame({ t: "op", gen: "g1", rev, lease: "l9", start: 0, del: 1, ins: text, by: "s2" });

  it("shows the live draft, and the published deck while the app has it full screen", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    coEdit(s, 4, "# One draft");
    expect(title()).toBe("One draft");
    app({ type: "presenting", on: true });
    expect(title()).toBe("One");
    // A co-editor's typing never reaches the presented screen.
    coEdit(s, 5, "# One draft, more");
    expect(title()).toBe("One");
    app({ type: "presenting", on: false });
    expect(title()).toBe("One draft, more");
  });

  it("shows the deck as last published after a page Publish, also in presenter view", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    coEdit(s, 4, "# One v2");
    // The draft is published: the room says it has no edits since the new version.
    s.frame({ t: "saved", version: 2, rev: 4 });
    s.frame({ t: "status", dirty: false, editors: [], last_edit_at: null, last_by_you: false });
    coEdit(s, 5, "# One v2 and typing");
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", cancelable: true }));
    expect(document.getElementById("__plinth-slides")?.getAttribute("data-mode")).toBe("presenter");
    expect(title()).toBe("One v2");
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(title()).toBe("One v2 and typing");
  });

  it("does not take a draft as published before the room says whether it holds edits", () => {
    start(DECK);
    const s = sock("doc");
    // The welcome's draft holds edits from an earlier session; the status saying so comes after.
    s.frame({
      t: "welcome",
      v: 1,
      you: YOU,
      gen: "g1",
      rev: 3,
      base_version: 1,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: "# One unpublished\n---\n# Two" });
    expect(title()).toBe("One unpublished");
    s.frame({ t: "status", dirty: true, editors: [], last_edit_at: null, last_by_you: false });
    app({ type: "presenting", on: true });
    expect(title()).toBe("One");
  });

  it("shows the published deck while this presenter leads, and counts its slides", () => {
    start(DECK, "present");
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    sock("slides").frame({ t: "welcome", v: 1, you: { id: "s_me", present: true }, at: null });
    // A co-editor's empty first slide hides it in the draft, which then shows one slide.
    s.frame({ t: "op", gen: "g1", rev: 4, lease: "l9", start: 0, del: 1, ins: "", by: "s2" });
    expect(document.documentElement.getAttribute("data-count")).toBe("1");
    const lead = document.querySelector<HTMLButtonElement>(
      ".plinth-slides__controls .plinth-slides__lead",
    );
    lead?.click();
    expect(document.documentElement.getAttribute("data-count")).toBe("2");
    expect(title()).toBe("One");
    lead?.click();
    expect(document.documentElement.getAttribute("data-count")).toBe("1");
  });

  it("follows a presenter on the published deck", () => {
    start(DECK, "present");
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    s.frame({ t: "op", gen: "g1", rev: 4, lease: "l9", start: 0, del: 1, ins: "", by: "s2" });
    expect(document.documentElement.getAttribute("data-count")).toBe("1");
    sock("slides").frame({
      t: "welcome",
      v: 1,
      you: { id: "s_me", present: true },
      at: { slide: 2, by: "s_lead" },
    });
    expect(document.documentElement.getAttribute("data-count")).toBe("2");
    expect(document.documentElement.getAttribute("data-slide")).toBe("2");
    expect(document.getElementById("__plinth-slides")?.getAttribute("data-follow")).toBe("on");
  });
});
