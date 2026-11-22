// Loss paths for token values, against a room model that answers frames the way
// apps/worker/src/rooms/doc.ts does (lease / edit / release / struct, one lease per socket,
// `released` before the new `leased`, `not_held` for an edit on a lease it already replaced), with
// network latency: the room handles every frame the client has sent so far, then the client gets
// the answers one message (task) at a time, microtasks running between them.
import {
  applyDesignSystemStruct,
  blockLines,
  designSystemToLive,
  dsGet,
  dsLiveSystem,
  dsNodeAtPath,
  joinLines,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  splitLines,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { ASK_TIMEOUT_MS } from "./edit.ts";
import { FIXTURE } from "./testFixture.ts";

const APP = "https://plinth.example.com";
// biome-ignore lint/suspicious/noExplicitAny: test frames
type Json = Record<string, any>;

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: Json[] = [];
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
  frame(f: Json) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** The room, for one client socket (s1) and one other editor (s2, Ben). */
class Room {
  lines: string[];
  rev = 0;
  gen = "g1";
  mine: { id: string; start: number; end: number } | null = null;
  ben: { id: string; start: number; end: number } | null = null;
  frozen: number | null = null;
  n = 0;
  cursor = 0;
  /** Edits to refuse with this error code (by the order they come). */
  refuseNext: string | null = null;
  needsFlush = false;
  flushDue = false;
  ws: FakeSocket;
  constructor(ws: FakeSocket, text: string) {
    this.ws = ws;
    this.lines = splitLines(text);
  }
  welcome(ws: FakeSocket) {
    this.ws = ws;
    this.cursor = 0;
    this.mine = null;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: this.gen,
      rev: this.rev,
      base_version: 4,
      flushed_rev: this.rev,
      conflict_version: this.frozen,
      last_by_you: false,
      leases: this.ben
        ? [{ id: this.ben.id, start: this.ben.start, end: this.ben.end, by: "ben@example.org" }]
        : [],
      peers: this.ben ? [{ id: "s2", email: "ben@example.org", lease: this.ben.id }] : [],
    });
    ws.frame({ t: "text", gen: this.gen, part: 0, of: 1, chunk: joinLines(this.lines) });
  }
  private overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
    return a.start < b.end && b.start < a.end;
  }
  private handle(f: Json, out: Json[]) {
    switch (f.t) {
      case "lease": {
        if (this.frozen !== null) return out.push({ t: "lease_denied", reason: "frozen" });
        if (f.rev !== this.rev) return out.push({ t: "lease_denied", reason: "stale" });
        if (this.ben && this.overlaps(this.ben, f as { start: number; end: number })) {
          return out.push({ t: "lease_denied", reason: "held", by: "ben@example.org" });
        }
        const prev = this.mine?.id;
        this.mine = { id: `L${++this.n}`, start: f.start, end: f.end };
        if (prev) out.push({ t: "released", lease: prev });
        out.push({
          t: "leased",
          lease: this.mine.id,
          start: f.start,
          end: f.end,
          holder: "s1",
          by: "ada@example.org",
        });
        return;
      }
      case "edit": {
        const l = this.mine;
        if (!l || l.id !== f.lease) return out.push({ t: "error", code: "not_held" });
        if (this.frozen !== null) return out.push({ t: "lease_denied", reason: "frozen" });
        if (this.refuseNext) {
          const code = this.refuseNext;
          this.refuseNext = null;
          return out.push({ t: "error", code });
        }
        const ins = blockLines(f.text);
        this.lines = [...this.lines.slice(0, l.start), ...ins, ...this.lines.slice(l.end)];
        this.rev += 1;
        const del = l.end - l.start;
        this.mine = { ...l, end: l.start + ins.length };
        this.needsFlush = true;
        out.push({
          t: "op",
          gen: this.gen,
          rev: this.rev,
          lease: l.id,
          start: l.start,
          del,
          ins: f.text,
          by: "s1",
          seq: f.seq,
        });
        return;
      }
      case "release": {
        if (!this.mine || this.mine.id !== f.lease)
          return out.push({ t: "error", code: "not_held" });
        const id = this.mine.id;
        this.mine = null;
        out.push({ t: "released", lease: id });
        // doc.ts release: `if (this.needsFlush) void this.flushNow()`: D1 is awaited, so the
        // `flushed` frame comes after the frames already queued.
        if (this.needsFlush) this.flushDue = true;
        return;
      }
      case "struct": {
        if (this.frozen !== null) return out.push({ t: "struct_denied", reason: "frozen" });
        if (f.rev !== this.rev) return out.push({ t: "struct_denied", reason: "stale" });
        const r = applyDesignSystemStruct(this.lines, f.op);
        if (typeof r === "string") return out.push({ t: "error", code: "invalid" });
        if (this.mine) {
          out.push({ t: "released", lease: this.mine.id });
          this.mine = null;
        }
        this.lines = r.lines;
        this.rev += 1;
        out.push({ t: "struct", gen: this.gen, rev: this.rev, op: f.op, by: "s1" });
        this.needsFlush = true;
        return;
      }
      case "takeover": {
        // doc.ts takeover: no holder of that lease (it was released meanwhile) is `not_held`.
        if (!this.ben || this.ben.id !== f.lease) return out.push({ t: "error", code: "not_held" });
        const { start, end } = this.ben;
        this.ben = null;
        const prev = this.mine?.id;
        this.mine = { id: `L${++this.n}`, start, end };
        if (prev) out.push({ t: "released", lease: prev });
        out.push({ t: "released", lease: f.lease });
        out.push({
          t: "leased",
          lease: this.mine.id,
          start,
          end,
          holder: "s1",
          by: "ada@example.org",
        });
        return;
      }
      case "keep":
        if (!this.mine || this.mine.id !== f.lease)
          return out.push({ t: "error", code: "not_held" });
        return out.push({ t: "kept", lease: f.lease });
      case "sync":
        return;
    }
  }
  /** Handle what the client sent so far, then deliver the answers one message at a time. */
  async pump(): Promise<boolean> {
    const n = process.env.ONE ? 1 : this.ws.sent.length - this.cursor;
    const batch = this.ws.sent.slice(this.cursor, this.cursor + n);
    this.cursor += batch.length;
    if (batch.length === 0) return false;
    const out: Json[] = [];
    for (const f of batch) {
      const before = out.length;
      this.handle(f, out);
      if (process.env.TRACE)
        console.log(
          "C>",
          JSON.stringify(f).slice(0, 90),
          "\n   R<",
          out
            .slice(before)
            .map((o) => JSON.stringify(o).slice(0, 70))
            .join(" | "),
        );
    }
    if (this.flushDue) {
      this.flushDue = false;
      this.needsFlush = false;
      out.push({ t: "flushed", rev: this.rev });
    }
    for (const o of out) {
      this.ws.frame(o);
      await flush();
    }
    return true;
  }
  /** Ben replaces the value at `path` (he leases it, edits, releases). */
  async benSets(path: (string | number)[], value: unknown) {
    const node = dsNodeAtPath(this.lines, path);
    if (!node) throw new Error("no node");
    const text = JSON.stringify(value);
    const first = this.lines[node.start] as string;
    // The value's own lines, canonically, as dsNodeLines would write it (one-line values here).
    const key = first.slice(0, first.indexOf(":") + 2);
    const comma = (this.lines[node.end - 1] as string).endsWith(",") ? "," : "";
    const ins = [`${key}${text}${comma}`];
    this.lines = [...this.lines.slice(0, node.start), ...ins, ...this.lines.slice(node.end)];
    this.rev += 1;
    this.ws.frame({
      t: "leased",
      lease: "B9",
      start: node.start,
      end: node.end,
      holder: "s2",
      by: "ben@example.org",
    });
    await flush();
    this.ws.frame({
      t: "op",
      gen: this.gen,
      rev: this.rev,
      lease: "B9",
      start: node.start,
      del: node.end - node.start,
      ins: ins.join("\n"),
      by: "s2",
    });
    await flush();
    this.ws.frame({ t: "released", lease: "B9" });
    await flush();
  }
  /** Ben types somewhere else (the guidelines' last line): only the rev moves. */
  async benTypesElsewhere() {
    const at = this.lines.length - 1;
    const text = `${this.lines[at]}!`;
    this.lines[at] = text;
    this.rev += 1;
    this.ws.frame({
      t: "op",
      gen: this.gen,
      rev: this.rev,
      lease: "B8",
      start: at,
      del: 1,
      ins: text,
      by: "s2",
    });
    await flush();
  }
  /** An agent's version merges in cleanly: every lease ends (rebased), a new gen, the text again. */
  async rebase() {
    if (this.mine) {
      this.ws.frame({ t: "lease_lost", lease: this.mine.id, reason: "rebased" });
      this.mine = null;
      await flush();
    }
    this.gen = `g${Number(this.gen.slice(1)) + 1}`;
    this.rev += 1;
    this.ws.frame({ t: "rebased", version: 5, gen: this.gen, rev: this.rev });
    await flush();
    this.ws.frame({ t: "text", gen: this.gen, part: 0, of: 1, chunk: joinLines(this.lines) });
    await flush();
  }
  value(path: (string | number)[]): unknown {
    return dsGet(dsLiveSystem(this.lines), path);
  }
}

