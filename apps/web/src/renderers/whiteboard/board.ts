// The board on screen: the model, the camera, the selection and what the viewer may do, with
// every pointer, wheel and key handler. Writes go through BoardSync and room traffic through Live;
// without them (the editor preview, a page without the runtime) the board only shows what it was
// given, read-only. Every handler is a no-op for edits while the board is read-only.
import {
  BOARD_LIMITS,
  type BoardBlock,
  type BoardColor,
  type BoardSettings,
  cellText,
  HEX_COLOR_RE,
  isShapeKind,
  SHAPE_KINDS,
  type TableCol,
  type TableRow,
  TEXT_SIZES,
} from "@plinth/shared";
import {
  type Camera,
  center,
  fitCamera,
  loadCamera,
  panBy,
  saveCamera,
  screenToWorld,
  zoomAt,
} from "./camera.ts";
import {
  boardSvg,
  canvasMeasure,
  download,
  drawPng,
  exportName,
  pngBlob,
  svgBlob,
  themeOf,
} from "./export.ts";
import type { Live } from "./live.ts";
import { BoardModel, type DocIn, type Entry } from "./model.ts";
import type { RuntimePeer } from "./runtime.ts";
import { type BoardSync, KEPT_THEIRS_TEXT, putCells, USE_MINE_LABEL } from "./sync.ts";
import {
  applyCamera,
  buildView,
  type DrawState,
  draw,
  drawPeers,
  forgetTable,
  hueOf,
  KIND_LABELS,
  setStyleList,
  type ToolKind,
  type ViewEls,
} from "./view.ts";

/** The size a new block of each kind gets. */
const NEW_SIZE: Record<ToolKind, { w: number; h: number }> = {
  note: { w: 200, h: 140 },
  text: { w: 240, h: 60 },
  rect: { w: 200, h: 100 },
  ellipse: { w: 180, h: 120 },
};
const GRID = 240;
/** Below this viewport width (px) Fit keeps text readable: it zooms out no further than this. */
const NARROW = 560;
const NARROW_MIN_FIT = 0.75;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const coord = (v: number) => clamp(Math.round(v), -BOARD_LIMITS.maxCoord, BOARD_LIMITS.maxCoord);
const size = (v: number) => clamp(Math.round(v), BOARD_LIMITS.minSize, BOARD_LIMITS.maxSize);

export interface BoardOptions {
  win: Window;
  root: HTMLElement;
  title: string;
  settings: BoardSettings;
}

type Drag =
  | { kind: "pan"; pointer: number; x: number; y: number }
  | {
      kind: "move";
      pointer: number;
      id: string;
      dx: number;
      dy: number;
      moved: boolean;
      /** Where the block was when the drag began. */
      bx: number;
      by: number;
      /** What a section carries with it: the blocks inside it, from where each began. */
      carried: { id: string; bx: number; by: number }[];
    }
  | { kind: "resize"; pointer: number; id: string; x0: number; y0: number; w0: number; h0: number };

export class Board {
  readonly model = new BoardModel();
  readonly view: ViewEls;
  readonly doc: Document;
  readonly win: Window;
  camera: Camera;
  selected: string | null = null;
  editing: string | null = null;
  connectFrom: string | null = null;
  connecting = false;
  readOnly = true;
  color: BoardColor = "yellow";
  sync: BoardSync | null = null;
  live: Live | null = null;
  private peers: RuntimePeer[] = [];
  /**
   * Where peers are dragging blocks, with the rev of the stored copy each was drawn over. Only
   * drawn: the model's copy of a block is the server's, which every save starts from, so a peer's
   * unsaved position is never written by this viewer. It goes once that copy changes, this viewer
   * changes the block, or a snapshot arrives.
   */
  private readonly peerMoves = new Map<string, { x: number; y: number; rev: number }>();
  /**
   * The stored text and rev of the block being edited, as the edit began: what it saves over. On a
   * table, the cell being written in and the rows as they were.
   */
  private editStart: {
    text: string;
    rev: number;
    cell?: {
      row: string;
      col: string;
      rows: Record<string, TableRow>;
      cols: Record<string, TableCol>;
    };
  } | null = null;
  /** The link a press began on: opened when the press ends without a drag. */
  private downLink: HTMLAnchorElement | null = null;
  private drag: Drag | null = null;
  private pinch: Map<number, { x: number; y: number }> = new Map();
  private pinchDist = 0;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly title: string;

