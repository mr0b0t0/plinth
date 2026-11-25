// The formatted-text editor on its own (doc-blocks): the DOM walk reads only its allowlist, paste
// is text, links go through the URL check, and Enter, Backspace and Tab act on the model.
import { DOC_DIALECT, type RichBlock, serializeBlock, verifyBlock } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docEnv, docMarkdownTools, isSafeHref, normalizeHref } from "../doc/markdown.ts";
import { FORMAT_LOST, LINK_REFUSED, RichBlockEditor, type RichHost } from "./richblock.ts";

const TOOLS = docMarkdownTools();

function make(block: RichBlock) {
  const host = {
    atom: vi.fn((md: string) => [document.createTextNode(`[atom ${md}]`)]),
    changed: vi.fn(),
    split: vi.fn<RichHost["split"]>(),
    tab: vi.fn(),
    escape: vi.fn(),
    announce: vi.fn(),
    verify: (b: RichBlock) => verifyBlock(b, TOOLS, docEnv("")),
    isSafeHref,
    normalizeHref,
  } satisfies RichHost;
  const r = new RichBlockEditor(document, host, block, { label: "Block 1, paragraph" });
  document.body.append(r.el);
  return { r, host };
}

function caret(node: Node, offset: number, end = offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, end);
  const sel = document.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
}

function key(el: Element, k: string, mods: KeyboardEventInit = {}) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }),
  );
}