/** Pump until nothing more is sent, letting the 1.5 s let-go timers run. */
async function settle(room: Room) {
  for (let i = 0; i < 60; i++) {
    const any = await room.pump();
    vi.advanceTimersByTime(2000);
    await flush();
    if (!any && room.ws.sent.length === room.cursor) return;
    if (process.env.ONE) i = Math.min(i, 10);
  }
}

const SOURCE = JSON.stringify(FIXTURE);
const LIVE = designSystemToLive(SOURCE);
let stop: (() => void) | null = null;
let posted: Json[] = [];
beforeEach(() => {
  posted = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((m: unknown) => {
    posted.push(m as Json);
  });
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeSocket.all = [];
  document.body.innerHTML = "";
});
const send = (m: Json) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
      origin: APP,
      source: window.parent as never,
    }),
  );
const root = () => document.getElementById("__plinth-design_system") as HTMLElement;
const row = (path: string) =>
  root().querySelector<HTMLElement>(`.ds-token[data-path="${path}"]`) as HTMLElement;
const notice = () => document.querySelector(".ds-notice")?.textContent ?? "";
const lastLive = () => posted.filter((m) => m.type === "live").at(-1);

async function start(): Promise<Room> {
  const html = typedShellHtml(TYPE_REGISTRY.design_system, {
    title: "T",
    text: SOURCE,
    base: "",
    appOrigin: APP,
    live: "room",
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0] ?? "";
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] ?? "";
  document.body.innerHTML = main + data;
  stop = boot(window, { connect: () => new FakeSocket() as unknown as WebSocket });
  const ws = FakeSocket.all.at(-1) as FakeSocket;
  const room = new Room(ws, LIVE);
  room.welcome(ws);
  send({ type: "edit", on: true });
  await flush();
  return room;
}

