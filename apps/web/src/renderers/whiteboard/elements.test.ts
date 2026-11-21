// The widened elements on the page: Claude's shapes drawn as an outline behind the words, sections
// behind everything with arrows over them, tables as a grid whose cells people write in, inline
// marks as spans and safe links (never markup), custom colours, and the one Shape or Text size list
// a selection shows. A section carries the blocks inside it when it is dragged.
import { type BoardBlock, parseBoardSettings } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./board.ts";
import type { RuntimeCollection, RuntimeDoc } from "./runtime.ts";
import { BoardSync } from "./sync.ts";
import { renderText } from "./view.ts";

class Coll implements RuntimeCollection {
  docs = new Map<string, RuntimeDoc>();
  rev = 10;
  sets: { id: string; data: unknown; ifRev?: number }[] = [];
  async list() {
    return { docs: [...this.docs.values()] };
  }
  async all() {
    return [...this.docs.values()];
  }
  async get(id: string) {
    return this.docs.get(id) ?? null;
  }
  async add(data: unknown): Promise<RuntimeDoc> {
    const d = { id: `n${++this.rev}`, data, rev: this.rev };
    this.docs.set(d.id, d);
    return d;
  }
  async set(id: string, data: unknown, opts?: { ifRev?: number }) {
    this.sets.push({ id, data, ifRev: opts?.ifRev });
    const cur = this.docs.get(id);
    if (opts?.ifRev !== undefined && (cur?.rev ?? 0) !== opts.ifRev) {
      throw Object.assign(new Error("conflict"), { code: "conflict", currentRev: cur?.rev ?? 0 });
    }
    const d = { id, data, rev: ++this.rev };
    this.docs.set(id, d);
    return d;
  }
  async update(): Promise<RuntimeDoc> {
    throw new Error("unused");
  }
  async delete(id: string) {
    this.docs.delete(id);
  }
  onSnapshot() {
    return () => {};
  }
}

function setup(blocks: Record<string, BoardBlock>, arrows: Record<string, unknown> = {}) {
  const root = document.createElement("main");
  document.body.append(root);
  const board = new Board({
    win: window,
    root,
    title: "Board",
    settings: parseBoardSettings('{"v":1}'),
  });
  const coll = new Coll();
  const say = vi.fn();
  board.sync = new BoardSync({
    blocks: coll,
    arrows: new Coll(),
    model: board.model,
    changed: () => board.redraw(),
    readOnly: () => board.setReadOnly(true),
    say,
    emit: () => {},
    busy: (id) => board.holds(id),
    wait: async () => {},
  });
  for (const [id, b] of Object.entries(blocks)) {
    coll.docs.set(id, { id, data: b, rev: 3 });
    board.model.upsertBlock(id, b, 3);
  }
  for (const [id, a] of Object.entries(arrows)) board.model.upsertArrow(id, a, 3);
  board.setReadOnly(false);
  const el = (id: string) => {
    const found = board.view.blocks.get(id);
    if (!found) throw new Error(`no block ${id}`);
    return found;
  };
  return { board, root, coll, el, say };
}

const shape = (over: Partial<BoardBlock> = {}): BoardBlock => ({
  kind: "rect",
  x: 0,
  y: 0,
  w: 200,
  h: 100,
  text: "",
  ...over,
});

