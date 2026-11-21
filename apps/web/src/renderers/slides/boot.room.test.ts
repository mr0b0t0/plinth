// A deck in room mode (the draft socket, modelled with a fake socket): a block open when the socket
// drops is taken again where it was, not on another slide that holds the same lines; a block whose
// lines move before the room reads its lease (a stale answer, a merge) is found again by its text,
// and nothing opens on lines that no longer hold what was clicked; what was typed survives a lease
// that ends (an edit in flight when the socket died, a room that restarted from D1, an insert
// point typed in, the text after the caret when Enter splits a block); and outside
// edit mode the deck follows the live draft only while nobody presents or leads, showing the
// published deck while the app has it full screen, in presenter view and while a presenter leads
// the room.
import {
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRescue, mergeRescue } from "../../components/editor/draft.ts";
import { readRescueItems } from "../../components/viewer/rendererProtocol.ts";
import { HIDDEN_CLOSE_MS } from "../common/live.ts";
import { boot } from "./boot.ts";
import { DECK_WORDS, EDIT_DEBOUNCE_MS } from "./edit.ts";
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

  it("asks again when the socket drops before the lease taking it again is answered", () => {
    const deck = "# Intro\n---\n## Agenda";
    start(deck);
    welcomeDoc(sock("doc"), deck, false);
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2') as
        | HTMLElement
        | undefined
    )?.click();
    const first = sock("doc");
    first.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    ed.textContent = "Agenda (Q4)";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    first.drop();
    vi.advanceTimersByTime(2000);
    const second = sock("doc");
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    // No answer: the socket drops again, and the next welcome asks once more.
    second.drop();
    vi.advanceTimersByTime(5000);
    const third = sock("doc");
    expect(third).not.toBe(second);
    welcomeDoc(third, deck, true, "g3");
    expect(third.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    third.frame({ t: "leased", lease: "l3", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(third.sent.at(-1)).toEqual({ t: "edit", lease: "l3", seq: 1, text: "## Agenda (Q4)" });
  });
});