const change = (path: string, value: string) => {
  const field = row(path).querySelector<HTMLInputElement>('input[type="text"]');
  if (!field) throw new Error(`no field for ${path}`);
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
};
const BG = ["tokens", "color", "bg", "$value"];
const FG = ["tokens", "color", "fg", "$value"];

describe("token values against the room's own answers", () => {
  it("baseline: one value is written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
  });

  it("two tokens in a row, both free: both are written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    change("color.fg", "#101010");
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
    expect(room.value(FG)).toBe("#101010");
  });

  it("two tokens in a row while someone else types elsewhere (both requests stale): both are written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    change("color.fg", "#101010");
    // Ben's keystroke reaches the room before the two lease requests.
    await room.benTypesElsewhere();
    await settle(room);
    expect(room.value(FG)).toBe("#101010");
    expect(room.value(BG)).toBe("#fafafa");
    expect(lastLive()).toMatchObject({ unflushed: false });
  });

  it("two tokens in a row, the first held by Ben: the second is still written", async () => {
    const room = await start();
    const bg = dsNodeAtPath(room.lines, BG);
    if (!bg) throw new Error("no node");
    room.ben = { id: "B1", start: bg.start, end: bg.end };
    change("color.bg", "#fafafa");
    change("color.fg", "#101010");
    await settle(room);
    if (process.env.TRACE) console.log("NOTICE", notice());
    // Ben holds bg: that one is refused (and said). fg was free and must be written.
    expect(room.value(FG)).toBe("#101010");
  });

  it("a shadow's X then Y, the focus staying in the row: both parts are kept", async () => {
    const room = await start();
    const r = row("shadow.card");
    const x = r.querySelector<HTMLInputElement>('[aria-label="shadow.card x: number"]');
    const y = r.querySelector<HTMLInputElement>('[aria-label="shadow.card y: number"]');
    if (!x || !y) throw new Error("no part fields");
    x.focus();
    x.value = "2";
    x.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(room);
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetX"])).toBe("2px");
    // Tab to Y (same row: the row is not drawn again under the focus).
    y.focus();
    y.value = "4";
    y.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(room);
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetY"])).toBe("4px");
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetX"])).toBe("2px");
  });

  it("a value refused as invalid is not written later over a newer value of Ben's", async () => {
    const room = await start();
    room.refuseNext = "invalid";
    change("color.bg", "#fafafa");
    await settle(room);
    expect(notice()).toContain("wasn't kept");
    expect(room.value(BG)).toBe("#ffffff");
    await room.benSets(BG, "#222222");
    expect(room.value(BG)).toBe("#222222");
    // The socket drops and comes back.
    room.ws.onclose?.({ code: 1006 } as CloseEvent);
    vi.advanceTimersByTime(60_000);
    const next = FakeSocket.all.at(-1) as FakeSocket;
    room.welcome(next);
    await flush();
    await settle(room);
    expect(room.value(BG)).toBe("#222222");
  });

  it("a value waiting for its lease when the draft is frozen for review is kept, not dropped", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    // An agent's version conflicts: the room freezes before it answers the request.
    room.frozen = 5;
    room.ws.frame({ t: "conflict", version: 5 });
    await flush();
    await settle(room);
    expect(lastLive()).toMatchObject({ conflict_version: 5 });
    if (process.env.TRACE) console.log("NOTICE", notice());
    // The value is still something the frame holds (pending), not gone.
    expect(lastLive()).toMatchObject({ unflushed: true });
  });

  /** The room freezes the draft for review while bg's value waits for its lease. */
  async function frozenWithValue() {
    const room = await start();
    change("color.bg", "#fafafa");
    room.frozen = 5;
    room.ws.frame({ t: "conflict", version: 5 });
    await flush();
    await settle(room);
    return room;
  }
  /** The review ends: the room's draft is published, or discarded for the version. */
  async function resolve(room: Room, why: "published" | "discarded") {
    room.frozen = null;
    room.gen = "g2";
    room.rev += 1;
    room.ws.frame({ t: "reset", version: 6, gen: room.gen, rev: room.rev, why });
    await flush();
    room.ws.frame({ t: "text", gen: room.gen, part: 0, of: 1, chunk: joinLines(room.lines) });
    await flush();
    await settle(room);
  }

  it("a value kept through a freeze says so, with Copy, and is written once the draft is kept", async () => {
    const room = await frozenWithValue();
    expect(notice()).toContain("your change isn't in the draft yet");
    const buttons = [...document.querySelectorAll(".ds-notice button")].map((b) => b.textContent);
    expect(buttons).toContain("Copy");
    await resolve(room, "published");
    expect(room.value(BG)).toBe("#fafafa");
    expect(lastLive()).toMatchObject({ unflushed: false });
  });

  it("a value kept through a freeze goes with a discard of the unpublished changes", async () => {
    const room = await frozenWithValue();
    const asked = room.ws.sent.filter((f) => f.t === "lease").length;
    await resolve(room, "discarded");
    expect(room.value(BG)).toBe("#ffffff");
    expect(room.ws.sent.filter((f) => f.t === "lease")).toHaveLength(asked);
    expect(lastLive()).toMatchObject({ unflushed: false });
  });

  it("a value refused as invalid is offered to copy", async () => {
    const room = await start();
    room.refuseNext = "invalid";
    change("color.bg", "#fafafa");
    await settle(room);
    const buttons = [...document.querySelectorAll(".ds-notice button")].map((b) => b.textContent);
    expect(buttons).toContain("Copy");
    expect(lastLive()).toMatchObject({ unflushed: false });
  });

  it("two tokens in a row, then Done: both are written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    change("color.fg", "#101010");
    send({ type: "edit", on: false });
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
    expect(room.value(FG)).toBe("#101010");
    expect(room.mine).toBeNull();
  });

  it("a token added while another's value waits for its lease: the value is written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    room_addToken("color", "extra");
    await settle(room);
    expect(room.value(["tokens", "color", "extra"])).toBeDefined();
    expect(room.value(BG)).toBe("#fafafa");
  });

  it("a token removed while another's value waits for its lease: the value is written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    row("color.old").querySelector<HTMLButtonElement>(".plinth-doc__menu-button")?.click();
    [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")]
      .find((i) => i.textContent === "Remove")
      ?.click();
    [...document.querySelectorAll<HTMLButtonElement>(".ds-form button")]
      .find((b) => b.textContent === "Remove")
      ?.click();
    await settle(room);
    expect(room.value(["tokens", "color", "old"])).toBeUndefined();
    expect(room.value(BG)).toBe("#fafafa");
  });

  it("an agent's version merges in while a value waits for its lease: the value is written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    await room.rebase();
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
  });

  it("an agent's version merges in right after the value's edit went out (before the room had it): written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    // The lease comes; the edit is sent, but the rebase reaches the room first.
    const batch = room.ws.sent.length;
    await room.pump();
    expect(room.ws.sent.slice(batch).some((f) => f.t === "edit")).toBe(true);
    // Drop that edit at the room (it arrives after the rebase: not_held).
    await room.rebase();
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
  });
});

