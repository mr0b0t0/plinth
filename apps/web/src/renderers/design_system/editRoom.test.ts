// Editing a design system with the room (edit.ts over common/live.ts): a value is leased by its
// own lines and replaced whole, written canonically; struct frames carry the design system's ops,
// and an op the room applies moves the other leases by its line map; the guidelines' blocks are
// leased at their place after the JSON part; a description that is absent is created with set_text
// from its first words, then held by its own line. Frames are checked as the room sends them.
import {
  applyDesignSystemStruct,
  designSystemToLive,
  dsNodeAtPath,
  dsNodeLines,
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  splitLines,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_CLOSE_MS } from "../common/live.ts";
import { EDIT_DEBOUNCE_MS } from "../doc/edit.ts";
import { boot } from "./boot.ts";
import { rescueCode } from "./edit.ts";
import { FIXTURE } from "./testFixture.ts";

const APP = "https://plinth.example.com";
// biome-ignore lint/suspicious/noExplicitAny: test fixtures are walked by path
type Json = Record<string, any>;

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: Json[] = [];
  /**
   * Each frame's `id` (the room answers with it as `re`), kept apart so the frames read as before:
   * `idOf(t)` is the id of the last frame of kind `t` sent.
   */
  ids: { t: string; id: number }[] = [];
  idOf(t: string): number {
    const hit = this.ids.filter((x) => x.t === t).at(-1);
    if (!hit) throw new Error(`no ${t} sent`);
    return hit.id;
  }
  private unId(f: Record<string, unknown>): Record<string, unknown> {
    if (typeof f.id === "number") this.ids.push({ t: String(f.t), id: f.id });
    const { id: _id, ...rest } = f;
    return rest;
  }
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  closed = false;
  send(raw: string) {
    if (raw !== "ping") this.sent.push(this.unId(JSON.parse(raw)));
  }
  close() {
    this.closed = true;
  }
  frame(f: Json) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
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

/** The frame in room mode, and its socket before the room said anything. */
function opened() {
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
  return FakeSocket.all.at(-1) as FakeSocket;
}

/** The room's welcome, then its draft (`text`) in one chunk. */
function welcome(ws: FakeSocket, text = LIVE) {
  ws.frame({
    t: "welcome",
    v: 1,
    you: { id: "s1", email: "ada@example.org", right: "write" },
    gen: "g1",
    rev: 0,
    base_version: 4,
    flushed_rev: 0,
    conflict_version: null,
    last_by_you: false,
    leases: [],
    peers: [],
  });
  ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: text });
}