  constructor(o: BoardOptions) {
    this.win = o.win;
    this.doc = o.win.document;
    this.title = o.title;
    this.view = buildView(this.doc, o.root, o.settings.background);
    this.camera = loadCamera(o.win) ?? { x: -48, y: -48, zoom: 1 };
    applyCamera(this.view, this.camera);
    this.wire();
    this.setReadOnly(true);
  }

  // ---------- state ----------

  redraw(): void {
    const peerSelections = new Map<string, number>();
    for (const p of this.peers) {
      const sel = p.presence?.sel;
      if (!p.you && typeof sel === "string") peerSelections.set(sel, hueOf(p.viewer));
    }
    for (const [id, m] of this.peerMoves) {
      if (this.model.blocks.get(id)?.rev !== m.rev || this.sync?.saving(id)) {
        this.peerMoves.delete(id);
      }
    }
    const s: DrawState = {
      selected: this.selected,
      connectFrom: this.connectFrom,
      editing: this.editing,
      readOnly: this.readOnly,
      peerSelections,
      peerMoves: this.peerMoves,
    };
    if (
      this.selected &&
      !this.model.blocks.has(this.selected) &&
      !this.model.arrows.has(this.selected)
    ) {
      this.selected = null;
      s.selected = null;
    }
    draw(this.doc, this.view, this.model, s);
    this.updateButtons();
  }

  setReadOnly(on: boolean): void {
    this.readOnly = on;
    this.doc.documentElement.dataset.readonly = String(on);
    if (on) {
      this.finishEditing(false);
      this.setConnecting(false);
    }
    this.redraw();
  }

  /**
   * Only what the viewer can use now shows: the add buttons to people who may edit, the colours
   * for a selected note or shape, Connect for a selected block (or while connecting), Delete for
   * anything selected.
   */
  private updateButtons(): void {
    const t = this.view.toolbar;
    for (const b of Object.values(t.add)) b.disabled = this.readOnly;
    t.adds.hidden = this.readOnly;
    const id = this.selected;
    const block = id ? this.model.blocks.get(id)?.data : undefined;
    const edit = !this.readOnly;
    t.colour.hidden = !edit || !block || block.kind === "text";
    for (const [c, b] of Object.entries(t.colors) as [BoardColor, HTMLButtonElement][]) {
      b.setAttribute("aria-pressed", String(block?.color === c));
    }
    // A selected shape's kind, or a selected text's size.
    t.style.hidden = setStyleList(this.doc, t.style, edit && block ? block : null) === null;
    // At phone width one swatch shows the colour and opens the others; they close on a pick, on
    // Escape and when the selection goes. A custom #rrggbb shows as plain.
    const named = block?.color && !HEX_COLOR_RE.test(block.color) ? block.color : "";
    t.pick.dataset.color = block ? named : this.color;
    if (t.colour.hidden) this.openPalette(false);
    t.connect.hidden = !edit || (!block && !this.connecting);
    t.connect.disabled = this.model.blocks.size < 2;
    t.remove.hidden = !edit || id === null;
    // At phone width the selection's controls take the add buttons' place, so the bar stays one row.
    t.el.dataset.selection = String(edit && (id !== null || this.connecting));
  }

  private openPalette(on: boolean): void {
    const t = this.view.toolbar;
    t.colour.dataset.open = String(on);
    t.pick.setAttribute("aria-expanded", String(on));
    if (!on) return;
    // Under the swatch that opened it, kept inside the bar's 16 px gutters.
    const bar = t.el.getBoundingClientRect();
    const at = t.pick.getBoundingClientRect().left - bar.left;
    const room = bar.width - t.palette.offsetWidth - 16;
    t.palette.style.left = `${Math.round(Math.max(16, Math.min(at, room)))}px`;
  }

