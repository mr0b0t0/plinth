// The doc renderer in a room, end to end inside the frame: what it tells the app about typing on
// its way (the save status, and how long Publish waits), and how an open block is taken again after
// the socket drops before the room wrote the block's last edit to D1.
import { RENDERER_MESSAGE_SOURCE, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { BLOCK_REPLACED, EDIT_DEBOUNCE_MS } from "./edit.ts";

const APP = "https://plinth.example.com";
const base = { source: RENDERER_MESSAGE_SOURCE, v: 1 };

interface FakeSocket {
  url: string;
  sent: string[];
  onmessage?: (e: MessageEvent) => void;
  onclose?: (e: { code: number }) => void;
}

let sockets: FakeSocket[];
let toApp: { mock: { calls: unknown[][] }; mockRestore: () => void };
let stop: (() => void) | undefined;

function root(): HTMLElement {
  const el = document.getElementById("__plinth-doc");
  if (!el) throw new Error("no root");
  return el;
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin: APP, source: window.parent }));
}

/** The frame's last `live` status for the app. */
function lastLive(): Record<string, unknown> {
  const calls = toApp.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((m) => m?.type === "live");
  const last = calls.at(-1);
  if (!last) throw new Error("no live status");
  return last;
}

function frame(i: number, f: unknown): void {
  sockets[i]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(f) }));
}

function sent(i: number, t: string): Record<string, unknown>[] {
  return (sockets[i]?.sent ?? []).map((s) => JSON.parse(s)).filter((f) => f.t === t);
}

function welcome(i: number, text: string, rev: number, flushed: number, gen = "g", base = 1): void {
  frame(i, {
    t: "welcome",
    v: 1,
    you: { id: `s${i}`, email: "ada@example.org", right: "write" },
    gen,
    rev,
    base_version: base,
    flushed_rev: flushed,
    conflict_version: null,
    last_by_you: false,
    leases: [],
    peers: [],
  });
  frame(i, { t: "text", gen, part: 0, of: 1, chunk: text });
}

/** The room's answer to socket `i`'s last edit: its `op`, at rev `rev`. */
function ackEdit(i: number, rev: number): void {
  const e = sent(i, "edit").at(-1) as { lease: string; seq: number; text: string; id: number };
  frame(i, {
    t: "op",
    gen: "g",
    rev,
    lease: e.lease,
    start: leaseStart,
    del: leaseLen,
    ins: e.text,
    by: `s${i}`,
    seq: e.seq,
    re: e.id,
  });
  leaseLen = e.text.split("\n").length;
}

/** The lease granted last: its first line, how many lines it has now, its end when granted. */
let leaseStart = 0;
let leaseLen = 0;
let leaseEnd = 0;

/** Grants socket `i`'s last lease request. */
function grant(i: number, id: string): void {
  const l = sent(i, "lease").at(-1) as { start: number; end: number; id: number };
  leaseStart = l.start;
  leaseEnd = l.end;
  leaseLen = l.end - l.start;
  frame(i, {
    t: "leased",
    lease: id,
    start: l.start,
    end: l.end,
    holder: `s${i}`,
    by: "ada@example.org",
    re: l.id,
  });
}

/** Types `text` into the open block's editable `el` as a browser would. */
function type(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Types over the innermost element of the open block whose text is `from`. */
function retype(open: HTMLElement, from: string, to: string): void {
  const el = [...open.querySelectorAll<HTMLElement>("*")].findLast((e) => e.textContent === from);
  if (!el) throw new Error(`no "${from}" in the open block`);
  type(el, to);
}

function mountRoom(): void {
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
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      sent: string[] = [];
      onmessage?: (e: MessageEvent) => void;
      onclose?: (e: { code: number }) => void;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      send(s: string) {
        this.sent.push(s);
      }
      close() {}
    },
  );
  toApp = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  mountRoom();
  stop = boot(window);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  toApp.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Opens the block `selector` finds and grants its lease. */
async function openBlock(selector: string): Promise<HTMLElement> {
  (root().querySelector(selector) as HTMLElement).click();
  grant(0, "l1");
  await Promise.resolve();
  const el = root().querySelector<HTMLElement>('.plinth-doc__open [contenteditable="true"]');
  if (!el) throw new Error("the block did not open");
  return el;
}

