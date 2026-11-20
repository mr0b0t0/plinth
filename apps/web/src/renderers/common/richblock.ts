// Formatted-text editing of one Markdown block, on the page (doc-blocks; slides and design-system
// text share it). The block's model (@plinth/shared markdownSerialize.ts) is drawn as ordinary
// elements made with createElement and textContent, the editable parts get contenteditable, and
// after every input the DOM is read back into the model by a walk that only knows an allowlist:
// STRONG/B, EM/I, CODE, A (only the links this file drew or set), S/DEL/STRIKE, BR, text, and
// atoms (an image or a reference link, drawn from its Markdown by the page's own pipeline and
// found again by a WeakMap reference). Anything else counts as its text, so nothing a browser
// inserts can become markup. Paste is plain text only.
//
// Formatting commands, Enter, Tab and Backspace in lists act on the model, which is drawn again
// with the caret put back where it was. The host checks every model it is handed before it sends
// anything (verify after edit); a formatting command whose result the serializer cannot express
// is undone here, with "That formatting can't be kept here.".
import {
  applyMark,
  inlineLength,
  type LinkMark,
  normalizeBlock,
  type RichBlock,
  type RichInline,
  type RichListItem,
  type RichMarks,
  type RichSeg,
  rangeHasMark,
  splitInline,
  type ToggleMark,
} from "@plinth/shared";

/** What the editor needs from the page around it. */
export interface RichHost {
  /** An atom's Markdown drawn as the page draws it (sanitized nodes). */
  atom(md: string): Node[];
  /** The person changed the model (typing, formatting, structure). */
  changed(): void;
  /**
   * Enter that ends the block: `keep` stays where the block is, and `next` (null: nothing) goes
   * into a new block below it, with the caret at its start.
   */
  split(keep: RichBlock, next: RichBlock | null): void;
  /** Tab out of the block, to the next one (or the previous one, with Shift). */
  tab(back: boolean): void;
  /** Escape: the block is done. */
  escape(): void;
  /** A message for the frame's status line. */
  announce(text: string): void;
  /** The text the model would be sent as, or null when it cannot be (verify after edit). */
  verify(b: RichBlock): string | null;
  isSafeHref(url: string): boolean;
  /**
   * A typed address as the page's parser writes a link's href (percent-encoded, the host in
   * punycode), so the link reads back as the same mark.
   */
  normalizeHref(url: string): string;
}

export const FORMAT_LOST = "That formatting can't be kept here.";
export const LINK_REFUSED =
  "That address can't be used. Links go to http, https or mailto addresses, a #section, or a path on this site.";
const MAX_LIST_DEPTH = 3;

type ListBlock = Extract<RichBlock, { t: "bullet" | "ordered" }>;

/** An element's text the way the walk counts it. */
const ATOM_CHAR = "￼";

const atoms = new WeakMap<Node, string>();
const links = new WeakMap<Node, LinkMark>();
/** Blocks inside a quote that are drawn whole and not edited (a code block, a table, a divider). */
const islands = new WeakMap<Node, RichBlock>();
const listInfo = new WeakMap<Node, ListBlock>();

/** A place in the block: the n-th inline container (a leaf) and the offset in its flat text. */
export interface RichPoint {
  leaf: number;
  offset: number;
}

// ---------- the model's leaves ----------

/** How many inline containers (leaves) a block has; see leafRefs. */
function leavesOf(b: RichBlock): number {
  return leafRefs(b).length;
}

/** Blocks edited as text inside a quote; the others are drawn whole. */
const isFlow = (b: RichBlock) =>
  b.t === "paragraph" ||
  b.t === "heading" ||
  b.t === "quote" ||
  b.t === "bullet" ||
  b.t === "ordered";

interface LeafRef {
  get(): RichInline;
  set(c: RichInline): void;
  kind: "flow" | "line" | "plain";
}

