// Several cells at once on a sheet's page: how cell styles, highlight rules and option colours
// show (class names from fixed lists), selecting a range by keyboard, Shift+click and drag,
// copying it, and in edit mode clearing it, filling down (keys and the fill handle), the Format
// menu, undo and redo (and their refusal when someone changed the rows since), pasting this
// grid's own copy back with its formulas, and the column settings' colours and highlight rules.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { cellLookClasses, htmlText, tsvField } from "./grid.ts";

const APP = "https://plinth.example.com";
const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text" },
    { name: "Qty", type: "number", highlight: [{ when: "<", value: 0, color: "red" }] },
    { name: "Price", type: "number" },
    {
      name: "Stage",
      type: "select",
      options: ["new", "done"],
      colors: { done: "green" },
    },
  ],
});
const LINES = [
  HEADER,
  '["Apples",3,1.5,"new",{"style":{"A":{"bold":true,"fill":"yellow"},"B":{"fill":"blue"}}}]',
  '["Pears",-5,0.5,"done"]',
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
const notice = () => document.querySelector(".plinth-sheet__notice")?.textContent ?? "";
const key = (el: EventTarget, k: string, extra: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
const dbl = (el: Element) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input"));
};
const field = () => document.querySelector(".plinth-sheet__input") as HTMLInputElement | null;
const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".plinth-sheet__strip button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  ) as HTMLButtonElement;
const tick = () => new Promise((r) => setTimeout(r, 0));
const selected = () =>
  [...document.querySelectorAll('[aria-selected="true"]')].map((e) =>
    e.id.replace("__plinth-cell-", ""),
  );

async function collected(f: Framed): Promise<string[]> {
  f.parent.postMessage.mockClear();
  send(f, { type: "collect", nonce: "n".repeat(16) });
  const m = f.parent.postMessage.mock.calls.map((c) => c[0]).find((x) => x.type === "draft");
  return (m.text as string).split("\n");
}

/** A copy event at the focused cell, with a clipboard that keeps what is set. */
function copy(at: Element): Record<string, string> {
  const data: Record<string, string> = {};
  const e = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: {
      setData: (t: string, v: string) => (data[t] = v),
      getData: (t: string) => data[t] ?? "",
    },
  });
  at.dispatchEvent(e);
  return data;
}

function paste(at: Element, text: string) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: () => text } });
  at.dispatchEvent(e);
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  FakeSocket.all = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function view(lines = LINES) {
  mount(lines);
  const f = framed();
  stop = boot(f.win, { locale: "en-US" });
  return f;
}

function solo(lines = LINES) {
  const f = view(lines);
  send(f, { type: "edit", on: true });
  return f;
}

describe("looks", () => {
  it("draw styles, highlights and option chips as classes from fixed lists", () => {
    view();
    const a2 = cell("A2");
    expect(a2.classList).toContain("plinth-sheet__s-bold");
    expect(a2.classList).toContain("plinth-sheet__fill--yellow");
    // A highlight wins over the cell's own fill.
    expect(cell("B3").classList).toContain("plinth-sheet__hl--red");
    expect(cell("B2").classList).toContain("plinth-sheet__fill--blue");
    expect(cell("B2").classList).not.toContain("plinth-sheet__hl--red");
    // The total (=SUM) is -2: highlighted by its computed value.
    expect(cell("B4").classList).toContain("plinth-sheet__hl--red");
    const chip = cell("D3").querySelector(".plinth-sheet__chip");
    expect(chip?.className).toBe("plinth-sheet__chip plinth-sheet__chip--green");
    expect(chip?.textContent).toBe("done");
    // An option without a colour is plain text.
    expect(cell("D2").querySelector(".plinth-sheet__chip")).toBeNull();
    expect(cell("D2").textContent).toBe("new");
  });

  it("never turns a value it does not know into a class", () => {
    const bad = { fill: "red;background:url(x)", align: "justify", border: ["top", "x"] };
    expect(
      cellLookClasses({ style: bad as never, highlight: "lime" as never, chip: null }),
    ).toEqual(["plinth-sheet__bd", "plinth-sheet__bd--top"]);
    expect(
      cellLookClasses({
        style: { italic: true, align: "center", wrap: true, border: ["left", "bottom"] },
        highlight: null,
        chip: null,
      }),
    ).toEqual([
      "plinth-sheet__s-italic",
      "plinth-sheet__s-center",
      "plinth-sheet__s-wrap",
      "plinth-sheet__bd",
      "plinth-sheet__bd--left",
      "plinth-sheet__bd--bottom",
    ]);
  });
});