describe("doc renderer in a room: the status the app shows while typing", () => {
  it("is not left saying the typing is on its way when a keystroke changes no Markdown", async () => {
    welcome(0, "# Plan\n\nFirst paragraph.\n\nSecond.", 1, 1);
    post({ ...base, type: "edit", on: true });
    const el = await openBlock("p");
    type(el, "First paragraph. More");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    ackEdit(0, 2);
    frame(0, { t: "flushed", rev: 2 });
    await Promise.resolve();
    expect(lastLive()).toMatchObject({ dirty: true, unflushed: false });
    // A space at the end: the block's Markdown is the same, so nothing is sent.
    type(el, "First paragraph. More ");
    await Promise.resolve();
    expect(lastLive().unflushed).toBe(true);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    await Promise.resolve();
    expect(sent(0, "edit")).toHaveLength(1);
    // The room holds every change: the bar must not keep saying "Saving…".
    expect(lastLive().unflushed).toBe(false);
  });

  it("says a change is pending until the room acknowledged it, so Publish waits for it", async () => {
    welcome(0, "# Plan\n\nFirst paragraph.\n\nSecond.", 1, 1);
    post({ ...base, type: "edit", on: true });
    const el = await openBlock("p");
    await Promise.resolve();
    expect(lastLive().pending).toBeUndefined();
    type(el, "First paragraph. More");
    await Promise.resolve();
    // In the send delay.
    expect(lastLive().pending).toBe(true);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    await Promise.resolve();
    // Sent, and not acknowledged yet: a checkpoint taken now might not have it.
    expect(sent(0, "edit")).toHaveLength(1);
    expect(lastLive().pending).toBe(true);
    ackEdit(0, 2);
    await Promise.resolve();
    expect(lastLive().pending).toBeUndefined();
  });
});

describe("doc renderer in a room: an open block after the socket drops", () => {
  // The socket closes before the room wrote the block's last edit to D1. Whatever the room holds
  // when it comes back (the edit it acknowledged, the edit whose answer was lost with the socket,
  // or, reloaded from D1 after an eviction, the block from before the edit), the block is taken
  // again where it is and written over, never added a second time as a new block beside it.
  const cases: [string, string, string, string][] = [
    [
      "a table",
      "Intro.\n\n| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n\nAfter.",
      "td",
      "Apples",
    ],
    ["a paragraph", "Intro.\n\nMiddle.\n\nAfter.", "p:nth-of-type(2)", "Middle."],
    ["a list", "Intro.\n\n- one\n- two\n\nAfter.", "ul", "two"],
    ["a quote", "Intro.\n\n> quoted\n\nAfter.", "blockquote", "quoted"],
  ];
  const rooms = ["acknowledged", "unanswered", "evicted"] as const;
  for (const [name, text, selector, words] of cases) {
    for (const room of rooms) {
      it(`takes ${name} again in place, not as a copy (edit ${room})`, async () => {
        welcome(0, text, 1, 1);
        post({ ...base, type: "edit", on: true });
        (root().querySelector(selector) as HTMLElement).click();
        grant(0, "l1");
        await Promise.resolve();
        const open = root().querySelector<HTMLElement>(".plinth-doc__open");
        if (!open) throw new Error("the block did not open");
        retype(open, words, `${words} edited`);
        vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
        if (room === "acknowledged") ackEdit(0, 2);
        const edited = (sent(0, "edit").at(-1) as { text: string }).text;
        sockets[0]?.onclose?.({ code: 1006 });
        vi.advanceTimersByTime(60_000);
        expect(sockets).toHaveLength(2);
        const lines = text.split("\n");
        const roomText =
          room === "evicted"
            ? text
            : [...lines.slice(0, leaseStart), ...edited.split("\n"), ...lines.slice(leaseEnd)].join(
                "\n",
              );
        welcome(1, roomText, room === "evicted" ? 1 : 2, 1);
        await Promise.resolve();
        const again = sent(1, "lease");
        expect(again).toHaveLength(1);
        // The block's own lines, not an insert point next to them.
        const n = room === "evicted" ? leaseEnd - leaseStart : edited.split("\n").length;
        expect(again[0]).toMatchObject({ start: leaseStart, end: leaseStart + n });
        grant(1, "l2");
        await Promise.resolve();
        vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
        // What was typed goes over the block (a room that holds it already needs nothing sent).
        const writes = sent(1, "edit").map((e) => e.text);
        expect(writes).toEqual(room === "evicted" ? [edited] : []);
        expect(root().textContent?.split(`${words} edited`)).toHaveLength(2);
      });
    }
  }
});

