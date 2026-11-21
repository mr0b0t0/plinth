// Column settings, row moves and the phone cell editor on a sheet's page (sheet-columns): widths
// by the settings, Alt+arrows and the header's edge; thousands separators; a select column's
// options as a list; freezing as a header lease; rows moved with every formula following them,
// from the bar's Row and Column menus; the cell editor docked at phone width; and the grid's
// keyboard and screen reader behaviour.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BootOptions, boot } from "./boot.ts";
import { headerFrozen, readOptions } from "./edit.ts";

const APP = "https://plinth.example.com";
const COLUMNS = [
  { name: "Item", type: "text" },
  { name: "Qty", type: "number" },
  { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
  { name: "Paid", type: "checkbox" },
  { name: "Stage", type: "select", options: ["new", "done"] },
];
const HEADER = JSON.stringify({ plinth: "sheet", v: 1, columns: COLUMNS });
const LINES = [
  HEADER,
  '["Apples",3,1.5,true,"new"]',
  '["Pears",5,0.5,false,"done"]',
  '["Total","=SUM(B2:B3)","=B2*C2+B3*C3"]',
];

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

function mount(lines = LINES, live?: "room") {
  const html = typedShellHtml(TYPE_REGISTRY.sheet, {
    title: "Budget",
    text: lines.join("\n"),
    base: "",
    appOrigin: APP,
    ...(live ? { live } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.title = "Budget";
  document.body.innerHTML = main + data;
}

function framed() {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const win = {
    document,
    parent,
    location: window.location,
    innerWidth: 1024,
    print: vi.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent };
}

type Framed = ReturnType<typeof framed>;
const send = (f: Framed, m: Record<string, unknown>) =>
  f.target.dispatchEvent(
    new MessageEvent("message", {
      data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
      origin: APP,
      source: f.parent as never,
    }),
  );
const cell = (a: string) => document.getElementById(`__plinth-cell-${a}`) as HTMLElement;
const text = (a: string) => cell(a).textContent;
const sortOf = (a: string) => cell(a).querySelector(".plinth-sheet__sort") as HTMLButtonElement;
const field = () => document.querySelector(".plinth-sheet__input") as HTMLInputElement | null;
const notice = () => document.querySelector(".plinth-sheet__notice")?.textContent ?? "";
const said = () => document.querySelector('div.plinth-sheet__sr[role="status"]')?.textContent ?? "";
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
/** The open menu of the bar (Row or Column), or null. */
const menu = () => document.querySelector<HTMLElement>('[role="menu"]:not([hidden])');
const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;
const selectedCell = () => document.querySelector(".plinth-sheet__selected") as HTMLElement;
const menuButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".plinth-sheet__menu-btn")].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;
/** An item of the bar's Row menu (acting on the selected cell's row), with the menu open. */
const rowItem = (name: string) => {
  menuButton("Row").click();
  return item(name);
};
/** An item of the bar's Column menu (acting on the selected cell's column), with the menu open. */
const columnItem = (name: string) => {
  menuButton("Column").click();
  return item(name);
};
const panel = () => document.querySelector(".plinth-sheet__panel") as HTMLFormElement;
const labelled = (form: HTMLElement, name: string) =>
  [...form.querySelectorAll("label")].find((l) => l.firstChild?.textContent === name)
    ?.lastChild as HTMLInputElement;
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { cancelable: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The draft the frame hands the app in solo mode. */
async function collected(f: Framed): Promise<string[]> {
  f.parent.postMessage.mockClear();
  send(f, { type: "collect", nonce: "n".repeat(16) });
  const m = f.parent.postMessage.mock.calls.map((c) => c[0]).find((x) => x.type === "draft");
  return (m.text as string).split("\n");
}

const header = async (f: Framed) => JSON.parse((await collected(f))[0] as string);

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  FakeSocket.all = [];
  document.body.innerHTML = "";
  document.body.className = "";
  vi.useRealTimers();
});

function solo(opts: BootOptions = {}, lines = LINES) {
  mount(lines);
  const f = framed();
  stop = boot(f.win, { locale: "en-US", ...opts });
  send(f, { type: "edit", on: true });
  return f;
}

/** A sheet with the room, in edit mode: the welcome at rev 3 and LINES as its text. */
function roomed() {
  mount(LINES, "room");
  const f = framed();
  stop = boot(f.win, { connect: () => new FakeSocket() as unknown as WebSocket });
  const ws = FakeSocket.all.at(-1) as FakeSocket;
  ws.frame({
    t: "welcome",
    v: 1,
    you: { id: "s1", email: "ada@example.org", right: "write" },
    gen: "g1",
    rev: 3,
    base_version: 2,
    flushed_rev: 3,
    conflict_version: null,
    last_by_you: false,
    leases: [],
    peers: [],
  });
  ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: LINES.join("\n") });
  send(f, { type: "edit", on: true });
  return { f, ws };
}

