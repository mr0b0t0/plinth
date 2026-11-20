// The doc's block menu (doc-blocks): one button that opens a short menu of block actions (Turn
// into, Insert below, Move up and down, Delete). "Turn into", "Insert below" and its "Table" open
// in place of the menu, with a way back, so the menu stays short at any width. It stays inside the
// frame: below its button, above it when there is no room below, or moved up as far as it must
// when there is room on neither side. Built with createElement and textContent only, keyboard
// first: arrow keys, Home and End move between items, Enter or ArrowRight opens a sub-menu,
// ArrowLeft or Escape goes back (Escape at the top closes and gives focus back to the button), and
// a click outside closes it.

export interface MenuItem {
  label: string;
  run?(): void;
  /** Shown checked (the block's own kind under "Turn into"). */
  checked?: boolean;
  disabled?: boolean;
  /** Opens these items in place of the menu, under `label`. */
  sub?: MenuItem[];
  /** Opens the table size form in place of the menu. */
  table?: TableForm;
}

export interface MenuGroup {
  items: MenuItem[];
}

/** The table size form under "Insert below". */
export interface TableForm {
  insert(rows: number, cols: number): void;
}

export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 10;

let counter = 0;

/** How far the menu keeps from its button and from the frame's edges. */
const GAP = 4;
const MARGIN = 8;

export class BlockMenu {
  readonly button: HTMLButtonElement;
  private panel: HTMLElement | null = null;
  private readonly doc: Document;
  /** The items whose sub-menus were opened, the one shown last (empty at the top level). */
  private trail: MenuItem[] = [];