/** The room's draft and its socket, after welcome and the projection. */
function connected() {
  const ws = opened();
  welcome(ws);
  send({ type: "edit", on: true });
  return ws;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastLive = () => posted.filter((m) => m.type === "live").at(-1);

const lastOf = (ws: FakeSocket, t: string) => ws.sent.filter((f) => f.t === t).at(-1);

describe("with the room", () => {
  it("leases a value's own lines and sends it whole, canonically", () => {
    const ws = connected();
    const field = row("color.bg").querySelector<HTMLInputElement>('input[type="text"]');
    if (!field) throw new Error("no field");
    field.value = "#fafafa";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    const lines = splitLines(LIVE);
    const node = dsNodeAtPath(lines, ["tokens", "color", "bg", "$value"]);
    if (!node) throw new Error("no node");
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 0, start: node.start, end: node.end });
    ws.frame({
      t: "leased",
      lease: "L1",
      start: node.start,
      end: node.end,
      holder: "s1",
      by: "ada@example.org",
    });
    expect(lastOf(ws, "edit")).toMatchObject({
      t: "edit",
      lease: "L1",
      text: dsNodeLines(node, "#fafafa").join("\n"),
    });
  });

  it("sends a design system's op, and moves the other leases by its line map once the room applies it", () => {
    const ws = connected();
    const lines = splitLines(LIVE);
    const end = lines.indexOf("}");
    // Ben holds the guidelines' first line.
    ws.frame({
      t: "leased",
      lease: "B1",
      start: end + 1,
      end: end + 2,
      holder: "s2",
      by: "ben@example.org",
    });
    const menu = row("color.brand.500").querySelector<HTMLButtonElement>(
      ".plinth-doc__menu-button",
    );
    menu?.click();
    [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")]
      .find((i) => i.textContent === "Add a dark value")
      ?.click();
    const op = { op: "set_dark", token: "color.brand.500", value: "#3355ff" };
    expect(lastOf(ws, "struct")).toEqual({ t: "struct", rev: 0, op });
    ws.frame({ t: "struct", gen: "g1", rev: 1, op, by: "s1" });
    const applied = applyDesignSystemStruct(lines, op as never);
    if (typeof applied === "string") throw new Error(applied);
    // The dark value has its control, and Ben's lease is on the same guidelines line, lower down.
    expect(row("color.brand.500").querySelectorAll(".ds-token__side")).toHaveLength(2);
    const holder = document.querySelector("[data-text='guidelines'] .plinth-doc__holder");
    expect(holder?.textContent).toBe("ben@example.org is editing");
    expect(applied.map[end + 1]).toBe(applied.lines.indexOf("}") + 1);
  });

  it("names a guidelines block for Ask an agent as the published version has it", async () => {
    const ws = opened();
    // The room's draft has a paragraph above the published ones.
    const draft = { ...FIXTURE, guidelines: `Draft words first.\n\n${FIXTURE.guidelines}` };
    const text = designSystemToLive(JSON.stringify(draft));
    welcome(ws, text);
    send({ type: "edit", on: true });
    const end = splitLines(text).indexOf("}");
    const p = [...root().querySelectorAll<HTMLElement>("[data-text='guidelines'] p")].find(
      (x) => x.textContent === "One primary button per view.",
    );
    p?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(lastOf(ws, "lease")).toMatchObject({ start: end + 5, end: end + 6 });
    ws.frame({
      t: "leased",
      lease: "L1",
      start: end + 5,
      end: end + 6,
      holder: "s1",
      by: "ada@example.org",
    });
    await tick();
    const menuButton = [
      ...root().querySelectorAll<HTMLElement>("[data-text='guidelines'] .plinth-doc__menu-button"),
    ].at(-1);
    menuButton?.click();
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu [role^='menuitem']")].find(
        (i) => i.textContent === label,
      );
    item("Insert below")?.click();
    item("Image")?.click();
    await tick();
    const ask = posted.filter((m) => m.type === "ask").at(-1);
    // The published guidelines are a heading and this paragraph: it is their second block.
    expect(ask?.anchor).toEqual({
      key: "guidelines:block-2:add-image",
      text: "One primary button per view.",
    });
  });

  it("a lease granted to a part that let go is released when the newer request is refused", async () => {
    const ws = connected();
    const end = splitLines(LIVE).indexOf("}");
    const desc = dsNodeAtPath(splitLines(LIVE), ["components", 0, "description"]);
    if (!desc) throw new Error("no node");
    // The guidelines' paragraph asks, then the description takes the turn and asks too.
    root()
      .querySelector<HTMLElement>("[data-text='guidelines'] p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const first = ws.idOf("lease");
    root()
      .querySelector<HTMLElement>("[data-text='component:button:description'] p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const second = ws.idOf("lease");
    expect(second).not.toBe(first);
    // The room grants the first (nobody's now), then refuses the second: Ben holds it.
    ws.frame({
      t: "leased",
      lease: "L1",
      start: end + 3,
      end: end + 4,
      holder: "s1",
      by: "ada@example.org",
      re: first,
    });
    await tick();
    expect(ws.sent.filter((f) => f.t === "release")).toHaveLength(0);
    ws.frame({ t: "lease_denied", reason: "held", by: "ben@example.org", re: second });
    await tick();
    expect(lastOf(ws, "release")).toEqual({ t: "release", lease: "L1" });
    expect(desc.start).toBeGreaterThan(0);
  });

  it("leases a guidelines block at its place after the JSON part", () => {
    const ws = connected();
    const end = splitLines(LIVE).indexOf("}");
    const p = root().querySelector<HTMLElement>("[data-text='guidelines'] p");
    p?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // "# Using Acme UI", "", "One primary button per view.": the paragraph is the third line.
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 0, start: end + 3, end: end + 4 });
  });

  it("creates an absent description from its first words, then holds its line", () => {
    vi.useFakeTimers();
    const ws = connected();
    const place = root().querySelector<HTMLElement>(
      "[data-text='component:badge:description'] .plinth-doc__placeholder",
    );
    if (!place) throw new Error("no place to write");
    place.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const el = root().querySelector<HTMLElement>(
      "[data-text='component:badge:description'] [contenteditable='true']",
    );
    if (!el) throw new Error("no open block");
    el.textContent = "Marks something new";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    const op = {
      op: "set_text",
      path: "components.badge.description",
      value: "Marks something new",
    };
    expect(lastOf(ws, "struct")).toEqual({ t: "struct", rev: 0, op });
    // Nothing is leased for it before it exists.
    expect(ws.sent.filter((f) => f.t === "lease")).toHaveLength(0);
    ws.frame({ t: "struct", gen: "g1", rev: 1, op, by: "s1" });
    const after = applyDesignSystemStruct(splitLines(LIVE), op as never);
    if (typeof after === "string") throw new Error(after);
    const node = dsNodeAtPath(after.lines, ["components", 1, "description"]);
    if (!node) throw new Error("no node");
    // More was typed meanwhile: the line is leased, and the text sent whole.
    el.textContent = "Marks something new and shiny";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 1, start: node.start, end: node.end });
    ws.frame({
      t: "leased",
      lease: "L2",
      start: node.start,
      end: node.end,
      holder: "s1",
      by: "ada@example.org",
    });
    expect(lastOf(ws, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(node, "Marks something new and shiny").join("\n"),
    });
  });
});