describe("pure helpers", () => {
  it("reads an edited option list: renames, removals, empties dropped, duplicates refused", () => {
    expect(
      readOptions(
        [
          { from: "done", value: " Done " },
          { from: "new", value: "new" },
          { from: null, value: "later" },
          { from: null, value: "  " },
        ],
        ["new", "done", "old"],
      ),
    ).toEqual({
      options: ["Done", "new", "later"],
      renames: new Map([["done", "Done"]]),
      removed: ["old"],
    });
    expect(
      readOptions(
        [
          { from: "a", value: "b" },
          { from: null, value: "b" },
        ],
        ["a"],
      ),
    ).toEqual({
      error: 'The option "b" is listed twice',
    });
    expect(readOptions([{ from: "a", value: "" }], ["a"])).toEqual({
      error: "A select column lists 1 to 100 options",
    });
    const many = Array.from({ length: 101 }, (_, i) => ({ from: null, value: `o${i}` }));
    expect(readOptions(many, [])).toHaveProperty("error");
  });

  it("freezes in the header's canonical spelling, and unfreezes by leaving it out", () => {
    const h = { columns: [{ name: "A", type: "text" as const }] };
    expect(headerFrozen(h, 1)).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"A","type":"text"}],"freeze":{"cols":1}}',
    );
    expect(headerFrozen({ ...h, freeze: { cols: 1 } }, 0)).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"A","type":"text"}]}',
    );
  });
});

describe("the grid for keyboards and screen readers", () => {
  it("is a grid with its counts and indexes, one tab stop, and read-only until edit mode", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const grid = document.querySelector("table") as HTMLTableElement;
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("4");
    expect(grid.getAttribute("aria-colcount")).toBe("6");
    expect(grid.getAttribute("aria-readonly")).toBe("true");
    expect(cell("B1").getAttribute("aria-colindex")).toBe("3");
    expect(cell("A3").closest("tr")?.getAttribute("aria-rowindex")).toBe("3");
    expect(document.querySelector(".plinth-sheet__letters")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    // One cell is in the tab order, and it follows the selection.
    const stops = () =>
      [...grid.querySelectorAll<HTMLElement>("td, button")].filter((e) => e.tabIndex === 0);
    expect(stops()).toEqual([cell("A2")]);
    cell("C3").focus();
    expect(stops()).toEqual([cell("C3")]);
    send(f, { type: "edit", on: true });
    expect(grid.getAttribute("aria-readonly")).toBe("false");
  });

  it("moves with the arrows, Home and End, into the header, and to the first and last cell", () => {
    mount();
    stop = boot(framed().win);
    cell("B3").focus();
    key(cell("B3"), "Home");
    expect(document.activeElement).toBe(cell("A3"));
    key(cell("A3"), "End");
    expect(document.activeElement).toBe(cell("E3"));
    key(cell("E3"), "ArrowUp");
    key(cell("E2"), "ArrowUp");
    // The header's stop is its sort button.
    expect(document.activeElement).toBe(sortOf("E1"));
    expect(sortOf("E1").tabIndex).toBe(0);
    key(sortOf("E1"), "ArrowLeft");
    expect(document.activeElement).toBe(sortOf("D1"));
    key(sortOf("D1"), "ArrowDown");
    expect(document.activeElement).toBe(cell("D2"));
    key(cell("D2"), "End", { ctrlKey: true });
    expect(document.activeElement).toBe(cell("E4"));
    key(cell("E4"), "Home", { ctrlKey: true });
    expect(document.activeElement).toBe(sortOf("A1"));
  });

  it("follows the rows shown: a filter skips hidden rows", () => {
    mount();
    stop = boot(framed().win);
    const filter = document.querySelector<HTMLInputElement>(".plinth-sheet__filter-input");
    if (!filter) throw new Error("no filter");
    filter.value = "a";
    filter.dispatchEvent(new Event("input"));
    // "Apples", "Pears" and "Total" all hold an "a": filter on one only.
    filter.value = "total";
    filter.dispatchEvent(new Event("input"));
    cell("A4").focus();
    key(cell("A4"), "ArrowUp");
    expect(document.activeElement).toBe(sortOf("A1"));
  });

  it("describes the cells of a row someone else holds", async () => {
    mount(LINES, "room");
    const f = framed();
    stop = boot(f.win, { connect: () => new FakeSocket() as unknown as WebSocket });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev: 3,
      base_version: 2,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: LINES.join("\n") });
    send(f, { type: "edit", on: true });
    ws.frame({ t: "leased", lease: "l9", start: 2, end: 3, holder: "s2", by: "bo@example.org" });
    await tick();
    const id = cell("B3").getAttribute("aria-describedby");
    expect(id).toBe("__plinth-held-3");
    expect(document.getElementById(id as string)?.textContent).toBe("Bo is editing");
    ws.frame({ t: "released", lease: "l9" });
    await tick();
    expect(cell("B3").hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById("__plinth-held-3")).toBeNull();
  });
});