  constructor(
    doc: Document,
    private readonly groups: () => MenuGroup[],
    label = "Block actions",
  ) {
    this.doc = doc;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "plinth-rich__btn plinth-doc__menu-button";
    b.textContent = "⋯";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.panel) this.close(true);
      // A click with a pointer (detail > 0) opens it with no focus ring; a key brings the ring back.
      else this.open(e.detail > 0);
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !this.panel) {
        e.preventDefault();
        this.open();
      }
    });
    this.button = b;
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  open(pointer = false): void {
    this.close(false);
    const panel = this.doc.createElement("div");
    panel.className = pointer ? "plinth-doc__menu plinth-doc__menu--pointer" : "plinth-doc__menu";
    panel.setAttribute("role", "menu");
    panel.id = `plinth-doc-menu-${++counter}`;
    panel.setAttribute("aria-label", this.button.getAttribute("aria-label") ?? "Block actions");
    this.button.setAttribute("aria-controls", panel.id);
    panel.addEventListener("keydown", this.onKey);
    this.button.after(panel);
    this.button.setAttribute("aria-expanded", "true");
    this.panel = panel;
    this.showTop();
    this.doc.addEventListener("mousedown", this.onOutside, true);
  }

  /** Draws the top level, with focus on the item labelled `from` (else the first). */
  private showTop(from?: string): void {
    const panel = this.panel;
    if (!panel) return;
    this.trail = [];
    panel.replaceChildren();
    this.groups().forEach((g, gi) => {
      if (gi > 0) panel.append(this.separator());
      const group = this.doc.createElement("div");
      group.setAttribute("role", "group");
      for (const item of g.items) group.append(this.item(item));
      panel.append(group);
    });
    this.place();
    const items = this.items();
    (items.find((i) => i.textContent === from) ?? items[0])?.focus({ preventScroll: true });
  }

  /**
   * Keeps the level just drawn inside the frame, so its last items show without scrolling the
   * page: below the button, else above it, else as low as it fits.
   */
  private place(): void {
    const panel = this.panel;
    const win = this.doc.defaultView;
    // Its parent is the block's corner, which is positioned: `top` counts from there.
    const parent = panel?.parentElement;
    if (!panel || !win || !parent) return;
    panel.style.top = "";
    panel.style.maxHeight = "";
    const room = win.innerHeight - 2 * MARGIN;
    if (panel.offsetHeight > room) panel.style.maxHeight = `${room}px`;
    const h = panel.offsetHeight;
    const b = this.button.getBoundingClientRect();
    let top = b.bottom + GAP;
    if (top + h > win.innerHeight - MARGIN) {
      const above = b.top - GAP - h;
      top = above >= MARGIN ? above : Math.max(MARGIN, win.innerHeight - MARGIN - h);
    }
    const box = parent.getBoundingClientRect();
    panel.style.marginTop = "0";
    panel.style.top = `${Math.round(top - box.top - parent.clientTop)}px`;
  }

  /** Goes back one level, with focus on the item that opened the level left. */
  private back(): void {
    const left = this.trail.pop();
    const parent = this.trail.at(-1);
    if (parent) this.draw(parent, left?.label);
    else this.showTop(left?.label);
  }

  /** Opens `item`'s sub-menu (or table form) in place of the level shown. */
  private showSub(item: MenuItem): void {
    this.trail.push(item);
    this.draw(item);
  }

  /** Draws `item`'s sub-menu, with focus on the item labelled `from` (else the first). */
  private draw(item: MenuItem, from?: string): void {
    const panel = this.panel;
    if (!panel) return;
    panel.replaceChildren();
    const doc = this.doc;
    const back = doc.createElement("button");
    back.type = "button";
    back.className = "plinth-doc__menu-item plinth-doc__menu-back";
    back.textContent = item.label;
    back.setAttribute("aria-label", `Back from ${item.label}`);
    back.setAttribute("role", "menuitem");
    back.tabIndex = -1;
    back.addEventListener("mousedown", (e) => e.preventDefault());
    back.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.back();
    });
    const group = doc.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", item.label);
    if (item.table) group.append(this.tableForm(item.table));
    else for (const s of item.sub ?? []) group.append(this.item(s));
    panel.append(back, this.separator(), group);
    this.place();
    const items = this.items().filter((i) => i !== back);
    const first = item.table
      ? group.querySelector<HTMLElement>("input")
      : (items.find((i) => i.textContent === from) ??
        items.find((i) => i.getAttribute("aria-checked") === "true") ??
        items[0]);
    first?.focus({ preventScroll: true });
  }

  private separator(): HTMLElement {
    const sep = this.doc.createElement("div");
    sep.className = "plinth-doc__menu-sep";
    sep.setAttribute("role", "separator");
    return sep;
  }

  private item(item: MenuItem): HTMLElement {
    const it = this.doc.createElement("button");
    it.type = "button";
    it.className = "plinth-doc__menu-item";
    it.textContent = item.label;
    it.tabIndex = -1;
    const opens = item.sub !== undefined || item.table !== undefined;
    if (item.checked !== undefined) {
      it.setAttribute("role", "menuitemradio");
      it.setAttribute("aria-checked", String(item.checked));
    } else it.setAttribute("role", "menuitem");
    if (opens) {
      it.classList.add("plinth-doc__menu-sub");
      it.setAttribute("aria-haspopup", "menu");
    }
    if (item.disabled) it.setAttribute("aria-disabled", "true");
    it.addEventListener("mousedown", (e) => e.preventDefault());
    it.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.disabled) return;
      if (opens) {
        this.showSub(item);
        return;
      }
      this.close(false);
      item.run?.();
    });
    return it;
  }

  private tableForm(t: TableForm): HTMLElement {
    const doc = this.doc;
    const form = doc.createElement("div");
    form.className = "plinth-doc__menu-table";
    const go = () => {
      const clamp = (v: string, max: number) =>
        Math.max(1, Math.min(max, Math.trunc(Number(v)) || 1));
      const r = clamp(rows.value, MAX_TABLE_ROWS);
      const c = clamp(cols.value, MAX_TABLE_COLS);
      this.close(false);
      t.insert(r, c);
    };
    const field = (label: string, value: number, max: number) => {
      const l = doc.createElement("label");
      const span = doc.createElement("span");
      span.textContent = label;
      const input = doc.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = String(max);
      input.value = String(value);
      input.addEventListener("keydown", (e) => {
        // The field keeps its own keys; Enter inserts and Escape goes back.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          go();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.back();
        }
      });
      l.append(span, input);
      form.append(l);
      return input;
    };
    const rows = field("Rows", 2, MAX_TABLE_ROWS);
    const cols = field("Columns", 2, MAX_TABLE_COLS);
    const insert = doc.createElement("button");
    insert.type = "button";
    insert.className = "plinth-doc__menu-item";
    insert.textContent = "Insert table";
    insert.setAttribute("role", "menuitem");
    insert.tabIndex = -1;
    insert.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      go();
    });
    form.append(insert);
    return form;
  }

  private items(): HTMLElement[] {
    return Array.from(
      this.panel?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? [],
    );
  }

  private readonly onKey = (e: KeyboardEvent) => {
    this.panel?.classList.remove("plinth-doc__menu--pointer");
    const items = this.items();
    const active = this.doc.activeElement as HTMLElement;
    const i = items.indexOf(active);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowRight" && active?.classList.contains("plinth-doc__menu-sub")) {
      e.preventDefault();
      active.click();
      return;
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && this.trail.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.back();
      return;
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
      return;
    } else if (e.key === "Tab") {
      this.close(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  private readonly onOutside = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (t && (this.panel?.contains(t) || this.button.contains(t))) return;
    this.close(false);
  };

  close(refocus: boolean): void {
    if (!this.panel) return;
    this.panel.remove();
    this.panel = null;
    this.trail = [];
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-controls");
    this.doc.removeEventListener("mousedown", this.onOutside, true);
    if (refocus) this.button.focus();
  }
}