describe("edit mode asked for before the room's draft arrives", () => {
  it("edits once the draft is here, and is not called too large while it is on its way", async () => {
    const ws = opened();
    // `?edit` and a frame reload send this on the frame's load, before the room's welcome.
    send({ type: "edit", on: true, focus: "first" });
    await tick();
    expect(lastLive()).toMatchObject({ editing: true, connected: false });
    expect(lastLive()).not.toHaveProperty("unavailable");
    expect(document.querySelector(".ds-notice")?.textContent ?? "").not.toMatch(/too large/);
    welcome(ws);
    await tick();
    expect(lastLive()).toMatchObject({ editing: true, connected: true });
    expect(lastLive()).not.toHaveProperty("unavailable");
    // The focus asked for with it lands once the editable page is drawn.
    expect(document.activeElement?.classList.contains("ds-name")).toBe(true);
    const field = row("color.bg").querySelector<HTMLInputElement>('input[type="text"]');
    if (!field) throw new Error("no field");
    field.value = "#fafafa";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastOf(ws, "lease")).toMatchObject({ t: "lease", rev: 0 });
  });

  it("checks the size when the draft comes, and says a draft too large to edit is", async () => {
    const ws = opened();
    send({ type: "edit", on: true });
    await tick();
    expect(lastLive()).toMatchObject({ editing: true });
    // Past the projection's line cap.
    welcome(ws, LIVE + "\n".repeat(200_000));
    await tick();
    expect(lastLive()).toMatchObject({ editing: false, unavailable: "too_large" });
    expect(document.querySelector(".ds-notice")?.textContent).toMatch(/too large to edit/);
  });

  it("forgets the check when edit mode ends before the draft comes", async () => {
    const ws = opened();
    send({ type: "edit", on: true });
    send({ type: "edit", on: false });
    welcome(ws, LIVE + "\n".repeat(200_000));
    await tick();
    expect(lastLive()).toMatchObject({ editing: false });
    expect(lastLive()).not.toHaveProperty("unavailable");
  });
});