describe("rows move", () => {
  it("up and down from the Row menu and with Alt+Shift+arrows; formulas follow; it is said", async () => {
    const f = solo();
    cell("A3").focus();
    const up = rowItem("Move row up");
    expect(up.disabled).toBe(false);
    up.click();
    const draft = await collected(f);
    expect(draft.slice(1)).toEqual([
      '["Pears",5,0.5,false,"done"]',
      '["Apples",3,1.5,true,"new"]',
      '["Total","=SUM(B2:B3)","=B3*C3+B2*C2"]',
    ]);
    expect(text("A2")).toBe("Pears");
    expect(said()).toBe("Row 3 moved to row 2.");
    // The moved row stays selected: row 2 cannot move up.
    expect(rowItem("Move row up").disabled).toBe(true);
    key(item("Move row down"), "Escape");
    expect(menu()).toBeNull();
    // Pears back down with the keyboard: the total's references are as they were.
    cell("B2").focus();
    key(cell("B2"), "ArrowDown", { altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(cell("B3"));
    expect(await collected(f)).toEqual(LINES);
    // The last row cannot move down.
    cell("A4").focus();
    key(cell("A4"), "ArrowDown", { altKey: true, shiftKey: true });
    expect(await collected(f)).toEqual(LINES);
    expect(document.activeElement).toBe(cell("A4"));
  });

  it("a moved row's own formulas move too, and the focus goes with it", async () => {
    const f = solo({}, [
      JSON.stringify({ plinth: "sheet", v: 1, columns: COLUMNS.slice(0, 2) }),
      '["a",1]',
      '["b","=B2*2"]',
    ]);
    cell("B3").focus();
    key(cell("B3"), "ArrowUp", { altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(cell("B2"));
    expect((await collected(f)).slice(1)).toEqual(['["b","=B3*2"]', '["a",1]']);
    expect(text("B2")).toBe("2");
    expect(said()).toBe("Row 3 moved to row 2.");
  });

  it("a move between two equal rows lands and is said, and a later edit leaves the focus alone", async () => {
    const f = solo({}, [
      JSON.stringify({ plinth: "sheet", v: 1, columns: COLUMNS.slice(0, 2) }),
      '["x"]',
      '["x"]',
      '["y",1]',
      '["z",2]',
    ]);
    cell("A2").focus();
    key(cell("A2"), "ArrowDown", { altKey: true, shiftKey: true });
    expect(said()).toBe("Row 2 moved to row 3.");
    expect(document.activeElement).toBe(cell("A3"));
    // Typing in another cell afterwards: once its edit lands, nothing moves the focus or says
    // a move again.
    cell("B5").focus();
    key(cell("B5"), "7");
    const input = field() as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await new Promise((r) => setTimeout(r, 450));
    expect(field()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(said()).toBe("Row 2 moved to row 3.");
    key(input, "Enter");
    expect((await collected(f))[4]).toBe('["z",7]');
  });

  it("refuses while a sort is on, since rows move in the sheet's own order", async () => {
    const f = solo();
    sortOf("A1").click();
    cell("A3").focus();
    // The Row menu offers neither move, as it offers nothing else that cannot run.
    expect(rowItem("Move row down").disabled).toBe(true);
    expect(item("Move row up").disabled).toBe(true);
    expect(item("Insert above").disabled).toBe(false);
    key(item("Insert above"), "Escape");
    // The keys say why.
    cell("A3").focus();
    key(cell("A3"), "ArrowDown", { altKey: true, shiftKey: true });
    expect(notice()).toContain("Turn the sort off first");
    expect(await collected(f)).toEqual(LINES);
  });

  it("while a filter hides rows, moves past them to the next row shown", async () => {
    const two = JSON.stringify({ plinth: "sheet", v: 1, columns: COLUMNS.slice(0, 2) });
    const rows = ['["kiwi",1]', '["fig",2]', '["date",3]', '["kale",4]'];
    const f = solo({}, [two, ...rows]);
    const filter = document.querySelector(".plinth-sheet__filter-input") as HTMLInputElement;
    filter.value = "k";
    filter.dispatchEvent(new Event("input"));
    // Shown: kiwi (row 2) and kale (row 5); fig and date are hidden between them.
    cell("A5").focus();
    expect(rowItem("Move row up").disabled).toBe(false);
    expect(item("Move row down").disabled).toBe(true);
    item("Move row up").click();
    // Kale trades places with kiwi; the hidden rows keep their order, after it.
    expect((await collected(f)).slice(1)).toEqual([
      '["kale",4]',
      '["kiwi",1]',
      '["fig",2]',
      '["date",3]',
    ]);
    expect(said()).toBe("Row 5 moved to row 2.");
    expect(selectedCell()).toBe(cell("A2"));
    // Kiwi is the last row shown now: it cannot move down, though hidden rows follow it.
    cell("A3").focus();
    expect(rowItem("Move row down").disabled).toBe(true);
    key(item("Insert above"), "Escape");
    // Kale (row 2) down with the keys: it trades places with kiwi again.
    cell("A2").focus();
    key(cell("A2"), "ArrowDown", { altKey: true, shiftKey: true });
    expect((await collected(f)).slice(1)).toEqual([
      '["kiwi",1]',
      '["kale",4]',
      '["fig",2]',
      '["date",3]',
    ]);
    expect(said()).toBe("Row 2 moved to row 3.");
  });

  it("from the Row menu: the first row cannot move up nor the last one down", async () => {
    const f = solo();
    cell("C2").focus();
    expect(rowItem("Move row up").disabled).toBe(true);
    expect(item("Move row down").disabled).toBe(false);
    key(item("Insert above"), "Escape");
    cell("C4").focus();
    expect(rowItem("Move row down").disabled).toBe(true);
    key(item("Insert above"), "Escape");
    cell("C2").focus();
    rowItem("Move row down").click();
    expect(menu()).toBeNull();
    expect((await collected(f))[2]).toBe('["Apples",3,1.5,true,"new"]');
    // The moved row stays selected where it went; the focus is back on the menu's button.
    expect(selectedCell()).toBe(cell("C3"));
    expect(document.activeElement).toBe(menuButton("Row"));
    // Nothing to move in the header.
    sortOf("C1").focus();
    expect(rowItem("Move row up").disabled).toBe(true);
    expect(item("Move row down").disabled).toBe(true);
  });

  it("with the room: a move_rows struct, aimed again at its row when stale", async () => {
    mount(LINES, "room");
    const f = framed();
    stop = boot(f.win, { connect: () => new FakeSocket() as unknown as WebSocket });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev: 3,
      base_version: 2,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: LINES.join("\n") });
    send(f, { type: "edit", on: true });
    cell("A3").focus();
    rowItem("Move row down").click();
    const op = { op: "move_rows", from: 3, count: 1, to: 4 };
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 3, op });
    // Someone inserted a row above first: Pears is row 4 now, so the move is aimed there.
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "insert_rows", before: 2, count: 1 },
      by: "s2",
    });
    ws.frame({ t: "struct_denied", reason: "stale" });
    await tick();
    const again = { op: "move_rows", from: 4, count: 1, to: 5 };
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 4, op: again });
    ws.frame({ t: "struct", gen: "g1", rev: 5, op: again, by: "s1" });
    await tick();
    expect(text("A5")).toBe("Pears");
    expect(text("A4")).toBe("Total");
    expect(said()).toBe("Row 4 moved to row 5.");
  });
});