describe("asking for a block whose lines moved meanwhile", () => {
  const DECK = "# One\n---\n## Two";

  /** Clicks slide 2's title in edit mode: a lease for its line at rev 3. */
  const clickTwo = (s: FakeSocket) => {
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    const h2 = document.querySelector(
      '.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2',
    ) as HTMLElement;
    h2.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
  };

  /** A co-editor turns slide 1's title line into three lines: "## Two" moves from line 2 to 4. */
  const coEdit = (s: FakeSocket) =>
    s.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 0,
      del: 1,
      ins: "# One\n\nMore",
      by: "s2",
    });

  const type = (text: string) => {
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    ed.textContent = text;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("finds the block again by its text after a stale answer", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    clickTwo(s);
    // The co-editor's op reaches the room before the lease does.
    coEdit(s);
    s.frame({ t: "lease_denied", reason: "stale" });
    // Line 2 is now the co-editor's "More": the lease asked for is the title's new line.
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 5 });
    s.frame({ t: "leased", lease: "l1", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    type("Two typed");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(s.sent.at(-1)).toEqual({ t: "edit", lease: "l1", seq: 1, text: "## Two typed" });
  });

  it("finds an insert point again by the lines around it", () => {
    const deck = "# One\n---\n---\n## Three";
    start(deck);
    const s = sock("doc");
    welcomeDoc(s, deck, false);
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    // The empty slide's "Click to add a title": an insert point between its two separators.
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__placeholder') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 2 });
    coEdit(s);
    s.frame({ t: "lease_denied", reason: "stale" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 4 });
  });

  it("never edits granted lines that are not the block asked for", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    clickTwo(s);
    coEdit(s);
    // A grant of the old line numbers, which now hold the co-editor's line.
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    // Once it is released, the block is asked for where its text is now.
    s.frame({ t: "released", lease: "l1" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 5 });
    s.frame({ t: "leased", lease: "l2", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    type("Two typed");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(s.sent.filter((f) => f.t === "edit")).toEqual([
      { t: "edit", lease: "l2", seq: 1, text: "## Two typed" },
    ]);
  });

  it("takes a block again after a rebase in the merged text, not the lines before it", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, true);
    clickTwo(s);
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    type("Two typed");
    // An agent publishes a version with a slide at the start, and the room merges it cleanly.
    const before = s.sent.length;
    s.frame({ t: "lease_lost", lease: "l1", reason: "rebased" });
    // Nothing is asked for on the lines from before the rebase.
    expect(s.sent.slice(before).some((f) => f.t === "lease")).toBe(false);
    s.frame({ t: "rebased", version: 2, gen: "g1", rev: 4 });
    expect(s.sent.slice(before).some((f) => f.t === "lease")).toBe(false);
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: "# Zero\n---\n# One\n---\n## Two" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 5 });
    s.frame({ t: "leased", lease: "l2", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(s.sent.filter((f) => f.t === "edit")).toEqual([
      { t: "edit", lease: "l2", seq: 1, text: "## Two typed" },
    ]);
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

describe("keeping what was typed when the lease ends", () => {
  /** The open block's editable element. */
  const editable = () => {
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    return ed;
  };
  const type = (text: string) => {
    const ed = editable();
    ed.textContent = text;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const edits = (s: FakeSocket) => s.sent.filter((f) => f.t === "edit");

  /** Clicks slide 2's title (line 2) in edit mode and is granted its lease. */
  const clickAgenda = (s: FakeSocket) => {
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2') as
        | HTMLElement
        | undefined
    )?.click();
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
  };

  it("takes a block again by the room's text when the socket died with an edit in flight", () => {
    const deck = "# Intro\n---\n## Agenda";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    clickAgenda(first);
    type("Agenda (Q4)");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    // Sent, but the network is gone: no op comes back, then the socket closes.
    expect(edits(first)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "## Agenda (Q4)" }]);
    first.drop();
    vi.advanceTimersByTime(2000);
    const second = sock("doc");
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(second)).toEqual([
      expect.objectContaining({ t: "edit", lease: "l2", text: "## Agenda (Q4)" }),
    ]);
  });

  it("takes a block again by its last written text when the room lost what it acked", () => {
    const deck = "# Intro\n---\n## Agenda";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    clickAgenda(first);
    type("Agenda (Q3)");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    first.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      seq: 1,
      start: 2,
      del: 1,
      ins: "## Agenda (Q3)",
      by: YOU.id,
    });
    type("Agenda (Q4)");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    first.drop();
    vi.advanceTimersByTime(2000);
    // The room was evicted before it wrote the acked edit: it holds the text from before it.
    const second = sock("doc");
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(second)).toEqual([
      expect.objectContaining({ t: "edit", lease: "l2", text: "## Agenda (Q4)" }),
    ]);
  });

  /** Clicks the empty slide 2's "Click to add a title" (an insert point at line 2) and types. */
  const addTitle = (s: FakeSocket, text: string) => {
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__placeholder') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 2 });
    s.frame({ t: "leased", lease: "l1", start: 2, end: 2, holder: YOU.id, by: YOU.email });
    if (text) type(text);
  };

  it("takes an insert point again after a reconnect and sends what was typed in it", () => {
    const deck = "# One\n---\n---\n## Three";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    addTitle(first, "Plans");
    // The socket drops before the debounce sends the title.
    first.drop();
    vi.advanceTimersByTime(2000);
    expect(edits(first)).toEqual([]);
    const second = sock("doc");
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 2 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 2, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(second)).toEqual([
      expect.objectContaining({ t: "edit", lease: "l2", text: "## Plans" }),
    ]);
  });

  it("takes an insert point again after a rebase and sends what was typed in it", () => {
    const deck = "# One\n---\n---\n## Three";
    start(deck);
    const s = sock("doc");
    welcomeDoc(s, deck, true);
    addTitle(s, "Plans");
    const before = s.sent.length;
    s.frame({ t: "lease_lost", lease: "l1", reason: "rebased" });
    s.frame({ t: "rebased", version: 2, gen: "g1", rev: 4 });
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: `# Zero\n---\n${deck}` });
    expect(s.sent.slice(before).filter((f) => f.t === "lease")).toEqual([
      { t: "lease", rev: 4, start: 4, end: 4 },
    ]);
    s.frame({ t: "leased", lease: "l2", start: 4, end: 4, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([expect.objectContaining({ lease: "l2", text: "## Plans" })]);
  });

  it("does not take an insert point again when nothing was typed in it", () => {
    const deck = "# One\n---\n---\n## Three";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    addTitle(first, "");
    first.drop();
    vi.advanceTimersByTime(2000);
    const second = sock("doc");
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.some((f) => f.t === "lease")).toBe(false);
  });

  it("writes the text after the caret when Enter splits a paragraph", () => {
    const deck = "# Intro\n\nHello world";
    start(deck);
    const s = sock("doc");
    welcomeDoc(s, deck, false);
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    const ed = editable();
    const node = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error("no text");
    const range = document.createRange();
    range.setStart(node, "Hello ".length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    ed.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // Head and tail go in one edit, so the tail is in the deck whatever happens next, and the
    // block's lease is let go at once.
    expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "Hello\n\nworld" }]);
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    s.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      seq: 1,
      start: 2,
      del: 1,
      ins: "Hello\n\nworld",
      by: YOU.id,
    });
    // The new block is the tail's own lines, asked for once the room let the head's lease go.
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    s.frame({ t: "released", lease: "l1" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 5 });
    s.frame({ t: "leased", lease: "l2", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    expect(editable().textContent).toBe("world");
    // Leaving the new block sends nothing more: both paragraphs stay.
    s.frame({ t: "released", lease: "l2" });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toHaveLength(1);
  });

  it("opens an insert point below when Enter is pressed at a paragraph's end", () => {
    const deck = "# Intro\n\nHello";
    start(deck);
    const s = sock("doc");
    welcomeDoc(s, deck, false);
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    const ed = editable();
    const node = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error("no text");
    const range = document.createRange();
    range.setStart(node, "Hello".length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    ed.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // Nothing changed in the paragraph: the insert point below it is asked for once the room let
    // the paragraph's lease go.
    expect(edits(s)).toEqual([]);
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    s.frame({ t: "released", lease: "l1" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    type("More");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "\nMore" }]);
  });
});