  /**
   * The toolbar's standing line. `why`, when given, is the reason, left to screen readers so the
   * line stays short.
   */
  banner(text: string, why = ""): void {
    const b = this.view.banner;
    // Empty when there is nothing to say, so the line collapses (:empty).
    if (text) b.replaceChildren(this.doc.createTextNode(text));
    else b.replaceChildren();
    if (text && why) {
      const span = this.doc.createElement("span");
      span.className = "wb-why";
      span.textContent = why;
      b.append(span);
    }
  }

  /**
   * No toolbar at all: for a viewer the board cannot identify (a thumbnail capture, a link viewer
   * who is not signed in), who could use only Fit, which `0` also does.
   */
  hideToolbar(): void {
    this.view.toolbar.el.hidden = true;
  }

  say(text: string, action?: { label: string; run: () => void }): void {
    const m = this.view.msg;
    m.replaceChildren(this.doc.createTextNode(text));
    if (action) {
      const b = this.doc.createElement("button");
      b.type = "button";
      b.textContent = action.label;
      b.addEventListener("click", () => {
        m.replaceChildren();
        action.run();
      });
      m.append(" ", b);
    }
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => m.replaceChildren(), action ? 8000 : 6000);
  }

  setPeers(list: RuntimePeer[]): void {
    this.peers = list;
    drawPeers(this.doc, this.view, list, this.camera);
    this.redraw();
  }

  setStatus(text: string, state: string): void {
    this.view.toolbar.status.textContent = text;
    this.doc.documentElement.dataset.room = state;
  }

  private setCamera(c: Camera): void {
    this.camera = c;
    applyCamera(this.view, c);
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => saveCamera(this.win, this.camera), 300);
  }

  /**
   * Show every block, at most at 100%. At phone width, never below a zoom whose text stays
   * readable: the board then starts at its top-left and pans.
   */
  fitBoard(): void {
    const vp = this.view.viewport;
    const w = vp.clientWidth || 800;
    const narrow = w < NARROW;
    this.setCamera(
      fitCamera(
        this.model.bounds(),
        w,
        vp.clientHeight || 600,
        narrow ? 24 : 48,
        narrow ? NARROW_MIN_FIT : undefined,
      ),
    );
  }

  private select(id: string | null): void {
    this.selected = id;
    this.live?.select(id && this.model.blocks.has(id) ? id : null);
    this.redraw();
  }

  /** Connect starts from the selected block, so the viewer then picks the other end. */
  private setConnecting(on: boolean): void {
    this.connecting = on;
    this.connectFrom =
      on && this.selected && this.model.blocks.has(this.selected) ? this.selected : null;
    const b = this.view.toolbar.connect;
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? (this.connectFrom ? "Pick a block…" : "Pick two blocks…") : "Connect";
  }

  // ---------- edits ----------

  /** Where a new block goes: the next free cell on a 240 grid near the middle of the view. */
  private freeSpot(w: number, h: number): { x: number; y: number } {
    const vp = this.view.viewport;
    const mid = center(this.camera, vp.clientWidth || 800, vp.clientHeight || 600);
    const cx = Math.round((mid.x - w / 2) / GRID) * GRID;
    const cy = Math.round((mid.y - h / 2) / GRID) * GRID;
    const taken = (x: number, y: number) =>
      [...this.model.blocks.values()].some(
        ({ data: b }) => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h,
      );
    for (let ring = 0; ring < 6; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const x = cx + i * GRID;
          const y = cy + j * GRID;
          if (!taken(x, y)) return { x, y };
        }
      }
    }
    return { x: cx, y: cy };
  }

  async addBlock(kind: ToolKind): Promise<void> {
    if (this.readOnly || !this.sync) return;
    const { w, h } = NEW_SIZE[kind];
    const at = this.freeSpot(w, h);
    const data: BoardBlock = {
      kind,
      x: coord(at.x),
      y: coord(at.y),
      w,
      h,
      text: "",
      z: this.model.nextZ(),
      ...(kind === "note" || kind === "rect" || kind === "ellipse" ? { color: this.color } : {}),
    };
    const id = await this.sync.addBlock(data);
    if (!id) return;
    this.select(id);
    this.startEditing(id);
  }

  /**
   * Save the fields a change set; `before` holds them as they were, for a drag already drawn, and
   * `since` the rev a change that began earlier (a text edit) was made over.
   */
  private save(
    id: string,
    patch: Partial<BoardBlock>,
    before?: Partial<BoardBlock>,
    since?: number,
  ): void {
    if (!this.model.blocks.has(id) || this.readOnly || !this.sync) return;
    this.peerMoves.delete(id);
    void this.sync.saveBlock(id, patch, before, since);
  }

  /** A block as this viewer sees it: the stored copy, where a peer is dragging it. */
  private shown(id: string): BoardBlock | undefined {
    const b = this.model.blocks.get(id)?.data;
    const m = this.peerMoves.get(id);
    return b && m ? { ...b, x: m.x, y: m.y } : b;
  }

  async deleteSelected(): Promise<void> {
    const id = this.selected;
    if (!id || this.readOnly || !this.sync) return;
    if (this.model.arrows.has(id)) {
      await this.sync.deleteArrow(id);
      this.select(null);
      return;
    }
    const undo = await this.sync.deleteBlock(id);
    if (!undo) return;
    this.select(null);
    this.say("Block deleted.", { label: "Undo", run: () => void undo.undo() });
  }

  private pickForArrow(id: string): void {
    if (!this.connectFrom) {
      this.connectFrom = id;
      this.redraw();
      return;
    }
    const from = this.connectFrom;
    this.setConnecting(false);
    if (from !== id) void this.sync?.addArrow(from, id);
    this.redraw();
  }

  /**
   * Write in a block: its text, a section's title, or on a table one cell (`cell`, or the
   * header's first when none is named).
   */
  startEditing(id: string, cell?: [string, string]): void {
    if (this.readOnly || this.editing === id) return;
    const el = this.view.blocks.get(id);
    const entry = this.model.blocks.get(id);
    const b = entry?.data;
    if (!el || !entry || !b) return;
    this.finishEditing(true);
    let host: Element = el;
    let value = b.text;
    if (b.kind === "table") {
      const target = cell ?? this.firstCell(el);
      const cellEl = target ? this.cellEl(el, target) : null;
      if (!target || !cellEl) return;
      host = cellEl;
      const v = b.rows?.[target[0]]?.[target[1]];
      value = typeof v === "string" ? v : "";
      this.editStart = {
        text: value,
        rev: entry.rev,
        cell: { row: target[0], col: target[1], rows: b.rows ?? {}, cols: b.cols ?? {} },
      };
    } else this.editStart = { text: b.text, rev: entry.rev };
    this.editing = id;
    const ta = this.doc.createElement("textarea");
    ta.className = "wb-edit";
    ta.value = value;
    ta.maxLength = b.kind === "table" ? BOARD_LIMITS.maxCell : BOARD_LIMITS.maxText;
    ta.setAttribute("aria-label", b.kind === "table" ? "Cell text" : `${KIND_LABELS[b.kind]} text`);
    if (b.kind === "table") host.querySelector("span")?.replaceChildren();
    else el.querySelector(".wb-text")?.replaceChildren();
    host.append(ta);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.finishEditing(false);
        el.focus();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.finishEditing(true);
        el.focus();
      }
    });
    ta.addEventListener("blur", () => this.finishEditing(true));
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.focus();
    this.redraw();
  }

  /**
   * End a text edit, saving it when `keep`. The text is written over the copy the edit began
   * from: a peer's text saved since is never overwritten. Theirs stays, and the viewer is told and
   * offered to put theirs back.
   */
  finishEditing(keep: boolean): void {
    const id = this.editing;
    const start = this.editStart;
    if (!id || !start) return;
    const el = this.view.blocks.get(id);
    const ta = el?.querySelector("textarea");
    this.editing = null;
    this.editStart = null;
    const max = start.cell ? BOARD_LIMITS.maxCell : BOARD_LIMITS.maxText;
    const text = ta ? [...ta.value].slice(0, max).join("") : null;
    ta?.remove();
    const cur = this.model.blocks.get(id)?.data;
    if (start.cell && keep && text !== null && text !== start.text && !cur) {
      this.say("Someone deleted this table while you were writing in it.");
    }
    if (start.cell && cur) {
      // A table: the cell goes into its row, over the rows as the edit began. Typed text is never
      // dropped: when the cell, its row or its column changed meanwhile, theirs is kept and the
      // viewer is offered theirs back ("Use mine"), which brings back a row or column that went.
      const { row, col, rows, cols } = start.cell;
      const nowRow = cur.rows && Object.hasOwn(cur.rows, row) ? cur.rows[row] : undefined;
      const colThere = cur.cols !== undefined && Object.hasOwn(cur.cols, col);
      const now = cellText(cur, row, col);
      if (keep && text !== null && text !== start.text && !(nowRow && colThere && now === text)) {
        if (nowRow && colThere && now === start.text) {
          const next = { ...cur.rows, [row]: { ...nowRow, [col]: text } as TableRow };
          this.save(id, { rows: next }, { rows }, start.rev);
        } else {
          const typed = text;
          this.say(KEPT_THEIRS_TEXT, {
            label: USE_MINE_LABEL,
            run: () => {
              const b = this.model.blocks.get(id)?.data;
              if (b) this.save(id, putCells(b, { rows, cols }, [{ row, col, text: typed }]));
            },
          });
        }
      }
      // Draw the cells again (the edit emptied one).
      const el = this.view.blocks.get(id);
      if (el) forgetTable(el);
    } else if (keep && text !== null && cur && text !== start.text && text !== cur.text) {
      if (cur.text !== start.text) {
        // A peer's text reached the model during the edit (a conflict on another save of it).
        this.say(KEPT_THEIRS_TEXT, { label: USE_MINE_LABEL, run: () => this.save(id, { text }) });
      } else this.save(id, { text }, { text: start.text }, start.rev);
    }
    // A peer's save that came in during the edit: read now, or after the save just started.
    this.sync?.release(id);
    this.redraw();
  }

  /** A table's header's first cell: [row id, column id]. */
  private firstCell(el: HTMLElement): [string, string] | null {
    const first = el.querySelector(".wb-cell");
    return first ? (this.view.cells.get(first) ?? null) : null;
  }

  private cellEl(el: HTMLElement, [row, col]: [string, string]): HTMLElement | null {
    for (const c of el.querySelectorAll<HTMLElement>(".wb-cell")) {
      const at = this.view.cells.get(c);
      if (at && at[0] === row && at[1] === col) return c;
    }
    return null;
  }

  /** The cell of a table under an event's target, if any. */
  private cellOf(target: Element | null): [string, string] | null {
    const c = target?.closest?.(".wb-cell");
    return c ? (this.view.cells.get(c) ?? null) : null;
  }

  // ---------- export ----------

  async exportAs(kind: "png" | "svg"): Promise<void> {
    const theme = themeOf(this.win, this.view.root);
    if (kind === "svg") {
      const svg = boardSvg(this.doc, this.model, theme, canvasMeasure(this.doc));
      download(this.doc, svgBlob(svg), exportName(this.title, "svg"));
      return;
    }
    const canvas = drawPng(this.doc, this.model, theme);
    const blob = canvas ? await pngBlob(canvas) : null;
    if (!blob) {
      this.say("This browser could not draw the PNG. Try SVG.");
      return;
    }
    download(this.doc, blob, exportName(this.title, "png"));
  }

  // ---------- input ----------

  private world(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.view.viewport.getBoundingClientRect();
    return screenToWorld(this.camera, e.clientX - r.left, e.clientY - r.top);
  }

  private blockIdOf(target: EventTarget | null): string | null {
    const el = (target as Element | null)?.closest?.(".wb-block");
    if (!el) return null;
    for (const [id, b] of this.view.blocks) if (b === el) return id;
    return null;
  }

  private wire(): void {
    const v = this.view;
    const t = v.toolbar;
    for (const [k, b] of Object.entries(t.add) as [ToolKind, HTMLButtonElement][]) {
      b.addEventListener("click", () => void this.addBlock(k));
    }
    for (const [c, b] of Object.entries(t.colors) as [BoardColor, HTMLButtonElement][]) {
      b.addEventListener("click", () => {
        // The colour of the selected block, and of the next block this viewer adds.
        this.color = c;
        const id = this.selected;
        const blk = id ? this.model.blocks.get(id)?.data : undefined;
        if (id && blk && blk.kind !== "text") this.save(id, { color: c });
        if (t.colour.dataset.open === "true") {
          this.openPalette(false);
          t.pick.focus();
        }
        this.redraw();
      });
    }
    t.pick.addEventListener("click", () => this.openPalette(t.colour.dataset.open !== "true"));
    t.style.addEventListener("change", () => {
      const id = this.selected;
      const blk = id ? this.model.blocks.get(id)?.data : undefined;
      if (!id || !blk) return;
      const value = t.style.value;
      if (isShapeKind(blk.kind) && (SHAPE_KINDS as readonly string[]).includes(value)) {
        this.save(id, { kind: value as BoardBlock["kind"] });
      } else if (blk.kind === "text" && (TEXT_SIZES as readonly string[]).includes(value)) {
        this.save(id, { size: value as BoardBlock["size"] });
      }
    });
    t.colour.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || t.colour.dataset.open !== "true") return;
      e.stopPropagation();
      this.openPalette(false);
      t.pick.focus();
    });
    t.connect.addEventListener("click", () => {
      if (!this.readOnly) this.setConnecting(!this.connecting);
      this.redraw();
    });
    // Delete hides itself with the selection: keep the keyboard's place on the board.
    t.remove.addEventListener("click", () => {
      void this.deleteSelected().then(() => {
        if (t.remove.hidden) v.viewport.focus();
      });
    });
    t.fit.addEventListener("click", () => this.fitBoard());

    const vp = v.viewport;
    vp.addEventListener("pointerdown", (e) => {
      this.openPalette(false);
      this.onPointerDown(e);
    });
    vp.addEventListener("pointermove", (e) => this.onPointerMove(e));
    vp.addEventListener("pointerup", (e) => this.onPointerUp(e));
    vp.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    vp.addEventListener("pointerleave", () => this.live?.pointer(null, null));
    vp.addEventListener("dblclick", (e) => {
      // The viewport captures the pointer on a block's pointerdown, so the double click is aimed
      // at the viewport: find the block under the pointer.
      const under = this.doc.elementFromPoint?.(e.clientX, e.clientY) ?? null;
      const id = this.blockIdOf(e.target) ?? this.blockIdOf(under);
      if (id) this.startEditing(id, this.cellOf(under) ?? undefined);
    });
    // A link in a block opens in a new tab when it is pressed without a drag (onPointerUp), or
    // from the keyboard; the browser's own navigation never runs, so a press that moves the block
    // never opens it.
    vp.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a.wb-link");
      if (!a) return;
      e.preventDefault();
      if (e.detail === 0) this.openLink(a as HTMLAnchorElement);
    });
    // A middle click (or any other button) on a link never opens it either.
    vp.addEventListener("auxclick", (e) => {
      if ((e.target as Element | null)?.closest?.("a.wb-link")) e.preventDefault();
    });
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          const f = Math.exp(-e.deltaY * 0.01);
          this.setCamera(zoomAt(this.camera, e.clientX - r.left, e.clientY - r.top, f));
        } else this.setCamera(panBy(this.camera, -e.deltaX, -e.deltaY));
      },
      { passive: false },
    );
    vp.addEventListener("keydown", (e) => this.onKey(e));
    vp.addEventListener("focusin", (e) => {
      const id = this.blockIdOf(e.target);
      if (id && id !== this.selected && !this.connecting) this.select(id);
    });
  }

  /** Open a block's link in a new tab, with no opener or referrer. */
  private openLink(a: HTMLAnchorElement): void {
    const href = a.href;
    if (!/^https?:/i.test(href)) return;
    this.win.open(href, "_blank", "noopener,noreferrer");
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button > 0) return;
    const vp = this.view.viewport;
    const target = e.target as Element | null;
    if (target?.closest?.("textarea")) return;
    this.downLink = (target?.closest?.("a.wb-link") as HTMLAnchorElement | null) ?? null;
    const arrowId = (target as SVGElement | null)?.dataset?.arrow;
    if (arrowId && this.model.arrows.has(arrowId)) {
      this.select(arrowId);
      return;
    }
    const id = this.blockIdOf(target);
    if (id) {
      if (this.connecting) {
        this.pickForArrow(id);
        return;
      }
      if (this.selected !== id) this.select(id);
      if (this.readOnly) {
        // A viewer's press on a link opens it as it ends.
        if (this.downLink) vp.setPointerCapture?.(e.pointerId);
        return;
      }
      const b = this.model.blocks.get(id)?.data;
      const seen = this.shown(id);
      if (!b || !seen) return;
      // This viewer takes the block from where it is drawn (a peer may be dragging it).
      const at = this.world(e);
      if (target?.closest?.(".wb-resize")) {
        this.drag = {
          kind: "resize",
          pointer: e.pointerId,
          id,
          x0: at.x,
          y0: at.y,
          w0: b.w,
          h0: b.h,
        };
      } else {
        // A section carries the blocks inside it.
        const carried = this.model.inside(id).flatMap((cid) => {
          const c = this.model.blocks.get(cid)?.data;
          return c ? [{ id: cid, bx: c.x, by: c.y }] : [];
        });
        this.drag = {
          kind: "move",
          pointer: e.pointerId,
          id,
          dx: at.x - seen.x,
          dy: at.y - seen.y,
          moved: false,
          bx: b.x,
          by: b.y,
          carried,
        };
      }
      e.preventDefault();
      vp.setPointerCapture?.(e.pointerId);
      return;
    }
    // The background: pan with one pointer, pinch with two.
    this.pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = null;
      return;
    }
    if (this.selected) this.select(null);
    if (this.connecting) this.setConnecting(false);
    this.drag = { kind: "pan", pointer: e.pointerId, x: e.clientX, y: e.clientY };
    vp.setPointerCapture?.(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const at = this.world(e);
    this.live?.pointer(at.x, at.y);
    if (this.pinch.has(e.pointerId)) this.pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && d > 0) {
        const r = this.view.viewport.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left;
        const my = (a.y + b.y) / 2 - r.top;
        this.setCamera(zoomAt(this.camera, mx, my, d / this.pinchDist));
      }
      this.pinchDist = d;
      return;
    }
    const drag = this.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    if (drag.kind === "pan") {
      this.setCamera(panBy(this.camera, e.clientX - drag.x, e.clientY - drag.y));
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    const cur = this.model.blocks.get(drag.id);
    if (!cur) return;
    if (drag.kind === "move") {
      const x = coord(at.x - drag.dx);
      const y = coord(at.y - drag.dy);
      if (x === cur.data.x && y === cur.data.y) return;
      drag.moved = true;
      this.peerMoves.delete(drag.id);
      cur.data = { ...cur.data, x, y };
      for (const c of drag.carried) {
        const e = this.model.blocks.get(c.id);
        if (!e) continue;
        this.peerMoves.delete(c.id);
        e.data = { ...e.data, x: coord(c.bx + x - drag.bx), y: coord(c.by + y - drag.by) };
      }
      this.live?.moving(drag.id, x, y);
    } else {
      cur.data = {
        ...cur.data,
        w: size(drag.w0 + at.x - drag.x0),
        h: size(drag.h0 + at.y - drag.y0),
      };
    }
    this.redraw();
  }

  private onPointerUp(e: PointerEvent): void {
    this.pinch.delete(e.pointerId);
    if (this.pinch.size < 2) this.pinchDist = 0;
    const link = this.downLink;
    this.downLink = null;
    const drag = this.drag;
    if (link && (!drag || (drag.kind === "move" && !drag.moved))) this.openLink(link);
    if (!drag || drag.pointer !== e.pointerId) return;
    this.drag = null;
    if (drag.kind === "pan") return;
    const cur = this.model.blocks.get(drag.id)?.data;
    if (cur && drag.kind === "move" && drag.moved) {
      this.live?.moved();
      this.save(drag.id, { x: cur.x, y: cur.y }, { x: drag.bx, y: drag.by });
      for (const c of drag.carried) {
        const moved = this.model.blocks.get(c.id)?.data;
        if (moved) this.save(c.id, { x: moved.x, y: moved.y }, { x: c.bx, y: c.by });
        this.sync?.release(c.id);
      }
    } else if (cur && drag.kind === "resize") {
      this.save(drag.id, { w: cur.w, h: cur.h }, { w: drag.w0, h: drag.h0 });
    }
    // A peer's save that came in during the gesture: read now, or after the save just started.
    this.sync?.release(drag.id);
  }

  /**
   * Whether this viewer is dragging or resizing a block, or carrying it in a section it drags (its
   * model copy holds the gesture).
   */
  gesturing(id: string): boolean {
    const d = this.drag;
    if (d === null || d.kind === "pan") return false;
    return d.id === id || (d.kind === "move" && d.carried.some((c) => c.id === id));
  }

  /**
   * Whether this viewer holds a block: dragging or resizing it, or editing its text. A peer's save
   * of it is read once that ends (BoardSync's `busy`).
   */
  holds(id: string): boolean {
    return this.gesturing(id) || this.editing === id;
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as Element | null)?.closest?.("textarea")) return;
    const id =
      this.blockIdOf(e.target) ??
      (this.selected && this.model.blocks.has(this.selected) ? this.selected : null);
    const vp = this.view.viewport;
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[e.key];
    if (step && id) {
      e.preventDefault();
      if (this.readOnly) return;
      const b = this.shown(id);
      if (!b) return;
      const n = e.shiftKey ? 50 : 10;
      this.save(id, { x: coord(b.x + step[0] * n), y: coord(b.y + step[1] * n) });
      return;
    }
    if (step) {
      e.preventDefault();
      this.setCamera(panBy(this.camera, -step[0] * 60, -step[1] * 60));
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
      e.preventDefault();
      void this.deleteSelected();
      return;
    }
    if (e.key === "Enter" && id) {
      e.preventDefault();
      this.startEditing(id, this.cellOf(e.target as Element | null) ?? undefined);
      return;
    }
    if (e.key === "Escape") {
      if (this.connecting) this.setConnecting(false);
      this.select(null);
      vp.focus();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      this.setCamera(zoomAt(this.camera, vp.clientWidth / 2, vp.clientHeight / 2, 1.25));
    } else if (e.key === "-") {
      e.preventDefault();
      this.setCamera(zoomAt(this.camera, vp.clientWidth / 2, vp.clientHeight / 2, 0.8));
    } else if (e.key === "0") {
      e.preventDefault();
      this.fitBoard();
    }
  }

  /**
   * A collection as read from shared data. A block this viewer is dragging, resizing, editing or
   * still saving keeps its local copy: the next snapshot after its write brings the server's.
   */
  applySnapshot(collection: "blocks" | "arrows", docs: readonly DocIn[]): void {
    const keep = new Map<string, Entry<BoardBlock>>();
    if (collection === "blocks") {
      const busy = new Set<string>();
      if (this.drag && this.drag.kind !== "pan") busy.add(this.drag.id);
      if (this.drag?.kind === "move") for (const c of this.drag.carried) busy.add(c.id);
      if (this.editing) busy.add(this.editing);
      for (const id of this.model.blocks.keys()) if (this.sync?.saving(id)) busy.add(id);
      for (const id of busy) {
        const e = this.model.blocks.get(id);
        if (e) keep.set(id, e);
      }
    }
    this.model.applySnapshot(collection, docs);
    for (const [id, e] of keep) if (this.model.blocks.has(id)) this.model.blocks.set(id, e);
    if (collection === "blocks") this.peerMoves.clear();
    this.redraw();
  }

  /**
   * A peer is dragging a block: draw it moving, unless this viewer is dragging it too or saving
   * it. Only drawn: the model keeps the stored copy (see peerMoves).
   */
  peerMoved(id: string, x: number, y: number): void {
    const cur = this.model.blocks.get(id);
    if (!cur || (this.drag && "id" in this.drag && this.drag.id === id)) return;
    if (this.sync?.saving(id)) return;
    this.peerMoves.set(id, { x: coord(x), y: coord(y), rev: cur.rev });
    this.redraw();
  }
}