describe("column widths", () => {
  it("Alt+Right and Alt+Left in the header, 8 px a step, sent once the keys rest", async () => {
    vi.useFakeTimers();
    const f = solo();
    const b = sortOf("B1");
    key(b, "ArrowRight", { altKey: true });
    key(b, "ArrowRight", { altKey: true });
    key(b, "ArrowRight", { altKey: true });
    key(b, "ArrowLeft", { altKey: true });
    expect((document.querySelectorAll("col")[2] as HTMLElement).style.width).toBe("136px");
    expect(said()).toBe("Qty: 136 pixels wide.");
    vi.advanceTimersByTime(500);
    expect((await header(f)).columns[1]).toEqual({ name: "Qty", type: "number", width: 136 });
  });

  it("clamps to 40 to 800", async () => {
    vi.useFakeTimers();
    const f = solo();
    for (let i = 0; i < 20; i++) key(sortOf("A1"), "ArrowLeft", { altKey: true });
    vi.advanceTimersByTime(500);
    expect((await header(f)).columns[0].width).toBe(40);
  });

  it("by dragging the header's edge", async () => {
    const f = solo();
    const handle = cell("C1").querySelector(".plinth-sheet__resize") as HTMLElement;
    expect(handle.getAttribute("aria-hidden")).toBe("true");
    const at = (type: string, x: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, { clientX: x, button: 0, pointerId: 1, bubbles: true }),
      );
    at("pointerdown", 300);
    at("pointermove", 350);
    expect((document.querySelectorAll("col")[3] as HTMLElement).style.width).toBe("170px");
    at("pointermove", 380);
    at("pointerup", 380);
    expect((await header(f)).columns[2].width).toBe(200);
    expect(said()).toBe("Price: 200 pixels wide.");
  });

  it("changed while the column settings are open: Apply keeps that width", async () => {
    vi.useFakeTimers();
    const f = solo();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    key(sortOf("B1"), "ArrowRight", { altKey: true });
    vi.advanceTimersByTime(500);
    expect((await header(f)).columns[1].width).toBe(128);
    submit(panel());
    expect(notice()).not.toContain("changed meanwhile");
    expect((await header(f)).columns[1]).toEqual({ name: "Quantity", type: "number", width: 128 });
  });

  it("changed while the column settings are open: renamed options still reach the cells", async () => {
    vi.useFakeTimers();
    const f = solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    (panel().querySelectorAll(".plinth-sheet__option input")[1] as HTMLInputElement).value = "Done";
    key(sortOf("E1"), "ArrowRight", { altKey: true });
    vi.advanceTimersByTime(500);
    submit(panel());
    expect(notice()).not.toContain("changed meanwhile");
    const draft = await collected(f);
    expect(JSON.parse(draft[0] as string).columns[4]).toEqual({
      name: "Stage",
      type: "select",
      width: 128,
      options: ["new", "Done"],
    });
    expect(draft[2]).toBe('["Pears",5,0.5,false,"Done"]');
  });

  /** Someone else changes the header to these columns, through their own lease. */
  const theirs = (ws: FakeSocket, columns: unknown[], rev: number) => {
    ws.frame({ t: "leased", lease: "l9", start: 0, end: 1, holder: "s2", by: "bo@example.org" });
    ws.frame({
      t: "op",
      gen: "g1",
      rev,
      lease: "l9",
      start: 0,
      del: 1,
      ins: JSON.stringify({ plinth: "sheet", v: 1, columns }),
      by: "s2",
      seq: 1,
    });
    ws.frame({ t: "released", lease: "l9" });
  };

  it("in the room: a width someone else set while the settings were open is kept", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    theirs(
      ws,
      COLUMNS.map((c, i) => (i === 1 ? { ...c, width: 200 } : c)),
      4,
    );
    await tick();
    submit(panel());
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 0, end: 1 });
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 1, holder: "s1", by: "ada@example.org" });
    expect(notice()).not.toContain("changed meanwhile");
    const edit = ws.sent.find((m) => m.t === "edit") as { text: string } | undefined;
    expect(JSON.parse(edit?.text ?? "{}").columns[1]).toEqual({
      name: "Quantity",
      type: "number",
      width: 200,
    });
  });

  it("in the room: a column inserted before it while the settings are open; they follow it", async () => {
    const { ws } = roomed();
    cell("E2").focus();
    columnItem("Column settings…").click();
    expect(panel().getAttribute("aria-label")).toBe("Column E settings");
    // "done", which E3 holds, renamed: the cells that hold it must be renamed with it.
    (panel().querySelectorAll(".plinth-sheet__option input")[1] as HTMLInputElement).value = "Done";
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "insert_columns", before: "A", columns: [{ name: "Note", type: "text" }] },
      by: "s2",
    });
    await tick();
    // Stage is column F now; the settings say so and still hold what was typed.
    expect(panel().getAttribute("aria-label")).toBe("Column F settings");
    expect(
      (panel().querySelectorAll(".plinth-sheet__option input")[1] as HTMLInputElement).value,
    ).toBe("Done");
    submit(panel());
    // The cells of column F hold "done": the whole sheet, not the header alone.
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 0, end: 4 });
    expect(panel()).not.toBeNull();
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 4, holder: "s1", by: "ada@example.org" });
    const edit = ws.sent.find((m) => m.t === "edit") as { text: string } | undefined;
    const lines = (edit?.text ?? "").split("\n");
    expect(JSON.parse(lines[0] ?? "{}").columns[5]).toEqual({
      name: "Stage",
      type: "select",
      options: ["new", "Done"],
    });
    expect(lines[2]).toBe('[null,"Pears",5,0.5,false,"Done"]');
    expect(panel()).toBeNull();
    expect(said()).toBe("Column F settings applied.");
  });

  it("in the room: a column inserted before it, then a removed option a cell holds is refused", async () => {
    const { ws } = roomed();
    cell("E2").focus();
    columnItem("Column settings…").click();
    const remove = panel().querySelector('button[aria-label="Remove done"]') as HTMLButtonElement;
    remove.click();
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "insert_columns", before: "A", columns: [{ name: "Note", type: "text" }] },
      by: "s2",
    });
    await tick();
    submit(panel());
    expect(notice()).toContain('F3 holds "done"');
    expect(panel()).not.toBeNull();
    expect(ws.sent.filter((m) => m.t === "lease")).toEqual([]);
  });

  it("in the room: its column deleted while the settings are open; they stay, saying so", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "delete_columns", from: "B", count: 1 },
      by: "s2",
    });
    await tick();
    expect(panel()).not.toBeNull();
    expect(labelled(panel(), "Name").value).toBe("Quantity");
    expect(notice()).toContain("Column B (Qty) was deleted meanwhile");
    submit(panel());
    expect(panel()).not.toBeNull();
    expect(labelled(panel(), "Name").value).toBe("Quantity");
    expect(notice()).toContain("Column B (Qty) was deleted meanwhile");
    expect(ws.sent.filter((m) => m.t === "lease")).toEqual([]);
  });

  it("in the room: the settings stay open, with what was typed, when the write is refused at the grant", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    submit(panel());
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 0, end: 1 });
    // Still waiting for the lease: the settings stay, and a second Apply asks for nothing more.
    expect(panel()).not.toBeNull();
    submit(panel());
    expect(ws.sent.filter((m) => m.t === "lease")).toHaveLength(1);
    // Someone else renames the column before the lease comes.
    theirs(
      ws,
      COLUMNS.map((c, i) => (i === 1 ? { ...c, name: "Units" } : c)),
      4,
    );
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 1, holder: "s1", by: "ada@example.org" });
    expect(notice()).toContain("The column changed meanwhile");
    expect(ws.sent.filter((m) => m.t === "edit")).toEqual([]);
    expect(panel()).not.toBeNull();
    expect(labelled(panel(), "Name").value).toBe("Quantity");
  });

  it("in the room: Cancel while Apply waits for its lease applies nothing", () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    submit(panel());
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 0, end: 1 });
    (
      [...panel().querySelectorAll("button")].find(
        (b) => b.textContent === "Cancel",
      ) as HTMLButtonElement
    ).click();
    expect(panel()).toBeNull();
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 1, holder: "s1", by: "ada@example.org" });
    expect(ws.sent.filter((m) => m.t === "edit")).toEqual([]);
    expect(text("B1")).toContain("Qty");
  });

  it("in the room: a rename someone else made while the settings were open still refuses", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    labelled(panel(), "Name").value = "Quantity";
    theirs(
      ws,
      COLUMNS.map((c, i) => (i === 1 ? { ...c, name: "Units" } : c)),
      4,
    );
    await tick();
    submit(panel());
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 1, holder: "s1", by: "ada@example.org" });
    expect(notice()).toContain("The column changed meanwhile");
    expect(ws.sent.filter((m) => m.t === "edit")).toEqual([]);
  });
});