describe("never dropping typing the room does not hold yet", () => {
  const DECK = "# One\n---\n## Two";
  const editable = () => {
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    return ed;
  };
  const type = (text: string) => {
    const ed = editable();
    ed.textContent = text;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const edits = (s: FakeSocket) => s.sent.filter((f) => f.t === "edit");
  /** What the frame posted to the app. */
  const posts = () => parent.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
  const lastStatus = () =>
    posts()
      .filter((p) => p.type === "live")
      .at(-1);
  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  /** Opens slide 2's title (line 2), granted as `lease`. */
  const openTwo = (s: FakeSocket, lease = "l1") => {
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toMatchObject({ t: "lease", start: 2, end: 3 });
    s.frame({ t: "leased", lease, start: 2, end: 3, holder: YOU.id, by: YOU.email });
  };

  /** Leaves typing in the open block that cannot be written as Markdown as it stands. */
  const stick = () => {
    const ed = editable();
    ed.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
  };

  /** The socket drops and the next one is welcomed with `text`. */
  const reconnect = (text: string, dirty = true) => {
    sock("doc").drop();
    vi.advanceTimersByTime(5000);
    const s = sock("doc");
    welcomeDoc(s, text, dirty, `g${FakeSocket.all.length}`);
    return s;
  };

  it("keeps a lease holding typing it cannot write in use, so it is not taken over as idle", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    stick();
    expect(edits(s)).toEqual([]);
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000);
    expect(s.sent.at(-1)).toEqual({ t: "keep", lease: "l1" });
    s.frame({ t: "kept", lease: "l1" });
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000);
    expect(s.sent.filter((f) => f.t === "keep")).toHaveLength(2);
  });

  it("keeps a hidden tab's socket open while such typing waits", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    stick();
    const close = vi.spyOn(s, "close");
    const was = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 1);
      expect(close).not.toHaveBeenCalled();
    } finally {
      if (was) Object.defineProperty(document, "visibilityState", was);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });

  it("asks for no other block while such typing keeps its block open", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    stick();
    const asked = s.sent.filter((f) => f.t === "lease").length;
    app({ type: "goto", slide: 1 });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide h1') as
        | HTMLElement
        | undefined
    )?.click();
    // A grant elsewhere would take the open block's place from under its typing.
    expect(s.sent.filter((f) => f.t === "lease")).toHaveLength(asked);
    expect(editable().textContent).toBe("abc");
  });

  it("leaves such typing as typed when the room refuses an earlier edit", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    type("Two typed");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    stick();
    s.frame({ t: "error", code: "invalid" });
    expect(editable().textContent).toBe("abc");
    expect(editable().querySelector("strong")).not.toBeNull();
  });

  it("writes such typing below the block, without its marks, when someone takes it over", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    stick();
    s.frame({ t: "lease_lost", lease: "l1", reason: "takeover" });
    s.frame({ t: "leased", lease: "l9", start: 2, end: 3, holder: "s2", by: "bo@example.org" });
    // An insert point right after the block the other person holds now.
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "\n## abc" }]);
  });

  it("writes an edit the room never acknowledged below the block when it is taken over", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    type("Two typed");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "## Two typed" }]);
    // The lease goes before the room took the edit: it may never have landed.
    s.frame({ t: "lease_lost", lease: "l1", reason: "takeover" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s).at(-1)).toEqual({ t: "edit", lease: "l2", seq: 2, text: "\n## Two typed" });
  });

  it("says nothing of its own for a lease that went before its last frame was answered", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openTwo(s);
    const live = document.querySelector(".plinth-slides__live") as HTMLElement;
    live.textContent = "";
    s.frame({ t: "error", code: "not_held" });
    expect(live.textContent).toBe("");
  });

  it("puts typing back in its place after a review the draft froze for", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, true);
    openTwo(s);
    type("Two typed");
    // The draft freezes before the debounce sends it.
    s.frame({ t: "lease_lost", lease: "l1", reason: "closed" });
    s.frame({ t: "conflict", version: 2 });
    // Asked for at once, and refused while the review waits: nothing is asked again meanwhile.
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "lease_denied", reason: "frozen" });
    const asked = s.sent.length;
    s.frame({ t: "status", dirty: true, editors: [], last_edit_at: null, last_by_you: false });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([]);
    expect(s.sent.length).toBe(asked);
    // The review ends with the draft kept: the block is asked for where its text is.
    s.frame({ t: "rebased", version: 2, gen: "g1", rev: 4 });
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: DECK });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "## Two typed" }]);
  });

  it("writes typing as a new block nearby when its block is held after a reconnect", async () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openTwo(first);
    type("Two typed");
    first.drop();
    await settle();
    // Not in the draft yet: the page asks before it is left.
    expect(lastStatus()?.unflushed).toBe(true);
    vi.advanceTimersByTime(5000);
    const s = sock("doc");
    welcomeDoc(s, DECK, true, "g2");
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l9", start: 2, end: 3, holder: "s2", by: "bo@example.org" });
    s.frame({ t: "lease_denied", reason: "held", by: "bo@example.org" });
    // The nearest block end nobody's lease touches: after slide 1's title.
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 1, end: 1 });
    s.frame({ t: "leased", lease: "l2", start: 1, end: 1, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "\n## Two typed" }]);
  });

  it("writes typing as a new block nearby when its text is gone after a reconnect", () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openTwo(first);
    type("Two typed");
    // Someone retitled slide 2 while this socket was away.
    const s = reconnect("# One\n---\n## Second");
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "\n## Two typed" }]);
  });

  it("writes typing taken again after edit mode ended, and opens nothing", () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openTwo(first);
    type("Two typed");
    first.drop();
    app({ type: "edit", on: false });
    vi.advanceTimersByTime(5000);
    const s = sock("doc");
    welcomeDoc(s, DECK, true, "g2");
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    expect(s.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l2", seq: 1, text: "## Two typed" },
      { t: "release", lease: "l2" },
    ]);
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
  });

  it("keeps typing the room refuses to write with Copy, and tries it again after a reconnect", async () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openTwo(first);
    type("Two typed");
    const s = reconnect(DECK);
    s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toHaveLength(1);
    s.frame({ t: "error", code: "invalid" });
    // Not put back as the room has it: kept on the page, with Copy, and still unsent.
    const bar = document.querySelector(".plinth-slides__kept");
    expect(bar?.textContent).toContain(DECK_WORDS.stuckKept);
    expect(bar?.querySelector("button")?.textContent).toBe(DECK_WORDS.copy);
    await settle();
    expect(lastStatus()?.unflushed).toBe(true);
    const again = reconnect(DECK);
    // Back in as a new block at the nearest free place.
    expect(again.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    again.frame({ t: "leased", lease: "l3", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(again)).toMatchObject([{ t: "edit", lease: "l3", text: "\n## Two typed" }]);
    expect(document.querySelector(".plinth-slides__kept")).toBeNull();
  });

  it("drops what it kept when the unpublished changes are discarded", async () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, true);
    openTwo(s);
    type("Two typed");
    s.frame({ t: "lease_lost", lease: "l1", reason: "closed" });
    s.frame({ t: "reset", version: 1, gen: "g1", rev: 4, why: "discarded" });
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: DECK });
    const asked = s.sent.at(-1);
    if (asked?.t === "lease") {
      s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    }
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([]);
    await settle();
    expect(lastStatus()?.unflushed).toBe(false);
  });
});