describe("a range of cells", () => {
  it("grows with Shift and the arrows, says its size, and Escape goes back to one cell", () => {
    view();
    cell("B2").focus();
    key(cell("B2"), "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "ArrowRight", { shiftKey: true });
    expect(document.activeElement).toBe(cell("C3"));
    expect(selected().sort()).toEqual(["B2", "B3", "C2", "C3"]);
    expect(document.querySelector(".plinth-sheet__fx-addr")?.textContent).toBe("B2:C3");
    expect(
      document.querySelector('.plinth-sheet__page [aria-live="polite"].plinth-sheet__sr')
        ?.textContent,
    ).toBe("B2 to C3 selected, 4 cells");
    expect(document.querySelector("table")?.getAttribute("aria-multiselectable")).toBe("true");
    key(cell("C3"), "Escape");
    expect(selected()).toEqual([]);
    expect(document.querySelector(".plinth-sheet__fx-addr")?.textContent).toBe("C3");
  });

  it("grows with Shift+click and with a drag", () => {
    view();
    cell("A2").focus();
    cell("C3").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    expect(selected().length).toBe(6);
    cell("B2").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    cell("B2").focus();
    cell("C4").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, buttons: 1 }));
    expect(selected().sort()).toEqual(["B2", "B3", "B4", "C2", "C3", "C4"]);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    cell("A4").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, buttons: 0 }));
    expect(selected().length).toBe(6);
  });

  it("copies as text and an HTML table, in the order shown, without the rows a filter hides", () => {
    view();
    const filter = document.querySelector(".plinth-sheet__filter-input") as HTMLInputElement;
    filter.value = "e";
    filter.dispatchEvent(new Event("input"));
    cell("A2").focus();
    key(cell("A2"), "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "ArrowRight", { shiftKey: true });
    // Total has no "e": the selection runs Apples and Pears.
    const data = copy(document.activeElement as Element);
    expect(data["text/plain"]).toBe("Apples\t3\nPears\t-5");
    expect(data["text/html"]).toBe(
      "<table><tr><td>Apples</td><td>3</td></tr><tr><td>Pears</td><td>-5</td></tr></table>",
    );
  });

  it("quotes and escapes what it copies", () => {
    expect(tsvField('a\t"b"')).toBe('"a\t""b"""');
    expect(tsvField("plain")).toBe("plain");
    expect(htmlText('<b>&"')).toBe("&lt;b&gt;&amp;&quot;");
  });
});