describe("number grouping", () => {
  it("turns thousands separators off and on, only with a number format", async () => {
    const f = solo();
    cell("C2").focus();
    columnItem("Column settings…").click();
    const g = labelled(panel(), "Thousands separators");
    expect(g.checked).toBe(true);
    expect((g.closest("label") as HTMLElement).hidden).toBe(false);
    g.checked = false;
    submit(panel());
    expect((await header(f)).columns[2].format).toEqual({
      style: "currency",
      currency: "EUR",
      decimals: 2,
      grouping: false,
    });
    columnItem("Column settings…").click();
    expect(labelled(panel(), "Thousands separators").checked).toBe(false);
    labelled(panel(), "Thousands separators").checked = true;
    submit(panel());
    expect((await header(f)).columns[2].format).toEqual({
      style: "currency",
      currency: "EUR",
      decimals: 2,
    });
    // An automatic format has no separators to set.
    cell("B2").focus();
    columnItem("Column settings…").click();
    expect((labelled(panel(), "Thousands separators").closest("label") as HTMLElement).hidden).toBe(
      true,
    );
  });
});

describe("select options as a list", () => {
  const optionInputs = () =>
    [...panel().querySelectorAll<HTMLInputElement>(".plinth-sheet__option input")].map(
      (i) => i.value,
    );
  const optionButton = (label: string) =>
    panel().querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

  it("adds, reorders and removes options, through a lease on the header", async () => {
    const f = solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    expect(optionInputs()).toEqual(["new", "done"]);
    const add = panel().querySelector('input[aria-label="New option"]') as HTMLInputElement;
    add.value = "later";
    key(add, "Enter");
    expect(optionInputs()).toEqual(["new", "done", "later"]);
    optionButton("Move later up").click();
    expect(optionInputs()).toEqual(["new", "later", "done"]);
    expect(optionButton("Move new up").disabled).toBe(true);
    submit(panel());
    expect((await header(f)).columns[4].options).toEqual(["new", "later", "done"]);
    columnItem("Column settings…").click();
    optionButton("Remove later").click();
    submit(panel());
    expect((await header(f)).columns[4].options).toEqual(["new", "done"]);
  });

  it("an option's moves keep the focus in the list when pressed, so a tap reaches them", () => {
    solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    const up = optionButton("Move done up");
    expect(up.classList.contains("plinth-sheet__ghost--move")).toBe(true);
    const press = new Event("pointerdown", { bubbles: true, cancelable: true });
    up.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    up.click();
    expect(optionInputs()).toEqual(["done", "new"]);
  });

  it("refuses to drop an option a cell holds, saying where", async () => {
    const f = solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    optionButton("Remove done").click();
    submit(panel());
    expect(notice()).toContain('E3 holds "done". Change those cells first, or keep the option.');
    expect(panel()).not.toBeNull();
    expect(await collected(f)).toEqual(LINES);
  });

  it("renames an option in the cells that hold it too, in one change", async () => {
    const f = solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    const inputs = panel().querySelectorAll<HTMLInputElement>(".plinth-sheet__option input");
    (inputs[1] as HTMLInputElement).value = "Done";
    // A swap of names is a rename of both.
    (inputs[0] as HTMLInputElement).value = "New";
    submit(panel());
    const draft = await collected(f);
    expect(JSON.parse(draft[0] as string).columns[4].options).toEqual(["New", "Done"]);
    expect(draft[1]).toBe('["Apples",3,1.5,true,"New"]');
    expect(draft[2]).toBe('["Pears",5,0.5,false,"Done"]');
    expect(text("E3")).toBe("Done");
  });

  it("with the room: a rename that cells hold leases the whole sheet; one they don't, the header", () => {
    mount(LINES, "room");
    const f = framed();
    stop = boot(f.win, { connect: () => new FakeSocket() as unknown as WebSocket });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev: 3,
      base_version: 2,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: LINES.join("\n") });
    send(f, { type: "edit", on: true });
    cell("E2").focus();
    columnItem("Column settings…").click();
    (panel().querySelectorAll(".plinth-sheet__option input")[1] as HTMLInputElement).value = "Done";
    submit(panel());
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 0, end: 4 });
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 4, holder: "s1", by: "ada@example.org" });
    const edit = ws.sent.at(-2) as { t: string; text: string };
    expect(edit.t).toBe("edit");
    expect(edit.text.split("\n")[2]).toBe('["Pears",5,0.5,false,"Done"]');
    // An option no cell holds: the header alone.
    columnItem("Column settings…").click();
    const add = panel().querySelector('input[aria-label="New option"]') as HTMLInputElement;
    add.value = "later";
    submit(panel());
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 0, end: 1 });
  });
});