describe("a split, and a block taken again after a reconnect", () => {
  const editable = () => {
    const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    return ed;
  };
  const edits = (s: FakeSocket) => s.sent.filter((f) => f.t === "edit");

  /** Opens slide 1's paragraph (line 2) and is granted its lease. */
  const openPara = (s: FakeSocket) => {
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
  };

  /** Presses Enter in `ed` with the caret `at` characters into its text. */
  const enterAt = (ed: HTMLElement, at: number) => {
    const node = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error("no text");
    const range = document.createRange();
    range.setStart(node, at);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    ed.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  };

  const DECK = "# Intro\n\nabcd";

  it("closes the block at once: a key or a second Enter before the answer sends nothing", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openPara(s);
    const ed = editable();
    enterAt(ed, 2);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "ab\n\ncd" }]);
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    // A key typed before the room answers, and a second Enter: the old block is gone, so neither
    // can send the text before the caret alone over the tail.
    ed.textContent = "abx";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    ed.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toHaveLength(1);
    s.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      seq: 1,
      start: 2,
      del: 1,
      ins: "ab\n\ncd",
      by: YOU.id,
    });
    s.frame({ t: "released", lease: "l1" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 4, end: 5 });
    s.frame({ t: "leased", lease: "l2", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    expect(editable().textContent).toBe("cd");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toHaveLength(1);
  });

  it("writes both halves again when the socket drops between the split and its answer", () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openPara(first);
    enterAt(editable(), 2);
    expect(edits(first)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "ab\n\ncd" }]);
    // The network goes before the room answers: the edit never landed.
    first.drop();
    vi.advanceTimersByTime(5000);
    const second = sock("doc");
    welcomeDoc(second, DECK, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    // Both halves, at once, and the place closes again: the person had left it.
    expect(second.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l2", seq: 2, text: "ab\n\ncd" },
      { t: "release", lease: "l2" },
    ]);
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
  });

  it("writes nothing again when the split landed before the socket dropped", () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openPara(first);
    enterAt(editable(), 2);
    first.drop();
    vi.advanceTimersByTime(5000);
    const second = sock("doc");
    // The room took the edit; only its answer was lost.
    welcomeDoc(second, "# Intro\n\nab\n\ncd", true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 5 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 5, holder: YOU.id, by: YOU.email });
    expect(edits(second)).toEqual([]);
    expect(second.sent.at(-1)).toEqual({ t: "release", lease: "l2" });
  });

  it("leases the whole block again when the text sent last is its first lines", () => {
    const deck = "# Intro\n\n- one\n- two";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide ul') as
        | HTMLElement
        | undefined
    )?.click();
    expect(first.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 4 });
    first.frame({ t: "leased", lease: "l1", start: 2, end: 4, holder: YOU.id, by: YOU.email });
    // The last item is deleted, and the edit goes out; the socket drops before the room answers.
    const ed = editable();
    ed.querySelector("li:last-child")?.remove();
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(first)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "- one" }]);
    first.drop();
    vi.advanceTimersByTime(5000);
    const second = sock("doc");
    // The room never took it: it still holds both items, "- one" being the first of them.
    welcomeDoc(second, deck, true, "g2");
    expect(second.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 4 });
    second.frame({ t: "leased", lease: "l2", start: 2, end: 4, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(second)).toEqual([{ t: "edit", lease: "l2", seq: 2, text: "- one" }]);
  });

  it("never opens the text after the caret on the old block when the room refused the split", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openPara(s);
    enterAt(editable(), 2);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "ab\n\ncd" }]);
    // The room did not take the edit (too fast, or full), then let the lease go.
    s.frame({ t: "error", code: "rate_limited" });
    s.frame({ t: "released", lease: "l1" });
    // Written again in its place, both halves at once, and the place closes: nothing opens on
    // "abcd" as if it were the tail.
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    expect(s.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l2", seq: 2, text: "ab\n\ncd" },
      { t: "release", lease: "l2" },
    ]);
    // Refused again: kept on the page with Copy, and nothing more is asked for or sent.
    s.frame({ t: "error", code: "rate_limited" });
    s.frame({ t: "released", lease: "l2" });
    const sent = s.sent.length;
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(s.sent).toHaveLength(sent);
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    const bar = document.querySelector(".plinth-slides__kept");
    expect(bar?.textContent).toContain(DECK_WORDS.stuckKept);
    expect(bar?.querySelector("button")?.textContent).toBe(DECK_WORDS.copy);
  });

  it("keeps a split to copy when a co-editor filled the deck before the room read it", () => {
    // A second slide fills the deck to just under its size limit.
    const filler = "x".repeat(LIMITS.maxSlidesBytes - DECK.length - "\n---\n".length - 8);
    const deck = `${DECK}\n---\n${filler}`;
    start(deck);
    const s = sock("doc");
    welcomeDoc(s, deck, false);
    openPara(s);
    enterAt(editable(), 2);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "ab\n\ncd" }]);
    // Someone else's op lands first and takes the room left, so the room refuses the split.
    s.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 4,
      del: 0,
      ins: "1234567",
      by: "s2",
    });
    s.frame({ t: "error", code: "too_large" });
    s.frame({ t: "released", lease: "l1" });
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    const asked = s.sent.at(-1);
    if (asked?.t === "lease") {
      expect(asked).toEqual({ t: "lease", rev: 4, start: 2, end: 3 });
      s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    }
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    // "abcd" is never edited as the tail: the split is not sent again into a full deck, and is
    // kept on the page with Copy.
    expect(edits(s)).toHaveLength(1);
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    expect(document.querySelector(".plinth-slides__kept")?.textContent).toContain(
      DECK_WORDS.stuckKept,
    );
  });

  it("writes a closed block's edit again when the room let its lease go without taking it", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    openPara(s);
    const ed = editable();
    ed.textContent = "abcd typed";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    // Escape: what waits is sent, and the lease let go, before the room answers either.
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l1", seq: 1, text: "abcd typed" },
      { t: "release", lease: "l1" },
    ]);
    s.frame({ t: "error", code: "rate_limited" });
    s.frame({ t: "released", lease: "l1" });
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    expect(s.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l2", seq: 2, text: "abcd typed" },
      { t: "release", lease: "l2" },
    ]);
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
  });
});