function leafRefs(b: RichBlock): LeafRef[] {
  const out: LeafRef[] = [];
  const visit = (x: RichBlock) => {
    switch (x.t) {
      case "paragraph":
        out.push({ get: () => x.c, set: (c) => (x.c = c), kind: "flow" });
        break;
      case "heading":
        out.push({ get: () => x.c, set: (c) => (x.c = c), kind: x.setext ? "flow" : "line" });
        break;
      case "code":
      case "indented":
        out.push({
          get: () => [{ k: "text", text: x.text.replace(/\n$/, ""), m: {} }],
          set: (c) => {
            x.text = c.map((s) => (s.k === "text" ? s.text : "")).join("");
          },
          kind: "plain",
        });
        break;
      case "quote":
        if (!x.blocks.some(isFlow)) {
          // An empty quote still has a paragraph to type into.
          out.push({
            get: () => [],
            set: (c) => x.blocks.push({ t: "paragraph", c }),
            kind: "flow",
          });
        }
        for (const y of x.blocks) if (isFlow(y)) visit(y);
        break;
      case "bullet":
      case "ordered":
        for (const it of x.items) {
          if (it.blocks.length === 0) {
            out.push({
              get: () => [],
              set: (c) => (it.blocks = [{ t: "paragraph", c }]),
              kind: "flow",
            });
          }
          for (const y of it.blocks) visit(y);
        }
        break;
      case "table":
        x.head.forEach((_, i) => {
          out.push({ get: () => x.head[i] ?? [], set: (c) => (x.head[i] = c), kind: "line" });
        });
        for (const row of x.rows) {
          row.forEach((_, i) => {
            out.push({ get: () => row[i] ?? [], set: (c) => (row[i] = c), kind: "line" });
          });
        }
        break;
      default:
        break;
    }
  };
  visit(b);
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------- drawing ----------

interface Drawn {
  leaves: HTMLElement[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function drawInline(doc: Document, host: RichHost, parent: HTMLElement, c: RichInline): void {
  // Nest marks in the serializer's order, sharing an element across neighbouring segments.
  type Mark = "link" | "strike" | "strong" | "em";
  const stack: { mark: Mark; el: HTMLElement; link?: LinkMark }[] = [];
  const has = (m: RichMarks, k: Mark) => (k === "link" ? m.link !== undefined : !!m[k]);
  const order: Mark[] = ["link", "strike", "strong", "em"];
  const target = () => stack.at(-1)?.el ?? parent;
  for (const s of c) {
    const m: RichMarks = s.k === "br" ? {} : s.m;
    const want = order.filter((k) => has(m, k));
    let keep = 0;
    while (
      keep < stack.length &&
      keep < want.length &&
      stack[keep]?.mark === want[keep] &&
      (want[keep] !== "link" || stack[keep]?.link === m.link)
    ) {
      keep++;
    }
    stack.length = keep;
    for (let i = keep; i < want.length; i++) {
      const k = want[i] as Mark;
      const tag = k === "link" ? "a" : k === "strike" ? "del" : k === "strong" ? "strong" : "em";
      const e = el(doc, tag);
      if (k === "link" && m.link) {
        links.set(e, m.link);
        // Shown, never followed while editing (the page's own link rules apply when it renders).
        if (host.isSafeHref(m.link.href)) {
          e.setAttribute("href", m.link.href);
          e.setAttribute("rel", "noopener noreferrer nofollow");
        }
        if (m.link.title) e.title = m.link.title;
      }
      target().append(e);
      stack.push({ mark: k, el: e, ...(k === "link" ? { link: m.link } : {}) });
    }
    if (s.k === "br") target().append(el(doc, "br"));
    else if (s.k === "atom") {
      const span = el(doc, "span", "plinth-rich__atom");
      span.contentEditable = "false";
      span.append(...host.atom(s.md));
      atoms.set(span, s.md);
      target().append(span);
    } else if (s.m.code) {
      const code = el(doc, "code");
      code.textContent = s.text;
      target().append(code);
    } else target().append(doc.createTextNode(s.text));
  }
}

function drawBlock(
  doc: Document,
  host: RichHost,
  b: RichBlock,
  drawn: Drawn,
  editable: boolean,
): HTMLElement {
  const leaf = (e: HTMLElement) => {
    drawn.leaves.push(e);
    return e;
  };
  switch (b.t) {
    case "paragraph": {
      const p = leaf(el(doc, "p"));
      drawInline(doc, host, p, b.c);
      return p;
    }
    case "heading": {
      const h = leaf(el(doc, `h${b.level}` as "h1"));
      drawInline(doc, host, h, b.c);
      return h;
    }
    case "quote": {
      const q = el(doc, "blockquote");
      if (!b.blocks.some(isFlow)) q.append(leaf(el(doc, "p")));
      for (const x of b.blocks) {
        if (isFlow(x)) q.append(drawBlock(doc, host, x, drawn, editable));
        else {
          const island = drawBlock(doc, host, x, { leaves: [] }, false);
          island.contentEditable = "false";
          islands.set(island, x);
          q.append(island);
        }
      }
      return q;
    }
    case "bullet":
    case "ordered": {
      const list = el(doc, b.t === "bullet" ? "ul" : "ol");
      if (b.t === "ordered" && b.start !== 1) list.setAttribute("start", String(b.start));
      listInfo.set(list, b);
      for (const it of b.items) {
        const li = el(doc, "li");
        for (const x of it.blocks) {
          const child = drawBlock(doc, host, x, drawn, editable);
          if (x.t === "paragraph" && b.tight) child.classList.add("plinth-rich__tight");
          li.append(child);
        }
        if (it.blocks.length === 0) {
          // An empty item still has a place for the caret.
          const p = leaf(el(doc, "p", b.tight ? "plinth-rich__tight" : undefined));
          li.append(p);
        }
        list.append(li);
      }
      return list;
    }
    case "table": {
      const wrap = el(doc, "div", "plinth-doc__table");
      const table = el(doc, "table");
      const cls = (i: number) => {
        const a = b.align[i];
        return a ? `plinth-doc__align-${a}` : undefined;
      };
      const thead = el(doc, "thead");
      const hr = el(doc, "tr");
      b.head.forEach((c, i) => {
        const th = leaf(el(doc, "th", cls(i)));
        if (editable) th.contentEditable = "true";
        drawInline(doc, host, th, c);
        hr.append(th);
      });
      thead.append(hr);
      table.append(thead);
      if (b.rows.length > 0) {
        const tbody = el(doc, "tbody");
        for (const row of b.rows) {
          const tr = el(doc, "tr");
          row.forEach((c, i) => {
            const td = leaf(el(doc, "td", cls(i)));
            if (editable) td.contentEditable = "true";
            drawInline(doc, host, td, c);
            tr.append(td);
          });
          tbody.append(tr);
        }
        table.append(tbody);
      }
      wrap.append(table);
      return wrap;
    }
    case "code":
    case "indented": {
      const pre = el(doc, "pre");
      const code = leaf(el(doc, "code"));
      code.textContent = b.text.replace(/\n$/, "");
      if (editable) code.contentEditable = "true";
      pre.append(code);
      return pre;
    }
    case "divider":
      return el(doc, "hr");
    case "image": {
      const fig = el(doc, "p", "plinth-rich__image");
      fig.append(...host.atom(`![${b.alt.replace(/[[\]\\]/g, "\\$&")}]${b.rest}`));
      return fig;
    }
  }
}

// ---------- reading the DOM back ----------

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "TD",
  "TH",
  "PRE",
]);

interface Probe {
  node: Node;
  offset: number;
  found?: RichPoint;
}

class Reader {
  leaf = -1;
  pos = 0;
  constructor(private readonly probes: Probe[]) {}

  startLeaf(container: Node): void {
    this.leaf++;
    this.pos = 0;
    this.check(container, 0);
  }

  private check(node: Node, childIndex: number): void {
    for (const p of this.probes) {
      if (!p.found && p.node === node && p.offset <= childIndex) {
        p.found = { leaf: this.leaf, offset: this.pos };
      }
    }
  }

  /** Reads the inline content under `node` with `marks`. */
  inline(node: Node, marks: RichMarks, out: RichSeg[], plain = false): void {
    const kids = Array.from(node.childNodes);
    kids.forEach((child, i) => {
      this.check(node, i);
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? "";
        for (const p of this.probes) {
          if (!p.found && p.node === child)
            p.found = { leaf: this.leaf, offset: this.pos + p.offset };
        }
        if (text !== "") out.push({ k: "text", text, m: { ...marks } });
        this.pos += text.length;
        return;
      }
      if (child.nodeType !== 1) return;
      const e = child as HTMLElement;
      const atom = atoms.get(e);
      if (atom !== undefined) {
        if (plain) return;
        out.push({ k: "atom", md: atom, m: { ...marks } });
        this.pos += 1;
        return;
      }
      const tag = e.tagName;
      if (tag === "BR") {
        if (plain) out.push({ k: "text", text: "\n", m: {} });
        else out.push({ k: "br" });
        this.pos += 1;
        return;
      }
      if (BLOCK_TAGS.has(tag)) {
        // Something the browser nested: a line break, then its text.
        if (out.length > 0) {
          out.push({ k: "text", text: "\n", m: {} });
          this.pos += 1;
        }
        this.inline(e, marks, out, plain);
        return;
      }
      if (plain) {
        this.inline(e, marks, out, plain);
        return;
      }
      const m = { ...marks };
      if (tag === "STRONG" || tag === "B") m.strong = true;
      else if (tag === "EM" || tag === "I") m.em = true;
      else if (tag === "S" || tag === "DEL" || tag === "STRIKE") m.strike = true;
      else if (tag === "CODE") m.code = true;
      else if (tag === "A") {
        const l = links.get(e);
        if (l) m.link = l;
      }
      this.inline(e, m, out, plain);
    });
    this.check(node, kids.length);
  }

  leafInline(node: Node, plain = false): RichInline {
    this.startLeaf(node);
    const out: RichSeg[] = [];
    this.inline(node, {}, out, plain);
    return out.map((s) =>
      s.k === "text" && !plain ? { ...s, text: s.text.replace(/ /g, " ") } : s,
    );
  }

  /** Children of a quote or a list item as blocks: paragraphs, headings, lists, quotes. */
  flow(container: Node, inItem: boolean, tight: boolean): RichBlock[] {
    const out: RichBlock[] = [];
    let loose: Node[] = [];
    const flushLoose = () => {
      if (loose.length === 0) return;
      // Read the stray inline nodes in place, as one paragraph.
      this.startLeaf(container);
      const segs: RichSeg[] = [];
      for (const n of loose) {
        const wrap = { childNodes: [n] } as unknown as Node;
        this.inline(wrap, {}, segs);
      }
      out.push({ t: "paragraph", c: segs });
      loose = [];
    };
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 1) {
        const e = child as HTMLElement;
        const island = islands.get(e);
        if (island) {
          flushLoose();
          out.push(island);
          continue;
        }
        const tag = e.tagName;
        if (tag === "UL" || tag === "OL") {
          flushLoose();
          out.push(this.list(e, inItem));
          continue;
        }
        if (tag === "BLOCKQUOTE" && !inItem) {
          flushLoose();
          out.push({ t: "quote", blocks: this.flow(e, false, false) });
          continue;
        }
        if (/^H[1-6]$/.test(tag) && !inItem) {
          flushLoose();
          out.push({ t: "heading", level: Number(tag[1]), setext: false, c: this.leafInline(e) });
          continue;
        }
        if (tag === "P" || tag === "DIV") {
          flushLoose();
          out.push({ t: "paragraph", c: this.leafInline(e) });
          continue;
        }
      }
      loose.push(child);
    }
    flushLoose();
    void tight;
    return out;
  }

  list(e: HTMLElement, nested: boolean): ListBlock {
    void nested;
    const info = listInfo.get(e);
    const items: RichListItem[] = [];
    const tight = info?.tight ?? true;
    for (const child of Array.from(e.childNodes)) {
      if (child.nodeType === 1 && (child as HTMLElement).tagName === "LI") {
        items.push({ blocks: this.flow(child, true, tight) });
      } else if (child.nodeType === 3 && (child.nodeValue ?? "").trim() === "") {
        // White space between items.
      } else {
        const wrap = { childNodes: [child] } as unknown as Node;
        items.push({ blocks: this.flow(wrap, true, tight) });
      }
    }
    if (e.tagName === "OL") {
      const start = info?.t === "ordered" ? info.start : Number(e.getAttribute("start") ?? "1");
      const delim = info?.t === "ordered" ? info.delim : ".";
      return { t: "ordered", start, delim, tight, items };
    }
    const marker = info?.t === "bullet" ? info.marker : "-";
    return { t: "bullet", marker, tight, items };
  }
}