describe("while someone else changes the sheet", () => {
  /** Someone else appends a row: the shape changes, so the grid is built again. */
  const appended = (ws: FakeSocket, rev: number) =>
    ws.frame({
      t: "struct",
      gen: "g1",
      rev,
      op: { op: "insert_rows", before: 5, count: 1 },
      by: "s2",
    });

  it("a rebuild leaves the focus in the column settings, so a key goes there, not to a cell", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    columnItem("Column settings…").click();
    const name = labelled(panel(), "Name");
    expect(document.activeElement).toBe(name);
    name.value = "Quant";
    name.setSelectionRange(2, 4);
    appended(ws, 4);
    await tick();
    expect(cell("A5")).not.toBeNull();
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([2, 4]);
    key(document.activeElement as Element, "Z");
    expect(ws.sent.filter((m) => m.t === "lease")).toEqual([]);
    expect(field()).toBeNull();
    expect(name.value).toBe("Quant");
  });

  it("a rebuild leaves the focus in the filter, with what it holds", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    const filter = document.querySelector(".plinth-sheet__filter-input") as HTMLInputElement;
    filter.focus();
    filter.value = "Ap";
    filter.dispatchEvent(new Event("input"));
    appended(ws, 4);
    await tick();
    const now = document.querySelector(".plinth-sheet__filter-input") as HTMLInputElement;
    expect(now).not.toBe(filter);
    expect(document.activeElement).toBe(now);
    expect([now.value, now.selectionStart, now.selectionEnd]).toEqual(["Ap", 2, 2]);
    key(document.activeElement as Element, "Z");
    expect(ws.sent.filter((m) => m.t === "lease")).toEqual([]);
    expect(field()).toBeNull();
  });

  it("a rebuild keeps the focus on the selected cell when a cell had it", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    appended(ws, 4);
    await tick();
    expect(document.activeElement).toBe(cell("B2"));
  });

  it("a rebuild while elsewhere in the page leaves the focus off the cells", async () => {
    const { ws } = roomed();
    cell("B2").focus();
    menuButton("Row").focus();
    appended(ws, 4);
    await tick();
    expect(document.activeElement).not.toBe(cell("B2"));
    key(document.activeElement as Element, "Z");
    expect(ws.sent.filter((m) => m.t === "lease")).toEqual([]);
    expect(field()).toBeNull();
  });

  it("a width the keys had not sent yet is still written when edit mode ends", async () => {
    const { f, ws } = roomed();
    key(sortOf("B1"), "ArrowRight", { altKey: true });
    key(sortOf("B1"), "ArrowRight", { altKey: true });
    send(f, { type: "edit", on: false });
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 0, end: 1 });
    // Until the lease is answered, the frame says it has a change not saved yet.
    await tick();
    const live = f.parent.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === "live");
    expect(live.at(-1)?.unflushed).toBe(true);
    ws.frame({ t: "leased", lease: "l1", start: 0, end: 1, holder: "s1", by: "ada@example.org" });
    const edit = ws.sent.find((m) => m.t === "edit") as { text: string } | undefined;
    expect(JSON.parse(edit?.text ?? "{}").columns[1]).toEqual({
      name: "Qty",
      type: "number",
      width: 136,
    });
    expect(ws.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
  });
});

