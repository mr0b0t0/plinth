// A peer's drag is only drawn: it never enters the model's copy of the block, which is the
// server's and what a save starts from. So a viewer who edits a block's text while someone else
// drags it writes only the text, and the drop that follows keeps the move. The mirror case: a
// block this viewer is dragging or resizing is not read again when a peer saves it (it is read
// once the gesture ends), so the drop puts the gesture on top of the peer's change. A text edit is
// held the same way and written at the rev it began from, so a peer's text saved during it is kept
// and the editor is offered theirs back, never written over without a word.
import { type BoardBlock, parseBoardSettings } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./board.ts";
import type { RuntimeCollection, RuntimeDoc } from "./runtime.ts";
import { BoardSync, DELETED_AS_NOTE_TEXT, KEPT_AS_NOTE_TEXT, USE_MINE_LABEL } from "./sync.ts";

const blk = (x: number, text = ""): BoardBlock => ({
  kind: "note",
  x,
  y: 0,
  w: 100,
  h: 80,
  text,
});

/** One collection both viewers write to, with the server's rev check. */
class Coll implements RuntimeCollection {
  docs = new Map<string, RuntimeDoc>();
  rev = 10;
  sets: { data: unknown; ifRev?: number }[] = [];
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
    this.sets.push({ data, ifRev: opts?.ifRev });
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

function viewer(blocks: Coll) {
  const root = document.createElement("main");
  document.body.append(root);
  const board = new Board({
    win: window,
    root,
    title: "Board",
    settings: parseBoardSettings('{"v":1}'),
  });
  const say = vi.fn();
  board.sync = new BoardSync({
    blocks,
    arrows: new Coll(),
    model: board.model,
    changed: () => board.redraw(),
    readOnly: () => board.setReadOnly(true),
    say,
    emit: () => {},
    busy: (id) => board.holds(id),
    wait: async () => {},
  });
  board.setReadOnly(false);
  return { board, say, root };
}

/** A pointer event on an element of the board, bubbling to the viewport's handlers. */
function pointer(el: Element, type: string, x: number, y = 0) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }),
  );
}

/** Two viewers of block "a" at x 0, rev 3. */
function pair() {
  const blocks = new Coll();
  blocks.docs.set("a", { id: "a", data: blk(0, "A1"), rev: 3 });
  const a = viewer(blocks);
  const b = viewer(blocks);
  for (const v of [a, b]) {
    v.board.model.upsertBlock("a", blk(0, "A1"), 3);
    v.board.redraw();
  }
  const el = (v: { root: HTMLElement }, sel = ".wb-block") => {
    const found = v.root.querySelector(sel);
    if (!found) throw new Error(`no ${sel}`);
    return found;
  };
  return { blocks, a, b, el };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Board and a peer's drag", () => {
  it("draws a peer's drag without changing the stored copy", () => {
    const blocks = new Coll();
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0, "A1"), 3);
    board.redraw();
    board.peerMoved("a", 40, 0);
    const el = root.querySelector<HTMLElement>(".wb-block");
    expect(el?.style.left).toBe("40px");
    expect(el?.classList.contains("moving")).toBe(true);
    expect(board.model.blocks.get("a")).toEqual({ data: blk(0, "A1"), rev: 3 });
  });

  it("a text save during a peer's drag writes only the text, and their drop keeps the move", async () => {
    const blocks = new Coll();
    blocks.docs.set("a", { id: "a", data: blk(0, "A1"), rev: 3 });
    const a = viewer(blocks);
    const b = viewer(blocks);
    for (const v of [a, b]) {
      v.board.model.upsertBlock("a", blk(0, "A1"), 3);
      v.board.redraw();
    }
    // B drags the block; A's board follows it live, then A finishes editing its text.
    a.board.peerMoved("a", 40, 0);
    a.board.startEditing("a");
    const ta = a.root.querySelector("textarea");
    if (!ta) throw new Error("no editor");
    ta.value = "hello";
    a.board.finishEditing(true);
    await vi.waitFor(() => expect(a.board.sync?.saving("a")).toBe(false));
    expect(blocks.sets[0]).toEqual({ data: blk(0, "hello"), ifRev: 3 });
    // B drops at 100: a conflict, and the move is put on top of A's text.
    expect(await b.board.sync?.saveBlock("a", { x: 100, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(blocks.docs.get("a")?.data).toEqual(blk(100, "hello"));
    expect(b.say).not.toHaveBeenCalled();
  });

  it("nudges a block from where it is drawn, and stops drawing the peer's drag", async () => {
    const blocks = new Coll();
    blocks.docs.set("a", { id: "a", data: blk(0), rev: 3 });
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0), 3);
    board.peerMoved("a", 40, 0);
    const el = root.querySelector<HTMLElement>(".wb-block");
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(blocks.sets).toHaveLength(1));
    expect(blocks.sets[0]).toEqual({ data: blk(50), ifRev: 3 });
    expect(el?.classList.contains("moving")).toBe(false);
  });

  it("drops a peer's drag once the block's stored copy changes", async () => {
    const blocks = new Coll();
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0), 3);
    board.peerMoved("a", 40, 0);
    // The peer saved its drop: the board reads it again at the next rev.
    board.model.upsertBlock("a", blk(100), 4);
    board.redraw();
    const el = root.querySelector<HTMLElement>(".wb-block");
    expect(el?.style.left).toBe("100px");
    expect(el?.classList.contains("moving")).toBe(false);
  });
});

