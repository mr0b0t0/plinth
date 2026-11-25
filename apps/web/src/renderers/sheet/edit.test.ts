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
import { notKept } from "./edit.ts";
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
  send(raw: string) {
    if (raw === "ping") return;
    const f = JSON.parse(raw);
    if (f.t === this.refuse) throw new Error("closed");
    this.sent.push(this.unId(f));
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

describe("dropped text in a notice", () => {
  it("is quoted whole when short, and cut to 40 characters with an ellipsis when long", () => {
    expect(notKept("12", "B3")).toBe('Not kept in B3: "12"');
    expect(notKept("  two\n lines ")).toBe('Not kept: "two lines"');
    // At a space when one is near the cut, else mid-word.
    expect(notKept("Conference travel, Lisbon and Porto, incl. the two train passes", "A4")).toBe(
      'Not kept in A4: "Conference travel, Lisbon and Porto…"',
    );
    expect(notKept("x".repeat(100))).toBe(`Not kept: "${"x".repeat(39)}…"`);
  });
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
    // In the bar beside the filter, not a toolbar of their own.
    expect(strip.closest(".plinth-sheet__bar")).not.toBeNull();
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

  it("opens column settings as a popover that Escape closes", () => {
    start();
    cell("B2").focus();
    button("Column settings…").click();
    const form = document.querySelector(".plinth-sheet__panel") as HTMLFormElement;
    // Over the grid, not a strip above it; Cancel before the primary Apply.
    expect(form.closest(".plinth-sheet__slot")).toBeNull();
    expect(form.getAttribute("aria-label")).toBe("Column B settings");
    const actions = [...form.querySelectorAll("button")].map((b) => b.textContent);
    expect(actions).toEqual(["Cancel", "Apply"]);
    // The selects show words, and keep the stored values.
    const [types, formats] = [...form.querySelectorAll("select")];
    expect([...(types?.options ?? [])].map((o) => [o.value, o.text])).toEqual([
      ["text", "Text"],
      ["number", "Number"],
      ["date", "Date"],
      ["checkbox", "Checkbox"],
      ["select", "Select"],
      ["url", "URL"],
    ]);
    expect([...(formats?.options ?? [])].map((o) => o.text)).toEqual([
      "Automatic",
      "Plain",
      "Percent",
      "Currency",
    ]);
    key(form.querySelector("input") as HTMLInputElement, "Escape");
    expect(document.querySelector(".plinth-sheet__panel")).toBeNull();
    expect(document.activeElement).toBe(cell("B2"));
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
    // The row is tinted, with no badge; its number names the holder for a pointer and a screen
    // reader.
    const held = cell("A2").closest("tr");
    expect(held?.classList.contains("plinth-sheet__row--held")).toBe(true);
    const num = held?.querySelector("th.plinth-sheet__rownum");
    expect(num?.getAttribute("title")).toBe("Bo is editing");
    expect(num?.querySelector(".plinth-sheet__holder.plinth-sheet__sr")?.textContent).toBe(
      "Bo is editing",
    );
    expect(num?.textContent).toBe("2Bo is editing");
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
    // The double-click's second press selects no words in the held cell.
    const press = (el: Element, detail: number) => {
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press(cell("A2"), 1)).toBe(false);
    expect(press(cell("A2"), 2)).toBe(true);
    dbl(cell("A2"));
    expect(ws.sent.length).toBe(before);
    // The tint already shows it: no notice on screen, a screen reader is told.
    expect(notice()).toBe("");
    expect(document.querySelector(".plinth-sheet__sr[role=status]")?.textContent).toBe(
      "Bo is editing this row.",
    );
    cell("A3").focus();
    button("Delete row").click();
    expect(ws.sent.length).toBe(before);
    expect(notice()).toContain("Rows and columns change once they finish");
    ws.frame({ t: "released", lease: "l9" });
    await tick();
    expect(cell("A2").closest("tr")?.querySelector(".plinth-sheet__holder")).toBeNull();
    expect(cell("A2").closest("tr")?.querySelector("th")?.hasAttribute("title")).toBe(false);
    button("Insert below").click();
    const op = { op: "insert_rows", before: 4, count: 1 };
    expect(ws.sent.at(-1)).toEqual({ t: "struct", rev: 4, op });
    ws.frame({ t: "struct", gen: "g1", rev: 5, op, by: "s1" });
    await tick();
    expect(document.documentElement.getAttribute("data-rows")).toBe("4");
    expect(text("A5")).toBe("Total");
  });

  it("after a dropped socket, a row the room acknowledged but had not flushed is taken again where it is", async () => {
    vi.useFakeTimers();
    const { ws } = start();
    dbl(cell("B3"));
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    type(field() as HTMLInputElement, "6");
    vi.advanceTimersByTime(300);
    expect(ws.sent.at(-1)).toEqual({
      t: "edit",
      lease: "l1",
      seq: 1,
      text: '["Pears",6,0.5,false]',
    });
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
      re: ws.idOf("edit"),
    });
    // The socket drops before the room's flush; the room keeps running with the edit.
    ws.onclose?.({ code: 1006 } as CloseEvent);
    vi.advanceTimersByTime(60_000);
    const again = FakeSocket.all.at(-1) as FakeSocket;
    expect(again).not.toBe(ws);
    const lines = [...LINES];
    lines[2] = '["Pears",6,0.5,false]';
    again.frame({
      t: "welcome",
      v: 1,
      you: YOU,
      gen: "g1",
      rev: 4,
      base_version: 2,
      flushed_rev: 3,
      conflict_version: null,
      last_by_you: true,
      leases: [],
      peers: [],
    });
    again.frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: lines.join("\n") });
    await Promise.resolve();
    // Found by the text the room acknowledged: the same row, asked for again, the field kept.
    expect(again.sent.at(-1)).toEqual({ t: "lease", rev: 4, start: 2, end: 3 });
    again.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: "s1", by: YOU.email });
    await Promise.resolve();
    expect(field()?.value).toBe("6");
    expect(notice()).not.toContain("changed meanwhile");
  });

  it("the save status settles after a keystroke that changes no row", async () => {
    vi.useFakeTimers();
    const { f, ws } = start();
    dbl(cell("B3"));
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    // The value it already has: the row line is the same, so nothing is sent.
    type(field() as HTMLInputElement, "5");
    await Promise.resolve();
    const lastLive = () =>
      f.parent.postMessage.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((m) => m.type === "live")
        .at(-1);
    expect(lastLive()?.unflushed).toBe(true);
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(ws.sent.filter((s) => s.t === "edit")).toEqual([]);
    expect(lastLive()?.unflushed).toBe(false);
  });

  it("a freeze that closes the cell quotes what the room did not get, and only that", async () => {
    const { ws } = start();
    dbl(cell("B3"));
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    // Typed within the last moments before the freeze: not sent yet.
    type(field() as HTMLInputElement, "6");
    ws.frame({ t: "conflict", version: 4 });
    ws.frame({ t: "lease_lost", lease: "l1", reason: "closed" });
    await tick();
    expect(field()).toBeNull();
    expect(notice()).toContain('Paused. Not kept in B3: "6"');
  });

  it("the notice quotes a long unsent text on one line, cut to 40 characters", async () => {
    const { ws } = start();
    dbl(cell("A3"));
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    const long = "Pears from the market on Saturday, the big green ones, two boxes";
    type(field() as HTMLInputElement, long);
    // Inside the open field a double-click still selects a word.
    const twice = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2 });
    field()?.dispatchEvent(twice);
    expect(twice.defaultPrevented).toBe(false);
    ws.frame({ t: "conflict", version: 4 });
    ws.frame({ t: "lease_lost", lease: "l1", reason: "closed" });
    await tick();
    const shown = document.querySelector(".plinth-sheet__notice > span") as HTMLElement;
    expect(shown.textContent).toBe(
      'Paused. Not kept in A3: "Pears from the market on Saturday, the…"',
    );
    // The whole text stays on the notice for a pointer, so it can be typed again.
    expect(shown.title).toBe(long);
  });

  it("typing the room already applied is not quoted when the cell is closed", async () => {
    const next = start();
    dbl(cell("B3"));
    next.ws.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: "s1", by: YOU.email });
    type(field() as HTMLInputElement, "7");
    next.ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l2",
      start: 2,
      del: 1,
      ins: '["Pears",7,0.5,false]',
      by: "s1",
      seq: 1,
    });
    next.ws.frame({ t: "lease_lost", lease: "l2", reason: "takeover" });
    await tick();
    expect(field()).toBeNull();
    expect(notice()).toContain("Someone else took over this row.");
    expect(notice()).not.toContain("not kept");
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

  it("a row the room refuses shows the room's row again and says why; the next edit is unflushed until its ack", async () => {
    const { f, ws } = start();
    const lastLive = () =>
      f.parent.postMessage.mock.calls
        .map((c) => c[0])
        .filter((m) => m?.type === "live")
        .at(-1);
    dbl(cell("B3"));
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: YOU.email });
    type(field() as HTMLInputElement, "6");
    key(field() as HTMLInputElement, "Enter");
    expect(ws.sent.at(-2)).toMatchObject({ t: "edit", seq: 1 });
    ws.frame({ t: "error", code: "invalid", re: ws.idOf("edit") });
    await tick();
    // The refused value was never in the draft: the grid shows the room's row, and says so.
    expect(text("B3")).toBe("5");
    expect(notice()).toContain("does not fit the sheet");
    // Nothing of this frame waits for the room any more.
    expect(lastLive()).toMatchObject({ unflushed: false });
    // A later edit is unsent until the room acknowledges it, as before.
    dbl(cell("B2"));
    ws.frame({ t: "leased", lease: "l2", start: 1, end: 2, holder: "s1", by: YOU.email });
    type(field() as HTMLInputElement, "7");
    key(field() as HTMLInputElement, "Enter");
    await tick();
    expect(lastLive()).toMatchObject({ unflushed: true });
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l2",
      start: 1,
      del: 1,
      ins: '["Apples",7,1.5,true,"new"]',
      by: "s1",
      seq: 2,
      re: ws.idOf("edit"),
    });
    ws.frame({ t: "flushed", rev: 4 });
    await tick();
    expect(text("B2")).toBe("7");
    expect(lastLive()).toMatchObject({ unflushed: false });
  });

  it("says why the room refused a struct", async () => {
    const { ws } = start();
    cell("B2").focus();
    button("Delete column").click();
    expect(ws.sent.at(-1)).toMatchObject({ t: "struct", op: { op: "delete_columns" } });
    ws.frame({ t: "struct_denied", reason: "held", by: "bo@example.org" });
    expect(notice()).toContain("Bo is editing. Rows and columns change once they finish.");
  });
});
