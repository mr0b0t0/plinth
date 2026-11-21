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
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  splitLines,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_DEBOUNCE_MS } from "../doc/edit.ts";
import { boot } from "./boot.ts";
import { FIXTURE } from "./testFixture.ts";

const APP = "https://plinth.example.com";
// biome-ignore lint/suspicious/noExplicitAny: test fixtures are walked by path
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