describe("Board and a peer's save during this viewer's gesture", () => {
  it("a peer's text save while this viewer drags keeps the drag, and the drop keeps both", async () => {
    const { blocks, a, b, el } = pair();
    // B presses on the block and drags it 100 to the right, then holds still.
    pointer(el(b), "pointerdown", 10);
    pointer(el(b), "pointermove", 110);
    expect(b.board.model.blocks.get("a")?.data.x).toBe(100);
    // A saves new text and says so: B's board is told to read the block again.
    expect(await a.board.sync?.saveBlock("a", { text: "hello" })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect((el(b) as HTMLElement).style.left).toBe("100px");
    // B lets go without moving again: the move goes on top of A's text.
    pointer(el(b), "pointerup", 110);
    await vi.waitFor(() => expect(b.board.sync?.saving("a")).toBe(false));
    expect(blocks.docs.get("a")?.data).toEqual(blk(100, "hello"));
    expect(b.say).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(b.board.model.blocks.get("a")?.data).toEqual(blk(100, "hello")));
  });

  it("a peer's move while this viewer resizes keeps the new size and their position", async () => {
    const { blocks, a, b, el } = pair();
    // Select the block so its resize handle shows, then drag the handle 50 right and 20 down.
    pointer(el(b), "pointerdown", 10);
    pointer(el(b), "pointerup", 10);
    const handle = el(b, ".wb-resize");
    pointer(handle, "pointerdown", 100, 80);
    pointer(handle, "pointermove", 150, 100);
    expect(b.board.model.blocks.get("a")?.data).toMatchObject({ w: 150, h: 100 });
    expect(await a.board.sync?.saveBlock("a", { x: 40, y: 0 }, { x: 0, y: 0 })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect(b.board.model.blocks.get("a")?.data).toMatchObject({ w: 150, h: 100 });
    pointer(handle, "pointerup", 150, 100);
    await vi.waitFor(() => expect(b.board.sync?.saving("a")).toBe(false));
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(40, "A1"), w: 150, h: 100 });
    expect(b.say).not.toHaveBeenCalled();
  });

  it("reads a block it skipped during a gesture again once the gesture ends without a save", async () => {
    const { a, b, el } = pair();
    pointer(el(b), "pointerdown", 10);
    expect(await a.board.sync?.saveBlock("a", { text: "hello" })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect(b.board.model.blocks.get("a")?.rev).toBe(3);
    // A press and release with no move saves nothing, and catches up with A's save.
    pointer(el(b), "pointerup", 10);
    await vi.waitFor(() =>
      expect(b.board.model.blocks.get("a")).toEqual({ data: blk(0, "hello"), rev: 11 }),
    );
    expect(el(b).querySelector(".wb-text")?.textContent).toBe("hello");
  });

  it("reads a block it skipped during its own save again once that save settles", async () => {
    const { blocks, b } = pair();
    // B's write lands, but its answer is held until a peer has saved on top of it.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const set = blocks.set.bind(blocks);
    blocks.set = async (id, data, opts) => {
      const d = await set(id, data, opts);
      await gate;
      return d;
    };
    const saving = b.board.sync?.saveBlock("a", { text: "B" });
    await vi.waitFor(() => expect(blocks.sets).toHaveLength(1));
    blocks.docs.set("a", { id: "a", data: blk(40, "B"), rev: 20 });
    await b.board.sync?.refetch("blocks", "a");
    release();
    expect(await saving).toBe(true);
    await vi.waitFor(() =>
      expect(b.board.model.blocks.get("a")).toEqual({ data: blk(40, "B"), rev: 20 }),
    );
  });
});