/** Reads a drawn block back into its model, keeping what the DOM cannot change. */
function readBlock(shape: RichBlock, content: HTMLElement, probes: Probe[]): RichBlock {
  const r = new Reader(probes);
  switch (shape.t) {
    case "paragraph":
      return { t: "paragraph", c: r.leafInline(content) };
    case "heading":
      return { ...shape, c: r.leafInline(content) };
    case "quote":
      return { t: "quote", blocks: r.flow(content, false, false) };
    case "bullet":
    case "ordered":
      return r.list(content, false);
    case "table": {
      const cells = Array.from(content.querySelectorAll("th, td"));
      const n = shape.head.length;
      const read = cells.map((c) => r.leafInline(c));
      const head = read.slice(0, n);
      const rows: RichInline[][] = [];
      for (let i = n; i < read.length; i += n) rows.push(read.slice(i, i + n));
      return { ...shape, head, rows };
    }
    case "code":
    case "indented": {
      const code = content.querySelector("code") ?? content;
      const c = r.leafInline(code, true);
      const text = c.map((s) => (s.k === "text" ? s.text : "")).join("");
      return { ...shape, text: text === "" ? "" : `${text}\n` };
    }
    default:
      return shape;
  }
}

// ---------- the editor ----------

export interface RichOptions {
  /** Extra controls at the end of the toolbar (the block menu). */
  extra?: HTMLElement[];
  /** The block's name for assistive technology ("Block 3, paragraph"). */
  label: string;
}