describe("freezing", () => {
  it("from the Column menu: up to the selected column, and unfrozen again", async () => {
    const f = solo();
    cell("B2").focus();
    expect(columnItem("Unfreeze columns").hidden).toBe(true);
    item("Freeze up to this column").click();
    expect((await header(f)).freeze).toEqual({ cols: 2 });
    expect(said()).toBe("Columns A to B stay in view.");
    expect(cell("A2").classList.contains("plinth-sheet__frozen")).toBe(true);
    // Frozen up to B already: only Unfreeze does something there, so only it shows.
    cell("B2").focus();
    expect(columnItem("Freeze up to this column").hidden).toBe(true);
    expect(item("Unfreeze columns").hidden).toBe(false);
    item("Unfreeze columns").click();
    expect((await header(f)).freeze).toBeUndefined();
    expect(cell("A2").classList.contains("plinth-sheet__frozen")).toBe(false);
  });

  it("offers no freeze past the fifth column", () => {
    // Narrow columns, so five of them stay in view in the test's 1024px frame.
    const cols = Array.from({ length: 7 }, (_, i) => ({ name: `C${i}`, type: "text", width: 60 }));
    solo({}, [JSON.stringify({ plinth: "sheet", v: 1, columns: cols }), '["a"]']);
    cell("E2").focus();
    expect(columnItem("Freeze up to this column").hidden).toBe(false);
    key(item("Insert left"), "Escape");
    cell("F2").focus();
    expect(columnItem("Freeze up to this column").hidden).toBe(true);
    // Arrows skip the hidden items.
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>("#plinth-sheet-menu-column [role=menuitem]"),
    ];
    const settings = items.find((b) => b.textContent === "Column settings…");
    const del = items.find((b) => b.textContent === "Delete column") as HTMLButtonElement;
    del.focus();
    key(del, "ArrowDown");
    expect(document.activeElement).toBe(settings);
  });

  it("offers no freeze item a frame too narrow to keep those columns in view", () => {
    // A 360px frame: the frozen columns scroll with the rest past 180px (48px of row numbers and
    // 120px a column, so column A stays in view and A to B does not).
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      const max = Number(/max-width: (\d+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY);
      return {
        matches: 360 <= max,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as MediaQueryList;
    });
    const frozenAtB = JSON.stringify({ ...JSON.parse(HEADER), freeze: { cols: 2 } });
    solo({}, [frozenAtB, ...LINES.slice(1)]);
    expect(document.querySelector(".plinth-sheet--unfrozen")).not.toBeNull();
    cell("A2").focus();
    // Column A alone fits; Unfreeze would change nothing on this frame, since A to B scroll here.
    expect(columnItem("Freeze up to this column").hidden).toBe(false);
    expect(item("Unfreeze columns").hidden).toBe(true);
    key(item("Insert left"), "Escape");
    cell("C2").focus();
    expect(columnItem("Freeze up to this column").hidden).toBe(true);
    expect(item("Unfreeze columns").hidden).toBe(true);
    vi.restoreAllMocks();
  });

  it("has no header controls outside edit mode", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    expect(document.querySelector(".plinth-sheet__tool")).toBeNull();
    send(f, { type: "edit", on: true });
    // The width handle on the header's edge, and no menu button: the bar's menus are the way in.
    const tools = cell("A1").querySelectorAll(".plinth-sheet__tool");
    expect([...tools].map((t) => t.className)).toEqual(["plinth-sheet__tool plinth-sheet__resize"]);
    expect(text("A1")).toBe("Item");
    send(f, { type: "edit", on: false });
    expect(document.querySelector(".plinth-sheet__tool")).toBeNull();
  });
});