/** Start editing block "a" on a viewer's board and type into it, without finishing. */
function type(v: { board: Board; root: HTMLElement }, text: string) {
  v.board.startEditing("a");
  const ta = v.root.querySelector("textarea");
  if (!ta) throw new Error("no editor");
  ta.value = text;
}

describe("Board and a peer's save during this viewer's text edit", () => {
  it("keeps a peer's text saved during the edit, says so, and offers the editor's back", async () => {
    const { blocks, a, b } = pair();
    // A opens the block's text and types; B saves new text for it; A's board hears of it.
    type(a, "from A");
    expect(await b.board.sync?.saveBlock("a", { text: "from B" })).toBe(true);
    await a.board.sync?.refetch("blocks", "a");
    // A finishes: the write is at the rev the edit began from, so B's save is a conflict.
    a.board.finishEditing(true);
    await vi.waitFor(() => expect(a.board.sync?.saving("a")).toBe(false));
    expect(blocks.sets.slice(1).map((c) => c.ifRev)).toEqual([3]);
    expect(blocks.docs.get("a")?.data).toEqual(blk(0, "from B"));
    // A's text is already safe, in a new note beside the block, before A is told.
    await vi.waitFor(() =>
      expect(a.say).toHaveBeenCalledWith(
        KEPT_AS_NOTE_TEXT,
        expect.objectContaining({ label: USE_MINE_LABEL }),
      ),
    );
    const note = [...blocks.docs.values()].find((d) => d.id !== "a");
    expect(note?.data).toMatchObject({ kind: "note", x: 124, y: 0, text: "from A" });
    await vi.waitFor(() => expect(a.board.model.blocks.get("a")?.data).toEqual(blk(0, "from B")));
    // A chooses to put theirs back: written over B's text, at its rev, and the note goes.
    a.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() => expect(blocks.docs.get("a")?.data).toEqual(blk(0, "from A")));
    expect(blocks.sets.at(-1)?.ifRev).toBe(11);
    await vi.waitFor(() => expect(blocks.docs.has(note?.id ?? "")).toBe(false));
  });

  it("keeps A's text as a note when the message goes before A acts on it", async () => {
    const { blocks, a, b } = pair();
    type(a, "from A");
    expect(await b.board.sync?.saveBlock("a", { text: "from B" })).toBe(true);
    await a.board.sync?.refetch("blocks", "a");
    a.board.finishEditing(true);
    await vi.waitFor(() =>
      expect(a.say).toHaveBeenCalledWith(KEPT_AS_NOTE_TEXT, expect.anything()),
    );
    // Another message replaces the offer, and the page is closed: the note is on the server.
    a.board.say("Block deleted.");
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text).sort()).toEqual([
      "from A",
      "from B",
    ]);
  });

  it("keeps what A wrote in a note where the block was when B deletes it during the edit", async () => {
    const { blocks, a, b } = pair();
    type(a, "from A");
    expect(await b.board.sync?.deleteBlock("a")).not.toBeNull();
    // A's next snapshot no longer has it: the block goes, and with it the editor, but not the text.
    a.board.applySnapshot("blocks", []);
    await vi.waitFor(() => expect(a.say).toHaveBeenCalledWith(DELETED_AS_NOTE_TEXT, undefined));
    expect(blocks.docs.has("a")).toBe(false);
    const notes = [...blocks.docs.values()];
    expect(notes.map((d) => d.data)).toEqual([
      { kind: "note", x: 124, y: 0, w: 200, h: 140, text: "from A", z: 1 },
    ]);
    expect(a.root.querySelector("textarea")).toBeNull();
  });

  it("keeps what A wrote in a note when the block was deleted before A's save reached it", async () => {
    const { blocks, a, b } = pair();
    type(a, "from A");
    expect(await b.board.sync?.deleteBlock("a")).not.toBeNull();
    // A's board held the news during the edit: the save finds the block gone.
    await a.board.sync?.refetch("blocks", "a");
    a.board.finishEditing(true);
    await vi.waitFor(() => expect(a.say).toHaveBeenCalledWith(DELETED_AS_NOTE_TEXT, undefined));
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text)).toEqual(["from A"]);
  });

  it("puts the edited text on top of a peer's change to another field", async () => {
    const { blocks, a, b } = pair();
    type(a, "from A");
    expect(await b.board.sync?.saveBlock("a", { color: "blue" })).toBe(true);
    await a.board.sync?.refetch("blocks", "a");
    a.board.finishEditing(true);
    await vi.waitFor(() => expect(a.board.sync?.saving("a")).toBe(false));
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(0, "from A"), color: "blue" });
    expect(a.say).not.toHaveBeenCalled();
  });

  it("does not write over a peer's text that reached the board during the edit", async () => {
    const { blocks, a } = pair();
    type(a, "from A");
    // Another save of this block conflicted meanwhile and brought B's text into the model.
    blocks.docs.set("a", { id: "a", data: blk(0, "from B"), rev: 20 });
    a.board.model.blocks.set("a", { data: blk(0, "from B"), rev: 20 });
    a.board.finishEditing(true);
    expect(blocks.sets).toHaveLength(0);
    await vi.waitFor(() =>
      expect(a.say).toHaveBeenCalledWith(
        KEPT_AS_NOTE_TEXT,
        expect.objectContaining({ label: USE_MINE_LABEL }),
      ),
    );
    expect([...blocks.docs.values()].find((d) => d.id !== "a")?.data).toMatchObject({
      text: "from A",
    });
    a.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() => expect(blocks.sets).toEqual([{ data: blk(0, "from A"), ifRev: 20 }]));
  });

  it("reads a peer's save it held during the edit once the edit is dropped", async () => {
    const { a, b } = pair();
    type(a, "from A");
    expect(await b.board.sync?.saveBlock("a", { text: "from B" })).toBe(true);
    await a.board.sync?.refetch("blocks", "a");
    expect(a.board.model.blocks.get("a")?.rev).toBe(3);
    a.board.finishEditing(false);
    await vi.waitFor(() =>
      expect(a.board.model.blocks.get("a")).toEqual({ data: blk(0, "from B"), rev: 11 }),
    );
  });
});