describe("typing goes back only into the kind of part it was typed in", () => {
  const edits = (s: FakeSocket) => s.sent.filter((f) => f.t === "edit");
  const leases = (s: FakeSocket) => s.sent.filter((f) => f.t === "lease");
  /** Sets the text of the first editor in `host` (".plinth-slides__open" or the notes'). */
  const type = (host: string, text: string) => {
    const ed = document.querySelector(`${host} [contenteditable="true"]`);
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    ed.textContent = text;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const SLIDE = ".plinth-slides__open";
  const NOTES = ".plinth-slides__notepad-edit";
  /** The socket drops and the next one is welcomed with `text`. */
  const reconnect = (text: string) => {
    sock("doc").drop();
    vi.advanceTimersByTime(5000);
    const s = sock("doc");
    welcomeDoc(s, text, true, `g${FakeSocket.all.length}`);
    return s;
  };
  /** Opens raw slide `n`'s speaker notes, granted as l1 on `start`..`end`. */
  const openNotes = (s: FakeSocket, n: number, start: number, end: number) => {
    app({ type: "edit", on: true });
    app({ type: "goto", slide: n });
    (
      document.querySelector(
        `.plinth-slides__frame[data-n="${n}"] .plinth-slides__notepad-body`,
      ) as HTMLElement | null
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start, end });
    s.frame({ t: "leased", lease: "l1", start, end, holder: YOU.id, by: YOU.email });
  };

  // Slide 1's paragraph "Hello" (line 2), and its speaker notes repeat it (line 6).
  const DECK = "# One\n\nHello\n\nNote: intro\n\nHello";

  const openHello = (s: FakeSocket) => {
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
  };

  it("never takes a slide's block again on speaker notes that repeat its text", () => {
    start(DECK);
    const first = sock("doc");
    welcomeDoc(first, DECK, false);
    openHello(first);
    type(SLIDE, "Goodbye");
    // The socket drops before the debounce, and meanwhile a co-editor deletes the slide's "Hello".
    const s = reconnect("# One\n\nNote: intro\n\nHello");
    // Not the notes' "Hello" (now line 4): a new block on the slide, after its title.
    expect(leases(s)).toEqual([{ t: "lease", rev: 3, start: 1, end: 1 }]);
    s.frame({ t: "leased", lease: "l2", start: 1, end: 1, holder: YOU.id, by: YOU.email });
    // The editor is on the slide, where the person sees it.
    expect(
      document.querySelector(`.plinth-slides__frame[data-n="1"] .plinth-slides__slide ${SLIDE}`),
    ).not.toBeNull();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "\nGoodbye" }]);
  });

  it("takes the block again on its slide, not a nearer copy in another slide's notes", () => {
    const deck = "# Zero\n\nNote:\nHello\n---\n# One\n\nHello";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    app({ type: "edit", on: true });
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    expect(first.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 7, end: 8 });
    first.frame({ t: "leased", lease: "l1", start: 7, end: 8, holder: YOU.id, by: YOU.email });
    type(SLIDE, "Goodbye");
    // Slide 1's notes grew meanwhile: their "Hello" is on line 7 now, the slide's on line 11.
    const s = reconnect("# Zero\n\nNote:\nA\n\nB\n\nHello\n---\n# One\n\nHello");
    expect(leases(s)).toEqual([{ t: "lease", rev: 3, start: 11, end: 12 }]);
    s.frame({ t: "leased", lease: "l2", start: 11, end: 12, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([{ t: "edit", lease: "l2", seq: 1, text: "Goodbye" }]);
  });

  it("never opens a slide's block on speaker notes lines granted for it", () => {
    start(DECK);
    const s = sock("doc");
    welcomeDoc(s, DECK, false);
    app({ type: "edit", on: true });
    (
      document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
        | HTMLElement
        | undefined
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    // A co-editor deletes the slide's "Hello", and the grant names the notes' "Hello".
    s.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 0,
      del: 4,
      ins: "# One\n",
      by: "s2",
    });
    s.frame({ t: "leased", lease: "l1", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    expect(document.querySelector(SLIDE)).toBeNull();
    expect(document.querySelector(NOTES)).toBeNull();
    expect(edits(s)).toEqual([]);
  });

  it("writes speaker notes that repeat the slide's text back into the notes, never the slide", () => {
    const deck = "# One\n\nHello\n\nNote:\nHello";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    openNotes(first, 1, 4, 6);
    type(NOTES, "Goodbye");
    // A co-editor rewrote the notes meanwhile: they are not found as they were.
    const s = reconnect("# One\n\nHello\n\nNote: Hello");
    // Never the slide's "Hello" (line 2): the slide's notes, with the kept text after them.
    expect(leases(s)).toEqual([{ t: "lease", rev: 3, start: 4, end: 5 }]);
    s.frame({ t: "leased", lease: "l2", start: 4, end: 5, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([
      expect.objectContaining({ lease: "l2", text: "Note: Hello\n\nGoodbye" }),
    ]);
  });

  it("writes kept speaker notes after their own slide's notes when the lines moved", () => {
    const deck = "# One\n\nNote:\nFirst\n---\n## Two\n\nNote:\nSay hi";
    start(deck);
    const first = sock("doc");
    welcomeDoc(first, deck, false);
    openNotes(first, 2, 7, 9);
    type(NOTES, "abc");
    // Meanwhile slide 1's notes grew past line 7, where slide 2's notes were, and slide 2's notes
    // were rewritten.
    const s = reconnect("# One\n\nNote:\nFirst\n\nSecond\n\nThird\n---\n## Two\n\nNote: Say hi");
    expect(leases(s)).toEqual([{ t: "lease", rev: 3, start: 11, end: 12 }]);
    s.frame({ t: "leased", lease: "l2", start: 11, end: 12, holder: YOU.id, by: YOU.email });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    expect(edits(s)).toEqual([
      expect.objectContaining({ lease: "l2", text: "Note: Say hi\n\nabc" }),
    ]);
  });
});

describe("typing kept across a reload (the rescue store)", () => {
  // The app's copy, as the app keeps it: merge-only, in its own session storage
  // (components/editor/draft.ts), fed by the frame's `rescue` reports.
  const USER = "u1";
  const ART = "art1";
  const stored = () => readRescueItems(loadRescue(USER, ART)) ?? [];
  const edits = (s: FakeSocket) => s.sent.filter((f) => f.t === "edit");

  /** Boots the deck on `text` with the app keeping the frame's rescue reports. */
  function startKept(text: string) {
    start(text);
    parent.postMessage.mockImplementation((m: Record<string, unknown>) => {
      if (m.type !== "rescue") return;
      const upsert = readRescueItems(m.upsert);
      if (!upsert) throw new Error("bad rescue report");
      mergeRescue(USER, ART, upsert, [
        ...((m.written as string[]) ?? []),
        ...((m.gone as string[]) ?? []),
      ]);
    });
    const s = sock("doc");
    welcomeDoc(s, text, true);
    app({ type: "edit", on: true });
    return s;
  }

  /** A reload: the old frame goes, a new one boots on `text` and is offered what the app kept. */
  function reload(text: string) {
    stop?.();
    stop = undefined;
    const s = startKept(text);
    app({ type: "rescue", items: stored() });
    return s;
  }

  /** Leaves typing in the open editor that cannot be written as Markdown as it stands. */
  const stick = (sel: string) => {
    const ed = document.querySelector(sel);
    if (!(ed instanceof HTMLElement)) throw new Error("not open");
    ed.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
  };

  const NOTES = "# One\n---\n## Two\n\nNote:\nSay hi";

  /** Opens slide 2's speaker notes (lines 4 and 5) and leaves typing in them it cannot write. */
  const stickNotes = (s: FakeSocket) => {
    app({ type: "goto", slide: 2 });
    (
      document.querySelector(
        '.plinth-slides__frame[data-n="2"] .plinth-slides__notepad-body',
      ) as HTMLElement | null
    )?.click();
    expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 4, end: 6 });
    s.frame({ t: "leased", lease: "l1", start: 4, end: 6, holder: YOU.id, by: YOU.email });
    stick('.plinth-slides__notepad-edit [contenteditable="true"]');
  };

  beforeEach(() => sessionStorage.clear());

  it("writes a slide's kept text back on its slide after a reload", () => {
    const DECK = "# One\n---\n## Two";
    const s = startKept(DECK);
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2') as
        | HTMLElement
        | undefined
    )?.click();
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    stick('.plinth-slides__open [contenteditable="true"]');
    expect(edits(s)).toEqual([]);
    expect(stored()).toEqual([
      expect.objectContaining({ text: "## abc", near: 2, part: "slide", slide: 2, ref: "## Two" }),
    ]);
    // The page is reloaded (after its warning): the new frame writes it back, as a new block below
    // slide 2's title, and closes it.
    const again = reload(DECK);
    expect(again.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    again.frame({ t: "leased", lease: "l2", start: 3, end: 3, holder: YOU.id, by: YOU.email });
    expect(again.sent.slice(-2)).toEqual([
      expect.objectContaining({ t: "edit", lease: "l2", text: "\n## abc" }),
      { t: "release", lease: "l2" },
    ]);
    expect(stored()).toHaveLength(1);
    // Kept until the room says it holds it.
    const seq = (edits(again)[0] as { seq: number }).seq;
    again.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l2",
      seq,
      start: 3,
      del: 0,
      ins: "\n## abc",
      by: YOU.id,
    });
    expect(stored()).toEqual([]);
  });

  it("writes speaker notes kept back into the same slide's notes, never onto the slide", () => {
    const s = startKept(NOTES);
    stickNotes(s);
    expect(stored()).toEqual([
      expect.objectContaining({ text: "abc", part: "notes", slide: 2, ref: "## Two" }),
    ]);
    const again = reload(NOTES);
    // The notes are asked for, not a place on the slide.
    expect(again.sent.filter((f) => f.t === "lease")).toEqual([
      { t: "lease", rev: 3, start: 4, end: 6 },
    ]);
    again.frame({ t: "leased", lease: "l2", start: 4, end: 6, holder: YOU.id, by: YOU.email });
    expect(again.sent.slice(-2)).toEqual([
      expect.objectContaining({ t: "edit", lease: "l2", text: "Note:\nSay hi\n\nabc" }),
      { t: "release", lease: "l2" },
    ]);
  });

  it("keeps notes kept to copy when their slide has no notes now, and writes none on it", () => {
    const s = startKept(NOTES);
    stickNotes(s);
    const again = reload("# One\n---\n## Two");
    expect(again.sent.some((f) => f.t === "lease")).toBe(false);
    const bar = document.querySelector(".plinth-slides__kept");
    expect(bar?.textContent).toContain(DECK_WORDS.stuckKept);
    expect(bar?.querySelector("button")?.textContent).toBe(DECK_WORDS.copy);
    // Still in the app's store, for the next reload.
    expect(stored()).toHaveLength(1);
  });

  describe("a block whose typing the deck at its size limit cannot take", () => {
    const DECK = "# Intro\n\nabcd";
    // A second slide fills the deck to 8 bytes under its size limit.
    const filler = "x".repeat(LIMITS.maxSlidesBytes - DECK.length - "\n---\n".length - 8);
    const FULL = `${DECK}\n---\n${filler}`;
    const TYPED = "abcd typed a lot of words";
    const KEPT = expect.objectContaining({ text: TYPED, part: "slide", slide: 1 });
    const lastLive = () =>
      parent.postMessage.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((m) => m.type === "live")
        .at(-1);

    /** Opens slide 1's paragraph, is granted its lease, and types more than the deck can take. */
    const typeTooMuch = (s: FakeSocket) => {
      (
        document.querySelector('.plinth-slides__frame[data-n="1"] .plinth-slides__slide p') as
          | HTMLElement
          | undefined
      )?.click();
      expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
      s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
      const ed = document.querySelector('.plinth-slides__open [contenteditable="true"]');
      if (!(ed instanceof HTMLElement)) throw new Error("not open");
      ed.textContent = TYPED;
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      return ed;
    };

    const pressEscape = (ed: HTMLElement) =>
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const ways: [string, (ed: HTMLElement) => void][] = [
      ["Escape", pressEscape],
      [
        "Escape after the pause",
        (ed) => {
          vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
          // Refused here: the block stays open with the typing.
          expect(ed.textContent).toBe(TYPED);
          expect(document.querySelector(".plinth-slides__open")).not.toBeNull();
          pressEscape(ed);
        },
      ],
      ["Done", () => app({ type: "edit", on: false })],
    ];

    it.each(ways)("keeps it to copy, and in the store, when it closes by %s", async (_, end) => {
      const s = startKept(FULL);
      end(typeTooMuch(s));
      // Nothing is sent and the lease is let go; once the room answers, the place is asked for
      // again to write what was typed there, as for an edit the room refused.
      expect(edits(s)).toEqual([]);
      expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
      expect(stored()).toEqual([KEPT]);
      s.frame({ t: "released", lease: "l1" });
      expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
      s.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: YOU.id, by: YOU.email });
      // Still too large: not sent, kept on the page with Copy and in the app's store.
      expect(edits(s)).toEqual([]);
      expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l2" });
      s.frame({ t: "released", lease: "l2" });
      const sent = s.sent.length;
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      expect(s.sent).toHaveLength(sent);
      expect(document.querySelector(".plinth-slides__open")).toBeNull();
      const bar = document.querySelector(".plinth-slides__kept");
      expect(bar?.textContent).toContain(DECK_WORDS.stuckKept);
      expect(bar?.querySelector("button")?.textContent).toBe(DECK_WORDS.copy);
      expect(stored()).toEqual([KEPT]);
      await Promise.resolve();
      expect(lastLive()?.unflushed).toBe(true);
    });

    it("counts it as unsent, and keeps it in the store, while the block stays open", async () => {
      const s = startKept(FULL);
      typeTooMuch(s);
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      expect(edits(s)).toEqual([]);
      await Promise.resolve();
      expect(lastLive()?.unflushed).toBe(true);
      expect(stored()).toEqual([KEPT]);
    });

    it("writes it again when the room takes the quiet lease over", () => {
      const s = startKept(FULL);
      typeTooMuch(s);
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      // Nothing was sent, so the room saw the lease idle and gave it to someone else.
      s.frame({ t: "lease_lost", lease: "l1", reason: "takeover" });
      expect(document.querySelector(".plinth-slides__open")).toBeNull();
      expect(stored()).toEqual([KEPT]);
      // Asked for as a new block below the one taken over.
      expect(s.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 3, end: 3 });
    });

    it("drops nothing kept once the typing fits again and is sent", () => {
      const s = startKept(FULL);
      const ed = typeTooMuch(s);
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      ed.textContent = "abcd ok";
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      pressEscape(ed);
      expect(edits(s)).toEqual([{ t: "edit", lease: "l1", seq: 1, text: "abcd ok" }]);
      s.frame({
        t: "op",
        gen: "g1",
        rev: 4,
        lease: "l1",
        seq: 1,
        start: 2,
        del: 1,
        ins: "abcd ok",
        by: YOU.id,
      });
      s.frame({ t: "released", lease: "l1" });
      // Written: nothing is asked for again, kept on the page or in the store.
      expect(s.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
      expect(document.querySelector(".plinth-slides__kept")).toBeNull();
      expect(stored()).toEqual([]);
    });
  });

  it("drops what it kept from the store when the unpublished changes are discarded", () => {
    const DECK = "# One\n---\n## Two";
    const s = startKept(DECK);
    app({ type: "goto", slide: 2 });
    (
      document.querySelector('.plinth-slides__frame[data-n="2"] .plinth-slides__slide h2') as
        | HTMLElement
        | undefined
    )?.click();
    s.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: YOU.id, by: YOU.email });
    stick('.plinth-slides__open [contenteditable="true"]');
    expect(stored()).toHaveLength(1);
    s.frame({ t: "lease_lost", lease: "l1", reason: "closed" });
    s.frame({ t: "reset", version: 1, gen: "g1", rev: 4, why: "discarded" });
    s.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: DECK });
    expect(stored()).toEqual([]);
  });
});