describe("editing a range", () => {
  it("Delete clears every selected cell and keeps their styles", async () => {
    const f = solo();
    cell("A2").focus();
    key(cell("A2"), "ArrowRight", { shiftKey: true });
    key(document.activeElement as Element, "Delete");
    expect((await collected(f))[1]).toBe(
      '[null,null,1.5,"new",{"style":{"A":{"bold":true,"fill":"yellow"},"B":{"fill":"blue"}}}]',
    );
  });

  it("fills down with Ctrl+D, moving relative references, and from the row above for one row", async () => {
    const lines = [HEADER, '["a",1,"=B2*2"]', '["b",2]', '["c",3]'];
    const f = solo(lines);
    cell("C2").focus();
    key(cell("C2"), "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "d", { ctrlKey: true });
    expect((await collected(f)).slice(1)).toEqual([
      '["a",1,"=B2*2"]',
      '["b",2,"=B3*2"]',
      '["c",3,"=B4*2"]',
    ]);
    cell("A4").focus();
    key(cell("A4"), "d", { metaKey: true });
    expect((await collected(f))[3]).toBe('["b",3,"=B4*2"]');
  });

  it("does not fill while a sort shows another order", async () => {
    const f = solo();
    (cell("B1").querySelector("button") as HTMLButtonElement).click();
    cell("B2").focus();
    key(cell("B2"), "d", { ctrlKey: true });
    expect(notice()).toContain("Turn the sort off first");
    expect(await collected(f)).toEqual(LINES.map((l) => l));
  });

  it("fills the rows the fill handle is dragged over", async () => {
    const lines = [HEADER, '["a",1,"=B2+1"]', '["b"]', '["c"]', '["d"]'];
    const f = solo(lines);
    cell("C2").focus();
    const handle = cell("C2").querySelector(".plinth-sheet__fill-handle") as HTMLElement;
    expect(handle).not.toBeNull();
    const pe = (t: string, x = 0) => {
      const e = new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: x });
      Object.defineProperty(e, "pointerId", { value: 1 });
      return e;
    };
    handle.dispatchEvent(pe("pointerdown"));
    document.elementFromPoint = () => cell("C4");
    handle.dispatchEvent(pe("pointermove"));
    expect(document.querySelectorAll(".plinth-sheet__fill-target").length).toBe(2);
    handle.dispatchEvent(pe("pointerup"));
    expect(document.querySelectorAll(".plinth-sheet__fill-target").length).toBe(0);
    expect((await collected(f)).slice(1)).toEqual([
      '["a",1,"=B2+1"]',
      '["b",null,"=B3+1"]',
      '["c",null,"=B4+1"]',
      '["d"]',
    ]);
  });

  it("styles the selection from the Format menu and with Ctrl+B", async () => {
    const f = solo();
    cell("B3").focus();
    key(cell("B3"), "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "ArrowRight", { shiftKey: true });
    item("Bold").click();
    item("Fill green").click();
    item("Outline").click();
    let rows = await collected(f);
    expect(rows[2]).toBe(
      '["Pears",-5,0.5,"done",{"style":{"B":{"bold":true,"fill":"green","border":["top","left"]},"C":{"bold":true,"fill":"green","border":["top","right"]}}}]',
    );
    expect(rows[3]).toBe(
      '["Total","=SUM(B2:B3)","=B2*C2+B3*C3",{"style":{"B":{"bold":true,"fill":"green","border":["bottom","left"]},"C":{"bold":true,"fill":"green","border":["right","bottom"]}}}]',
    );
    // The selected cell is bold: Ctrl+B takes it off the whole selection.
    key(document.activeElement as Element, "b", { ctrlKey: true });
    rows = await collected(f);
    expect(rows[2]).not.toContain('"bold"');
    item("Clear formatting").click();
    rows = await collected(f);
    expect(rows.slice(2)).toEqual(LINES.slice(2));
  });
});

