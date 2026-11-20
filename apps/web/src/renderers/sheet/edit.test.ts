// On-page editing of a sheet (#36): what typed text becomes (locale numbers, formulas, pasted
// tab-separated text), the cell editor alone (solo) and with the room (leases on row lines, the
// row line it sends, rows other people hold, struct frames), and that a value the room would
// refuse never leaves the frame.
import {
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { cellFromInput, inputText, numberLocale, parseLocaleNumber, parseTsv } from "./input.ts";

const APP = "https://plinth.example.com";
const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text" },
    { name: "Qty", type: "number" },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Paid", type: "checkbox" },
    { name: "Stage", type: "select", options: ["new", "done"] },
  ],
});
const LINES = [
  HEADER,
  '["Apples",3,1.5,true,"new"]',
  '["Pears",5,0.5,false]',
  '["Total","=SUM(B2:B3)","=B2*C2+B3*C3"]',
];

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: Record<string, unknown>[] = [];
  /** A frame type whose send throws (a socket that went away). */
  refuse: string | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    if (raw === "ping") return;
    const f = JSON.parse(raw);
    if (f.t === this.refuse) throw new Error("closed");
    this.sent.push(f);
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
    print: vi.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent };
}

type Framed = ReturnType<typeof framed>;
const msg = (m: Record<string, unknown>) => ({
  source: RENDERER_MESSAGE_SOURCE,
  v: RENDERER_PROTOCOL_VERSION,
  ...m,
});
const send = (f: Framed, m: Record<string, unknown>) =>
  f.target.dispatchEvent(
    new MessageEvent("message", { data: msg(m), origin: APP, source: f.parent as never }),
  );