describe("doc renderer in a room: an open block when a newer version replaces the lines", () => {
  const TABLE = "| Name | Qty |\n| --- | --- |\n| Apples | 3 |";
  const V1 = `# Plan\n\nIntro.\n\n${TABLE}\n\nAfter.`;
  // The agent's version adds two paragraphs above the table: its lines move down by four.
  const MOVED = `# Plan\n\nIntro.\n\nA new paragraph.\n\nAnother one.\n\n${TABLE}\n\nAfter.`;
  // The agent's version rewrites the doc: the table is gone.
  const GONE = "# Plan\n\nIntro.\n\nA new paragraph.\n\nAnother one.\n\nAfter.";

  async function openTable(): Promise<void> {
    welcome(0, V1, 1, 1);
    post({ ...base, type: "edit", on: true });
    (root().querySelector("td") as HTMLElement).click();
    grant(0, "l1");
    await Promise.resolve();
    expect(root().querySelector(".plinth-doc__open")).not.toBeNull();
  }

  /** The room replaced a clean draft with `text` (an agent's version), as it sends it. */
  function rebasedTo(text: string): void {
    frame(0, { t: "lease_lost", lease: "l1", reason: "rebased" });
    frame(0, { t: "reset", version: 2, gen: "g", rev: 2 });
    frame(0, { t: "text", gen: "g", part: 0, of: 1, chunk: text });
    // Asked for on the lines before the version, with their rev: the room says stale.
    const asked = sent(0, "lease").at(-1) as { id: number; rev: number };
    if (asked.rev === 1) frame(0, { t: "lease_denied", reason: "stale", re: asked.id });
  }

  /** The room reloaded on `text` while it slept, and closed the socket (4412) to resync it. */
  function resyncedTo(text: string): void {
    sockets[0]?.onclose?.({ code: 4412 });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    welcome(1, text, 0, 0, "g2", 2);
  }

  const lastLease = () => [...sent(0, "lease"), ...sent(1, "lease")].at(-1);

  for (const [how, move] of [
    ["merged by the room", rebasedTo],
    ["loaded while the room slept", resyncedTo],
  ] as const) {
    it(`takes the table again where it moved to (${how})`, async () => {
      await openTable();
      move(MOVED);
      await Promise.resolve();
      // The table's own lines in the new version, 8 to 10, never v1's 4 to 6.
      expect(lastLease()).toMatchObject({ start: 8, end: 11 });
    });

    it(`closes the table, untouched, when the version removed it, never writing it back (${how})`, async () => {
      await openTable();
      move(GONE);
      await Promise.resolve();
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      // No insert point asked for, and nothing sent: the old table is not put back.
      expect(lastLease()).toMatchObject({ start: 4, end: 7 });
      expect([...sent(0, "edit"), ...sent(1, "edit")]).toEqual([]);
      expect(root().querySelector(".plinth-doc__open")).toBeNull();
      expect(root().querySelector("table")).toBeNull();
      expect(document.body.textContent).toContain(BLOCK_REPLACED);
    });

    it(`keeps what was typed in the table as a block of its own when the version removed it (${how})`, async () => {
      await openTable();
      retype(root().querySelector(".plinth-doc__open") as HTMLElement, "Apples", "Apples red");
      // Typed, and still in the send delay when the lines change.
      move(GONE);
      await Promise.resolve();
      const asked = lastLease() as { start: number; end: number };
      // An insert point near where it was: the typing is never lost.
      expect(asked.end).toBe(asked.start);
    });
  }
});

describe("doc renderer in a room: other blocks a newer version removes while open", () => {
  const kinds: [string, string, string][] = [
    ["a paragraph", "Intro.\n\nMiddle.\n\nAfter.", "p:nth-of-type(2)"],
    ["a list", "Intro.\n\n- one\n- two\n\nAfter.", "ul"],
    ["a quote", "Intro.\n\n> quoted\n\nAfter.", "blockquote"],
    ["a code block", "Intro.\n\n```\ncode\n```\n\nAfter.", "pre"],
  ];
  for (const [name, text, selector] of kinds) {
    it(`closes ${name}, untouched, rather than writing it back`, async () => {
      welcome(0, text, 1, 1);
      post({ ...base, type: "edit", on: true });
      (root().querySelector(selector) as HTMLElement).click();
      grant(0, "l1");
      await Promise.resolve();
      expect(root().querySelector(".plinth-doc__open")).not.toBeNull();
      sockets[0]?.onclose?.({ code: 4412 });
      vi.advanceTimersByTime(60_000);
      welcome(1, "Intro.\n\nRewritten.\n\nAfter.", 0, 0, "g2", 2);
      await Promise.resolve();
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
      expect(sent(1, "lease")).toEqual([]);
      expect(sent(1, "edit")).toEqual([]);
      expect(root().querySelector(".plinth-doc__open")).toBeNull();
      expect(root().textContent).toContain("Rewritten.");
    });
  }
});