// The doc editor's rules for typing the page cannot write yet (#97), in the design system's
// formatted texts: the lease is kept in use, the typing is kept to rescue (with the app keeping a
// copy) until the room acknowledges a write of it, a hidden tab keeps its socket, a discard clears
// what is kept, and no Publish goes out without it.
describe("typing the page cannot write yet", () => {
  // Timers are fake; microtasks (the status line, the rescue writes) run as they do.
  const fake = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const END = splitLines(LIVE).indexOf("}");
  const lease = (ws: FakeSocket, id: string, start: number, end: number) =>
    ws.frame({ t: "leased", lease: id, start, end, holder: "s1", by: "ada@example.org" });
  /** The room applies this socket's last edit (on lease `id`, at `start`..`end`) and acks it. */
  let rev = 0;
  const ack = (ws: FakeSocket, id: string, start: number, end: number) => {
    const e = lastOf(ws, "edit") as Json;
    rev += 1;
    ws.frame({
      t: "op",
      gen: "g1",
      rev,
      lease: id,
      start,
      del: end - start,
      ins: e.text,
      by: "s1",
      seq: e.seq,
    });
  };
  beforeEach(() => {
    rev = 0;
  });
  const rescues = () => posted.filter((m) => m.type === "rescue");
  /** Types into the open block what cannot be written as typed (overlapping marks). */
  const stick = (sel: string) => {
    const el = root().querySelector<HTMLElement>(`${sel} [contenteditable='true']`);
    if (!el) throw new Error("no open block");
    el.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    return el;
  };
  /** The guidelines' paragraph, open and held (lease L1), holding such typing. */
  const stuckGuidelines = (ws: FakeSocket) => {
    root()
      .querySelector<HTMLElement>("[data-text='guidelines'] p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    lease(ws, "L1", END + 3, END + 4);
    return stick("[data-text='guidelines']");
  };

  it("keeps a guidelines block's lease in use while such typing waits", async () => {
    fake();
    const ws = connected();
    stuckGuidelines(ws);
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000 * 3);
    expect(ws.sent.filter((f) => f.t === "keep")).toEqual([
      { t: "keep", lease: "L1" },
      { t: "keep", lease: "L1" },
      { t: "keep", lease: "L1" },
    ]);
    // A `keep` the room no longer knows (its lease went first) says nothing.
    ws.frame({ t: "error", code: "not_held" });
    expect(document.querySelector(".ds-notice")).toBeNull();
    await flush();
    expect(lastLive()).toMatchObject({ unsavable: true, unflushed: true });
  });

  it("keeps a description's line in use while such typing waits", () => {
    fake();
    const ws = connected();
    const node = dsNodeAtPath(splitLines(LIVE), ["components", 0, "description"]);
    if (!node) throw new Error("no node");
    root()
      .querySelector<HTMLElement>("[data-text='component:button:description'] p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 0, start: node.start, end: node.end });
    lease(ws, "L1", node.start, node.end);
    stick("[data-text='component:button:description']");
    expect(ws.sent.filter((f) => f.t === "edit")).toHaveLength(0);
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000 * 2);
    expect(ws.sent.filter((f) => f.t === "keep")).toEqual([
      { t: "keep", lease: "L1" },
      { t: "keep", lease: "L1" },
    ]);
  });

  it("keeps such typing to rescue, with the app, until the room acknowledges its write", async () => {
    fake();
    const ws = connected();
    stuckGuidelines(ws);
    await flush();
    const first = rescues()[0];
    expect(first).toMatchObject({ upsert: [{ text: "abc", near: 2 }], written: [], gone: [] });
    const id = first?.upsert[0].id as string;
    expect(id).toMatch(/^g_/);
    // Someone takes the block over: the typing goes in below it, without its formatting.
    ws.frame({ t: "lease_lost", lease: "L1", reason: "takeover" });
    ws.frame({
      t: "leased",
      lease: "B1",
      start: END + 3,
      end: END + 4,
      holder: "s2",
      by: "ben@example.org",
    });
    await flush();
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 0, start: END + 4, end: END + 4 });
    lease(ws, "L2", END + 4, END + 4);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({ lease: "L2" });
    expect((lastOf(ws, "edit") as Json).text).toContain("abc");
    // Not before the room's acknowledgement does it leave the app's store.
    expect(rescues().flatMap((r) => r.written)).toEqual([]);
    ack(ws, "L2", END + 4, END + 4);
    await flush();
    expect(rescues().flatMap((r) => r.written)).toEqual([id]);
  });

  it("writes what the app kept from before a reload into its own text", async () => {
    fake();
    const ws = connected();
    const usage = dsNodeAtPath(splitLines(LIVE), ["components", 0, "usage"]);
    if (!usage) throw new Error("no node");
    const cid = `${rescueCode("component:button:usage")}_r1`;
    send({ type: "rescue", items: [{ id: cid, text: "Kept words", near: 1 }] });
    await flush();
    expect(lastOf(ws, "lease")).toEqual({
      t: "lease",
      rev: 0,
      start: usage.start,
      end: usage.end,
    });
    expect(lastLive()).toMatchObject({ unflushed: true });
    lease(ws, "L1", usage.start, usage.end);
    await flush();
    const sent = lastOf(ws, "edit") as Json;
    expect(JSON.parse(`{${sent.text.trim().replace(/,$/, "")}}`).usage).toBe(
      "- Do: one per view\n\nKept words",
    );
    expect(rescues().flatMap((r) => r.written)).toEqual([]);
    ack(ws, "L1", usage.start, usage.end);
    await flush();
    expect(rescues().flatMap((r) => r.written)).toEqual([cid]);
  });

  it("an item whose text is gone goes into the guidelines, under the id the app has", async () => {
    fake();
    const ws = connected();
    send({ type: "rescue", items: [{ id: "cgone_r9", text: "Orphan words", near: 0 }] });
    await flush();
    const asked = lastOf(ws, "lease") as Json;
    expect(asked.start).toBeGreaterThan(END);
    lease(ws, "L1", asked.start, asked.end);
    await flush();
    expect((lastOf(ws, "edit") as Json).text).toContain("Orphan words");
    ack(ws, "L1", asked.start, asked.end);
    await flush();
    expect(rescues().flatMap((r) => r.written)).toEqual(["cgone_r9"]);
  });

  it("keeps a hidden tab's socket while such typing waits", () => {
    fake();
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const ws = connected();
    stuckGuidelines(ws);
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 10);
    expect(ws.closed).toBe(false);
  });

  it("a discard clears what is kept to rescue, in the app's store too", async () => {
    fake();
    const ws = connected();
    stuckGuidelines(ws);
    await flush();
    const id = rescues()[0]?.upsert[0].id;
    ws.frame({ t: "lease_lost", lease: "L1", reason: "closed" });
    ws.frame({ t: "reset", version: 4, gen: "g2", rev: 0, why: "discarded" });
    ws.frame({ t: "text", gen: "g2", part: 0, of: 1, chunk: LIVE });
    await flush();
    expect(rescues().flatMap((r) => r.gone)).toEqual([id]);
  });

  it("Cmd/Ctrl+S asks for one Publish, and none while a text holds such typing", async () => {
    fake();
    const ws = connected();
    const saves = () => posted.filter((m) => m.type === "save").length;
    const press = () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    // Every text's editor hears the shortcut: one Publish is asked for.
    root()
      .querySelector<HTMLElement>(".ds-name")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
    await flush();
    expect(saves()).toBe(1);
    stuckGuidelines(ws);
    press();
    await flush();
    expect(saves()).toBe(1);
  });

  it("a description the room could not create yet stays unsent, and is created once it can be", async () => {
    fake();
    const ws = connected();
    root()
      .querySelector<HTMLElement>(
        "[data-text='component:badge:description'] .plinth-doc__placeholder",
      )
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const el = root().querySelector<HTMLElement>(
      "[data-text='component:badge:description'] [contenteditable='true']",
    );
    if (!el) throw new Error("no open block");
    el.textContent = "Marks something new";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(ws.sent.filter((f) => f.t === "struct")).toHaveLength(1);
    // Ben holds lines the op would change.
    ws.frame({ t: "struct_denied", reason: "held", by: "ben@example.org" });
    await flush();
    expect(lastLive()).toMatchObject({ unflushed: true });
    // His lease ends: it is created now.
    ws.frame({
      t: "leased",
      lease: "B1",
      start: 3,
      end: 4,
      holder: "s2",
      by: "ben@example.org",
    });
    ws.frame({ t: "released", lease: "B1" });
    await flush();
    const structs = ws.sent.filter((f) => f.t === "struct");
    expect(structs).toHaveLength(2);
    expect(structs[1]).toMatchObject({ op: { op: "set_text", value: "Marks something new" } });
  });

  it("edit mode ending keeps a text's write that waits for its lease", async () => {
    fake();
    const ws = connected();
    stuckGuidelines(ws);
    // A token's value takes the socket's lease meanwhile; the block stays open with its typing.
    const field = row("color.bg").querySelector<HTMLInputElement>('input[type="text"]');
    if (!field) throw new Error("no field");
    field.value = "#fafafa";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    const node = dsNodeAtPath(splitLines(LIVE), ["tokens", "color", "bg", "$value"]);
    if (!node) throw new Error("no node");
    lease(ws, "L2", node.start, node.end);
    send({ type: "edit", on: false });
    await flush();
    // The typing, without its formatting, is written in the guidelines once the lease comes.
    const asked = lastOf(ws, "lease") as Json;
    expect(asked.start).toBeGreaterThan(END);
    lease(ws, "L3", asked.start, asked.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({ lease: "L3" });
    expect((lastOf(ws, "edit") as Json).text).toContain("abc");
  });
});