const text = (t: string) => ({ k: "text" as const, text: t, m: {} });
const md = (b: RichBlock) => serializeBlock(b, DOC_DIALECT);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RichBlockEditor", () => {
  it("draws atoms by reference, non-editable, and reads them back as written", () => {
    const { r } = make({
      t: "paragraph",
      c: [text("see "), { k: "atom", md: "![i](a.png)", m: {} }, text(" here")],
    });
    const atom = r.editable.querySelector(".plinth-rich__atom") as HTMLElement;
    expect(atom.getAttribute("contenteditable")).toBe("false");
    // A copy of the atom's element is not the atom: only the drawn one is known.
    const forged = atom.cloneNode(true);
    r.editable.append(forged);
    expect(md(r.model)).toBe("see ![i](a.png) here\\[atom !\\[i\\](a.png)\\]");
  });

  it("draws a soft line break as the page's space and reads it back as the line break", () => {
    const { r } = make({
      t: "paragraph",
      c: [text("one line\nthe next"), { k: "text", text: "bold\nlater", m: { strong: true } }],
    });
    const soft = r.editable.querySelectorAll(".plinth-rich__soft");
    expect(soft).toHaveLength(2);
    expect(soft[0]?.textContent).toBe("\n");
    // Untouched, the block reads back as it was: its bytes are kept.
    expect(md(r.model)).toBe("one line\nthe next**bold\nlater**");
    // The caret after a soft line break is in the text that follows it, not in its span.
    r.focus("start");
    const sel = document.getSelection() as Selection;
    const after = soft[0]?.nextSibling as Text;
    caret(after, 0);
    expect(r.selection()?.from).toEqual({ leaf: 0, offset: 9 });
    r.setModel(r.model, { leaf: 0, offset: 9 });
    expect(sel.anchorNode?.parentElement?.classList.contains("plinth-rich__soft")).toBe(false);
    expect(sel.anchorNode?.nodeValue).toBe("the next");
  });

  it("reads a link back only when this editor drew or set it", () => {
    const { r } = make({ t: "paragraph", c: [text("x")] });
    r.editable.innerHTML = '<a href="https://example.com">y</a>';
    expect(md(r.model)).toBe("y");
  });

  it("sets a link with Cmd+K, refusing an address the page would not link", () => {
    const { r, host } = make({ t: "paragraph", c: [text("click here")] });
    caret(r.editable.firstChild as Node, 6, 10);
    key(r.editable, "k", { metaKey: true });
    const input = r.el.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
    expect(input).not.toBeNull();
    // Text with no link yet has nothing to remove.
    const remove = r.el.querySelector('button[aria-label="Remove the link"]') as HTMLElement;
    expect(remove.hidden).toBe(true);
    (input as HTMLInputElement).value = "javascript:alert(1)";
    key(input as HTMLInputElement, "Enter");
    expect(host.announce).toHaveBeenCalledWith(LINK_REFUSED);
    (input as HTMLInputElement).value = "https://example.com/x";
    key(input as HTMLInputElement, "Enter");
    expect(md(r.model)).toBe("click [here](https://example.com/x)");
    const a = r.editable.querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    // On a link, the field offers Remove link.
    caret(a.firstChild as Node, 1, 1);
    key(r.editable, "k", { metaKey: true });
    expect(remove.hidden).toBe(false);
    key(input as HTMLInputElement, "Escape");
    // A link being edited is never followed.
    const followed = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    a.dispatchEvent(followed);
    expect(followed.defaultPrevented).toBe(true);
  });

  it("sets a link to an address with spaces or letters outside ASCII, as the page would", () => {
    for (const [url, href] of [
      ["https://pt.wikipedia.org/wiki/São_Paulo", "https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo"],
      ["https://bücher.de/", "https://xn--bcher-kva.de/"],
      ["https://example.com/a b", "https://example.com/a%20b"],
    ]) {
      const { r, host } = make({ t: "paragraph", c: [text("click here")] });
      caret(r.editable.firstChild as Node, 6, 10);
      key(r.editable, "k", { metaKey: true });
      const input = r.el.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
      (input as HTMLInputElement).value = url as string;
      key(input as HTMLInputElement, "Enter");
      expect(host.announce).not.toHaveBeenCalledWith(FORMAT_LOST);
      expect(md(r.model)).toBe(`click [here](${href})`);
      expect(r.editable.querySelector("a")?.getAttribute("href")).toBe(href);
      r.el.remove();
    }
  });

  it("refuses formatting with nothing selected, and undoes what cannot be kept", () => {
    const { r, host } = make({ t: "paragraph", c: [text("(a)b")] });
    caret(r.editable.firstChild as Node, 1);
    r.toggle("strong");
    expect(host.announce).toHaveBeenCalledWith("Select some text first.");
    // Bold over "bc" in "*ab*c" overlaps the emphasis without nesting in it: no CommonMark form.
    const over = make({ t: "paragraph", c: [{ ...text("ab"), m: { em: true } }, text("c")] });
    const em = over.r.editable.querySelector("em") as HTMLElement;
    const range = document.createRange();
    range.setStart(em.firstChild as Node, 1);
    range.setEnd(over.r.editable.lastChild as Node, 1);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    over.r.toggle("strong");
    expect(over.host.announce).toHaveBeenCalledWith(FORMAT_LOST);
    expect(md(over.r.model)).toBe("*ab*c");
  });

  it("shows no format bar for the text selectText chose, until the selection changes", async () => {
    const { r } = make({ t: "paragraph", c: [text("Untitled document")] });
    const bar = r.el.querySelector<HTMLElement>(".plinth-rich__toolbar") as HTMLElement;
    const settle = async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
    };
    r.selectText();
    await settle();
    expect(document.getSelection()?.toString()).toBe("Untitled document");
    expect(bar.hidden).toBe(true);
    // The selection leaves the block, then the person selects the same text: the bar shows.
    const elsewhere = document.createElement("p");
    elsewhere.textContent = "elsewhere";
    document.body.append(elsewhere);
    caret(elsewhere.firstChild as Node, 2);
    await settle();
    caret(r.editable.firstChild as Node, 0, "Untitled document".length);
    await settle();
    expect(bar.hidden).toBe(false);
  });

  it("Enter in a paragraph hands the two halves to the host", () => {
    const { r, host } = make({ t: "paragraph", c: [text("onetwo")] });
    caret(r.editable.firstChild as Node, 3);
    key(r.editable, "Enter");
    expect(host.split).toHaveBeenCalledWith(
      { t: "paragraph", c: [text("one")] },
      { t: "paragraph", c: [text("two")] },
      // The block as it was, so the host can undo the Enter.
      {
        before: {
          model: { t: "paragraph", c: [text("onetwo")] },
          from: { leaf: 0, offset: 3 },
          to: { leaf: 0, offset: 3 },
        },
      },
    );
  });

  it("Enter in a quote makes a paragraph in it; on an empty last one it leaves the quote", () => {
    const { r, host } = make({ t: "quote", blocks: [{ t: "paragraph", c: [text("ab")] }] });
    caret(r.editable.querySelector("p")?.firstChild as Node, 1);
    key(r.editable, "Enter");
    expect(md(r.model)).toBe("> a\n>\n> b");
    const last = r.editable.querySelectorAll("p")[1] as HTMLElement;
    last.textContent = "";
    caret(last, 0);
    key(r.editable, "Enter");
    expect(host.split).toHaveBeenCalledWith(
      { t: "quote", blocks: [{ t: "paragraph", c: [text("a")] }] },
      { t: "paragraph", c: [] },
      { before: expect.objectContaining({ from: { leaf: 1, offset: 0 } }) },
    );
  });

  it("Backspace in an empty last item leaves the list", () => {
    const { r, host } = make({
      t: "bullet",
      marker: "-",
      tight: true,
      items: [{ blocks: [{ t: "paragraph", c: [text("a")] }] }, { blocks: [] }],
    });
    const empty = r.editable.querySelectorAll("li")[1]?.querySelector("p") as HTMLElement;
    caret(empty, 0);
    key(r.editable, "Backspace");
    expect(host.split).toHaveBeenCalledWith(
      {
        t: "bullet",
        marker: "-",
        tight: true,
        items: [{ blocks: [{ t: "paragraph", c: [text("a")] }] }],
      },
      { t: "paragraph", c: [] },
      { before: expect.objectContaining({ from: { leaf: 1, offset: 0 } }) },
    );
  });

  it("indents at most three levels", () => {
    const item = (t: string) => ({ blocks: [{ t: "paragraph" as const, c: [text(t)] }] });
    const { r, host } = make({
      t: "bullet",
      marker: "-",
      tight: true,
      items: [item("a"), item("b"), item("c"), item("d")],
    });
    for (let i = 1; i <= 3; i++) {
      const p = r.editable.querySelectorAll("p")[i] as HTMLElement;
      caret(p.firstChild as Node, 0);
      for (let n = 0; n < i; n++) key(r.editable, "Tab");
    }
    expect(md(r.model)).toBe("- a\n  - b\n    - c\n    - d");
    expect(host.announce).toHaveBeenCalledWith("Lists go three levels deep.");
  });

  it("pastes plain text, on one line in a heading", () => {
    const { r } = make({ t: "heading", level: 2, setext: false, c: [text("Title")] });
    caret(r.editable.firstChild as Node, 5);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (t: string) => (t === "text/plain" ? " one\ntwo" : "<h1>x</h1>") },
    });
    r.editable.dispatchEvent(paste);
    expect(md(r.model)).toBe("## Title one two");
  });

  const paste = (target: Element, plain: string) => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { getData: (t: string) => (t === "text/plain" ? plain : "") },
    });
    target.dispatchEvent(e);
  };

  it("pastes several paragraphs as blocks of their own, around the caret", () => {
    const { r, host } = make({ t: "paragraph", c: [text("Startend")] });
    caret(r.editable.firstChild as Node, 5);
    paste(r.editable, " one\ncontinued\n\n\ntwo\r\n\r\nthree ");
    expect(host.split).toHaveBeenCalledTimes(1);
    const [keep, next, more] = host.split.mock.calls[0] as Parameters<RichHost["split"]>;
    expect(md(keep)).toBe("Start one\ncontinued");
    expect(more?.between?.map(md)).toEqual(["two"]);
    expect(md(next as RichBlock)).toBe("three end");
    // The caret goes after the pasted text, before what followed it.
    expect(more?.caret).toBe("three ".length);
    expect(more?.before?.model).toEqual({ t: "paragraph", c: [text("Startend")] });
  });

  it("pastes several paragraphs into a list as items, and into a quote as paragraphs", () => {
    const list = make({
      t: "bullet",
      marker: "-",
      tight: true,
      items: [{ blocks: [{ t: "paragraph", c: [text("ab")] }] }],
    });
    caret(list.r.editable.querySelector("p")?.firstChild as Node, 1);
    paste(list.r.editable, "x\n\ny\n\nz");
    expect(md(list.r.model)).toBe("- ax\n- y\n- zb");
    expect(list.host.split).not.toHaveBeenCalled();
    const quote = make({ t: "quote", blocks: [{ t: "paragraph", c: [text("ab")] }] });
    caret(quote.r.editable.querySelector("p")?.firstChild as Node, 2);
    paste(quote.r.editable, "x\n\ny");
    expect(md(quote.r.model)).toBe("> abx\n>\n> y");
    // One paragraph stays one, its line breaks soft.
    const one = make({ t: "paragraph", c: [text("a")] });
    caret(one.r.editable.firstChild as Node, 1);
    paste(one.r.editable, "b\nc");
    expect(md(one.r.model)).toBe("ab\nc");
    expect(one.host.split).not.toHaveBeenCalled();
  });

  it("keeps a multi-paragraph paste in a table cell on one line", () => {
    const { r, host } = make({
      t: "table",
      align: [null],
      head: [[text("h")]],
      rows: [[[text("c")]]],
    });
    const cell = r.editable.querySelectorAll("td, th")[1] as HTMLElement;
    caret(cell.firstChild as Node, 1);
    paste(r.editable, "x\n\ny");
    expect(host.split).not.toHaveBeenCalled();
    expect(md(r.model)).toBe("| h |\n| --- |\n| cx y |");
  });

  it("undoes and redoes formatting, Enter in a list, Tab and paste, each whole", () => {
    const item = (t: string) => ({ blocks: [{ t: "paragraph" as const, c: [text(t)] }] });
    const { r } = make({
      t: "bullet",
      marker: "-",
      tight: true,
      items: [item("one"), item("two")],
    });
    const undo = () => key(r.editable, "z", { metaKey: true });
    const redo = () => key(r.editable, "z", { metaKey: true, shiftKey: true });
    const p = () => r.editable.querySelectorAll("p");
    // Bold.
    caret(p()[0]?.firstChild as Node, 0, 3);
    r.toggle("strong");
    expect(md(r.model)).toBe("- **one**\n- two");
    // Tab.
    caret(p()[1]?.firstChild as Node, 0);
    key(r.editable, "Tab");
    expect(md(r.model)).toBe("- **one**\n  - two");
    // Enter in an item.
    caret(p()[1]?.firstChild as Node, 1);
    key(r.editable, "Enter");
    expect(md(r.model)).toBe("- **one**\n  - t\n  - wo");
    // Paste.
    caret(p()[2]?.firstChild as Node, 2);
    paste(r.editable, "x\n\ny");
    expect(md(r.model)).toBe("- **one**\n  - t\n  - wox\n  - y");
    undo();
    expect(md(r.model)).toBe("- **one**\n  - t\n  - wo");
    undo();
    expect(md(r.model)).toBe("- **one**\n  - two");
    undo();
    expect(md(r.model)).toBe("- **one**\n- two");
    undo();
    expect(md(r.model)).toBe("- one\n- two");
    redo();
    redo();
    expect(md(r.model)).toBe("- **one**\n  - two");
    // The browser's own history events go the same way.
    const e = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    r.editable.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(md(r.model)).toBe("- **one**\n- two");
  });

  it("undoes a line break and a link, and asks the host once nothing is left", () => {
    const { r, host } = make({ t: "paragraph", c: [text("click here")] });
    const undoHost = vi.fn(() => true);
    (host as RichHost).undo = undoHost;
    caret(r.editable.firstChild as Node, 6, 10);
    key(r.editable, "k", { metaKey: true });
    const input = r.el.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
    (input as HTMLInputElement).value = "https://example.com";
    key(input as HTMLInputElement, "Enter");
    expect(md(r.model)).toBe("click [here](https://example.com)");
    caret(r.editable.firstChild as Node, 5);
    key(r.editable, "Enter", { shiftKey: true });
    expect(md(r.model)).toBe("click\\\n[here](https://example.com)");
    key(r.editable, "z", { metaKey: true });
    expect(md(r.model)).toBe("click [here](https://example.com)");
    key(r.editable, "z", { metaKey: true });
    expect(md(r.model)).toBe("click here");
    expect(undoHost).not.toHaveBeenCalled();
    key(r.editable, "z", { metaKey: true });
    expect(undoHost).toHaveBeenCalledTimes(1);
  });

  it("makes one undo step of a run of typing", () => {
    const { r } = make({ t: "paragraph", c: [text("a")] });
    const t = r.editable.firstChild as Text;
    const type = (ch: string) => {
      r.editable.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true }),
      );
      t.data += ch;
    };
    type("b");
    type("c");
    expect(md(r.model)).toBe("abc");
    key(r.editable, "z", { metaKey: true });
    expect(md(r.model)).toBe("a");
    key(r.editable, "z", { metaKey: true, shiftKey: true });
    expect(md(r.model)).toBe("abc");
  });

  it("drops the browser's own formatting and drops", () => {
    const { r } = make({ t: "paragraph", c: [text("x")] });
    for (const inputType of ["formatBold", "insertFromDrop", "insertLink"]) {
      const e = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      r.editable.dispatchEvent(e);
      expect(e.defaultPrevented, inputType).toBe(true);
    }
  });
});