const FORMATS: { mark: ToggleMark; label: string; text: string; key: string; shift?: boolean }[] = [
  { mark: "strong", label: "Bold", text: "B", key: "b" },
  { mark: "em", label: "Italic", text: "I", key: "i" },
  { mark: "code", label: "Code", text: "</>", key: "e" },
  { mark: "strike", label: "Strikethrough", text: "S", key: "x", shift: true },
];

const KIND_NAMES: Record<RichBlock["t"], string> = {
  paragraph: "paragraph",
  heading: "heading",
  quote: "quote",
  bullet: "bulleted list",
  ordered: "numbered list",
  table: "table",
  code: "code block",
  indented: "code block",
  divider: "divider",
  image: "image",
};

export function kindName(b: RichBlock): string {
  return b.t === "heading" ? `heading ${b.level}` : KIND_NAMES[b.t];
}

/** Whether a block's text is edited in place (not a divider or an image). */
const hasText = (b: RichBlock) => b.t !== "divider" && b.t !== "image";

export class RichBlockEditor {
  readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly toolbar: HTMLElement;
  private readonly linkForm: HTMLElement;
  private readonly linkInput: HTMLInputElement;
  /** "Remove link", shown only when the text being linked already has a link. */
  private readonly removeButton: HTMLButtonElement;
  private readonly buttons = new Map<ToggleMark | "link", HTMLButtonElement>();
  private altInput: HTMLInputElement | null = null;
  private content!: HTMLElement;
  private drawn: Drawn = { leaves: [] };
  private shape: RichBlock;
  /** The selection the link field was opened for. */
  private linkRange: { from: RichPoint; to: RichPoint } | null = null;