describe("a text's edit the room refuses", () => {
  it("is the room's text again, as a doc block's is, and is not sent again", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const ws = connected();
    const node = dsNodeAtPath(splitLines(LIVE), ["components", 0, "description"]);
    if (!node) throw new Error("no node");
    const sel = "[data-text='component:button:description']";
    root()
      .querySelector<HTMLElement>(`${sel} p`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    ws.frame({
      t: "leased",
      lease: "L1",
      start: node.start,
      end: node.end,
      holder: "s1",
      by: "ada@example.org",
    });
    const el = root().querySelector<HTMLElement>(`${sel} [contenteditable='true']`);
    if (!el) throw new Error("no open block");
    el.textContent = "Starts an action.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(ws.sent.filter((f) => f.t === "edit")).toHaveLength(1);
    ws.frame({ t: "error", code: "invalid" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(root().querySelector(sel)?.textContent).toContain("Triggers an action.");
    // Someone else's change: nothing is sent again.
    ws.frame({ t: "released", lease: "L1" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ws.sent.filter((f) => f.t === "edit" || f.t === "struct")).toHaveLength(1);
  });

  it("a refused op from a row's menu is the op's refusal, not the text's that wrote before it", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const ws = connected();
    const node = dsNodeAtPath(splitLines(LIVE), ["components", 0, "description"]);
    if (!node) throw new Error("no node");
    const sel = "[data-text='component:button:description']";
    root()
      .querySelector<HTMLElement>(`${sel} p`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    ws.frame({
      t: "leased",
      lease: "L1",
      start: node.start,
      end: node.end,
      holder: "s1",
      by: "ada@example.org",
    });
    const el = root().querySelector<HTMLElement>(`${sel} [contenteditable='true']`);
    if (!el) throw new Error("no open block");
    el.textContent = "Starts an action.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    const e = lastOf(ws, "edit") as Json;
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 1,
      lease: "L1",
      start: node.start,
      del: node.end - node.start,
      ins: e.text,
      by: "s1",
      seq: e.seq,
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // A dark value is added from a row's menu, and the room refuses that op.
    row("color.brand.500").querySelector<HTMLButtonElement>(".plinth-doc__menu-button")?.click();
    [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")]
      .find((i) => i.textContent === "Add a dark value")
      ?.click();
    expect(lastOf(ws, "struct")).toMatchObject({ op: { op: "set_dark" } });
    ws.frame({ t: "error", code: "invalid" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The page says so itself; the description keeps what it wrote.
    expect(document.querySelector(".ds-notice")?.textContent).toContain("can't be used here");
    expect(root().querySelector(sel)?.textContent).toContain("Starts an action.");
  });
});

// A token's value is written on `change` and asks for its lines' lease first: until the room grants
// it the value waits in the frame, and it is never dropped there. It counts as unflushed, edit mode
// ending keeps the request, a socket that closes first asks again after the reconnect, another
// change meanwhile waits its turn, and an edit sent just before a drop is sent again.
describe("a token value waiting for its lease", () => {
  const fake = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const lease = (ws: FakeSocket, id: string, start: number, end: number) =>
    ws.frame({ t: "leased", lease: id, start, end, holder: "s1", by: "ada@example.org" });
  const nodeIn = (lines: string[], path: (string | number)[]) => {
    const n = dsNodeAtPath(lines, path);
    if (!n) throw new Error("no node");
    return n;
  };
  const nodeOf = (path: (string | number)[]) => nodeIn(splitLines(LIVE), path);
  const BG = ["tokens", "color", "bg", "$value"];
  const FG = ["tokens", "color", "fg", "$value"];
  const change = (path: string, value: string) => {
    const field = row(path).querySelector<HTMLInputElement>('input[type="text"]');
    if (!field) throw new Error(`no field for ${path}`);
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };
  /** The room applies and acknowledges this socket's last edit, on lease `id` at `node`. */
  const ack = (ws: FakeSocket, id: string, node: { start: number; end: number }, rev: number) => {
    const e = lastOf(ws, "edit") as Json;
    ws.frame({
      t: "op",
      gen: "g1",
      rev,
      lease: id,
      start: node.start,
      del: node.end - node.start,
      ins: e.text,
      by: "s1",
      seq: e.seq,
    });
  };
  /** The socket closes, the frame reconnects after its backoff, and the room welcomes it again. */
  const reconnect = (ws: FakeSocket, text = LIVE, rev = 0) => {
    ws.onclose?.({ code: 1006 } as CloseEvent);
    vi.advanceTimersByTime(60_000);
    const next = FakeSocket.all.at(-1) as FakeSocket;
    expect(next).not.toBe(ws);
    next.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev,
      base_version: 4,
      flushed_rev: rev,
      conflict_version: null,
      last_by_you: rev > 0,
      leases: [],
      peers: [],
    });
    next.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: text });
    return next;
  };

  it("counts as unflushed while it waits", async () => {
    fake();
    const ws = connected();
    change("color.bg", "#fafafa");
    await flush();
    expect(lastOf(ws, "lease")).toMatchObject({ t: "lease" });
    // `pending` tells the app's Publish and Done to wait for it.
    expect(lastLive()).toMatchObject({ unflushed: true, pending: true });
    const node = nodeOf(BG);
    lease(ws, "L1", node.start, node.end);
    ack(ws, "L1", node, 1);
    await flush();
    expect(lastLive()).not.toHaveProperty("pending");
  });

  it("edit mode ending keeps its request: the value is sent once the lease comes, then let go", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    send({ type: "edit", on: false });
    await flush();
    expect(lastLive()).toMatchObject({ editing: false, unflushed: true });
    lease(ws, "L1", node.start, node.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({
      lease: "L1",
      text: dsNodeLines(node, "#fafafa").join("\n"),
    });
    // Out of edit mode nothing holds the token's lines longer than its write.
    expect(lastOf(ws, "release")).toEqual({ t: "release", lease: "L1" });
  });

  it("an edit the room answers not_held (its lease ended by an op) asks again and is sent", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    // A dark value is added meanwhile: the op is sent after the value's request.
    row("color.brand.500").querySelector<HTMLButtonElement>(".plinth-doc__menu-button")?.click();
    [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")]
      .find((i) => i.textContent === "Add a dark value")
      ?.click();
    const op = lastOf(ws, "struct")?.op;
    expect(op).toMatchObject({ op: "set_dark" });
    // The room grants the request, then the op ends that lease; the value's edit comes after it.
    lease(ws, "L1", node.start, node.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({ lease: "L1" });
    ws.frame({ t: "released", lease: "L1" });
    ws.frame({ t: "struct", gen: "g1", rev: 1, op, by: "s1" });
    ws.frame({ t: "error", code: "not_held", re: ws.idOf("edit") });
    await flush();
    expect(lastLive()).toMatchObject({ unflushed: true });
    const applied = applyDesignSystemStruct(splitLines(LIVE), op as never);
    if (typeof applied === "string") throw new Error(applied);
    const now = nodeIn(applied.lines, BG);
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 1, start: now.start, end: now.end });
    lease(ws, "L2", now.start, now.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(now, "#fafafa").join("\n"),
    });
  });

  it("after the socket closes before the lease comes, asks again and sends the value", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    expect(lastOf(ws, "lease")).toMatchObject({ start: node.start, end: node.end });
    const ws2 = reconnect(ws);
    await flush();
    expect(lastLive()).toMatchObject({ unflushed: true });
    expect(lastOf(ws2, "lease")).toMatchObject({ start: node.start, end: node.end });
    lease(ws2, "L2", node.start, node.end);
    await flush();
    expect(lastOf(ws2, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(node, "#fafafa").join("\n"),
    });
  });

  it("after a reconnect, a later change to the same token is sent", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    const ws2 = reconnect(ws);
    await flush();
    change("color.bg", "#f0f0f0");
    await flush();
    expect(ws2.sent.filter((f) => f.t === "lease").length).toBeGreaterThan(0);
    lease(ws2, "L2", node.start, node.end);
    await flush();
    expect(lastOf(ws2, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(node, "#f0f0f0").join("\n"),
    });
  });

  it("another token changed while one waits: it asks only after that answer, and both are sent", async () => {
    fake();
    const ws = connected();
    const bg = nodeOf(BG);
    const fg = nodeOf(FG);
    change("color.bg", "#fafafa");
    change("color.fg", "#101010");
    // One request at a time: the second waits for the first's answer.
    expect(ws.sent.filter((f) => f.t === "lease")).toHaveLength(1);
    lease(ws, "L1", bg.start, bg.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({
      lease: "L1",
      text: dsNodeLines(bg, "#fafafa").join("\n"),
    });
    expect(lastOf(ws, "lease")).toMatchObject({ start: fg.start, end: fg.end });
    ack(ws, "L1", bg, 1);
    ws.frame({ t: "released", lease: "L1" });
    lease(ws, "L2", fg.start, fg.end);
    await flush();
    expect(lastOf(ws, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(fg, "#101010").join("\n"),
    });
    expect(lastLive()).toMatchObject({ unflushed: true });
  });

  it("an edit sent just before the socket closed is sent again after the reconnect", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    lease(ws, "L1", node.start, node.end);
    expect(ws.sent.filter((f) => f.t === "edit")).toHaveLength(1);
    // No acknowledgement came before the drop.
    const ws2 = reconnect(ws);
    await flush();
    expect(lastLive()).toMatchObject({ unflushed: true });
    expect(lastOf(ws2, "lease")).toMatchObject({ start: node.start, end: node.end });
    lease(ws2, "L2", node.start, node.end);
    await flush();
    expect(lastOf(ws2, "edit")).toMatchObject({
      lease: "L2",
      text: dsNodeLines(node, "#fafafa").join("\n"),
    });
  });

  it("an edit the room has is not sent again after a reconnect", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(BG);
    change("color.bg", "#fafafa");
    lease(ws, "L1", node.start, node.end);
    ack(ws, "L1", node, 1);
    await flush();
    const applied = splitLines(LIVE);
    applied.splice(node.start, node.end - node.start, ...dsNodeLines(node, "#fafafa"));
    const ws2 = reconnect(ws, applied.join("\n"), 1);
    await flush();
    expect(ws2.sent.filter((f) => f.t === "lease" || f.t === "edit")).toHaveLength(0);
  });

  it("a new description whose creation the socket took with it is created again after the reconnect", async () => {
    fake();
    const ws = connected();
    root()
      .querySelector<HTMLElement>(
        "[data-text='component:badge:description'] .plinth-doc__placeholder",
      )
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const el = root().querySelector<HTMLElement>(
      "[data-text='component:badge:description'] [contenteditable='true']",
    );
    if (!el) throw new Error("no open block");
    el.textContent = "Marks something new";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(lastOf(ws, "struct")).toMatchObject({ op: { op: "set_text" } });
    // The socket drops before the room answered the creation.
    const ws2 = reconnect(ws);
    await flush();
    expect(lastOf(ws2, "struct")).toMatchObject({
      op: { op: "set_text", path: "components.badge.description", value: "Marks something new" },
    });
  });

  it("a description's lease asked for before a drop is asked for again after the reconnect", async () => {
    fake();
    const ws = connected();
    const node = nodeOf(["components", 0, "description"]);
    const sel = "[data-text='component:button:description']";
    root()
      .querySelector<HTMLElement>(`${sel} p`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(lastOf(ws, "lease")).toEqual({ t: "lease", rev: 0, start: node.start, end: node.end });
    const ws2 = reconnect(ws);
    await flush();
    root()
      .querySelector<HTMLElement>(`${sel} p`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(lastOf(ws2, "lease")).toEqual({ t: "lease", rev: 0, start: node.start, end: node.end });
  });
});