function pointer(el: Element, type: string, x: number, y = 0) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("drawing the new elements", () => {
  it("draws a shape's outline as an svg path behind its words; a box and an ellipse stay CSS", () => {
    const { el } = setup({
      d: shape({ kind: "diamond", text: "Go?" }),
      r: shape({ kind: "rect", x: 300 }),
    });
    const path = el("d").querySelector(".wb-shape path");
    expect(path?.getAttribute("d")).toMatch(/^M100 0L200 50/);
    expect(el("d").hasAttribute("data-shape")).toBe(true);
    expect(el("d").querySelector<HTMLElement>(".wb-text")?.style.padding).toBe("33px 60px");
    expect(el("r").querySelector(".wb-shape")).toBeNull();
    expect(el("r").getAttribute("aria-label")).toBe("Box, empty");
    expect(el("d").getAttribute("aria-label")).toBe("Diamond: Go?");
  });

  it("takes any #rrggbb as written, with words that read on it, and outlines in a colour's ink", () => {
    const { el } = setup({
      a: shape({ kind: "cloud", color: "#102030", stroke: "pink" }),
      b: shape({ kind: "text", color: "#abcdef", size: "title", textAlign: "right" }),
    });
    expect(el("a").dataset.color).toBe("custom");
    expect(el("a").style.getPropertyValue("--wb-fill")).toBe("#102030");
    expect(el("a").style.getPropertyValue("--wb-on")).toBe("#ffffff");
    expect(el("a").style.getPropertyValue("--wb-stroke")).toBe("var(--wb-ink-pink)");
    const text = el("b").querySelector<HTMLElement>(".wb-text");
    expect(text?.style.fontSize).toBe("48px");
    expect(text?.style.lineHeight).toBe("62px");
    expect(text?.style.textAlign).toBe("right");
  });

  it("draws a section behind every block, its arrows over it", () => {
    const { board, el } = setup(
      {
        n: shape({ kind: "note", x: 40, y: 40, w: 100, h: 80, z: -5 }),
        s: shape({ kind: "container", x: 0, y: 0, w: 400, h: 300, text: "Now", z: 9 }),
        m: shape({ x: 200, y: 40, w: 100, h: 80 }),
      },
      { a: { from: "n", to: "m" } },
    );
    const z = (id: string) => Number(el(id).style.zIndex);
    expect(z("s")).toBeLessThan(Number(board.view.arrows.style.zIndex));
    expect(Number(board.view.arrows.style.zIndex)).toBeLessThan(z("n"));
    expect(el("s").querySelector(".wb-text")?.textContent).toBe("Now");
  });

  it("draws an arrow with sides in right angles and its heads as shapes, in its colour", () => {
    const { root } = setup(
      { a: shape(), b: shape({ x: 400, y: 200 }) },
      {
        x: { from: "a", to: "b", fromSide: "right", toSide: "left", heads: ["circle", "arrow"] },
        y: { from: "b", to: "a", color: "green" },
      },
    );
    const lines = root.querySelectorAll(".wb-arrow");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute("d")?.split("L").length).toBeGreaterThan(2);
    const heads = [...root.querySelectorAll(".wb-arrow-head")].map((h) => h.getAttribute("d"));
    expect(heads[0]).toMatch(/A/);
    expect(heads[1]).toMatch(/^M/);
    // The second arrow carries only the default head at its end.
    expect(heads[2]).toBeNull();
    const g = lines[1]?.parentElement as unknown as SVGGElement;
    expect(g.style.getPropertyValue("--wb-arrow-c")).toBe("var(--wb-ink-green)");
  });

  it("draws a table as a grid: columns by weight, the header first, fills and shading", () => {
    const { el } = setup({
      t: shape({
        kind: "table",
        w: 280,
        h: 90,
        cols: { c2: { at: 2, w: 120 }, c1: { at: 1, w: 160 } },
        rows: {
          r1: { at: 1, c1: "Plan", c2: "Price" },
          r2: { at: 2, c1: "Pro", c2: "20" },
          r3: { at: 3, c1: "Team", c2: "40" },
        },
        fills: { r2: { c1: "#000000" } },
        heat: { cols: { c2: "blue" } },
      }),
    });
    const grid = el("t").querySelector<HTMLElement>(".wb-table");
    expect(grid?.style.gridTemplateColumns).toBe("160fr 120fr");
    const cells = [...el("t").querySelectorAll<HTMLElement>(".wb-cell")];
    expect(cells.map((c) => c.textContent)).toEqual(["Plan", "Price", "Pro", "20", "Team", "40"]);
    expect(cells[0]?.classList.contains("wb-head")).toBe(true);
    expect(cells[2]?.style.background).toMatch(/^(#000000|rgb\(0, 0, 0\))$/);
    expect(cells[2]?.style.color).toMatch(/^(#ffffff|rgb\(255, 255, 255\))$/);
    expect(cells[3]?.style.getPropertyValue("--wb-heat")).toBe("var(--wb-ink-blue)");
    expect(cells[3]?.style.getPropertyValue("--wb-heat-pct")).toBe("12%");
    expect(cells[5]?.style.getPropertyValue("--wb-heat-pct")).toBe("62%");
  });
});

describe("inline marks", () => {
  it("draws marks as spans and an http(s) link as an <a>; markup and other links stay text", () => {
    const el = document.createElement("div");
    renderText(
      document,
      el,
      "**Bold** <b>x</b> [ok](https://example.com) [no](javascript:alert(1))",
    );
    expect(el.querySelector(".wb-b")?.textContent).toBe("Bold");
    expect(el.querySelector("b")).toBeNull();
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/");
    expect(links[0]?.rel).toBe("noopener noreferrer nofollow");
    expect(links[0]?.target).toBe("_blank");
    expect(el.textContent).toBe("Bold <b>x</b> ok [no](javascript:alert(1))");
    renderText(document, el, "plain <i>text</i>");
    expect(el.childNodes).toHaveLength(1);
    expect(el.textContent).toBe("plain <i>text</i>");
  });

  it("opens a link pressed without a drag in a new tab, with no opener", () => {
    const { el } = setup({ a: shape({ text: "See [docs](https://example.com/d)" }) });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = el("a").querySelector("a");
    if (!link) throw new Error("no link");
    pointer(link, "pointerdown", 10);
    pointer(link, "pointerup", 10);
    expect(open).toHaveBeenCalledWith("https://example.com/d", "_blank", "noopener,noreferrer");
    open.mockClear();
    // A press that drags the block never opens it.
    pointer(link, "pointerdown", 10);
    pointer(link, "pointermove", 80);
    pointer(link, "pointerup", 80);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe("changing the new elements on the page", () => {
  it("shows one Shape list for a selected shape, a Text size list for text, and saves the pick", async () => {
    const { board, coll, el } = setup({ a: shape(), t: shape({ kind: "text", x: 300 }) });
    const sel = board.view.toolbar.style;
    expect(sel.hidden).toBe(true);
    pointer(el("a"), "pointerdown", 10);
    pointer(el("a"), "pointerup", 10);
    expect(sel.hidden).toBe(false);
    expect(sel.getAttribute("aria-label")).toBe("Shape");
    expect(sel.value).toBe("rect");
    expect([...sel.options].map((o) => o.value)).toContain("cloud");
    sel.value = "hexagon";
    sel.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(coll.sets).toHaveLength(1));
    expect(coll.sets[0]?.data).toMatchObject({ kind: "hexagon" });
    pointer(el("t"), "pointerdown", 310);
    pointer(el("t"), "pointerup", 310);
    expect(sel.getAttribute("aria-label")).toBe("Text size");
    expect(sel.value).toBe("small");
    sel.value = "title";
    sel.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(coll.sets).toHaveLength(2));
    expect(coll.sets[1]?.data).toMatchObject({ kind: "text", size: "title" });
  });

  it("a section carries the blocks inside it, saving each where it lands", async () => {
    const { coll, el } = setup({
      s: shape({ kind: "container", x: 0, y: 0, w: 400, h: 300, text: "Now" }),
      in: shape({ x: 40, y: 40, w: 100, h: 80 }),
      out: shape({ x: 500, y: 40, w: 100, h: 80 }),
    });
    pointer(el("s"), "pointerdown", 300, 200);
    pointer(el("s"), "pointermove", 350, 210);
    expect(el("in").style.left).toBe("90px");
    pointer(el("s"), "pointerup", 350, 210);
    await vi.waitFor(() => expect(coll.sets.map((s) => s.id).sort()).toEqual(["in", "s"]));
    expect(coll.docs.get("in")?.data).toMatchObject({ x: 90, y: 50 });
    expect(coll.docs.get("out")?.data).toMatchObject({ x: 500, y: 40 });
  });

  it("writes in one table cell and saves the rows over the copy the edit began from", async () => {
    const { board, coll, el } = setup({
      t: shape({
        kind: "table",
        w: 240,
        h: 60,
        cols: { c1: { at: 1 }, c2: { at: 2 } },
        rows: { r1: { at: 1, c1: "Plan", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$20" } },
      }),
    });
    board.startEditing("t", ["r2", "c2"]);
    const ta = el("t").querySelector(".wb-cell textarea") as HTMLTextAreaElement | null;
    if (!ta) throw new Error("no cell editor");
    expect(ta.value).toBe("$20");
    expect(ta.getAttribute("aria-label")).toBe("Cell text");
    ta.value = "$25";
    board.finishEditing(true);
    await vi.waitFor(() => expect(coll.sets).toHaveLength(1));
    expect(coll.sets[0]).toMatchObject({ ifRev: 3 });
    expect(coll.docs.get("t")?.data).toMatchObject({
      rows: { r1: { at: 1, c1: "Plan", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$25" } },
    });
    expect([...el("t").querySelectorAll(".wb-cell")].map((c) => c.textContent)).toEqual([
      "Plan",
      "Price",
      "Pro",
      "$25",
    ]);
  });
});

describe("a table cell typed while someone else changes the table", () => {
  const baseTable = (): BoardBlock => ({
    kind: "table",
    x: 0,
    y: 0,
    w: 240,
    h: 60,
    text: "",
    cols: { c1: { at: 1 }, c2: { at: 2 } },
    rows: { r1: { at: 1, c1: "Plan", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$20" } },
  });

  /** Ana starts typing in r2.c2, the server takes `theirs` meanwhile, and she types "$25". */
  function typeOver(theirs: BoardBlock | null, inModel = false) {
    const t = setup({ t: baseTable() });
    t.board.startEditing("t", ["r2", "c2"]);
    if (theirs) {
      t.coll.docs.set("t", { id: "t", data: theirs, rev: 40 });
      if (inModel) t.board.model.blocks.set("t", { data: theirs, rev: 40 });
    }
    const ta = t.el("t").querySelector(".wb-cell textarea") as HTMLTextAreaElement;
    ta.value = "$25";
    t.board.finishEditing(true);
    return t;
  }

  /** The "Use mine" a message offered, from the sync's say or the board's own line. */
  function pressUseMine(t: ReturnType<typeof setup>) {
    const call = t.say.mock.calls.find((c) => c[1]?.label === "Use mine");
    if (call) return () => call[1].run();
    const b = [...t.root.querySelectorAll(".wb-msg button")].find(
      (x) => x.textContent === "Use mine",
    ) as HTMLButtonElement | undefined;
    if (!b) throw new Error("no Use mine");
    return () => b.click();
  }

  it("(a) a change to another cell meanwhile: both stay, with no message", async () => {
    const theirs = baseTable();
    theirs.rows = { ...theirs.rows, r1: { at: 1, c1: "Tier", c2: "Price" } };
    const t = typeOver(theirs);
    await vi.waitFor(() => expect(t.board.sync?.saving("t")).toBe(false));
    expect(t.coll.docs.get("t")?.data).toMatchObject({
      rows: { r1: { at: 1, c1: "Tier", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$25" } },
    });
    expect(t.say).not.toHaveBeenCalled();
  });

  it("(b) the same cell, the peer's text already on screen: theirs stays and Use mine writes hers", async () => {
    const theirs = baseTable();
    theirs.rows = { ...theirs.rows, r2: { at: 2, c1: "Pro", c2: "$30" } };
    const t = typeOver(theirs, true);
    expect(t.coll.sets).toHaveLength(0);
    expect(t.root.querySelector(".wb-msg")?.textContent).toMatch(/Their change was kept/);
    pressUseMine(t)();
    await vi.waitFor(() => expect(t.coll.sets).toHaveLength(1));
    expect(t.coll.docs.get("t")?.data).toMatchObject({ rows: { r2: { c2: "$25" } } });
  });

  it("the same cell changed on the server: the save keeps theirs and offers hers back", async () => {
    const theirs = baseTable();
    theirs.rows = { ...theirs.rows, r2: { at: 2, c1: "Pro", c2: "$30" } };
    const t = typeOver(theirs);
    await vi.waitFor(() => expect(t.board.sync?.saving("t")).toBe(false));
    expect(t.coll.docs.get("t")?.data).toMatchObject({ rows: { r2: { c2: "$30" } } });
    pressUseMine(t)();
    await vi.waitFor(() =>
      expect(t.coll.docs.get("t")?.data).toMatchObject({ rows: { r2: { c2: "$25" } } }),
    );
  });

  it("its row deleted meanwhile: Use mine brings the row back with her text", async () => {
    const theirs = baseTable();
    theirs.rows = { r1: { at: 1, c1: "Plan", c2: "Price" } };
    const t = typeOver(theirs);
    await vi.waitFor(() => expect(t.board.sync?.saving("t")).toBe(false));
    expect(t.coll.docs.get("t")?.data).toMatchObject({ rows: { r1: { c1: "Plan" } } });
    expect((t.coll.docs.get("t")?.data as BoardBlock | undefined)?.rows).not.toHaveProperty("r2");
    pressUseMine(t)();
    await vi.waitFor(() =>
      expect(t.coll.docs.get("t")?.data).toMatchObject({
        rows: { r2: { at: 2, c1: "Pro", c2: "$25" } },
      }),
    );
  });

  it("its column deleted meanwhile: Use mine brings the column back with her text", async () => {
    const theirs: BoardBlock = {
      ...baseTable(),
      cols: { c1: { at: 1 } },
      rows: { r1: { at: 1, c1: "Plan" }, r2: { at: 2, c1: "Pro" } },
    };
    const t = typeOver(theirs);
    await vi.waitFor(() => expect(t.board.sync?.saving("t")).toBe(false));
    pressUseMine(t)();
    await vi.waitFor(() =>
      expect(t.coll.docs.get("t")?.data).toMatchObject({
        cols: { c1: { at: 1 }, c2: { at: 2 } },
        rows: { r2: { c1: "Pro", c2: "$25" } },
      }),
    );
  });

  it("a section dragged carries a section nested in it and what that one holds", async () => {
    const { coll, el } = setup({
      outer: shape({ kind: "container", x: 0, y: 0, w: 600, h: 400, text: "Out" }),
      inner: shape({ kind: "container", x: 40, y: 40, w: 300, h: 200, text: "In" }),
      n: shape({ x: 60, y: 60, w: 100, h: 80 }),
    });
    pointer(el("outer"), "pointerdown", 500, 350);
    pointer(el("outer"), "pointermove", 520, 360);
    pointer(el("outer"), "pointerup", 520, 360);
    await vi.waitFor(() =>
      expect(coll.sets.map((s) => s.id).sort()).toEqual(["inner", "n", "outer"]),
    );
    expect(coll.docs.get("inner")?.data).toMatchObject({ x: 60, y: 50 });
    expect(coll.docs.get("n")?.data).toMatchObject({ x: 80, y: 70 });
  });
});