describe("Board's toolbar and editing", () => {
  it("starts editing on a double click the viewport's pointer capture aims at the viewport", () => {
    const { board, root } = viewer(new Coll());
    board.model.upsertBlock("a", blk(0, "A1"), 3);
    board.redraw();
    const block = root.querySelector(".wb-block");
    const vp = root.querySelector(".wb-viewport");
    if (!block || !vp) throw new Error("no board");
    const had = "elementFromPoint" in document;
    const at = vi.fn(() => block);
    Object.defineProperty(document, "elementFromPoint", { value: at, configurable: true });
    try {
      vp.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 20, clientY: 20 }));
    } finally {
      if (!had) delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
    expect(at).toHaveBeenCalledWith(20, 20);
    expect(board.editing).toBe("a");
    expect(root.querySelector(".wb-block textarea")).not.toBeNull();
    // The resize handle goes while the text is edited.
    expect(root.querySelector(".wb-resize")).toBeNull();
  });

  it("marks the toolbar while something is selected, for the phone layout", () => {
    const { board, root } = viewer(new Coll());
    board.model.upsertBlock("a", blk(0, "A1"), 3);
    board.redraw();
    const bar = root.querySelector<HTMLElement>(".wb-toolbar");
    expect(bar?.dataset.selection).toBe("false");
    root.querySelector(".wb-block")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(bar?.dataset.selection).toBe("true");
    board.setReadOnly(true);
    expect(bar?.dataset.selection).toBe("false");
  });

  it("shows the selected block's colour on one swatch that opens the colours and closes on a pick", () => {
    const blocks = new Coll();
    blocks.docs.set("a", { id: "a", data: { ...blk(0, "A1"), color: "blue" }, rev: 3 });
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", { ...blk(0, "A1"), color: "blue" }, 3);
    board.redraw();
    const colour = root.querySelector<HTMLElement>(".wb-colour");
    const pick = root.querySelector<HTMLButtonElement>(".wb-pick");
    if (!colour || !pick) throw new Error("no colour control");
    expect(colour.hidden).toBe(true);
    root.querySelector(".wb-block")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(colour.hidden).toBe(false);
    expect(pick.getAttribute("aria-label")).toBe("Colour");
    expect(pick.dataset.color).toBe("blue");
    expect(pick.getAttribute("aria-expanded")).toBe("false");
    pick.click();
    expect(colour.dataset.open).toBe("true");
    expect(pick.getAttribute("aria-expanded")).toBe("true");
    // Escape closes it and leaves the selection as it is.
    root
      .querySelector('[aria-label="Pink"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(colour.dataset.open).toBe("false");
    expect(colour.hidden).toBe(false);
    pick.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Pink"]')?.click();
    expect(colour.dataset.open).toBe("false");
    expect(pick.dataset.color).toBe("pink");
    expect(document.activeElement).toBe(pick);
    expect(blocks.sets.at(-1)?.data).toMatchObject({ color: "pink" });
  });
});
