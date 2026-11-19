// The doc's block menu (doc-blocks): one button that opens a menu of block actions (Turn into,
// Insert below, Move up and down, Delete, Ask an agent). Built with createElement and textContent
// only, keyboard first: arrow keys, Home and End move between items, Escape closes and gives focus
// back to the button, and a click outside closes it.

export interface MenuItem {
  label: string;
  run(): void;
  /** Shown checked (the block's own kind under "Turn into"). */
  checked?: boolean;
  disabled?: boolean;
}

export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

/** The table size form under "Insert below". */
export interface TableForm {
  insert(rows: number, cols: number): void;
}

export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 10;

let counter = 0;

export class BlockMenu {
  readonly button: HTMLButtonElement;
  private panel: HTMLElement | null = null;
  private readonly doc: Document;

  constructor(
    doc: Document,
    private readonly groups: () => MenuGroup[],
    private readonly table: TableForm | null,
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
      else this.open();
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

  open(): void {
    this.close(false);
    const doc = this.doc;
    const panel = doc.createElement("div");
    panel.className = "plinth-doc__menu";
    panel.setAttribute("role", "menu");
    panel.id = `plinth-doc-menu-${++counter}`;
    panel.setAttribute("aria-label", this.button.getAttribute("aria-label") ?? "Block actions");
    this.button.setAttribute("aria-controls", panel.id);
    const groups = this.groups();
    groups.forEach((g, gi) => {
      if (gi > 0) {
        const sep = doc.createElement("div");
        sep.className = "plinth-doc__menu-sep";
        sep.setAttribute("role", "separator");
        panel.append(sep);
      }
      const group = doc.createElement("div");
      group.setAttribute("role", "group");
      if (g.label) {
        const id = `${panel.id}-g${gi}`;
        const head = doc.createElement("div");
        head.className = "plinth-doc__menu-label";
        head.id = id;
        head.textContent = g.label;
        group.setAttribute("aria-labelledby", id);
        group.append(head);
      }
      for (const item of g.items) {
        const it = doc.createElement("button");
        it.type = "button";
        it.className = "plinth-doc__menu-item";
        it.textContent = item.label;
        it.tabIndex = -1;
        if (item.checked !== undefined) {
          it.setAttribute("role", "menuitemradio");
          it.setAttribute("aria-checked", String(item.checked));
        } else it.setAttribute("role", "menuitem");
        if (item.disabled) it.setAttribute("aria-disabled", "true");
        it.addEventListener("mousedown", (e) => e.preventDefault());
        it.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (item.disabled) return;
          this.close(false);
          item.run();
        });
        group.append(it);
      }
      panel.append(group);
    });
    if (this.table) panel.append(this.tableForm(this.table));
    panel.addEventListener("keydown", this.onKey);
    this.button.after(panel);
    this.button.setAttribute("aria-expanded", "true");
    this.panel = panel;
    this.items()[0]?.focus();
    doc.addEventListener("mousedown", this.onOutside, true);
  }

  private tableForm(t: TableForm): HTMLElement {
    const doc = this.doc;
    const form = doc.createElement("div");
    form.className = "plinth-doc__menu-table";
    form.setAttribute("role", "group");
    form.setAttribute("aria-label", "Insert a table below");
    const field = (label: string, value: number, max: number) => {
      const l = doc.createElement("label");
      const span = doc.createElement("span");
      span.textContent = label;
      const input = doc.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = String(max);
      input.value = String(value);
      input.addEventListener("keydown", (e) => e.stopPropagation());
      l.append(span, input);
      form.append(l);
      return input;
    };
    const rows = field("Rows", 2, MAX_TABLE_ROWS);
    const cols = field("Columns", 2, MAX_TABLE_COLS);
    const go = doc.createElement("button");
    go.type = "button";
    go.className = "plinth-doc__menu-item";
    go.textContent = "Insert table";
    go.setAttribute("role", "menuitem");
    go.tabIndex = -1;
    go.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const clamp = (v: string, max: number) =>
        Math.max(1, Math.min(max, Math.trunc(Number(v)) || 1));
      const r = clamp(rows.value, MAX_TABLE_ROWS);
      const c = clamp(cols.value, MAX_TABLE_COLS);
      this.close(false);
      t.insert(r, c);
    });
    form.append(go);
    return form;
  }

  private items(): HTMLElement[] {
    return Array.from(
      this.panel?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? [],
    );
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const items = this.items();
    const i = items.indexOf(this.doc.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") {
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
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-controls");
    this.doc.removeEventListener("mousedown", this.onOutside, true);
    if (refocus) this.button.focus();
  }
}