  constructor(
    doc: Document,
    private readonly host: RichHost,
    block: RichBlock,
    private readonly opts: RichOptions,
  ) {
    this.doc = doc;
    this.shape = normalizeBlock(clone(block));
    this.el = el(doc, "div", "plinth-rich");
    this.toolbar = el(doc, "div", "plinth-rich__toolbar");
    this.toolbar.setAttribute("role", "toolbar");
    this.toolbar.setAttribute("aria-label", "Formatting");
    for (const f of FORMATS) {
      const b = this.button(f.text, `${f.label} (${shortcut(f.key, f.shift)})`, () =>
        this.toggle(f.mark),
      );
      b.classList.add(`plinth-rich__fmt-${f.mark}`);
      b.setAttribute("aria-pressed", "false");
      this.buttons.set(f.mark, b);
    }
    const link = this.button("Link", `Link (${shortcut("k")})`, () => this.openLink());
    link.setAttribute("aria-pressed", "false");
    this.buttons.set("link", link);
    this.linkForm = el(doc, "div", "plinth-rich__link");
    this.linkForm.hidden = true;
    this.linkForm.setAttribute("role", "group");
    this.linkForm.setAttribute("aria-label", "Link");
    this.linkInput = el(doc, "input");
    this.linkInput.type = "url";
    this.linkInput.setAttribute("aria-label", "Link address");
    this.linkInput.placeholder = "https://";
    this.linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.applyLink();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeLink(true);
      }
    });
    const apply = this.button("Apply", "Apply the link", () => this.applyLink(), false);
    this.removeButton = this.button(
      "Remove link",
      "Remove the link",
      () => this.removeLink(),
      false,
    );
    this.linkForm.append(this.linkInput, apply, this.removeButton);
    for (const x of opts.extra ?? []) this.toolbar.append(x);
    this.el.append(this.toolbar, this.linkForm);
    this.draw();
    this.el.addEventListener("keydown", this.onKey);
    this.el.addEventListener("input", this.onInput);
    this.el.addEventListener("paste", this.onPaste);
    this.el.addEventListener("drop", (e) => e.preventDefault());
    // A link in the block being edited is text to edit, never followed (not even with a modifier).
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element | null;
      if (t?.closest?.("a") && this.content.contains(t)) e.preventDefault();
    });
    this.el.addEventListener("auxclick", (e) => {
      const t = e.target as Element | null;
      if (t?.closest?.("a")) e.preventDefault();
    });
    this.el.addEventListener("beforeinput", this.onBeforeInput);
    this.doc.addEventListener("selectionchange", this.onSelection);
  }

  /** Stops listening to the document (the editor is being dropped). */
  destroy(): void {
    this.doc.removeEventListener("selectionchange", this.onSelection);
  }

  private button(text: string, label: string, run: () => void, inBar = true): HTMLButtonElement {
    const b = el(this.doc, "button", "plinth-rich__btn");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.title = label;
    // Keep the selection in the text while the button is pressed.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    if (inBar) this.toolbar.append(b);
    return b;
  }

  /** The block as the person has it now. */
  get model(): RichBlock {
    return normalizeBlock(this.read([]));
  }

  /** The editable element that holds the block (for focus and tests). */
  get editable(): HTMLElement {
    return this.content;
  }

  get kind(): RichBlock["t"] {
    return this.shape.t;
  }

  private read(probes: Probe[]): RichBlock {
    if (this.shape.t === "image") {
      return { ...this.shape, alt: this.altInput?.value ?? this.shape.alt };
    }
    return readBlock(this.shape, this.content, probes);
  }

  /** Draws `block` in place of the current one, with the caret at `at` (or none). */
  setModel(block: RichBlock, at?: RichPoint | null): void {
    const focused = this.el.contains(this.doc.activeElement);
    this.shape = normalizeBlock(clone(block));
    this.draw();
    if (at) this.place(at);
    else if (focused) this.focus("end");
  }

  private draw(): void {
    const old = this.content as HTMLElement | undefined;
    this.drawn = { leaves: [] };
    const b = this.shape;
    const content = drawBlock(this.doc, this.host, b, this.drawn, true);
    content.classList.add("plinth-rich__content");
    content.setAttribute("aria-label", `${this.opts.label}, editable`);
    const textEditable = b.t !== "table" && b.t !== "code" && b.t !== "indented" && hasText(b);
    if (textEditable) {
      content.contentEditable = "true";
      content.setAttribute("role", "textbox");
      content.setAttribute("aria-multiline", b.t === "heading" && !b.setext ? "false" : "true");
      content.spellcheck = true;
    } else if (b.t === "code" || b.t === "indented") {
      const code = content.querySelector("code");
      code?.setAttribute("role", "textbox");
      code?.setAttribute("aria-multiline", "true");
      code?.setAttribute("aria-label", `${this.opts.label}, editable`);
      code?.setAttribute("spellcheck", "false");
    } else if (b.t === "table") {
      this.drawn.leaves.forEach((cell, i) => {
        cell.setAttribute("role", "textbox");
        cell.setAttribute("aria-label", `${this.opts.label}, cell ${i + 1}, editable`);
      });
    } else {
      content.tabIndex = -1;
    }
    for (const [, btn] of this.buttons)
      btn.hidden = !hasText(b) || b.t === "code" || b.t === "indented";
    this.linkForm.hidden = true;
    this.toolbar.querySelector(":scope > .plinth-rich__alt")?.remove();
    if (b.t === "image") {
      const label = el(this.doc, "label", "plinth-rich__alt");
      const span = el(this.doc, "span");
      span.textContent = "Alt text";
      const input = el(this.doc, "input");
      input.type = "text";
      input.value = b.alt;
      input.maxLength = 500;
      input.addEventListener("input", () => this.host.changed());
      label.append(span, input);
      this.altInput = input;
      // The field sits in the toolbar, which floats over the page, so the image keeps its place.
      this.toolbar.prepend(label);
    } else this.altInput = null;
    if (old) old.replaceWith(content);
    else this.el.append(content);
    this.content = content;
  }

  /** Puts the caret at the start or the end of the block. */
  focus(where: "start" | "end" | RichPoint): void {
    if (this.shape.t === "image") {
      this.altInput?.focus();
      return;
    }
    if (typeof where === "object") {
      this.place(where);
      return;
    }
    const leaves = this.drawn.leaves;
    if (leaves.length === 0) {
      (this.content.querySelector("[tabindex]") as HTMLElement | null)?.focus();
      this.content.focus();
      return;
    }
    if (where === "start") this.place({ leaf: 0, offset: 0 });
    else {
      const last = leaves.length - 1;
      const refs = leafRefs(this.shape);
      this.place({ leaf: last, offset: inlineLength(refs[last]?.get() ?? []) });
    }
  }

  /** The caret (or the selection's ends), as places in the model. */
  selection(): { from: RichPoint; to: RichPoint } | null {
    const sel = this.doc.getSelection?.();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!this.content.contains(range.startContainer)) return null;
    const a: Probe = { node: range.startContainer, offset: range.startOffset };
    const b: Probe = { node: range.endContainer, offset: range.endOffset };
    this.read([a, b]);
    if (!a.found || !b.found) return null;
    return { from: a.found, to: b.found };
  }

  /** Sets the caret at a model place in the drawn DOM. */
  private place(at: RichPoint, to?: RichPoint): void {
    const point = (p: RichPoint): [Node, number] | null => {
      const leaf = this.drawn.leaves[Math.max(0, Math.min(p.leaf, this.drawn.leaves.length - 1))];
      if (!leaf) return null;
      let left = p.offset;
      let found: [Node, number] | null = null;
      const walk = (n: Node): boolean => {
        for (const child of Array.from(n.childNodes)) {
          if (child.nodeType === 3) {
            const len = (child.nodeValue ?? "").length;
            if (left <= len) {
              found = [child, left];
              return true;
            }
            left -= len;
          } else if (child.nodeType === 1) {
            const e = child as HTMLElement;
            if (atoms.has(e) || e.tagName === "BR") {
              if (left === 0) {
                found = [n, Array.from(n.childNodes).indexOf(child)];
                return true;
              }
              left -= 1;
            } else if (walk(e)) return true;
          }
        }
        return false;
      };
      if (!walk(leaf)) found = [leaf, leaf.childNodes.length];
      return found;
    };
    const start = point(at);
    if (!start) return;
    const end = to ? point(to) : start;
    const leaf = this.drawn.leaves[Math.max(0, Math.min(at.leaf, this.drawn.leaves.length - 1))];
    (leaf?.closest('[contenteditable="true"]') as HTMLElement | null)?.focus({
      preventScroll: true,
    });
    const sel = this.doc.getSelection?.();
    if (!sel) return;
    const range = this.doc.createRange();
    try {
      range.setStart(start[0], start[1]);
      if (end) range.setEnd(end[0], end[1]);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      // A node that left the page meanwhile: no caret.
    }
  }

  // ---------- events ----------

  private readonly onInput = (e: Event) => {
    if (e.target === this.linkInput || e.target === this.altInput) return;
    this.host.changed();
  };

  private readonly onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    // The browser's own formatting and drops never reach the DOM: the model formats.
    if (t.startsWith("format") || t === "insertFromDrop" || t === "insertLink") {
      e.preventDefault();
      return;
    }
    if (t === "insertParagraph") {
      e.preventDefault();
      this.enter();
    } else if (t === "insertLineBreak") {
      e.preventDefault();
      this.lineBreak();
    }
  };

  private readonly onPaste = (e: ClipboardEvent) => {
    if (e.target === this.linkInput || e.target === this.altInput) return;
    e.preventDefault();
    let text = e.clipboardData?.getData("text/plain") ?? "";
    const leaf = this.selection()?.from.leaf ?? 0;
    const kind = leafRefs(this.shape)[leaf]?.kind ?? "flow";
    text = text.replace(/\r\n?/g, "\n");
    if (kind === "line") text = text.replace(/\s*\n\s*/g, " ");
    this.insertText(text);
  };

  /** Inserts plain text at the selection, as typing would. */
  insertText(text: string): void {
    const sel = this.doc.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this.content.contains(range.startContainer)) return;
    range.deleteContents();
    const node = this.doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.host.changed();
  }

  private readonly onSelection = () => {
    const s = this.selection();
    if (!s) return;
    const refs = leafRefs(this.read([]));
    const c = refs[s.from.leaf]?.get() ?? [];
    const from = s.from.offset;
    const to = s.from.leaf === s.to.leaf ? s.to.offset : inlineLength(c);
    const probe = from === to ? [Math.max(0, from - 1), Math.max(1, from)] : [from, to];
    for (const [mark, btn] of this.buttons) {
      btn.setAttribute(
        "aria-pressed",
        String(rangeHasMark(c, probe[0] as number, probe[1] as number, mark)),
      );
    }
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.target === this.linkInput) return;
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && hasText(this.shape)) {
      const k = e.key.toLowerCase();
      const f = FORMATS.find((x) => x.key === k && !!x.shift === e.shiftKey);
      if (f && this.shape.t !== "code" && this.shape.t !== "indented") {
        e.preventDefault();
        this.toggle(f.mark);
        return;
      }
      if (k === "k" && !e.shiftKey && this.shape.t !== "code" && this.shape.t !== "indented") {
        e.preventDefault();
        this.openLink();
        return;
      }
    }
    if (e.target === this.altInput) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.host.escape();
      } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.host.tab(e.shiftKey);
      }
      return;
    }
    if (!this.content.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.host.escape();
      return;
    }
    if (e.key === "Enter" && !mod && !e.altKey) {
      // Some browsers send no beforeinput for Enter in a contenteditable table cell or code.
      e.preventDefault();
      if (e.shiftKey) this.lineBreak();
      else this.enter();
      return;
    }
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.tab(e.shiftKey);
      return;
    }
    if (
      e.key === "Backspace" &&
      !mod &&
      (this.shape.t === "bullet" || this.shape.t === "ordered")
    ) {
      const s = this.selection();
      if (s && s.from.leaf === s.to.leaf && s.from.offset === 0 && s.to.offset === 0) {
        const model = this.read([]);
        const refs = leafRefs(model);
        if (inlineLength(refs[s.from.leaf]?.get() ?? []) === 0) {
          e.preventDefault();
          this.leaveEmptyItem(model, s.from.leaf);
        }
      }
    }
  };

  // ---------- commands ----------

  /** Bold, italic, code or strikethrough on the selection; a refused result is undone. */
  toggle(mark: ToggleMark): void {
    const s = this.selection();
    if (!s || (s.from.leaf === s.to.leaf && s.from.offset === s.to.offset)) {
      this.host.announce("Select some text first.");
      return;
    }
    const before = this.read([]);
    const model = clone(before);
    const refs = leafRefs(model);
    const ranges = this.ranges(refs, s);
    const on = !ranges.every(([i, a, b]) => rangeHasMark(refs[i]?.get() ?? [], a, b, mark));
    for (const [i, a, b] of ranges) {
      const ref = refs[i];
      if (ref && ref.kind !== "plain") ref.set(applyMark(ref.get(), a, b, mark, on));
    }
    this.commit(before, model, s);
  }

  private ranges(
    refs: LeafRef[],
    s: { from: RichPoint; to: RichPoint },
  ): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let i = s.from.leaf; i <= s.to.leaf; i++) {
      const len = inlineLength(refs[i]?.get() ?? []);
      out.push([i, i === s.from.leaf ? s.from.offset : 0, i === s.to.leaf ? s.to.offset : len]);
    }
    return out;
  }

  /** Draws a changed model if it can be sent; otherwise puts the old one back and says why. */
  private commit(before: RichBlock, after: RichBlock, s: { from: RichPoint; to: RichPoint }): void {
    if (this.host.verify(after) === null) {
      this.host.announce(FORMAT_LOST);
      this.shape = normalizeBlock(before);
      this.draw();
      this.place(s.from, s.to);
      return;
    }
    this.shape = after;
    this.draw();
    this.place(s.from, s.to);
    this.host.changed();
  }

  private openLink(): void {
    const s = this.selection();
    if (!s) return;
    const model = this.read([]);
    const refs = leafRefs(model);
    const c = refs[s.from.leaf]?.get() ?? [];
    let range = s;
    // A caret in a link edits that whole link.
    if (s.from.leaf === s.to.leaf && s.from.offset === s.to.offset) {
      const span = linkSpan(c, s.from.offset);
      if (!span) {
        this.host.announce("Select the text to link first.");
        return;
      }
      range = {
        from: { leaf: s.from.leaf, offset: span[0] },
        to: { leaf: s.from.leaf, offset: span[1] },
      };
    }
    this.linkRange = range;
    const href = linkAt(c, range.from.offset)?.href ?? "";
    this.linkInput.value = href;
    this.removeButton.hidden = href === "";
    this.linkForm.hidden = false;
    this.linkInput.focus();
  }

  private closeLink(refocus: boolean): void {
    const r = this.linkRange;
    this.linkForm.hidden = true;
    this.linkRange = null;
    if (refocus && r) this.place(r.from, r.to);
  }

  private applyLink(): void {
    const r = this.linkRange;
    const url = this.linkInput.value.trim();
    if (!r) {
      this.closeLink(false);
      return;
    }
    if (url === "") {
      this.removeLink();
      return;
    }
    const href = this.host.normalizeHref(url);
    if (!this.host.isSafeHref(url) || !this.host.isSafeHref(href)) {
      this.host.announce(LINK_REFUSED);
      return;
    }
    const before = this.read([]);
    const model = clone(before);
    const refs = leafRefs(model);
    for (const [i, a, b] of this.ranges(refs, r)) {
      const ref = refs[i];
      if (ref && ref.kind !== "plain") {
        ref.set(applyMark(ref.get(), a, b, "link", true, { href, title: "" }));
      }
    }
    this.linkForm.hidden = true;
    this.linkRange = null;
    this.commit(before, model, r);
  }

  private removeLink(): void {
    const r = this.linkRange;
    if (!r) {
      this.closeLink(false);
      return;
    }
    const before = this.read([]);
    const model = clone(before);
    const refs = leafRefs(model);
    for (const [i, a, b] of this.ranges(refs, r)) {
      const ref = refs[i];
      if (ref && ref.kind !== "plain") ref.set(applyMark(ref.get(), a, b, "link", false));
    }
    this.linkForm.hidden = true;
    this.linkRange = null;
    this.commit(before, model, r);
  }

  private lineBreak(): void {
    const s = this.selection();
    if (!s) return;
    const model = this.read([]);
    const refs = leafRefs(model);
    const ref = refs[s.from.leaf];
    if (!ref || ref.kind === "line") return;
    const [a] = splitInline(ref.get(), s.from.offset);
    const [, b] = splitInline(ref.get(), s.to.leaf === s.from.leaf ? s.to.offset : s.from.offset);
    if (ref.kind === "plain") {
      this.insertText("\n");
      return;
    }
    ref.set([...a, { k: "br" }, ...b]);
    this.shape = model;
    this.draw();
    this.place({ leaf: s.from.leaf, offset: s.from.offset + 1 });
    this.host.changed();
  }

  /** Enter: a new item in a list, a new paragraph in a quote, else a new block below. */
  private enter(): void {
    const s = this.selection();
    if (!s) return;
    const model = this.read([]);
    const leaf = s.from.leaf;
    const refs = leafRefs(model);
    const ref = refs[leaf];
    if (!ref) return;
    if (ref.kind === "plain") {
      this.insertText("\n");
      return;
    }
    if (model.t === "table") return;
    // The selected text goes, as typing over it would.
    const [head] = splitInline(ref.get(), s.from.offset);
    const tailFrom = s.to.leaf === leaf ? s.to.offset : inlineLength(ref.get());
    const [, tail] = splitInline(ref.get(), tailFrom);
    if (model.t === "paragraph" || model.t === "heading") {
      const keep: RichBlock = { ...model, c: head };
      const next: RichBlock = { t: "paragraph", c: tail };
      this.host.split(keep, next);
      return;
    }
    if (model.t === "bullet" || model.t === "ordered") {
      const at = locateItem(model, leaf);
      if (!at) return;
      const { list, index, item, block } = at;
      const empty = inlineLength(ref.get()) === 0 && item.blocks.length <= 1;
      if (empty) {
        this.leaveEmptyItem(model, leaf);
        return;
      }
      const bi = item.blocks.indexOf(block);
      const first: RichListItem = {
        blocks: [...item.blocks.slice(0, bi), { t: "paragraph", c: head }],
      };
      const second: RichListItem = {
        blocks: [{ t: "paragraph", c: tail }, ...item.blocks.slice(bi + 1)],
      };
      list.items.splice(index, 1, first, second);
      this.redraw(model, { leaf: leaf + 1, offset: 0 });
      return;
    }
    if (model.t === "quote") {
      const at = locateFlow(model, leaf);
      if (!at) return;
      const { parent, index } = at;
      const empty = inlineLength(ref.get()) === 0;
      if (empty && parent === model && index === model.blocks.length - 1) {
        model.blocks.splice(index, 1);
        this.host.split(model, { t: "paragraph", c: [] });
        return;
      }
      parent.blocks.splice(index, 1, { t: "paragraph", c: head }, { t: "paragraph", c: tail });
      this.redraw(model, { leaf: leaf + 1, offset: 0 });
    }
  }

  /** An empty list item: the last one leaves the list (a paragraph below); others go. */
  private leaveEmptyItem(model: RichBlock, leaf: number): void {
    if (model.t !== "bullet" && model.t !== "ordered") return;
    const at = locateItem(model, leaf);
    if (!at) return;
    const { list, index } = at;
    const top = list === model;
    if (top && index === list.items.length - 1) {
      list.items.splice(index, 1);
      if (list.items.length === 0) {
        this.host.split({ t: "paragraph", c: [] }, null);
        return;
      }
      this.host.split(model, { t: "paragraph", c: [] });
      return;
    }
    if (!top) {
      // Out of a nested list: one level up.
      this.outdent(model, leaf);
      return;
    }
    list.items.splice(index, 1);
    this.redraw(model, { leaf: Math.max(0, leaf - 1), offset: Number.MAX_SAFE_INTEGER });
  }

  private tab(back: boolean): void {
    const s = this.selection();
    const model = this.read([]);
    if (s && (model.t === "bullet" || model.t === "ordered")) {
      if (back) this.outdent(model, s.from.leaf, s.from.offset);
      else this.indent(model, s.from.leaf, s.from.offset);
      return;
    }
    if (s && model.t === "table") {
      const n = this.drawn.leaves.length;
      const next = s.from.leaf + (back ? -1 : 1);
      if (next >= 0 && next < n) {
        this.place({ leaf: next, offset: 0 });
        return;
      }
    }
    this.host.tab(back);
  }

  private indent(model: ListBlock, leaf: number, offset = 0): void {
    const at = locateItem(model, leaf);
    if (!at || at.index === 0 || at.depth >= MAX_LIST_DEPTH) {
      this.host.announce(at && at.depth >= MAX_LIST_DEPTH ? "Lists go three levels deep." : "");
      return;
    }
    const { list, index, item } = at;
    const prev = list.items[index - 1] as RichListItem;
    list.items.splice(index, 1);
    const last = prev.blocks.at(-1);
    if (last && (last.t === "bullet" || last.t === "ordered") && last.t === list.t) {
      last.items.push(item);
    } else {
      const nested: ListBlock =
        list.t === "bullet"
          ? { t: "bullet", marker: list.marker, tight: list.tight, items: [item] }
          : { t: "ordered", start: 1, delim: list.delim, tight: list.tight, items: [item] };
      prev.blocks.push(nested);
    }
    this.redraw(model, { leaf, offset });
  }

  private outdent(model: ListBlock, leaf: number, offset = 0): void {
    const path = itemPath(model, leaf);
    if (!path || path.length < 2) return;
    const inner = path[path.length - 1] as ItemAt;
    const outer = path[path.length - 2] as ItemAt;
    const { list, index, item } = inner;
    // The item and the ones after it leave the nested list; the ones after become its children.
    const after = list.items.splice(index);
    after.shift();
    if (list.items.length === 0) {
      outer.item.blocks = outer.item.blocks.filter((b) => b !== list);
    }
    if (after.length > 0) {
      const tailList: ListBlock = { ...list, items: after } as ListBlock;
      if (tailList.t === "ordered") tailList.start = 1;
      item.blocks.push(tailList);
    }
    outer.list.items.splice(outer.index + 1, 0, item);
    this.redraw(model, { leaf, offset });
  }

  private redraw(model: RichBlock, at: RichPoint): void {
    this.shape = normalizeBlock(model);
    this.draw();
    const refs = leafRefs(this.shape);
    const leaf = Math.min(at.leaf, Math.max(0, refs.length - 1));
    const len = inlineLength(refs[leaf]?.get() ?? []);
    this.place({ leaf, offset: Math.min(at.offset, len) });
    this.host.changed();
  }
}