describe("undo and redo", () => {
  const undoKey = (f: Framed, shift = false) =>
    f.target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: shift }),
    );

  it("take back a typed cell and make it again", async () => {
    const f = solo();
    dbl(cell("B2"));
    type(field() as HTMLInputElement, "9");
    key(field() as HTMLInputElement, "Enter");
    expect((await collected(f))[1]).toContain('"Apples",9');
    (document.activeElement as HTMLElement).blur();
    cell("A3").focus();
    undoKey(f);
    expect((await collected(f))[1]).toBe(LINES[1]);
    expect(document.activeElement).toBe(cell("B2"));
    undoKey(f, true);
    expect((await collected(f))[1]).toContain('"Apples",9');
  });

  it("take back a format and a fill, newest first", async () => {
    const f = solo();
    cell("A3").focus();
    item("Italic").click();
    key(cell("A3"), "ArrowDown", { shiftKey: true });
    key(document.activeElement as Element, "Delete");
    undoKey(f);
    expect((await collected(f))[3]).toBe(LINES[3]);
    undoKey(f);
    expect(await collected(f)).toEqual(LINES);
  });

  it("are refused when someone changed the rows since", async () => {
    mount(LINES, "room");
    const f = framed();
    stop = boot(f.win, {
      locale: "en-US",
      connect: () => new FakeSocket() as unknown as WebSocket,
    });
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    const you = { id: "s1", email: "you@example.com", right: "write" };
    ws.frame({
      t: "welcome",
      v: 1,
      you,
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
    await tick();
    cell("A3").focus();
    item("Italic").click();
    const lease = ws.sent.at(-1);
    expect(lease).toMatchObject({ t: "lease", start: 2, end: 3 });
    ws.frame({ t: "leased", lease: "l1", start: 2, end: 3, holder: "s1", by: you.email });
    const edit = ws.sent.find((s) => s.t === "edit") as { text: string; seq: number };
    expect(edit.text).toContain('"A":{"italic":true}');
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      start: 2,
      del: 1,
      ins: edit.text,
      by: "s1",
      seq: edit.seq,
    });
    ws.frame({ t: "released", lease: "l1" });
    // Someone else changes the same row.
    ws.frame({ t: "leased", lease: "l2", start: 2, end: 3, holder: "s2", by: "bo@example.com" });
    ws.frame({
      t: "op",
      gen: "g1",
      rev: 5,
      lease: "l2",
      start: 2,
      del: 1,
      ins: edit.text.replace("Pears", "Plums"),
      by: "s2",
      seq: 1,
    });
    ws.frame({ t: "released", lease: "l2" });
    await tick();
    const before = ws.sent.length;
    f.target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    expect(notice()).toContain("Changed since, so it can't be undone.");
    expect(ws.sent.length).toBe(before);
  });

  it("take back a paste past the end, rows and all", async () => {
    const f = solo();
    cell("A4").focus();
    paste(cell("A4"), "x\ny\nz");
    expect((await collected(f)).length).toBe(6);
    undoKey(f);
    expect(await collected(f)).toEqual(LINES);
  });
});

describe("this grid's own copy pasted back", () => {
  it("keeps formulas, moved by where they land", async () => {
    const f = solo();
    cell("B4").focus();
    const data = copy(cell("B4"));
    expect(data["text/plain"]).toBe("-2");
    cell("C4").focus();
    paste(cell("C4"), data["text/plain"] as string);
    expect((await collected(f))[3]).toBe('["Total","=SUM(B2:B3)","=SUM(C2:C3)"]');
  });
});

describe("column settings", () => {
  const panel = () => document.querySelector(".plinth-sheet__panel") as HTMLFormElement;

  it("give options a colour and columns highlight rules", async () => {
    const f = solo();
    cell("D2").focus();
    item("Column settings…").click();
    const swatches = [
      ...panel().querySelectorAll<HTMLSelectElement>(".plinth-sheet__option select"),
    ];
    expect(swatches.map((s) => s.value)).toEqual(["", "green"]);
    expect(swatches[0]?.getAttribute("aria-label")).toBe("Colour of new");
    (swatches[0] as HTMLSelectElement).value = "blue";
    swatches[0]?.dispatchEvent(new Event("change"));
    const add = [...panel().querySelectorAll("button")].find((b) => b.textContent === "Add rule");
    add?.click();
    const rule = panel().querySelector(".plinth-sheet__rule") as HTMLElement;
    const [when] = [...rule.querySelectorAll("select")] as HTMLSelectElement[];
    (when as HTMLSelectElement).value = "contains";
    when?.dispatchEvent(new Event("change"));
    (panel().querySelector(".plinth-sheet__rule input") as HTMLInputElement).value = "do";
    panel().dispatchEvent(new Event("submit", { cancelable: true }));
    const head = JSON.parse((await collected(f))[0] as string);
    expect(head.columns[3]).toEqual({
      name: "Stage",
      type: "select",
      options: ["new", "done"],
      colors: { new: "blue", done: "green" },
      highlight: [{ when: "contains", value: "do", color: "red" }],
    });
  });

  it("say which rule cannot be kept", async () => {
    const f = solo();
    cell("B2").focus();
    item("Column settings…").click();
    const rule = panel().querySelector(".plinth-sheet__rule") as HTMLElement;
    (rule.querySelector("input") as HTMLInputElement).value = "lots";
    panel().dispatchEvent(new Event("submit", { cancelable: true }));
    expect(notice()).toBe("Highlight rule 1: value must be a number in a number column.×");
    expect((await collected(f))[0]).toBe(HEADER);
  });
});