const cell = (a: string) => document.getElementById(`__plinth-cell-${a}`) as HTMLElement;
const text = (a: string) => cell(a).textContent;
const field = () => document.querySelector(".plinth-sheet__input") as HTMLInputElement | null;
const notice = () => document.querySelector(".plinth-sheet__notice")?.textContent ?? "";
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
const dbl = (el: Element) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input"));
};
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".plinth-sheet__strip button")].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The draft the frame hands the app in solo mode. */
async function collected(f: Framed): Promise<string> {
  f.parent.postMessage.mockClear();
  send(f, { type: "collect", nonce: "n".repeat(16) });
  const m = f.parent.postMessage.mock.calls.map((c) => c[0]).find((x) => x.type === "draft");
  return m.text as string;
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  FakeSocket.all = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("typed values", () => {
  it("reads numbers with the locale's separators", () => {
    const de = { decimal: ",", group: "." };
    const en = { decimal: ".", group: "," };
    expect(parseLocaleNumber("1.234,5", de)).toBe(1234.5);
    expect(parseLocaleNumber("1,234.5", en)).toBe(1234.5);
    expect(parseLocaleNumber(" -2,5 ", de)).toBe(-2.5);
    expect(parseLocaleNumber("1e3", en)).toBe(1000);
    expect(parseLocaleNumber("12,5%", de)).toBe(0.125);
    expect(parseLocaleNumber("12.5", en, true)).toBe(0.125);
    expect(parseLocaleNumber("abc", en)).toBeNull();
    expect(parseLocaleNumber("1.2.3", en)).toBeNull();
    expect(numberLocale("de-DE")).toEqual({ decimal: ",", group: "." });
  });

  it("turns typed text into the column's cell", () => {
    const de = { decimal: ",", group: "." };
    const num = { name: "Qty", type: "number" as const };
    expect(cellFromInput("", num, de)).toEqual({ ok: true, cell: null });
    expect(cellFromInput("3,5", num, de)).toEqual({ ok: true, cell: 3.5 });
    expect(cellFromInput("=B2*2", num, de)).toEqual({ ok: true, cell: "=B2*2" });
    expect(cellFromInput("'=x", { name: "T", type: "text" }, de)).toEqual({
      ok: true,
      cell: "'=x",
    });
    expect(cellFromInput("lots", num, de).ok).toBe(false);
    expect(cellFromInput("yes", { name: "P", type: "checkbox" }, de)).toEqual({
      ok: true,
      cell: true,
    });
    expect(inputText(3.5, num, de)).toBe("3,5");
    expect(inputText(0.125, { name: "S", type: "number", format: { style: "percent" } })).toBe(
      "12.5",
    );
  });

  it("parses tab-separated text as spreadsheet apps copy it", () => {
    expect(parseTsv("a\t1\nb\t2\n")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(parseTsv('"x\ty"\t"say ""hi"""\r\nz')).toEqual([["x\ty", 'say "hi"'], ["z"]]);
    expect(parseTsv("one")).toEqual([["one"]]);
  });
});

describe("solo editing", () => {
  function start(lines = LINES) {
    mount(lines);
    const f = framed();
    stop = boot(f.win, { locale: "en-US" });
    send(f, { type: "edit", on: true });
    return f;
  }

  it("opens a cell, sends the row, recomputes formulas, and the draft is canonical", async () => {
    const f = start();
    expect(document.querySelector(".plinth-sheet__strip")).not.toBeNull();
    dbl(cell("B2"));
    const input = field();
    expect(input?.value).toBe("3");
    expect(cell("B2").contains(input)).toBe(true);
    type(input as HTMLInputElement, "4");
    key(input as HTMLInputElement, "Enter");
    expect(field()).toBeNull();
    expect(text("B2")).toBe("4");
    expect(text("B4")).toBe("9");
    expect(await collected(f)).toBe(
      [HEADER, '["Apples",4,1.5,true,"new"]', LINES[2], LINES[3]].join("\n"),
    );
  });

  it("keeps a value the column cannot hold in the field and says why", async () => {
    const f = start();
    dbl(cell("B2"));
    const input = field() as HTMLInputElement;
    type(input, "three");
    key(input, "Enter");
    expect(field()).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(notice()).toContain("Qty takes numbers");
    // A formula that does not parse is refused the same way.
    type(input, "=SUM(");
    key(input, "Enter");
    expect(field()).toBe(input);
    key(input, "Escape");
    expect(field()).toBeNull();
    expect(await collected(f)).toBe(LINES.join("\n"));
  });

  it("Escape puts the row back after a sent edit", async () => {
    vi.useFakeTimers();
    const f = start();
    dbl(cell("A2"));
    const input = field() as HTMLInputElement;
    type(input, "Plums");
    vi.advanceTimersByTime(300);
    expect(text("C4")).toBeTruthy();
    expect(await collected(f)).toContain('["Plums",3');
    key(input, "Escape");
    expect(await collected(f)).toBe(LINES.join("\n"));
  });

  it("typing opens the selected cell with that key; a select column gets its options", () => {
    start();
    cell("A3").focus();
    key(cell("A3"), "Z");
    expect(field()?.value).toBe("Z");
    key(field() as HTMLInputElement, "Escape");
    dbl(cell("E2"));
    const sel = document.querySelector("select.plinth-sheet__input") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "new", "done"]);
    sel.value = "done";
    sel.dispatchEvent(new Event("change"));
    expect(text("E2")).toBe("done");
  });

  it("toggles a checkbox, clears a cell and pastes rows past the end", async () => {
    const f = start();
    cell("D2").focus();
    key(cell("D2"), "Enter");
    expect(cell("D2").querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("No");
    key(cell("A3"), "Delete");
    expect(text("A3")).toBe("");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "Figs\t2\nKiwis\t1,5\nLimes\t7\n" },
    });
    cell("A4").dispatchEvent(paste);
    const draft = (await collected(f)).split("\n");
    expect(draft.slice(1)).toEqual([
      '["Apples",3,1.5,false,"new"]',
      "[null,5,0.5,false]",
      '["Figs",2,"=B2*C2+B3*C3"]',
      '["Kiwis",15]',
      '["Limes",7]',
    ]);
    expect(document.documentElement.getAttribute("data-rows")).toBe("5");
  });

  it("refuses a paste that does not fit, and changes nothing", async () => {
    const f = start();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "a\tb" } });
    cell("B2").dispatchEvent(paste);
    expect(notice()).toContain("Qty takes numbers");
    const wide = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(wide, "clipboardData", { value: { getData: () => "1\t2\t3\t4\t5" } });
    cell("B2").dispatchEvent(wide);
    expect(notice()).toContain("reach past column E");
    expect(await collected(f)).toBe(LINES.join("\n"));
  });

  it("inserts and deletes rows and columns, moving formulas", async () => {
    const f = start();
    cell("A3").focus();
    button("Insert above").click();
    expect(document.documentElement.getAttribute("data-rows")).toBe("4");
    expect((await collected(f)).split("\n")[4]).toBe('["Total","=SUM(B2:B4)","=B2*C2+B4*C4"]');
    cell("B2").focus();
    button("Insert left").click();
    expect(text("B1")).toBe("Column 6");
    button("Delete column").click();
    expect(text("B1")).toBe("Qty");
    cell("A3").focus();
    button("Delete row").click();
    expect((await collected(f)).split("\n")).toEqual(LINES);
  });

  it("offers rows and columns in two menus, by keyboard too", () => {
    start();
    const strip = document.querySelector(".plinth-sheet__strip") as HTMLElement;
    const menus = [...strip.querySelectorAll<HTMLButtonElement>("[aria-haspopup=menu]")];
    expect(menus.map((b) => b.textContent)).toEqual(["Row", "Column"]);
    expect(strip.textContent).not.toContain("Double-click");
    const [row] = menus as [HTMLButtonElement];
    const list = document.getElementById(row.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(list.hidden).toBe(true);
    // On the header row, a row cannot go above it or be deleted.
    cell("A1").focus();
    key(row, "ArrowDown");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(document.activeElement?.textContent).toBe("Insert below");
    key(document.activeElement as Element, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Insert below");
    key(document.activeElement as Element, "Escape");
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(row);
    cell("A3").focus();
    row.click();
    expect(document.activeElement?.textContent).toBe("Insert above");
    key(document.activeElement as Element, "End");
    expect(document.activeElement?.textContent).toBe("Delete row");
    (document.activeElement as HTMLButtonElement).click();
    expect(list.hidden).toBe(true);
    expect(document.documentElement.getAttribute("data-rows")).toBe("2");
  });

  it("renames by typing in the header, and refuses a type the cells do not fit", async () => {
    const f = start();
    const th = cell("A1");
    key(th, "F2");
    const input = field() as HTMLInputElement;
    expect(input.value).toBe("Item");
    type(input, "Fruit");
    key(input, "Enter");
    expect(text("A1")).toBe("Fruit");
    cell("B2").focus();
    button("Column settings…").click();
    const form = document.querySelector(".plinth-sheet__panel") as HTMLFormElement;
    const typeSelect = form.querySelectorAll("select")[0] as HTMLSelectElement;
    typeSelect.value = "checkbox";
    typeSelect.dispatchEvent(new Event("change"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(notice()).toContain("Some cells do not fit");
    expect((await collected(f)).split("\n")[0]).toContain('"Fruit"');
    expect((await collected(f)).split("\n")[0]).toContain('{"name":"Qty","type":"number"}');
  });
});

describe("room editing", () => {
  const YOU = { id: "s1", email: "ada@example.org", right: "write" as const };

  function start() {
    mount(LINES, "room");
    const f = framed();
    stop = boot(f.win, {
      locale: "en-US",
      connect: () => new FakeSocket() as unknown as WebSocket,
    });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    ws.frame({
      t: "welcome",
      v: 1,
      you: YOU,
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

  it("leases the cell's row line and sends the whole row, then releases it", async () => {
    const { ws } = start();
    dbl(cell("B3"));
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    const input = field() as HTMLInputElement;
    expect(input.value).toBe("5");
    type(input, "6");
    key(input, "Enter");
    expect(ws.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l1", seq: 1, text: '["Pears",6,0.5,false]' },
      { t: "release", lease: "l1" },
    ]);
    // The room's ack applies it.
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      start: 2,
      del: 1,
      ins: '["Pears",6,0.5,false]',
      by: "s1",
      seq: 1,
    });
    await tick();
    expect(text("B4")).toBe("9");
  });

  it("shows who holds a row, keeps it closed, and waits for them before rows move", async () => {
    const { ws } = start();
    ws.frame({ t: "leased", lease: "l9", start: 1, end: 2, holder: "s2", by: "bo@example.org" });
    await tick();
    const tag = cell("A2").closest("tr")?.querySelector(".plinth-sheet__holder");
    expect(tag?.textContent).toBe("bo@example.org is editing");
    // Their typing arrives.
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 1,
      del: 1,
      ins: '["Apricots",3,1.5,true,"new"]',
      by: "s2",
      seq: 1,
    });
    await tick();
    expect(text("A2")).toBe("Apricots");
    const before = ws.sent.length;
    dbl(cell("A2"));
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("bo@example.org is editing this row.");
    cell("A3").focus();
    button("Delete row").click();
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("Rows and columns change once they finish");
    ws.frame({ t: "released", lease: "l9" });
    await tick();
    expect(cell("A2").closest("tr")?.querySelector(".plinth-sheet__holder")).toBeNull();
    button("Insert below").click();
    const op = { op: "insert_rows", before: 4, count: 1 };
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 4, op });
    ws.frame({ t: "struct", gen: "g1", rev: 5, op, by: "s1" });
    await tick();
    expect(document.documentElement.getAttribute("data-rows")).toBe("4");
    expect(text("A5")).toBe("Total");
  });

  it("hides the Row and Column menus while the draft waits for a review", async () => {
    const { ws } = start();
    const strip = document.querySelector(".plinth-sheet__strip") as HTMLElement;
    expect(strip.hidden).toBe(false);
    ws.frame({ t: "conflict", version: 4 });
    await tick();
    await tick();
    expect(strip.hidden).toBe(true);
  });

  it("aims a struct refused as stale at the row chosen, or drops it when that row is gone", async () => {
    const { ws } = start();
    const del = { op: "delete_rows", from: 2, count: 1 };
    cell("A2").focus();
    button("Delete row").click();
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 3, op: del });
    // Someone else deleted Apples first: deleting row 2 again would delete Pears.
    ws.frame({ t: "struct", gen: "g1", rev: 4, op: del, by: "s2" });
    const before = ws.sent.length;
    ws.frame({ t: "struct_denied", reason: "stale" });
    await tick();
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("The sheet changed meanwhile");
    expect(text("A2")).toBe("Pears");

    // Someone else inserted a row above Pears first: Pears is row 4 now.
    cell("A2").focus();
    button("Delete row").click();
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 4, op: del });
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 5,
      op: { op: "insert_rows", before: 2, count: 1 },
      by: "s2",
    });
    ws.frame({ t: "struct_denied", reason: "stale" });
    expect(ws.sent.at(-1)).toEqual({
      t: "struct",
      rev: 5,
      op: { op: "delete_rows", from: 3, count: 1 },
    });

    // Row below Total, after someone deleted the empty row above it: still below Total.
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 6,
      op: { op: "delete_rows", from: 3, count: 1 },
      by: "s1",
    });
    await tick();
    cell("A3").focus();
    button("Insert below").click();
    expect(ws.sent.at(-1)).toEqual({
      t: "struct",
      rev: 6,
      op: { op: "insert_rows", before: 4, count: 1 },
    });
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 7,
      op: { op: "delete_rows", from: 2, count: 1 },
      by: "s2",
    });
    ws.frame({ t: "struct_denied", reason: "stale" });
    expect(ws.sent.at(-1)).toEqual({
      t: "struct",
      rev: 7,
      op: { op: "insert_rows", before: 3, count: 1 },
    });
  });

  it("aims a column struct refused as stale at the column chosen", async () => {
    const { ws } = start();
    cell("C2").focus();
    button("Delete column").click();
    expect(ws.sent.at(-1)).toEqual({
      t: "struct",
      rev: 3,
      op: { op: "delete_columns", from: "C", count: 1 },
    });
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "insert_columns", before: "A", columns: [{ name: "Id", type: "text" }] },
      by: "s2",
    });
    ws.frame({ t: "struct_denied", reason: "stale" });
    // Price is column D now.
    expect(ws.sent.at(-1)).toEqual({
      t: "struct",
      rev: 4,
      op: { op: "delete_columns", from: "D", count: 1 },
    });
  });

  it("asks again for the row it was asked for when a lease is stale, and writes that row", async () => {
    const { ws } = start();
    cell("D2").focus();
    key(cell("D2"), " ");
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 1, end: 2 });
    // A row goes in above Apples before the room sees this lease.
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 4,
      op: { op: "insert_rows", before: 2, count: 1 },
      by: "s2",
    });
    ws.frame({ t: "lease_denied", reason: "stale" });
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 2, end: 3 });
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    expect(ws.sent.slice(-2)).toEqual([
      { t: "edit", lease: "l1", seq: 1, text: '["Apples",3,1.5,false,"new"]' },
      { t: "release", lease: "l1" },
    ]);
  });

  it("drops a write whose row is gone, or whose columns moved, when its lease is stale", async () => {
    const { ws } = start();
    key(cell("B3"), "Delete");
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 3, start: 2, end: 3 });
    // Pears changed meanwhile: clearing "row 3" now would clear what someone else wrote.
    ws.frame({ t: "leased", lease: "l9", start: 2, end: 3, holder: "s2", by: "bo@example.org" });
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l9",
      start: 2,
      del: 1,
      ins: '["Plums",5,0.5,false]',
      by: "s2",
      seq: 1,
    });
    ws.frame({ t: "released", lease: "l9" });
    let before = ws.sent.length;
    ws.frame({ t: "lease_denied", reason: "stale" });
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("The sheet changed meanwhile");

    // A checkbox column goes in at D: Total's line (three cells) is the same, but D is not Paid.
    key(cell("D4"), " ");
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 3, end: 4 });
    ws.frame({
      t: "struct",
      gen: "g1",
      rev: 5,
      op: { op: "insert_columns", before: "D", columns: [{ name: "Urgent", type: "checkbox" }] },
      by: "s2",
    });
    expect(ws.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 3, end: 4 });
    before = ws.sent.length;
    ws.frame({ t: "lease_denied", reason: "stale" });
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("The sheet changed meanwhile");
  });

  it("refuses a paste larger than one edit frame before taking a lease, and says so", async () => {
    const { ws } = start();
    const row = `${"x".repeat(110)}\t1\n`;
    const text = row.repeat(Math.ceil(LIMITS.liveDocFrameBytes / row.length) + 10);
    const before = ws.sent.length;
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
    cell("A2").dispatchEvent(ev);
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("Paste fewer rows at a time");
  });

  it("says so when a granted write cannot be sent", async () => {
    const { ws } = start();
    key(cell("D2"), " ");
    ws.refuse = "edit";
    ws.frame({ t: "leased", lease: "l1", start: 1, end: 2, holder: "s1", by: YOU.email });
    expect(ws.sent.at(-1)).toEqual({ t: "release", lease: "l1" });
    expect(notice()).toContain("That change was not sent");
  });

  it("says why the room refused a struct", async () => {
    const { ws } = start();
    cell("B2").focus();
    button("Delete column").click();
    expect(ws.sent.at(-1)).toMatchObject({ t: "struct", op: { op: "delete_columns" } });
    ws.frame({ t: "struct_denied", reason: "held", by: "bo@example.org" });
    expect(notice()).toContain("bo@example.org is editing");
  });
});