// ---------- list helpers ----------

interface ItemAt {
  list: ListBlock;
  index: number;
  item: RichListItem;
  block: RichBlock;
  depth: number;
}

/** The path of list items down to the one that holds leaf `leaf`, outermost first. */
function itemPath(model: ListBlock, leaf: number): ItemAt[] | null {
  let n = 0;
  const walk = (list: ListBlock, depth: number, path: ItemAt[]): ItemAt[] | null => {
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i] as RichListItem;
      for (const b of item.blocks) {
        const here = { list, index: i, item, block: b, depth };
        if (b.t === "bullet" || b.t === "ordered") {
          const found = walk(b, depth + 1, [...path, here]);
          if (found) return found;
        } else {
          const count = leavesOf(b);
          if (leaf < n + count) return [...path, here];
          n += count;
        }
      }
      if (item.blocks.length === 0) {
        if (leaf === n)
          return [...path, { list, index: i, item, block: { t: "paragraph", c: [] }, depth }];
        n++;
      }
    }
    return null;
  };
  return walk(model, 1, []);
}

function locateItem(model: ListBlock, leaf: number): ItemAt | null {
  return itemPath(model, leaf)?.at(-1) ?? null;
}

/** The quote (possibly nested) and the index of the block that holds leaf `leaf`. */
function locateFlow(
  model: Extract<RichBlock, { t: "quote" }>,
  leaf: number,
): { parent: Extract<RichBlock, { t: "quote" }>; index: number } | null {
  let n = 0;
  const walk = (
    q: Extract<RichBlock, { t: "quote" }>,
  ): { parent: typeof q; index: number } | null => {
    for (let i = 0; i < q.blocks.length; i++) {
      const b = q.blocks[i] as RichBlock;
      if (!isFlow(b)) continue;
      if (b.t === "quote") {
        const found = walk(b);
        if (found) return found;
        continue;
      }
      const count = leavesOf(b);
      if (leaf < n + count)
        return b.t === "paragraph" || b.t === "heading" ? { parent: q, index: i } : null;
      n += count;
    }
    return null;
  };
  return walk(model);
}

// ---------- link helpers ----------

function linkAt(c: RichInline, offset: number): LinkMark | undefined {
  let pos = 0;
  for (const s of c) {
    const len = s.k === "text" ? s.text.length : 1;
    if (offset >= pos && offset <= pos + len && s.k !== "br" && s.m.link) return s.m.link;
    pos += len;
  }
  return undefined;
}

function linkSpan(c: RichInline, offset: number): [number, number] | null {
  const l = linkAt(c, offset);
  if (!l) return null;
  let pos = 0;
  let start = -1;
  let end = -1;
  for (const s of c) {
    const len = s.k === "text" ? s.text.length : 1;
    const inLink = s.k !== "br" && s.m.link === l;
    if (inLink && start === -1 && offset <= pos + len) start = pos;
    if (inLink && start !== -1) end = pos + len;
    if (!inLink && start !== -1 && end !== -1) break;
    pos += len;
  }
  return start === -1 ? null : [start, end];
}

function shortcut(key: string, shift = false): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  return `${mac ? "⌘" : "Ctrl+"}${shift ? (mac ? "⇧" : "Shift+") : ""}${key.toUpperCase()}`;
}

export { ATOM_CHAR, leafRefs };