describe("the docked cell editor (phone width)", () => {
  it("opens a cell's field at the bottom under its address and column, saved by a check", async () => {
    const f = solo({ dock: true });
    cell("B3").focus();
    key(cell("B3"), "Enter");
    const dock = document.querySelector(".plinth-sheet__dock") as HTMLElement;
    expect(dock.getAttribute("role")).toBe("group");
    expect(dock.getAttribute("aria-label")).toBe("Edit B3");
    expect(dock.querySelector(".plinth-sheet__dock-label")?.textContent).toBe("B3Qty");
    expect(dock.querySelector(".plinth-sheet__dock-name")?.textContent).toBe("Qty");
    // One "Done" on the page (the edit bar's): the dock's button is a check named Save cell.
    expect([...dock.querySelectorAll("button")].map((b) => b.textContent)).toEqual([""]);
    const save = dock.querySelector("button") as HTMLButtonElement;
    expect(save.getAttribute("aria-label")).toBe("Save cell");
    const input = field() as HTMLInputElement;
    expect(dock.contains(input)).toBe(true);
    expect(cell("B3").contains(input)).toBe(false);
    expect(cell("B3").classList.contains("plinth-sheet__cell--docked")).toBe(true);
    expect(input.getAttribute("aria-label")).toBe(
      "Edit B3, Qty. Enter to finish, Escape to cancel.",
    );
    expect(document.body.classList.contains("plinth-sheet--docked")).toBe(true);
    input.value = "7";
    input.dispatchEvent(new Event("input"));
    save.click();
    expect(document.querySelector(".plinth-sheet__dock")).toBeNull();
    expect(document.body.classList.contains("plinth-sheet--docked")).toBe(false);
    expect(text("B3")).toBe("7");
    expect(document.activeElement).toBe(cell("B3"));
    expect((await collected(f))[2]).toBe('["Pears",7,0.5,false,"done"]');
  });

  it("a tap on the check keeps the focus in the field, so a refused value is kept, not cancelled", async () => {
    const f = solo({ dock: true });
    cell("B2").focus();
    key(cell("B2"), "Enter");
    const input = field() as HTMLInputElement;
    input.value = "many";
    input.dispatchEvent(new Event("input"));
    const save = document.querySelector(".plinth-sheet__dock-save") as HTMLButtonElement;
    // The press does not move the focus (iOS would move it to the page, and the blur cancel).
    for (const type of ["pointerdown", "mousedown"]) {
      const press = new Event(type, { bubbles: true, cancelable: true });
      save.dispatchEvent(press);
      expect(press.defaultPrevented, type).toBe(true);
    }
    expect(document.activeElement).toBe(input);
    save.click();
    expect(notice()).toContain("Qty takes numbers");
    expect(field()).toBe(input);
    expect(input.value).toBe("many");
    expect(document.activeElement).toBe(input);
    expect(await collected(f)).toEqual(LINES);
  });

  it("a rebuild leaves the docked field where it is, focused", async () => {
    mount(LINES, "room");
    const fr = framed();
    stop = boot(fr.win, { dock: true, connect: () => new FakeSocket() as unknown as WebSocket });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: { id: "s1", email: "ada@example.org", right: "write" },
      gen: "g1",
      rev: 3,
      base_version: 2,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    ws.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: LINES.join("\n") });
    send(fr, { type: "edit", on: true });
    cell("B3").focus();
    key(cell("B3"), "Enter");
    expect(ws.sent.at(-1)).toMatchObject({ t: "lease", start: 2, end: 3 });
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: "ada@example.org" });
    await tick();
    const input = field() as HTMLInputElement;
    const dock = document.querySelector(".plinth-sheet__dock") as HTMLElement;
    expect(dock.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    const moved: Node[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) moved.push(...r.removedNodes);
    });
    watch.observe(dock, { childList: true });
    // Someone else renames a column: the header changed, so the grid is built again around the
    // open field.
    ws.frame({ t: "leased", lease: "l9", start: 0, end: 1, holder: "s2", by: "bo@example.org" });
    const renamed = COLUMNS.map((c, i) => (i === 0 ? { ...c, name: "Thing" } : c));
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 0,
      del: 1,
      ins: JSON.stringify({ plinth: "sheet", v: 1, columns: renamed }),
      by: "s2",
      seq: 1,
    });
    ws.frame({ t: "released", lease: "l9" });
    await tick();
    watch.takeRecords().forEach((r) => {
      moved.push(...r.removedNodes);
    });
    watch.disconnect();
    expect(cell("A1").textContent).toContain("Thing");
    expect(moved).not.toContain(input);
    expect(dock.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(dock.getAttribute("aria-label")).toBe("Edit B3");
  });

  it("keeps a refused value in the docked field, and Escape closes it", async () => {
    const f = solo({ dock: true });
    cell("B2").focus();
    key(cell("B2"), "Enter");
    const input = field() as HTMLInputElement;
    input.value = "many";
    key(input, "Enter");
    expect(notice()).toContain("Qty takes numbers");
    expect(field()).toBe(input);
    key(input, "Escape");
    expect(document.querySelector(".plinth-sheet__dock")).toBeNull();
    expect(await collected(f)).toEqual(LINES);
  });
});

describe("the settings open where they are for", () => {
  it("opens the column settings under their header, outside the grid, with the actions last", () => {
    solo();
    cell("C2").focus();
    columnItem("Column settings…").click();
    const p = panel();
    expect(p.parentElement).toBe(document.body);
    expect(document.querySelector(".plinth-sheet__page")?.contains(p)).toBe(false);
    const actions = p.lastElementChild as HTMLElement;
    expect(actions.classList.contains("plinth-sheet__panel-actions")).toBe(true);
    expect([...actions.children].map((b) => b.textContent)).toEqual(["Cancel", "Apply"]);
    const types = p.querySelector("select") as HTMLSelectElement;
    expect([...types.options].map((o) => o.textContent)).toEqual([
      "Text",
      "Number",
      "Date",
      "Checkbox",
      "Select",
      "URL",
    ]);
    expect(types.value).toBe("number");
  });

  it("adds an option with Enter, with no Add button", () => {
    solo();
    cell("E2").focus();
    columnItem("Column settings…").click();
    expect(panel().querySelector('button[aria-label="Add option"]')).toBeNull();
    expect([...panel().querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Add");
  });

  it("names the column on the settings' sheet at phone width", () => {
    solo({ dock: true });
    cell("A3").focus();
    columnItem("Column settings…").click();
    expect(panel().classList.contains("plinth-sheet__panel--sheet")).toBe(true);
    expect(panel().querySelector(".plinth-sheet__sheet-title")?.textContent).toBe("Column A");
  });
});