describe("values waiting for their lease, against the room model", () => {
  const drop = async (room: Room) => {
    room.ws.onclose?.({ code: 1006 } as CloseEvent);
    vi.advanceTimersByTime(60_000);
    room.welcome(FakeSocket.all.at(-1) as FakeSocket);
    await flush();
  };
  it("a value asked for, then a drop before the lease: written after the reconnect, and a later change too", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    await drop(room);
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
    change("color.bg", "#f0f0f0");
    await settle(room);
    expect(room.value(BG)).toBe("#f0f0f0");
  });
  it("a value just before Done, lease not yet granted: written", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    send({ type: "edit", on: false });
    await flush();
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
    expect(room.mine).toBeNull();
  });
});

function room_addToken(group: string, name: string) {
  const g = root().querySelector<HTMLElement>(`.ds-group[data-group="${group}"]`);
  g?.querySelector<HTMLButtonElement>(".plinth-doc__menu-button")?.click();
  [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")]
    .find((i) => i.textContent === "Add a token")
    ?.click();
  const form = g?.querySelector<HTMLFormElement>("form.ds-form");
  const input = form?.querySelector<HTMLInputElement>(".ds-form__name");
  if (!form || !input) throw new Error("no add form");
  input.value = name;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("re-review: a takeover the room answers with not_held", () => {
  it("Ada takes over Ben's idle guidelines block just as he lets go: her token values still go", async () => {
    const room = await start();
    const end = room.lines.indexOf("}");
    const at = end + 3; // "One primary button per view."
    room.ben = { id: "B1", start: at, end: at + 1 };
    room.ws.frame({
      t: "leased",
      lease: "B1",
      start: at,
      end: at + 1,
      holder: "s2",
      by: "ben@example.org",
    });
    await flush();
    vi.advanceTimersByTime(61_000);
    const held = root().querySelector<HTMLElement>("[data-text='guidelines'] .plinth-doc__held");
    if (!held) throw new Error("no held block");
    held.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const take = [
      ...document.querySelectorAll<HTMLButtonElement>(".plinth-doc__notice button"),
    ].find((b) => b.textContent === "Take over");
    if (!take) throw new Error("no Take over");
    take.click();
    expect(room.ws.sent.at(-1)).toMatchObject({ t: "takeover", lease: "B1" });
    // Ben lets go first: the room has no holder of B1 when the takeover comes.
    room.ben = null;
    room.ws.frame({ t: "released", lease: "B1" });
    await flush();
    await settle(room);
    change("color.bg", "#fafafa");
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
    change("color.fg", "#101010");
    await settle(room);
    expect(room.value(FG)).toBe("#101010");
  });
});

describe("re-review: a composite another editor changed while Ada is in its row", () => {
  it("Ada's change to X keeps Ben's new blur", async () => {
    const room = await start();
    const r = row("shadow.card");
    const x = r.querySelector<HTMLInputElement>('[aria-label="shadow.card x: number"]');
    if (!x) throw new Error("no x");
    x.focus();
    // Ben changes the blur while Ada's focus is in the row (the row is not drawn again).
    await room.benSets(["tokens", "shadow", "card", "$value"], {
      color: "#0000001f",
      offsetX: "0px",
      offsetY: "1px",
      blur: "9px",
    });
    x.value = "2";
    x.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(room);
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetX"])).toBe("2px");
    expect(room.value(["tokens", "shadow", "card", "$value", "blur"])).toBe("9px");
  });

  it("a part refused while Ben holds the token is not sent again with the next part", async () => {
    const room = await start();
    const node = dsNodeAtPath(room.lines, ["tokens", "shadow", "card", "$value"]);
    if (!node) throw new Error("no node");
    const r = row("shadow.card");
    const x = r.querySelector<HTMLInputElement>('[aria-label="shadow.card x: number"]');
    const y = r.querySelector<HTMLInputElement>('[aria-label="shadow.card y: number"]');
    if (!x || !y) throw new Error("no part fields");
    x.focus();
    room.ben = { id: "B1", start: node.start, end: node.end };
    x.value = "2";
    x.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(room);
    expect(notice()).toContain("ben@example.org is editing this");
    // Ben lets go; Ada, still in the row, sets Y: X is the draft's again, not her refused 2.
    room.ben = null;
    y.focus();
    y.value = "4";
    y.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(room);
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetY"])).toBe("4px");
    expect(room.value(["tokens", "shadow", "card", "$value", "offsetX"])).toBe("0px");
  });
});

describe("a lease request the room never answers", () => {
  it("is given up after a while, and the value asks again", async () => {
    const room = await start();
    change("color.bg", "#fafafa");
    const asked = () => room.ws.sent.filter((f) => f.t === "lease").length;
    expect(asked()).toBe(1);
    // The room never answers it (an error the frame cannot match, or a frame lost).
    room.cursor = room.ws.sent.length;
    vi.advanceTimersByTime(ASK_TIMEOUT_MS + 1);
    await flush();
    expect(asked()).toBe(2);
    await settle(room);
    expect(room.value(BG)).toBe("#fafafa");
  });
});
