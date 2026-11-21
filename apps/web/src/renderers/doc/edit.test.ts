// The on-page editor (doc-blocks): a block opens as formatted text, with no Markdown shown, drawn
// with createElement after the page was sanitized; typing is sent at most every 250 ms, written
// back as Markdown by the serializer; Esc gives the block back; Cmd/Ctrl+S goes to the app; blocks
// other people hold show who holds them; the block menu turns, inserts, moves and deletes blocks;
// blocks the model cannot show are read-only with Ask an agent; images keep their bytes.
import { LIMITS } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRescue, mergeRescue } from "../../components/editor/draft.ts";
import { readRescueItems } from "../../components/viewer/rendererProtocol.ts";
import type { ClientLease, LeaseDenial, LeaseLoss } from "../common/live.ts";
import { FORMAT_LOST, type RichBlockEditor } from "../common/richblock.ts";
import {
  blockWords,
  CLEAR_REFUSED,
  composeBlock,
  DOC_FULL,
  DocEditor,
  EDIT_DEBOUNCE_MS,
  JOINED_BLOCKS,
  LocalDoc,
  NOT_SENT,
  padded,
  READ_ONLY_NOTE,
  REFUSED_EDIT,
  RESCUE_FRAME_ONLY,
  RESCUE_STUCK,
  RESCUE_WAITS,
  type RescueReport,
  TAKEN_KEPT,
  TOO_LONG,
  UNSAVABLE,
  unpadded,
} from "./edit.ts";

let root: HTMLElement;
let save: ReturnType<typeof vi.fn<() => void>>;
let ask: ReturnType<typeof vi.fn<(a: { key: string; text: string }, what: string) => void>>;

function setup(text: string, extra: Record<string, unknown> = {}) {
  const events = {
    granted: (l: ClientLease) => editor.granted(l),
    changed: () => editor.changed(),
  };
  const local = new LocalDoc(text, events);
  const editor: DocEditor = new DocEditor(root, window, local, {
    save,
    status: () => undefined,
    ask,
    ...extra,
  });
  editor.setEditing(true);
  return { local, editor };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function key(el: Element, k: string, mods: KeyboardEventInit = {}) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }),
  );
}

/** The open block's editor. */
function rich(editor: DocEditor): RichBlockEditor {
  const r = editor.openEditor;
  if (!r) throw new Error("no open block");
  return r;
}

/** Types into the open block's text as a browser would: the DOM changes, then `input`. */
function typeText(el: HTMLElement, text: string) {
  el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Selects [from, to) of a text node (or of an element's first text node). */
function select(node: Node, from: number, to = from) {
  const text = node.nodeType === 3 ? node : (node.firstChild as Node);
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const sel = document.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The item labelled `label` in the open block menu (in the sub-menu `group` when named). */
function menuItem(label: string, group?: string): HTMLElement {
  const scope = group
    ? [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu [role='group']")].find(
        (g) => g.getAttribute("aria-label") === group,
      )
    : document.querySelector<HTMLElement>(".plinth-doc__menu");
  const item = [...(scope?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])].find(
    (i) => i.textContent === label,
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

/**
 * Opens the block menu of the open (or selected) block and runs the item `label`, in the
 * sub-menu `group` ("Turn into", "Insert below") when one is named.
 */
function menu(label: string, group?: string) {
  const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
  if (!button) throw new Error("no menu button");
  click(button);
  if (group) click(menuItem(group));
  click(menuItem(label, group));
}

/** Opens the block menu's "Insert below", "Table" form and inserts a `rows` by `cols` table. */
function insertTable(rows: number, cols: number) {
  const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
  if (!button) throw new Error("no menu button");
  click(button);
  click(menuItem("Insert below"));
  click(menuItem("Table", "Insert below"));
  const inputs = document.querySelectorAll<HTMLInputElement>(".plinth-doc__menu-table input");
  (inputs[0] as HTMLInputElement).value = String(rows);
  (inputs[1] as HTMLInputElement).value = String(cols);
  click(menuItem("Insert table", "Table"));
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("main");
  root.id = "__plinth-doc";
  document.body.append(root);
  save = vi.fn<() => void>();
  ask = vi.fn<(a: { key: string; text: string }, what: string) => void>();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("DocEditor: formatted text", () => {
  it("opens a block as formatted text with no Markdown, the sanitized page around it", () => {
    const { editor } = setup("# Title\n\nA **bold** <img src=x onerror=alert(1)> para\n\nLast");
    // The page around the block is the sanitized render: the tag shows as text.
    expect(root.querySelector("img")).toBeNull();
    click(root.querySelector("p") as Element);
    const el = rich(editor).editable;
    expect(el.tagName).toBe("P");
    expect(el.getAttribute("contenteditable")).toBe("true");
    expect(el.getAttribute("role")).toBe("textbox");
    // Bold is shown bold; no ** and no tag in the text, and still no element from the source.
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.textContent).toBe("A bold <img src=x onerror=alert(1)> para");
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).not.toContain("**");
  });

  it("sends the block at most every 250 ms while typing, as Markdown", () => {
    const { local, editor } = setup("one\n\ntwo");
    const edit = vi.spyOn(local, "edit");
    click(root.querySelector("p") as Element);
    const el = rich(editor).editable;
    typeText(el, "o");
    typeText(el, "on");
    typeText(el, "one *really*!");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS - 1);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    // What a person types is text: the asterisks stay asterisks.
    expect(local.text).toBe("one \\*really\\*!\n\ntwo");
    expect(local.dirty).toBe(true);
  });

  it("formats with the toolbar and gives the block back on Escape", () => {
    const { local, editor } = setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    const r = rich(editor);
    typeText(r.editable, "two, edited");
    select(r.editable, 5, 11);
    click(r.el.querySelector(".plinth-rich__fmt-strong") as Element);
    expect(r.editable.querySelector("strong")?.textContent).toBe("edited");
    key(r.editable, "Escape");
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
    expect(local.text).toBe("one\n\ntwo, **edited**");
    expect(root.querySelectorAll("p")[1]?.querySelector("strong")?.textContent).toBe("edited");
  });

  it("formats with the keyboard: bold, italic, code and strikethrough", () => {
    const { local, editor } = setup("alpha beta gamma delta");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 0, 5);
    key(r.editable, "b", { metaKey: true });
    // The text nodes were drawn again: select by the model's offsets.
    const text = () => {
      const walker = document.createTreeWalker(r.editable, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      return nodes;
    };
    select(text()[1] as Text, 1, 5);
    key(r.editable, "i", { ctrlKey: true });
    select(text().at(-1) as Text, 7, 12);
    key(r.editable, "x", { metaKey: true, shiftKey: true });
    key(r.editable, "Escape");
    expect(local.text).toBe("**alpha** *beta* gamma ~~delta~~");
  });

  it("undoes a formatting command the serializer cannot keep, and says so", () => {
    // Bold over "bc" in "*ab*c" overlaps the emphasis without nesting in it: no CommonMark form.
    const { local, editor } = setup("*ab*c");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    const em = r.editable.querySelector("em") as HTMLElement;
    const range = document.createRange();
    range.setStart(em.firstChild as Text, 1);
    range.setEnd(r.editable.lastChild as Text, 1);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    key(r.editable, "b", { metaKey: true });
    expect(r.editable.querySelector("strong")).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(FORMAT_LOST);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("*ab*c");
  });

  it("bolds text that ends in punctuation right before a letter", () => {
    const { local, editor } = setup("(a)b");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 0, 3);
    key(r.editable, "b", { metaKey: true });
    expect(r.editable.querySelector("strong")?.textContent).toBe("(a)");
    key(r.editable, "Escape");
    expect(local.text).toBe("**(a)**&#x62;");
    expect(root.querySelector("p strong")?.textContent).toBe("(a)");
    expect(root.querySelector("p")?.textContent).toBe("(a)b");
  });

  it("reads only the allowlist back from the DOM: anything else counts as its text", () => {
    const { local, editor } = setup("plain");
    click(root.querySelector("p") as Element);
    const el = rich(editor).editable;
    // What a browser (or an extension) might leave in a contenteditable.
    el.innerHTML =
      'a<img src="x" onerror="alert(1)"><b>b</b><font color="red">c</font><span style="font-weight:bold">d</span><script>x</script><a href="javascript:alert(1)">e</a>';
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("a**b**cdxe");
  });

  it("pastes plain text only", () => {
    const { local, editor } = setup("one");
    click(root.querySelector("p") as Element);
    const el = rich(editor).editable;
    select(el, 3);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (t: string) =>
          t === "text/plain" ? " <b>two</b> **three**" : "<b>two</b><img src=x onerror=alert(1)>",
      },
    });
    el.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(el.querySelector("b, img")).toBeNull();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("one \\<b>two\\</b> \\*\\*three\\*\\*");
  });

  it("keeps a typed URL as text, so it becomes a link when the block renders again", () => {
    const { local, editor } = setup("one");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "see https://example.com/a_b*c");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("see https://example.com/a_b*c");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a_b*c");
  });

  it("moves to the next block with Tab", () => {
    const { editor } = setup("one\n\ntwo\n\nthree");
    click(root.querySelector("p") as Element);
    key(rich(editor).editable, "Tab");
    expect(rich(editor).editable.textContent).toBe("two");
  });

  it("Tab in the last block (Shift+Tab in the first) closes it and keeps focus on that block", () => {
    const { editor } = setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    key(rich(editor).editable, "Tab");
    expect(editor.openEditor).toBeNull();
    expect(document.activeElement).toBe(root.querySelectorAll("p")[1]);
    click(root.querySelector("p") as Element);
    key(rich(editor).editable, "Tab", { shiftKey: true });
    expect(editor.openEditor).toBeNull();
    expect(document.activeElement).toBe(root.querySelector("p"));
  });

  it("posts save to the app on Cmd/Ctrl+S, after sending the pending block", () => {
    const { local, editor } = setup("one");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "uno");
    key(rich(editor).editable, "s", { metaKey: true });
    expect(local.text).toBe("uno");
    expect(save).toHaveBeenCalledTimes(1);
    key(document.body, "s", { ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("adds a paragraph between two with Insert below, keeping blank lines around it", () => {
    const { local, editor } = setup("one\n\ntwo");
    // No "+" between blocks: Insert below and Enter at a block's end are the ways in.
    expect(root.querySelector("button")).toBeNull();
    click(root.querySelector("p") as Element);
    menu("Paragraph", "Insert below");
    const el = rich(editor).editable;
    expect(el.textContent).toBe("");
    typeText(el, "between");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("one\n\nbetween\n\ntwo");
    expect(padded("x", { before: true, after: true })).toBe("\nx\n");
    expect(unpadded("\nx\n", { before: true, after: true })).toBe("x");
  });

  it("Enter splits a paragraph into two blocks and opens the second", () => {
    const { local, editor } = setup("onetwo\n\nlast");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 3);
    key(r.editable, "Enter");
    expect(local.text).toBe("one\n\ntwo\n\nlast");
    expect(rich(editor).editable.textContent).toBe("two");
    // Enter at the end of a block opens an empty paragraph below it.
    const again = rich(editor);
    select(again.editable, 3);
    key(again.editable, "Enter");
    const fresh = rich(editor);
    expect(fresh.editable.textContent).toBe("");
    typeText(fresh.editable, "three");
    key(fresh.editable, "Escape");
    expect(local.text).toBe("one\n\ntwo\n\nthree\n\nlast");
  });

  it("Shift+Enter is a line break inside the block", () => {
    const { local, editor } = setup("onetwo");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 3);
    key(r.editable, "Enter", { shiftKey: true });
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("one\\\ntwo");
  });

  it("typing sent as a block closes moves the lines: the next block, Enter or Tab still lands right", () => {
    const { local, editor } = setup("onetwo\n\nb\n\nc");
    const lineBreak = () => {
      click(root.querySelector("p") as Element);
      select(rich(editor).editable, 3);
      key(rich(editor).editable, "Enter", { shiftKey: true });
    };
    // A click on a block below, before the pause: the block above gains a line as it closes.
    lineBreak();
    click(root.querySelectorAll("p")[2] as Element);
    expect(rich(editor).editable.textContent).toBe("c");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("one\\\ntwo\n\nb\n\nc");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "onetwo");
    key(rich(editor).editable, "Escape");
    // Enter at the end of a block further down, the same way.
    lineBreak();
    click(root.querySelectorAll("p")[1] as Element);
    expect(rich(editor).editable.textContent).toBe("b");
    select(rich(editor).editable, 1);
    key(rich(editor).editable, "Enter");
    typeText(rich(editor).editable, "new");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("one\\\ntwo\n\nb\n\nnew\n\nc");
    // Tab from a new block typed into: the block after it, not the new one.
    click(root.querySelector("p") as Element);
    menu("Paragraph", "Insert below");
    typeText(rich(editor).editable, "x");
    key(rich(editor).editable, "Tab");
    expect(rich(editor).editable.textContent).toBe("b");
    expect(local.text).toBe("one\\\ntwo\n\nx\n\nb\n\nnew\n\nc");
  });

  it("an Enter the doc has no room for keeps the block open with its text and says so", () => {
    const filler = "x".repeat(LIMITS.maxDocBytes - 20);
    const doc = `one two\n\nthree\n\n${filler}`;
    const { local, editor } = setup(doc);
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    typeText(r.editable, "one two and more words");
    select(r.editable, 3);
    key(r.editable, "Enter");
    expect(local.text).toBe(doc);
    // The same block is still open, with what was typed, and nothing else opened.
    expect(editor.openEditor).toBe(r);
    expect(r.editable.textContent).toBe("one two and more words");
    expect(local.mine).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(DOC_FULL);
  });

  it("an Enter whose edit is not sent keeps the typing, and sends it once it can", () => {
    const { local, editor } = setup("one two\n\nthree");
    const edit = vi.spyOn(local, "edit").mockReturnValue(false);
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    typeText(r.editable, "one two more");
    select(r.editable, 3);
    key(r.editable, "Enter");
    expect(local.text).toBe("one two\n\nthree");
    expect(editor.openEditor).toBe(r);
    expect(r.editable.textContent).toBe("one two more");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Not connected");
    // Back online: the block is still pending, so Escape sends it as typed (not split).
    edit.mockRestore();
    key(r.editable, "Escape");
    expect(local.text).toBe("one two more\n\nthree");
  });

  it("an Enter in a block over one frame keeps it open and says so", () => {
    const long = "word ".repeat(Math.ceil(LIMITS.liveDocFrameBytes / 5)).trim();
    const { local, editor } = setup(`${long}\n\nthree`);
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 4);
    key(r.editable, "Enter");
    expect(local.text).toBe(`${long}\n\nthree`);
    expect(editor.openEditor).toBe(r);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(TOO_LONG);
  });

  it("Enter at the start of a block keeps what was typed in it", () => {
    const { local, editor } = setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    typeText(r.editable, "one more");
    select(r.editable, 0);
    key(r.editable, "Enter");
    const fresh = rich(editor);
    expect(fresh).not.toBe(r);
    typeText(fresh.editable, "above");
    key(fresh.editable, "Escape");
    expect(local.text).toBe("above\n\none more\n\ntwo");
  });

  it("typing the doc has no room for says so", () => {
    const filler = "x".repeat(LIMITS.maxDocBytes - 10);
    const { local, editor } = setup(`one\n\n${filler}`);
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "one and a lot more words");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe(`one\n\n${filler}`);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(DOC_FULL);
  });

  it("in a list, Enter makes an item, Tab indents and Shift+Tab outdents", () => {
    const { local, editor } = setup("- one\n- two");
    click(root.querySelector("ul") as Element);
    const r = rich(editor);
    const second = r.editable.querySelectorAll("li")[1]?.querySelector("p") as HTMLElement;
    select(second, 3);
    key(r.editable, "Enter");
    expect(r.editable.querySelectorAll("li").length).toBe(3);
    const third = r.editable.querySelectorAll("li")[2]?.querySelector("p") as HTMLElement;
    third.textContent = "three";
    select(third, 0);
    key(r.editable, "Tab");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("- one\n- two\n  - three");
    const nested = r.editable.querySelector("li li p") as HTMLElement;
    select(nested, 0);
    key(r.editable, "Tab", { shiftKey: true });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("- one\n- two\n- three");
  });

  it("keeps a numbered list's start and delimiter", () => {
    const { local, editor } = setup("3) three\n4) four");
    click(root.querySelector("ol") as Element);
    const p = rich(editor).editable.querySelector("li p") as HTMLElement;
    typeText(p, "drei");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("3) drei\n4) four");
  });

  it("edits a table cell by cell, keeping the alignment", () => {
    const { local, editor } = setup("| a | b |\n| :-- | --: |\n| 1 | 2 |");
    click(root.querySelector(".plinth-doc__table") as Element);
    const cells = rich(editor).editable.querySelectorAll<HTMLElement>("th, td");
    expect(cells.length).toBe(4);
    typeText(cells[3] as HTMLElement, "x | y");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("| a | b |\n| :-- | --: |\n| 1 | x \\| y |");
  });

  it("keeps the reference definitions that follow a block, byte for byte", () => {
    const { local, editor } = setup(
      "See [the site][r].\n\n[r]:   https://example.com  'T'\n\nNext",
    );
    click(root.querySelector("p") as Element);
    const el = rich(editor).editable;
    // A reference link is kept whole, as written, and cannot be changed in place.
    const atom = el.querySelector(".plinth-rich__atom") as HTMLElement;
    expect(atom.getAttribute("contenteditable")).toBe("false");
    expect(atom.querySelector("a")?.textContent).toBe("the site");
    (el.firstChild as Text).nodeValue = "Look at ";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    key(el, "Escape");
    expect(local.text).toBe("Look at [the site][r].\n\n[r]:   https://example.com  'T'\n\nNext");
  });

  it("writes a leading < of any block as \\<, which renders the same and can become first", () => {
    const { local, editor } = setup("Intro\n\nText");
    click(root.querySelectorAll("p")[1] as Element);
    typeText(rich(editor).editable, "<html> basics");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("Intro\n\n\\<html> basics");
    expect(root.querySelectorAll("p")[1]?.textContent).toBe("<html> basics");
    // Deleting the first block leaves an escaped block first: still a doc.
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("\\<html> basics");
  });

  it("a change that would make the doc start like a web page is not kept, and says why", () => {
    // An agent wrote a second block that starts like an HTML document.
    const { local, editor } = setup("Intro\n\n<html> basics");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    typeText(r.editable, "");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    // Not applied: the block is back as the doc has it, still open, with the reason.
    expect(local.text).toBe("Intro\n\n<html> basics");
    expect(rich(editor).editable.textContent).toBe("Intro");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(REFUSED_EDIT);
  });

  it("deleting the block above an agent's <html> block writes that block escaped too", () => {
    const { local } = setup("Intro\n\n<html> basics\n\nmore");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("\\<html> basics\n\nmore");
  });

  it("a refusal from the room puts the block back from the room's lines", () => {
    const { editor } = setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "changed");
    editor.refused(REFUSED_EDIT);
    expect(rich(editor).editable.textContent).toBe("one");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(REFUSED_EDIT);
  });
});

describe("DocEditor: the block menu", () => {
  it("opened with a pointer, shows no focus ring until a key is pressed in it", () => {
    setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    const button = document.querySelector(".plinth-doc__menu-button") as HTMLElement;
    // A mouse or touch click (detail 1): the first item has focus, drawn without its ring.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    const panel = document.querySelector(".plinth-doc__menu") as HTMLElement;
    expect(panel.classList.contains("plinth-doc__menu--pointer")).toBe(true);
    expect(document.activeElement).toBe(menuItem("Turn into"));
    key(panel, "ArrowDown");
    expect(panel.classList.contains("plinth-doc__menu--pointer")).toBe(false);
    expect(document.activeElement).toBe(menuItem("Insert below"));
    key(panel, "Escape");
    // Enter or Space on the button (a click with detail 0) keeps the ring from the start.
    click(button);
    const again = document.querySelector(".plinth-doc__menu") as HTMLElement;
    expect(again.classList.contains("plinth-doc__menu--pointer")).toBe(false);
  });

  it("puts the block's corner on its top edge, or its bottom edge when there is no room above", () => {
    const top = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    try {
      setup("one\n\ntwo");
      top.mockReturnValue(new DOMRect(0, 200, 600, 40));
      click(root.querySelectorAll("p")[1] as Element);
      const open = document.querySelector(".plinth-doc__open") as HTMLElement;
      // The rest of the time an open block shows only its corner: the block menu.
      const corner = open.querySelector(":scope > .plinth-rich__corner") as HTMLElement;
      expect(corner.children).toHaveLength(1);
      expect(corner.firstElementChild?.getAttribute("aria-label")).toBe("Block actions");
      expect(open.classList.contains("plinth-rich--below")).toBe(false);
      top.mockReturnValue(new DOMRect(0, 4, 600, 40));
      click(root.querySelector("p") as Element);
      const first = document.querySelector(".plinth-doc__open") as HTMLElement;
      expect(first).not.toBe(open);
      expect(first.classList.contains("plinth-rich--below")).toBe(true);
    } finally {
      top.mockRestore();
    }
  });

  it("keeps the block menu inside the frame: below its button, else above, else as low as fits", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    try {
      setup("one\n\ntwo");
      click(root.querySelector("p") as Element);
      const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(
        -1,
      ) as HTMLElement;
      height.mockReturnValue(300);
      const vh = window.innerHeight;
      // Every box sits where the button is, so `top` reads from the button's own top.
      const at = (y: number) => rect.mockReturnValue(new DOMRect(500, y, 24, 24));
      const top = () => (document.querySelector(".plinth-doc__menu") as HTMLElement).style.top;
      at(100);
      click(button);
      expect(top()).toBe("28px");
      key(document.querySelector(".plinth-doc__menu") as Element, "Escape");
      // No room below: above the button.
      at(vh - 50);
      click(button);
      expect(top()).toBe("-304px");
      // Opening a sub-menu places it again: room on neither side, so as low as it fits.
      height.mockReturnValue(vh - 100);
      at(300);
      click(menuItem("Insert below"));
      expect(top()).toBe(`${vh - 8 - (vh - 100) - 300}px`);
    } finally {
      rect.mockRestore();
      height.mockRestore();
    }
  });

  it("opens the link field under the text it links, inside the block's column", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const style = document.createElement("style");
    style.textContent = ".plinth-rich__link { position: absolute; }";
    document.head.append(style);
    try {
      const { editor } = setup("one two three");
      click(root.querySelector("p") as Element);
      const r = rich(editor);
      rect.mockReturnValue(new DOMRect(100, 200, 400, 40));
      select(r.editable, 0, 3);
      document.dispatchEvent(new Event("selectionchange"));
      key(r.editable, "k", { metaKey: true });
      const link = r.el.querySelector(":scope > .plinth-rich__link") as HTMLElement;
      expect(link.hidden).toBe(false);
      // 4px under the text's bottom edge, from its left edge.
      expect(link.style.top).toBe("44px");
      expect(link.style.left).toBe("0px");
      // It comes after the text, where it docks at phone width.
      expect(r.editable.nextElementSibling).toBe(link);
    } finally {
      rect.mockRestore();
      style.remove();
    }
  });

  it("scrolls a block opened below the frame into view, with its corner", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    try {
      setup("one\n\ntwo");
      rect.mockReturnValue(new DOMRect(0, window.innerHeight + 100, 600, 40));
      click(root.querySelectorAll("p")[1] as Element);
      await Promise.resolve();
      expect(scroll).toHaveBeenCalledWith(0, 156);
    } finally {
      rect.mockRestore();
      scroll.mockRestore();
    }
  });

  it("shows the format bar only while text is selected, and never in a code block", () => {
    const { editor } = setup("one two\n\n```\ncode\n```");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    const bar = r.el.querySelector(":scope > .plinth-rich__toolbar") as HTMLElement;
    expect(bar.getAttribute("aria-label")).toBe("Formatting");
    const change = () => document.dispatchEvent(new Event("selectionchange"));
    select(r.editable, 2);
    change();
    expect(bar.hidden).toBe(true);
    select(r.editable, 0, 3);
    change();
    expect(bar.hidden).toBe(false);
    expect(r.formatting).toBe(true);
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "B",
      "I",
      "</>",
      "S",
      "Link",
    ]);
    // The link field takes its place while it is open.
    key(r.editable, "k", { metaKey: true });
    const link = r.el.querySelector(":scope > .plinth-rich__link") as HTMLElement;
    expect(link.hidden).toBe(false);
    expect(bar.hidden).toBe(true);
    key(link.querySelector("input") as HTMLElement, "Escape");
    expect(link.hidden).toBe(true);
    select(r.editable, 3);
    change();
    expect(bar.hidden).toBe(true);
    key(r.editable, "Escape");
    click(root.querySelector("pre") as Element);
    const code = rich(editor);
    select(code.editable.querySelector("code") as Node, 0, 2);
    change();
    expect((code.el.querySelector(":scope > .plinth-rich__toolbar") as HTMLElement).hidden).toBe(
      true,
    );
  });

  it("turns a block into another kind, keeping its text and marks", () => {
    const { local, editor } = setup("one *two*\n\nnext");
    click(root.querySelector("p") as Element);
    menu("Heading 2", "Turn into");
    expect(local.text).toBe("## one *two*\n\nnext");
    menu("Bulleted list", "Turn into");
    expect(local.text).toBe("- one *two*\n\nnext");
    menu("Quote", "Turn into");
    expect(local.text).toBe("> one *two*\n\nnext");
    menu("Code block", "Turn into");
    expect(local.text).toBe("```\none two\n```\n\nnext");
    expect(rich(editor).kind).toBe("code");
    menu("Paragraph", "Turn into");
    expect(local.text).toBe("one two\n\nnext");
  });

  it("inserts a block of a kind below, a divider, and a table of a chosen size", () => {
    const { local, editor } = setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    menu("Numbered list", "Insert below");
    const p = rich(editor).editable.querySelector("li p") as HTMLElement;
    typeText(p, "first");
    key(p, "Escape");
    expect(local.text).toBe("one\n\n1. first\n\ntwo");
    click(root.querySelector("ol") as Element);
    menu("Divider", "Insert below");
    expect(local.text).toBe("one\n\n1. first\n\n---\n\ntwo");
    click(root.querySelector("p") as Element);
    insertTable(1, 3);
    expect(local.text).toBe(
      "one\n\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n\n1. first\n\n---\n\ntwo",
    );
    // The new table opens for editing.
    expect(rich(editor).kind).toBe("table");
  });

  it("does not join a new list to the list next to it", () => {
    const { local, editor } = setup("- a\n- b");
    click(root.querySelector("ul") as Element);
    menu("Bulleted list", "Insert below");
    typeText(rich(editor).editable.querySelector("li p") as HTMLElement, "c");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("- a\n- b\n\n* c");
    expect(root.querySelectorAll("ul").length).toBe(2);
  });

  it("refuses a Turn into a list that would take in the indented block below", () => {
    // A list there would continue into the code block, which would render inside its item.
    const { local, editor } = setup("para\n\n    code line");
    click(root.querySelector("p") as Element);
    menu("Bulleted list", "Turn into");
    expect(local.text).toBe("para\n\n    code line");
    expect(rich(editor).kind).toBe("paragraph");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("para\n\n    code line");
    expect(root.querySelector("pre")).not.toBeNull();
  });

  it("refuses an Insert below of a list that would take in the indented block below", () => {
    const { local, editor } = setup("para\n\n    code line");
    click(root.querySelector("p") as Element);
    menu("Bulleted list", "Insert below");
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
    expect(local.text).toBe("para\n\n    code line");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    expect(root.querySelector("pre")).not.toBeNull();
  });

  it("refuses a Turn into a numbered list when both delimiters are taken around it", () => {
    const { local, editor } = setup("1. a\n\nmid\n\n1) b");
    click(root.querySelector("p") as Element);
    menu("Numbered list", "Turn into");
    expect(local.text).toBe("1. a\n\nmid\n\n1) b");
    expect(rich(editor).kind).toBe("paragraph");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    key(rich(editor).editable, "Escape");
    expect(root.querySelectorAll("ol").length).toBe(2);
  });

  it("refuses an Insert below of a numbered list when both delimiters are taken around it", () => {
    const { local, editor } = setup("1. a\n\n1) b");
    click(root.querySelector("ol") as Element);
    menu("Numbered list", "Insert below");
    expect(editor.openEditor).toBeNull();
    expect(local.text).toBe("1. a\n\n1) b");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    expect(root.querySelectorAll("ol").length).toBe(2);
  });

  it("refuses a Turn into of a new empty block that would join the block below once typed", () => {
    const { local, editor } = setup("para\n\n    code line");
    click(root.querySelector("p") as Element);
    menu("Paragraph", "Insert below");
    expect(rich(editor).kind).toBe("paragraph");
    menu("Bulleted list", "Turn into");
    expect(rich(editor).kind).toBe("paragraph");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    typeText(rich(editor).editable, "new");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("para\n\nnew\n\n    code line");
    expect(root.querySelector("pre")).not.toBeNull();
  });

  it("moves a block up and down, keeping every block's bytes", () => {
    const { local } = setup("# A\n\n1)  x\n\n*c*");
    click(root.querySelector("ol") as Element);
    menu("Move up");
    expect(local.text).toBe("1)  x\n\n# A\n\n*c*");
    click(root.querySelector("ol") as Element);
    menu("Move down");
    click(root.querySelector("ol") as Element);
    menu("Move down");
    expect(local.text).toBe("# A\n\n*c*\n\n1)  x");
  });

  it("deletes a block and leaves its reference definitions in place", () => {
    const { local } = setup("[x][r]\n\n[r]: https://example.com\n\nkeep [x][r]");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("[r]: https://example.com\n\nkeep [x][r]");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("a Delete or Move with no blank lines around the blocks keeps the others apart", () => {
    const { local } = setup("Intro text\n## Section\nBody");
    click(root.querySelector("h2") as Element);
    menu("Delete");
    expect(local.text).toBe("Intro text\n\nBody");
    expect(root.querySelectorAll("p").length).toBe(2);
  });

  it("a Move with no blank lines around the blocks keeps them apart at both ends", () => {
    const { local } = setup("Intro text\n## Section\nBody");
    click(root.querySelector("h2") as Element);
    menu("Move up");
    expect(local.text).toBe("## Section\n\nIntro text\n\nBody");
    expect(root.querySelectorAll("p").length).toBe(2);
  });

  it("a Delete or Move never joins two lists of the same marker", () => {
    const { local } = setup("- a\n- b\n\nThen:\n\n- c\n- d");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("- a\n- b\n\n* c\n* d");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(root.querySelector("ul p")).toBeNull();
  });

  it("a Move that would join two lists writes the moved list with a free marker", () => {
    const { local } = setup("- a\n\nmid\n\n- b\n\nend");
    click(root.querySelector("p") as Element);
    menu("Move down");
    expect(local.text).toBe("- a\n\n* b\n\nmid\n\nend");
    expect(root.querySelectorAll("ul").length).toBe(2);
  });

  it("a Move that takes a list down next to a list of its marker writes it with a free one", () => {
    const { local } = setup("- a\n\nmid\n\n- b");
    click(root.querySelector("p") as Element);
    menu("Move up");
    expect(local.text).toBe("mid\n\n* a\n\n- b");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(root.querySelector("ul p")).toBeNull();
  });

  it("refuses a Delete that would run the blocks around it together, and says why", () => {
    // Without the paragraph, the indented line would continue the list item.
    const { local } = setup("- a\n\nmid\n\n    code");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("- a\n\nmid\n\n    code");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
  });

  it("refuses a Delete between numbered lists when no delimiter is free", () => {
    // The list after the paragraph has the first list's delimiter, and the next one has the other.
    const { local } = setup("1. a\n\nmid\n\n1. b\n1) c");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("1. a\n\nmid\n\n1. b\n1) c");
    expect(root.querySelectorAll("ol").length).toBe(3);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
  });

  it("a block op the doc cannot take says so and opens nothing", () => {
    const filler = "x".repeat(LIMITS.maxDocBytes - 20);
    const { local, editor } = setup(`one\n\ntwo\n\n${filler}`);
    click(root.querySelector("p") as Element);
    insertTable(1, 2);
    expect(local.text).toBe(`one\n\ntwo\n\n${filler}`);
    expect(editor.openEditor).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(DOC_FULL);
  });

  it("a block op whose edit is not sent says so and opens nothing", () => {
    const { local, editor } = setup("one\n\ntwo\n\nthree");
    vi.spyOn(local, "edit").mockReturnValue(false);
    click(root.querySelector("p") as Element);
    menu("Divider", "Insert below");
    expect(local.text).toBe("one\n\ntwo\n\nthree");
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Not connected");
  });

  it("an Insert table whose edit is not sent opens no other block", () => {
    const { local, editor } = setup("one\n\ntwo\n\nthree");
    vi.spyOn(local, "edit").mockReturnValue(false);
    click(root.querySelector("p") as Element);
    insertTable(1, 2);
    expect(local.text).toBe("one\n\ntwo\n\nthree");
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Not connected");
  });

  it("an empty doc offers Write something, which starts a new paragraph", () => {
    const { local, editor } = setup("only");
    click(root.querySelector("p") as Element);
    menu("Delete");
    expect(local.text).toBe("");
    const ph = root.querySelector(".plinth-doc__placeholder") as HTMLElement;
    expect(ph.textContent).toBe("Write something");
    click(ph);
    typeText(rich(editor).editable, "fresh");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("fresh");
  });

  it("the menu of a new empty block acts on that block, never on the block after it", () => {
    const { local, editor } = setup("a\n\nb\n\nc");
    // An empty paragraph after "a", from Enter at its end.
    const fresh = () => {
      click(root.querySelector("p") as Element);
      select(rich(editor).editable, 1);
      key(rich(editor).editable, "Enter");
    };
    fresh();
    expect(rich(editor).editable.textContent).toBe("");
    // It has no lines yet, so it cannot move.
    const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
    click(button as Element);
    for (const label of ["Move up", "Move down"]) {
      const item = [...document.querySelectorAll<HTMLElement>("[role^='menuitem']")].find(
        (i) => i.textContent === label,
      );
      expect(item?.getAttribute("aria-disabled")).toBe("true");
    }
    click(button as Element);
    // Delete removes the new block, which leaves the doc as it was.
    menu("Delete");
    expect(local.text).toBe("a\n\nb\n\nc");
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
    // Insert below lands where the new block was, after "a".
    fresh();
    menu("Divider", "Insert below");
    expect(local.text).toBe("a\n\n---\n\nb\n\nc");
  });

  it("the menu of the empty block an Enter opens at the end of a block acts on that block", () => {
    const { local, editor } = setup("a\n\nb");
    click(root.querySelector("p") as Element);
    select(rich(editor).editable, 1);
    key(rich(editor).editable, "Enter");
    expect(rich(editor).editable.textContent).toBe("");
    menu("Delete");
    expect(local.text).toBe("a\n\nb");
    expect(editor.openEditor).toBeNull();
    // At the top of the doc (Enter at the start of its first block), Insert below puts the new
    // kind there.
    click(root.querySelector("p") as Element);
    select(rich(editor).editable, 0);
    key(rich(editor).editable, "Enter");
    expect(rich(editor).editable.textContent).toBe("");
    menu("Heading 2", "Insert below");
    typeText(rich(editor).editable, "Top");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("## Top\n\na\n\nb");
  });

  it("a block cleared between two lists is removed at once, in one edit, and stays open there", () => {
    const { local, editor } = setup("- a\n\nmid\n\n- b");
    const edit = vi.spyOn(local, "edit");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "");
    // No pause: the doc has what the page shows at once. Sending nothing in its place would run
    // the lists together, so the list after it takes another marker in the same edit.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(local.text).toBe("- a\n\n* b");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(editor.pending).toBe(false);
    // The block stays open, empty, where it was, with no lines in the doc.
    expect(rich(editor).editable.textContent).toBe("");
    expect(local.mine).toMatchObject({ start: 2, end: 2 });
    const kids = [...root.children].filter((c) => c.tagName !== "BUTTON");
    expect(kids.map((c) => c.tagName)).toEqual(["UL", "DIV", "UL"]);
    expect(kids[1]).toBe(rich(editor).el);
    // Typing again puts a block there.
    typeText(rich(editor).editable, "new");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("- a\n\nnew\n\n* b");
    typeText(rich(editor).editable, "");
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("- a\n\n* b");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(editor.openEditor).toBeNull();
    expect(local.mine).toBeNull();
  });

  it("Publish, Cmd/Ctrl+S and Done read a cleared block's removal while it is still open", () => {
    const { local, editor } = setup("- a\n\nmid\n\n- b");
    const seen: string[] = [];
    save.mockImplementation(() => seen.push(local.text));
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "");
    expect(editor.openEditor).not.toBeNull();
    // Publish in solo mode collects the frame's text after a flush.
    editor.flush();
    expect(local.text).toBe("- a\n\n* b");
    key(rich(editor).editable, "s", { metaKey: true });
    expect(seen).toEqual(["- a\n\n* b"]);
    // Done leaves edit mode with the same text.
    editor.setEditing(false);
    expect(local.text).toBe("- a\n\n* b");
    expect(root.textContent).not.toContain("mid");
    expect(root.querySelectorAll("ul").length).toBe(2);
  });

  it("click and Tab reach the list a cleared block's removal gave another marker", () => {
    const { local, editor } = setup("- a\n\nmid\n\n- b\n\nlast");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "");
    expect(local.text).toBe("- a\n\n* b\n\nlast");
    // Tab from the empty block opens the list after it (where Tab then indents).
    key(rich(editor).editable, "Tab");
    expect(rich(editor).editable.textContent).toBe("b");
    key(rich(editor).editable, "Escape");
    // Shift+Tab from the paragraph after it opens it again.
    click(root.querySelectorAll("p")[0] as Element);
    expect(rich(editor).editable.textContent).toBe("last");
    key(rich(editor).editable, "Tab", { shiftKey: true });
    expect(rich(editor).editable.textContent).toBe("b");
    key(rich(editor).editable, "Escape");
    // A click on it opens it too.
    click(root.querySelectorAll("ul")[1] as Element);
    expect(rich(editor).editable.textContent).toBe("b");
    expect(local.text).toBe("- a\n\n* b\n\nlast");
  });

  it("a cleared block whose removal would run the blocks together keeps its text, and says why", () => {
    const { local, editor } = setup("- a\n\nmid\n\n    code");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "");
    // Nothing changed: the block stays open with its last text, which the doc has.
    expect(local.text).toBe("- a\n\nmid\n\n    code");
    expect(rich(editor).editable.textContent).toBe("mid");
    expect(editor.pending).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(JOINED_BLOCKS);
    key(rich(editor).editable, "Escape");
    expect(local.text).toBe("- a\n\nmid\n\n    code");
    expect(root.querySelectorAll("pre").length).toBe(1);
  });

  it("a cleared block that joins nothing is still sent empty while it is open", () => {
    const { local, editor } = setup("one\n\nmid\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    typeText(rich(editor).editable, "");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).not.toContain("mid");
    // Clicking another block closes it, with the doc's two paragraphs as they were.
    click(root.querySelector("p") as Element);
    expect(rich(editor).editable.textContent).toBe("one");
    expect(root.querySelectorAll("p").length).toBe(2);
  });

  it("clicking another block after clearing one between lists deletes it and opens that block", () => {
    const { local, editor } = setup("- a\n\nmid\n\n- b\n\nlast");
    click(root.querySelector("p") as Element);
    typeText(rich(editor).editable, "");
    click(root.querySelectorAll("p")[1] as Element);
    expect(local.text).toBe("- a\n\n* b\n\nlast");
    expect(rich(editor).editable.textContent).toBe("last");
  });
});

describe("DocEditor: read-only blocks and images", () => {
  it("shows a block the model cannot hold read-only, with Ask an agent, Move and Delete", () => {
    const md = "Intro\n\n- item\n\n  ```\n  code\n  ```\n\nEnd";
    const { local, editor } = setup(md);
    click(root.querySelector("ul") as Element);
    // Not opened for editing: it is drawn in a panel like an open block's, with a bar on top of
    // what can be done, and its Ask an agent says why.
    expect(editor.openEditor).toBeNull();
    const panel = root.querySelector(":scope > .plinth-doc__selected") as HTMLElement;
    const bar = panel.firstElementChild as HTMLElement;
    expect(bar.classList.contains("plinth-doc__blockbar")).toBe(true);
    expect(panel.querySelector(":scope > ul")).not.toBeNull();
    const askButton = [...bar.querySelectorAll("button")].find(
      (b) => b.textContent === "Ask an agent",
    ) as HTMLElement;
    expect(askButton.getAttribute("aria-description")).toBe(READ_ONLY_NOTE);
    // Two controls only: Ask an agent and the block menu, with no paragraph of text.
    expect(bar.children).toHaveLength(2);
    click(askButton);
    // A structural key and the block's first words (never its number).
    expect(ask).toHaveBeenCalledWith({ key: "block-2", text: "item code" }, "list");
    expect(root.querySelector(".plinth-doc__selected")).toBeNull();
    // Move and Delete keep its bytes.
    click(root.querySelector("ul") as Element);
    menu("Move up");
    expect(local.text).toBe("- item\n\n  ```\n  code\n  ```\n\nIntro\n\nEnd");
    click(root.querySelector("ul") as Element);
    menu("Delete");
    expect(local.text).toBe("Intro\n\nEnd");
  });

  it("a selected read-only block follows none of its links, and Esc puts it back in the page", () => {
    setup("- [a link](https://example.com)\n\n  ```\n  code\n  ```\n\nEnd");
    click(root.querySelector("ul") as Element);
    const panel = root.querySelector(":scope > .plinth-doc__selected") as HTMLElement;
    const link = panel.querySelector("a") as HTMLAnchorElement;
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelector(".plinth-doc__selected")).toBe(panel);
    key(panel.querySelector("button") as Element, "Escape");
    expect(root.querySelector(".plinth-doc__selected")).toBeNull();
    expect(root.querySelector(":scope > ul")).not.toBeNull();
    expect(document.activeElement).toBe(root.querySelector(":scope > ul"));
  });

  it("edits an image's alt text, keeps its file, and asks an agent to change the image", () => {
    const { local, editor } = setup('![Chart](chart.png "Sales")\n\nText');
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    expect(r.kind).toBe("image");
    // Its corner has what an image's bar has: Ask an agent and the block menu. Focus is on Ask.
    const corner = r.el.querySelector(":scope > .plinth-rich__corner") as HTMLElement;
    expect([...corner.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Ask an agent",
      "⋯",
    ]);
    expect(document.activeElement?.textContent).toBe("Ask an agent");
    // The alt text is a field the menu's "Alt text" opens in the corner's place, floating over
    // the page like the corner, so the image keeps the place it had unopened.
    const alt = r.el.querySelector<HTMLInputElement>(".plinth-rich__alt input") as HTMLInputElement;
    expect(alt.value).toBe("Chart");
    expect((alt.parentElement as HTMLElement).hidden).toBe(true);
    menu("Alt text");
    expect((alt.parentElement as HTMLElement).hidden).toBe(false);
    expect(corner.hidden).toBe(true);
    expect(document.activeElement).toBe(alt);
    expect(r.editable.matches("p.plinth-rich__image")).toBe(true);
    alt.value = "Sales [chart]";
    alt.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe('![Sales \\[chart\\]](chart.png "Sales")\n\nText');
    // Esc (or Enter) closes the field into the corner again, with the block still open.
    key(alt, "Escape");
    expect((alt.parentElement as HTMLElement).hidden).toBe(true);
    expect(corner.hidden).toBe(false);
    expect(editor.openEditor).toBe(r);
    // An image block's Insert below has no Image of its own: its Ask an agent is the way in.
    const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
    click(button as Element);
    click(menuItem("Insert below"));
    expect(() => menuItem("Image", "Insert below")).toThrow();
    click(button as Element);
    click(
      [...r.el.querySelectorAll("button")].find((b) => b.textContent === "Ask an agent") as Element,
    );
    expect(ask).toHaveBeenCalledWith({ key: "block-1:image", text: "Sales [chart]" }, "image");
    expect(editor.openEditor).toBeNull();
  });

  it("Insert below ends with Image, which asks an agent", () => {
    setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    menu("Image", "Insert below");
    expect(ask).toHaveBeenCalledWith({ key: "block-2:image", text: "" }, "image");
  });

  it("the menu's top level is five items; Turn into and Insert below open in its place", () => {
    setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
    click(button as Element);
    const top = () =>
      [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu [role^='menuitem']")].map(
        (i) => i.textContent,
      );
    expect(top()).toEqual(["Turn into", "Insert below", "Move up", "Move down", "Delete"]);
    click(menuItem("Turn into"));
    // The block's own kind is checked and has the focus; Escape goes back, then closes.
    const checked = menuItem("Paragraph", "Turn into");
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(checked);
    key(checked, "Escape");
    expect(top()).toEqual(["Turn into", "Insert below", "Move up", "Move down", "Delete"]);
    expect(document.activeElement?.textContent).toBe("Turn into");
    // The Table form opens under Insert below; going back from it returns there.
    click(menuItem("Insert below"));
    click(menuItem("Table", "Insert below"));
    const rows = document.querySelector(".plinth-doc__menu-table input") as HTMLInputElement;
    expect(document.activeElement).toBe(rows);
    key(rows, "Escape");
    expect(document.activeElement).toBe(menuItem("Table", "Insert below"));
    key(document.activeElement as Element, "ArrowLeft");
    expect(document.activeElement?.textContent).toBe("Insert below");
    key(document.activeElement as Element, "Escape");
    expect(document.querySelector(".plinth-doc__menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("draws images from the draft's base version, and Esc at the top level leaves", () => {
    const leave = vi.fn();
    setup("![Chart](chart.png)\n\nText", { leave, fileVersion: () => 5 });
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/__plinth/v/5/chart.png");
    key(root.querySelector("p") as Element, "Escape");
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("composes a block with the lines kept around it", () => {
    expect(composeBlock([], "a", [])).toBe("a");
    expect(composeBlock(["[r]: u"], "a", [])).toBe("[r]: u\n\na");
    expect(composeBlock([], "a", ["", "[r]: u"])).toBe("a\n\n[r]: u");
    expect(composeBlock([], "", ["", "[r]: u"])).toBe("\n[r]: u");
  });
});

describe("DocEditor: holders and reconnects", () => {
  it("shows who holds a block and offers Take over only after 60 s idle", () => {
    const leases = new Map<string, ClientLease>([
      ["l2", { id: "l2", start: 2, end: 3, by: "bo@example.org", holder: "s2", at: Date.now() }],
    ]);
    const takeover = vi.fn(() => true);
    const backend = {
      lines: ["one", "", "two"],
      ready: true,
      connected: true,
      settled: true,
      mine: null,
      leases,
      you: { id: "s1", email: "ada@example.org", right: "write" as const },
      conflictVersion: null,
      ackedText: null,
      durableText: null,
      lease: vi.fn(() => true),
      edit: vi.fn(() => true),
      release: vi.fn(),
      takeover,
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    const held = root.querySelector(".plinth-doc__held") as HTMLElement;
    expect(held.textContent).toBe("two");
    expect(root.querySelector(".plinth-doc__holder")?.textContent).toBe(
      "bo@example.org is editing",
    );
    click(held);
    expect(backend.lease).not.toHaveBeenCalled();
    const notice = document.querySelector(".plinth-doc__notice") as HTMLElement;
    expect(notice.textContent).toContain("bo@example.org is editing this.");
    expect(notice.textContent).not.toContain("Take over");
    vi.advanceTimersByTime(60_000);
    click(held);
    const btn = [...document.querySelectorAll(".plinth-doc__notice button")].find(
      (b) => b.textContent === "Take over",
    ) as HTMLElement;
    click(btn);
    expect(takeover).toHaveBeenCalledWith("l2");
    // Leaving edit mode takes every decoration away.
    editor.setEditing(false);
    expect(
      root.querySelector(".plinth-doc__held, .plinth-doc__holder, .plinth-doc__selected"),
    ).toBeNull();
    expect(root.querySelector("[tabindex='0']:not(pre):not(div)")).toBeNull();
    expect(root.classList.contains("plinth-doc--editing")).toBe(false);
  });

  it("tells a code-confirmed editor to sign in instead of opening a block", () => {
    const backend = {
      lines: ["one"],
      ready: true,
      connected: true,
      settled: true,
      mine: null,
      leases: new Map(),
      you: { id: "s1", email: "e@example.org", right: "watch" as const },
      conflictVersion: null,
      ackedText: null,
      durableText: null,
      lease: vi.fn(() => true),
      edit: vi.fn(() => true),
      release: vi.fn(),
      takeover: vi.fn(() => true),
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    click(root.querySelector("p") as Element);
    expect(backend.lease).not.toHaveBeenCalled();
    expect(document.querySelector(".plinth-doc__notice")?.textContent).toContain("Sign in");
  });

  it("keeps the block and its text through a reconnect, then re-takes it and resends", () => {
    let mine: ClientLease | null = null;
    const sent: string[] = [];
    const backend = {
      lines: ["one", "", "two"],
      ready: true,
      connected: true,
      settled: true,
      get mine() {
        return mine;
      },
      leases: new Map<string, ClientLease>(),
      you: { id: "s1", email: "ada@example.org", right: "write" as const },
      conflictVersion: null,
      ackedText: "two" as string | null,
      durableText: "two" as string | null,
      lease: vi.fn((r: { start: number; end: number }) => {
        if (!backend.connected) return false;
        mine = { id: "l1", ...r, by: "ada@example.org", holder: "s1", at: Date.now() };
        backend.leases.set("l1", mine);
        queueMicrotask(() => editor.granted(mine as ClientLease));
        return true;
      }),
      edit: vi.fn((t: string) => {
        sent.push(t);
        return true;
      }),
      release: vi.fn(),
      takeover: vi.fn(() => true),
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    return (async () => {
      click(root.querySelectorAll("p")[1] as Element);
      await Promise.resolve();
      const r = rich(editor);
      expect(r.editable.textContent).toBe("two");
      // The socket drops: the lease is gone, the block stays with its text.
      backend.connected = false;
      mine = null;
      backend.leases.clear();
      editor.lost("reconnect");
      expect(root.contains(r.el)).toBe(true);
      typeText(r.editable, "two, typed offline");
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
      expect(sent).toEqual([]);
      // The room is back with a reloaded draft in which the block moved down a line.
      backend.connected = true;
      backend.lines = ["zero", "one", "", "two"];
      editor.changed();
      expect(backend.lease).toHaveBeenLastCalledWith(expect.objectContaining({ start: 3, end: 4 }));
      await Promise.resolve();
      expect(editor.openEditor).toBe(r);
      expect(r.editable.textContent).toBe("two, typed offline");
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(["two, typed offline"]);
    })();
  });

  it("a click while a block op waits for its lease opens that block after the op, not instead", async () => {
    // A room that grants later, as the doc socket does.
    let mine: ClientLease | null = null;
    const backend = {
      lines: ["one", "", "two", "", "three"],
      ready: true,
      connected: true,
      settled: true,
      get mine() {
        return mine;
      },
      leases: new Map<string, ClientLease>(),
      you: { id: "s1", email: "ada@example.org", right: "write" as const },
      conflictVersion: null,
      ackedText: null,
      durableText: null,
      lease: vi.fn((r: { start: number; end: number }) => {
        const l = { id: `l${backend.lease.mock.calls.length}`, ...r, by: "", holder: "s1", at: 0 };
        queueMicrotask(() => {
          mine = l;
          editor.granted(l);
        });
        return true;
      }),
      edit: vi.fn((t: string) => {
        const l = mine as ClientLease;
        const ins = t === "" ? [] : t.split("\n");
        backend.lines = [...backend.lines.slice(0, l.start), ...ins, ...backend.lines.slice(l.end)];
        mine = { ...l, end: l.start + ins.length };
        return true;
      }),
      release: vi.fn(() => {
        mine = null;
        queueMicrotask(() => editor.changed());
      }),
      takeover: vi.fn(() => true),
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    click(root.querySelectorAll("p")[2] as Element);
    await Promise.resolve();
    menu("Move up");
    // Before the op's lease arrives, the person clicks the first paragraph.
    click(root.querySelectorAll("p")[0] as Element);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(backend.lines.join("\n")).toBe("one\n\nthree\n\ntwo");
    expect(rich(editor).editable.textContent).toBe("one");
  });

  it("with a room, a cleared block between lists is deleted after its lease, also as edit mode ends", async () => {
    let mine: ClientLease | null = null;
    const backend = {
      lines: ["- a", "", "mid", "", "- b", "", "last"],
      ready: true,
      connected: true,
      settled: true,
      get mine() {
        return mine;
      },
      leases: new Map<string, ClientLease>(),
      you: { id: "s1", email: "ada@example.org", right: "write" as const },
      conflictVersion: null,
      ackedText: null,
      durableText: null,
      lease: vi.fn((r: { start: number; end: number }) => {
        const l = { id: `l${backend.lease.mock.calls.length}`, ...r, by: "", holder: "s1", at: 0 };
        queueMicrotask(() => {
          mine = l;
          editor.granted(l);
        });
        return true;
      }),
      edit: vi.fn((t: string) => {
        const l = mine as ClientLease;
        const ins = t === "" ? [] : t.split("\n");
        backend.lines = [...backend.lines.slice(0, l.start), ...ins, ...backend.lines.slice(l.end)];
        mine = { ...l, end: l.start + ins.length };
        return true;
      }),
      release: vi.fn(() => {
        mine = null;
        queueMicrotask(() => editor.changed());
      }),
      takeover: vi.fn(() => true),
    };
    const settle = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    click(root.querySelector("p") as Element);
    await settle();
    typeText(rich(editor).editable, "");
    // A click on another block while the delete waits for its lease opens that block after it.
    click(root.querySelectorAll("p")[1] as Element);
    await settle();
    expect(backend.lines.join("\n")).toBe("- a\n\n* b\n\nlast");
    expect(rich(editor).editable.textContent).toBe("last");
    typeText(rich(editor).editable, "");
    editor.setEditing(false);
    await settle();
    // "last" joins nothing, so it was sent empty; the lists stay two.
    expect(backend.lines.join("\n")).not.toContain("last");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(mine).toBeNull();
  });

  it("with a room, a cleared block is deleted when edit mode ends before the lease arrives", async () => {
    let mine: ClientLease | null = null;
    const backend = {
      lines: ["- a", "", "mid", "", "- b"],
      ready: true,
      connected: true,
      settled: true,
      get mine() {
        return mine;
      },
      leases: new Map<string, ClientLease>(),
      you: { id: "s1", email: "ada@example.org", right: "write" as const },
      conflictVersion: null,
      ackedText: null,
      durableText: null,
      lease: vi.fn((r: { start: number; end: number }) => {
        const l = { id: `l${backend.lease.mock.calls.length}`, ...r, by: "", holder: "s1", at: 0 };
        queueMicrotask(() => {
          mine = l;
          editor.granted(l);
        });
        return true;
      }),
      edit: vi.fn((t: string) => {
        const l = mine as ClientLease;
        const ins = t === "" ? [] : t.split("\n");
        backend.lines = [...backend.lines.slice(0, l.start), ...ins, ...backend.lines.slice(l.end)];
        mine = { ...l, end: l.start + ins.length };
        return true;
      }),
      release: vi.fn(() => {
        mine = null;
        queueMicrotask(() => editor.changed());
      }),
      takeover: vi.fn(() => true),
    };
    const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
    editor.setEditing(true);
    click(root.querySelector("p") as Element);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    typeText(rich(editor).editable, "");
    editor.setEditing(false);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(backend.lines.join("\n")).toBe("- a\n\n* b");
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(mine).toBeNull();
  });
});

/**
 * A room as the doc socket sees it: requests go out at once, and the room's answers arrive later,
 * in order. A lease takes the place of the one held (released, then leased), an edit comes back as
 * an op that changes the lines, and an edit or release under a lease no longer held is refused.
 */
function fakeRoom(text: string, deny: () => LeaseDenial | null = () => null) {
  let mine: ClientLease | null = null;
  let n = 0;
  // A lost lease (lose) takes the answers still on their way with it.
  let gen = 0;
  // Answers held back (hold) until the test lets them through one at a time (step).
  let held: (() => void)[] | null = null;
  const later = (f: () => void) => {
    const g = gen;
    const run = () => {
      if (g === gen) f();
    };
    if (held) held.push(run);
    else queueMicrotask(run);
  };
  const backend = {
    lines: text.split("\n"),
    ready: true,
    connected: true,
    settled: true,
    get mine() {
      return mine;
    },
    leases: new Map<string, ClientLease>(),
    you: { id: "s1", email: "ada@example.org", right: "write" as const },
    conflictVersion: null,
    ackedText: null,
    durableText: null,
    refused: [] as string[],
    lease: vi.fn((r: { start: number; end: number }) => {
      if (!backend.connected) return false;
      later(() => {
        const why = deny();
        if (why) {
          editor.denied(why, "bo@example.org");
          return;
        }
        if (mine) {
          mine = null;
          editor.changed();
        }
        const l = { id: `l${++n}`, ...r, by: "ada@example.org", holder: "s1", at: 0 };
        mine = l;
        editor.granted(l);
        editor.changed();
      });
      return true;
    }),
    edit: vi.fn((t: string) => {
      const id = mine?.id;
      if (!id || !backend.connected) return false;
      later(() => {
        const l = mine;
        if (l?.id !== id) {
          backend.refused.push(`edit ${id}`);
          return;
        }
        const ins = t === "" ? [] : t.split("\n");
        backend.lines = [...backend.lines.slice(0, l.start), ...ins, ...backend.lines.slice(l.end)];
        mine = { ...l, end: l.start + ins.length };
        editor.changed();
      });
      return true;
    }),
    release: vi.fn(() => {
      const id = mine?.id;
      later(() => {
        if (!id || mine?.id !== id) {
          backend.refused.push(`release ${id}`);
          return;
        }
        mine = null;
        editor.changed();
      });
    }),
    takeover: vi.fn(() => true),
  };
  const editor = new DocEditor(root, window, backend, { save, status: () => undefined });
  editor.setEditing(true);
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  /** The room ends the lease held (a reconnect drops the socket too), as the client reports it. */
  const lose = (reason: LeaseLoss) => {
    mine = null;
    gen++;
    held = null;
    if (reason === "reconnect") backend.connected = false;
    editor.lost(reason);
    if (reason === "reconnect") editor.disconnected();
  };
  /**
   * The socket drops, as the client reports it: the answers on their way are lost, a lease it
   * still counts as its own (one whose release has not come back) is lost with "reconnect", and
   * then the frame tells the editor the socket is gone.
   */
  const drop = () => {
    gen++;
    held = null;
    backend.connected = false;
    if (mine) {
      mine = null;
      editor.lost("reconnect");
    }
    editor.disconnected();
  };
  const hold = () => {
    held = [];
  };
  /** Lets the next held answer through; false when none is left. */
  const step = () => {
    const f = held?.shift();
    f?.();
    return f !== undefined;
  };
  /** The socket is back with the room's text: the client says so with a change. */
  const reconnect = () => {
    backend.connected = true;
    editor.changed();
  };
  return {
    backend,
    editor,
    settle,
    lose,
    drop,
    hold,
    step,
    reconnect,
    text: () => backend.lines.join("\n"),
  };
}

describe("DocEditor: a cleared block, with a room", () => {
  it("is removed with the list after it under one lease, before anything else reads the doc", async () => {
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b");
    click(root.querySelector("p") as Element);
    await settle();
    typeText(rich(editor).editable, "");
    // Asked for at once, with no pause, over the block and the list it writes again; until the
    // room has it, the app sees unsent changes (so Publish and Done wait for it).
    expect(backend.lease).toHaveBeenLastCalledWith({ start: 2, end: 5, text: "mid\n\n- b" });
    expect(backend.release).not.toHaveBeenCalled();
    expect(editor.pending).toBe(true);
    expect(rich(editor).editable.textContent).toBe("");
    await settle();
    // The room's doc is what the page shows while the block is still open, empty, where it was.
    expect(text()).toBe("- a\n\n* b");
    expect(editor.pending).toBe(false);
    expect(rich(editor).editable.textContent).toBe("");
    expect(backend.mine).toMatchObject({ start: 2, end: 2 });
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(root.textContent).not.toContain("mid");
    // Typing in it puts a paragraph there.
    typeText(rich(editor).editable, "new");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    await settle();
    expect(text()).toBe("- a\n\nnew\n\n* b");
    expect(backend.refused).toEqual([]);
  });

  it("keeps what is typed while the removal is on its way, and sends it once it is in", async () => {
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b");
    click(root.querySelector("p") as Element);
    await settle();
    typeText(rich(editor).editable, "");
    typeText(rich(editor).editable, "new");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    await settle();
    vi.advanceTimersByTime(0);
    await settle();
    expect(text()).toBe("- a\n\nnew\n\n* b");
    expect(rich(editor).editable.textContent).toBe("new");
    expect(backend.refused).toEqual([]);
  });

  it("click and Tab while the removal is on its way reach the list it gave another marker", async () => {
    const tab = fakeRoom("- a\n\nmid\n\n- b\n\nlast");
    click(root.querySelector("p") as Element);
    await tab.settle();
    typeText(rich(tab.editor).editable, "");
    key(rich(tab.editor).editable, "Tab");
    await tab.settle();
    expect(tab.text()).toBe("- a\n\n* b\n\nlast");
    expect(rich(tab.editor).editable.textContent).toBe("b");
    expect(tab.backend.refused).toEqual([]);
    tab.editor.setEditing(false);
    await tab.settle();
    document.body.innerHTML = "";
    root = document.createElement("main");
    document.body.append(root);
    const clicked = fakeRoom("- a\n\nmid\n\n- b\n\nlast");
    click(root.querySelector("p") as Element);
    await clicked.settle();
    typeText(rich(clicked.editor).editable, "");
    click(root.querySelectorAll("ul")[1] as Element);
    await clicked.settle();
    expect(clicked.text()).toBe("- a\n\n* b\n\nlast");
    expect(rich(clicked.editor).editable.textContent).toBe("b");
    expect(clicked.backend.refused).toEqual([]);
  });

  it("an emptied block not sent yet is removed once someone's edit makes it join its neighbours", async () => {
    const { backend, editor, settle, text } = fakeRoom("para\n\nmid\n\n- b");
    click(root.querySelectorAll("p")[1] as Element);
    await settle();
    typeText(rich(editor).editable, "");
    // A paragraph and a list around it: sent empty after the pause, as usual.
    expect(editor.pending).toBe(true);
    expect(text()).toBe("para\n\nmid\n\n- b");
    // Before the pause ends, someone turns the paragraph above into a list of the same marker.
    backend.lines[0] = "- a";
    editor.changed();
    // Then a click on the list below.
    click(root.querySelectorAll("ul")[1] as Element);
    await settle();
    expect(text()).toBe("- a\n\n* b");
    expect(rich(editor).editable.textContent).toBe("b");
    expect(backend.refused).toEqual([]);
  });

  it("closed while the removal is on its way, it is removed as Delete does", async () => {
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b");
    click(root.querySelector("p") as Element);
    await settle();
    typeText(rich(editor).editable, "");
    key(rich(editor).editable, "Escape");
    expect(editor.openEditor).toBeNull();
    await settle();
    expect(text()).toBe("- a\n\n* b");
    expect(backend.mine).toBeNull();
    expect(editor.pending).toBe(false);
    expect(backend.refused).toEqual([]);
  });

  it("a removal the room refuses keeps the block open with its last text, and says so", async () => {
    let why: LeaseDenial | null = null;
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b", () => why);
    click(root.querySelector("p") as Element);
    await settle();
    const own = backend.mine;
    why = "held";
    typeText(rich(editor).editable, "");
    await settle();
    // Nothing is held back unsent: the doc and the block both have the last text.
    expect(text()).toBe("- a\n\nmid\n\n- b");
    expect(rich(editor).editable.textContent).toBe("mid");
    expect(editor.pending).toBe(false);
    expect(backend.mine).toBe(own);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(CLEAR_REFUSED);
    // Editing goes on under the block's own lease.
    why = null;
    typeText(rich(editor).editable, "mid!");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    await settle();
    expect(text()).toBe("- a\n\nmid!\n\n- b");
    // Not connected: the same.
    backend.lease.mockImplementationOnce(() => false);
    typeText(rich(editor).editable, "");
    expect(rich(editor).editable.textContent).toBe("mid!");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(CLEAR_REFUSED);
    await settle();
    expect(text()).toBe("- a\n\nmid!\n\n- b");
    expect(backend.refused).toEqual([]);
  });

  /** A fresh page for each case of a loop. */
  const fresh = () => {
    document.body.innerHTML = "";
    root = document.createElement("main");
    document.body.append(root);
  };

  it("typed into, then closed before the room answers, it still sends what was typed", async () => {
    // Escape, a click on another block, Tab and Done, at each step of the removal: before its
    // lease, once its edit is sent, and while the place the block stays open at is asked for.
    const ends: Record<string, (editor: DocEditor) => void> = {
      escape: (editor) => key(rich(editor).editable, "Escape"),
      click: () => click(root.querySelectorAll("ul")[1] as Element),
      tab: (editor) => key(rich(editor).editable, "Tab"),
      done: (editor) => editor.setEditing(false),
    };
    for (const [how, end] of Object.entries(ends)) {
      for (const steps of [0, 1, 2]) {
        fresh();
        const at = `${how} after ${steps}`;
        const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b");
        click(root.querySelector("p") as Element);
        await settle();
        typeText(rich(editor).editable, "");
        for (let i = 0; i < steps; i++) await Promise.resolve();
        typeText(rich(editor).editable, "new");
        end(editor);
        // Until the doc has it, the app sees unsent changes.
        expect(editor.pending, at).toBe(true);
        await settle();
        expect(text(), at).toBe("- a\n\nnew\n\n* b");
        expect(editor.pending, at).toBe(false);
        expect(backend.refused, at).toEqual([]);
        if (how === "click" || how === "tab") {
          expect(rich(editor).editable.textContent, at).toBe("b");
        } else expect(backend.mine, at).toBeNull();
        editor.setEditing(false);
        await settle();
      }
    }
  });

  it("typed into, then refused its removal, it keeps the typing and sends it in its place", async () => {
    let why: LeaseDenial | null = null;
    const once = () => {
      const w = why;
      why = null;
      return w;
    };
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b", once);
    click(root.querySelector("p") as Element);
    await settle();
    why = "held";
    typeText(rich(editor).editable, "");
    typeText(rich(editor).editable, "new");
    await settle();
    expect(rich(editor).editable.textContent).toBe("new");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    await settle();
    expect(text()).toBe("- a\n\nnew\n\n- b");
    expect(editor.pending).toBe(false);
    // Closed before the refusal arrives: the same, and the block's lease is let go.
    why = "held";
    typeText(rich(editor).editable, "");
    typeText(rich(editor).editable, "newer");
    key(rich(editor).editable, "Escape");
    expect(editor.pending).toBe(true);
    await settle();
    expect(text()).toBe("- a\n\nnewer\n\n- b");
    expect(backend.mine).toBeNull();
    expect(editor.pending).toBe(false);
    expect(backend.refused).toEqual([]);
  });

  it("a reconnect or a merge while its removal is on its way keeps the block and its typing", async () => {
    // Before the removal's lease and once its edit is sent, the removal is lost with the lease:
    // the typing goes in place of the block. Once the removal is in, it goes where the block was.
    const want = ["- a\n\nnew\n\n- b", "- a\n\nnew\n\n- b", "- a\n\nnew\n\n* b"];
    for (const reason of ["reconnect", "rebased"] as const) {
      for (const steps of [0, 1, 2]) {
        fresh();
        const at = `${reason} after ${steps}`;
        const { backend, editor, settle, lose, reconnect, text } = fakeRoom("- a\n\nmid\n\n- b");
        click(root.querySelector("p") as Element);
        await settle();
        typeText(rich(editor).editable, "");
        for (let i = 0; i < steps; i++) await Promise.resolve();
        typeText(rich(editor).editable, "new");
        lose(reason);
        await settle();
        expect(rich(editor).editable.textContent, at).toBe("new");
        reconnect();
        await settle();
        vi.advanceTimersByTime(0);
        await settle();
        expect(rich(editor).editable.textContent, at).toBe("new");
        expect(text(), at).toBe(want[steps]);
        expect(editor.pending, at).toBe(false);
        expect(backend.refused, at).toEqual([]);
        editor.setEditing(false);
        await settle();
      }
    }
  });

  it("closed with typing, then a reconnect, sends the typing once the draft is back", async () => {
    const want = ["- a\n\nnew\n\n- b", "- a\n\nnew\n\n- b", "- a\n\nnew\n\n* b"];
    for (const steps of [0, 1, 2]) {
      fresh();
      const at = `after ${steps}`;
      const { backend, editor, settle, lose, reconnect, text } = fakeRoom("- a\n\nmid\n\n- b");
      click(root.querySelector("p") as Element);
      await settle();
      typeText(rich(editor).editable, "");
      for (let i = 0; i < steps; i++) await Promise.resolve();
      typeText(rich(editor).editable, "new");
      key(rich(editor).editable, "Escape");
      lose("reconnect");
      await settle();
      // Nothing can be sent while the socket is away, and the app still sees unsent changes.
      expect(editor.pending, at).toBe(true);
      reconnect();
      await settle();
      expect(text(), at).toBe(want[steps]);
      expect(editor.openEditor, at).toBeNull();
      expect(backend.mine, at).toBeNull();
      expect(editor.pending, at).toBe(false);
      expect(backend.refused, at).toEqual([]);
    }
  });

  it("closed with typing, a drop while its place is asked for sends it once the draft is back", async () => {
    // The removal is in and the typing's lease is asked for when the socket drops: before the
    // removal's lease is let go (the client then reports it lost) and after.
    for (const released of [false, true]) {
      fresh();
      const at = released ? "released" : "not released";
      const { backend, editor, settle, drop, hold, step, reconnect, text } =
        fakeRoom("- a\n\nmid\n\n- b");
      click(root.querySelector("p") as Element);
      await settle();
      hold();
      typeText(rich(editor).editable, "");
      typeText(rich(editor).editable, "new");
      key(rich(editor).editable, "Escape");
      const asked = () => {
        const r = backend.lease.mock.lastCall?.[0];
        return backend.lease.mock.calls.length > 2 && r?.start === r?.end;
      };
      for (let i = 0; i < 20 && !asked(); i++) step();
      expect(asked(), at).toBe(true);
      expect(text(), at).toBe("- a\n\n* b");
      if (released) step();
      expect(backend.mine === null, at).toBe(released);
      drop();
      await settle();
      expect(editor.pending, at).toBe(true);
      reconnect();
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(text(), at).toBe("- a\n\nnew\n\n* b");
      expect(editor.pending, at).toBe(false);
      expect(backend.mine, at).toBeNull();
      expect(backend.refused, at).toEqual([]);
    }
  });

  it("a removal refused after the block was closed releases its lease and says so", async () => {
    let why: LeaseDenial | null = null;
    const { backend, editor, settle, text } = fakeRoom("- a\n\nmid\n\n- b", () => why);
    click(root.querySelector("p") as Element);
    await settle();
    why = "held";
    typeText(rich(editor).editable, "");
    key(rich(editor).editable, "Escape");
    await settle();
    expect(text()).toBe("- a\n\nmid\n\n- b");
    expect(root.textContent).toContain("mid");
    expect(backend.mine).toBeNull();
    expect(editor.pending).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(CLEAR_REFUSED);
    expect(backend.refused).toEqual([]);
  });
});

describe("DocEditor: a second drop, with a room", () => {
  it("a block taken again after a reconnect is asked for again after another drop", async () => {
    const { backend, editor, settle, lose, drop, hold, reconnect, text } =
      fakeRoom("one\n\ntwo\n\nthree");
    click(root.querySelectorAll("p")[1] as Element);
    await settle();
    typeText(rich(editor).editable, "two!");
    // The room has the block's text from before the typing.
    (backend as { durableText: string | null }).durableText = "two";
    lose("reconnect");
    hold();
    reconnect();
    // Asked for again, and the socket drops before the room answers.
    expect(backend.lease).toHaveBeenCalledTimes(2);
    drop();
    reconnect();
    await settle();
    expect(backend.lease).toHaveBeenCalledTimes(3);
    expect(backend.mine).toMatchObject({ start: 2, end: 3 });
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    await settle();
    expect(rich(editor).editable.textContent).toBe("two!");
    expect(text()).toBe("one\n\ntwo!\n\nthree");
    expect(backend.refused).toEqual([]);
  });
});

describe("DocEditor: a block op, with a room", () => {
  it("a drop while its lease is asked for leaves editing free, and says it wasn't made", async () => {
    // Before the open block's lease is let go (the client then reports it lost) and after.
    const cases = [
      ["Delete", false, "two\n\nthree"],
      ["Delete", true, "two\n\nthree"],
      ["Move down", false, "two\n\none\n\nthree"],
      ["Move down", true, "two\n\none\n\nthree"],
    ] as const;
    for (const [label, released, after] of cases) {
      document.body.innerHTML = "";
      root = document.createElement("main");
      document.body.append(root);
      const at = `${label}, ${released ? "released" : "not released"}`;
      const { backend, editor, settle, drop, hold, step, reconnect, text } =
        fakeRoom("one\n\ntwo\n\nthree");
      click(root.querySelector("p") as Element);
      await settle();
      hold();
      menu(label);
      expect(backend.lease, at).toHaveBeenCalledTimes(2);
      if (released) step();
      expect(backend.mine === null, at).toBe(released);
      drop();
      await settle();
      expect(text(), at).toBe("one\n\ntwo\n\nthree");
      expect(editor.pending, at).toBe(false);
      expect(document.querySelector('[role="status"]')?.textContent, at).toContain(NOT_SENT);
      reconnect();
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      // Nothing waits for the op: a block opens at once, and the op can be made again.
      click(root.querySelectorAll("p")[1] as Element);
      await settle();
      expect(backend.lease, at).toHaveBeenCalledTimes(3);
      expect(rich(editor).editable.textContent, at).toBe("two");
      key(rich(editor).editable, "Escape");
      await settle();
      click(root.querySelector("p") as Element);
      await settle();
      menu(label);
      await settle();
      expect(text(), at).toBe(after);
      expect(backend.refused, at).toEqual([]);
      editor.setEditing(false);
      await settle();
    }
  });
});

describe("blockWords", () => {
  it("reads a list's items apart, with a dot between them, and a table's cells with spaces", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<ul><li>Maria: launch post</li><li>Ana: emails<pre>subject: Hi</pre></li><li> </li></ul>";
    expect(blockWords([...host.childNodes])).toBe("Maria: launch post · Ana: emails subject: Hi");
    host.innerHTML = "<table><tr><th>Risk</th><th>Owner</th></tr><tr><td>PSL</td></tr></table>";
    expect(blockWords([...host.childNodes])).toBe("Risk Owner PSL");
  });
});

// ---------- typing next to a mark ----------

/** Appends `ch` to the text node `node` at `at` (its end by default), as typing there would. */
function typeInto(node: Text, ch: string, at = node.length) {
  node.insertData(at, ch);
  node.parentElement
    ?.closest('[contenteditable="true"]')
    ?.dispatchEvent(new Event("input", { bubbles: true }));
}

function notice(): string {
  return document.querySelector('[role="status"]')?.textContent ?? "";
}

describe("typing next to a mark", () => {
  it("sends punctuation typed at the end of an italic run before more text", () => {
    const { local, editor } = setup("这是*重要*的事情");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    const em = r.editable.querySelector("em") as HTMLElement;
    typeInto(em.firstChild as Text, "，");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(editor.pending).toBe(false);
    expect(local.text).toBe("这是*重要，*&#x7684;事情");
    // More typing after it goes in too.
    typeInto(r.editable.lastChild as Text, "。");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(editor.pending).toBe(false);
    expect(local.text).toBe("这是*重要，*&#x7684;事情。");
    key(r.editable, "Escape");
    expect(root.querySelector("p em")?.textContent).toBe("重要，");
    expect(root.querySelector("p")?.textContent).toBe("这是重要，的事情。");
  });

  it("keeps text it cannot write open and pending: no close, no Publish, nothing lost", () => {
    const { local, editor } = setup("ab\n\nnext");
    const status = vi.fn();
    (editor as unknown as { hooks: { status: () => void } }).hooks.status = status;
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    // Emphasis and strong that overlap without nesting, as a browser can leave them.
    r.editable.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("ab\n\nnext");
    expect(editor.pending).toBe(true);
    expect(editor.unsavable).toBe(true);
    expect(notice()).toContain(UNSAVABLE);
    expect(status).toHaveBeenCalled();
    // The keystroke is not undone: the text stays as typed.
    expect(r.editable.textContent).toBe("abc");
    // Esc, a click on another block and Tab keep the block open with its text.
    key(r.editable, "Escape");
    expect(editor.openEditor).toBe(r);
    click(root.querySelectorAll("p")[0] as Element);
    expect(editor.openEditor).toBe(r);
    key(r.editable, "Tab");
    expect(editor.openEditor).toBe(r);
    expect(editor.pending).toBe(true);
    // Changing it so it can be written sends it, and the block closes as usual.
    r.editable.innerHTML = "<em>a</em><strong>bc</strong>";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(editor.pending).toBe(false);
    expect(editor.unsavable).toBe(false);
    expect(local.text).toBe("*a***bc**\n\nnext");
    key(r.editable, "Escape");
    expect(editor.openEditor).toBeNull();
  });

  it("keeps such text without its formatting when edit mode ends anyway", () => {
    const { local, editor } = setup("ab");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    r.editable.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(editor.unsavable).toBe(true);
    editor.setEditing(false);
    expect(local.text).toBe("abc");
    expect(editor.pending).toBe(false);
  });

  /** Opens the first paragraph and leaves typing in it that cannot be written as typed. */
  function stuckIn(editor: DocEditor) {
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    r.editable.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(editor.unsavable).toBe(true);
    return r;
  }

  it("Cmd/Ctrl+S publishes nothing while such typing is not in the doc", () => {
    const { editor } = setup("ab");
    const r = stuckIn(editor);
    key(r.editable, "s", { metaKey: true });
    expect(save).not.toHaveBeenCalled();
    expect(notice()).toContain(UNSAVABLE);
    // Once it can be written, the shortcut publishes as usual.
    r.editable.innerHTML = "<em>a</em>bc";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    key(r.editable, "s", { ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease in use while such typing waits, so it is not taken over as idle", () => {
    class Room extends LocalDoc {
      keep = vi.fn(() => true);
    }
    let editor: DocEditor;
    const room = new Room("ab", {
      granted: (l: ClientLease) => editor.granted(l),
      changed: () => editor.changed(),
    });
    editor = new DocEditor(root, window, room, { save, status: () => undefined, ask });
    editor.setEditing(true);
    stuckIn(editor);
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000 * 4);
    expect(room.keep).toHaveBeenCalledTimes(4);
    // Written again: the edits keep the lease in use, and the heartbeat stops.
    const r = rich(editor);
    r.editable.innerHTML = "<em>a</em>bc";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    vi.advanceTimersByTime(LIMITS.liveLeaseKeepS * 1000 * 3);
    expect(room.keep).toHaveBeenCalledTimes(4);
  });

  it("taken over meanwhile: the typing goes in below the block, without its formatting", () => {
    const { local, editor } = setup("ab\n\nnext");
    stuckIn(editor);
    // Someone else takes the block over: the lease is gone.
    local.mine = null;
    editor.lost("takeover");
    expect(local.text).toBe("ab\n\nabc\n\nnext");
    expect(notice()).toContain(TAKEN_KEPT);
    expect(editor.pending).toBe(false);
  });

  it("the draft closed meanwhile: the typing takes the block's place, without its formatting", () => {
    const { local, editor } = setup("ab\n\nnext");
    stuckIn(editor);
    local.mine = null;
    editor.lost("closed");
    expect(local.text).toBe("abc\n\nnext");
    expect(editor.pending).toBe(false);
  });

  it("edit mode ending while not connected keeps the typing and writes it once the draft is back", () => {
    const { local, editor } = setup("ab\n\nnext");
    stuckIn(editor);
    // The socket drops: the lease is reported lost, and nothing can be sent.
    Object.defineProperty(local, "connected", { value: false, configurable: true });
    local.mine = null;
    editor.lost("reconnect");
    editor.setEditing(false);
    expect(local.text).toBe("ab\n\nnext");
    expect(editor.pending).toBe(true);
    // Back: it is written in place of the block, without its formatting.
    Object.defineProperty(local, "connected", { value: true, configurable: true });
    editor.changed();
    expect(local.text).toBe("abc\n\nnext");
    expect(editor.pending).toBe(false);
  });

  it("solo: the kept copy has such typing, without its formatting", () => {
    const { local, editor } = setup("ab\n\nnext");
    stuckIn(editor);
    expect(local.text).toBe("ab\n\nnext");
    expect(editor.textWithTyping()).toBe("abc\n\nnext");
  });

  // Every single character typed in or at the edge of a formatted run, over a fixed corpus, is
  // either in the doc or leaves the block open and pending: never neither.
  it("never leaves typing neither sent nor pending", () => {
    const CORPUS = [
      "这是*重要*的事情",
      "foo *bar* baz",
      "a**b**c",
      "x ~~y~~ z",
      "(*x*)",
      "中文**粗体**中文",
    ];
    const CHARS = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", " ", "a", "中", "，", "。"];
    let tried = 0;
    const lost: string[] = [];
    for (const md of CORPUS) {
      const runs = (() => {
        const { editor } = setup(md);
        click(root.querySelector("p") as Element);
        const n = rich(editor).editable.querySelectorAll("em, strong, s, del").length;
        editor.setEditing(false);
        document.body.innerHTML = "";
        return n;
      })();
      for (let run = 0; run < runs; run++) {
        for (const ch of CHARS) {
          for (const where of ["start", "end"] as const) {
            root = document.createElement("main");
            document.body.append(root);
            const { local, editor } = setup(md);
            click(root.querySelector("p") as Element);
            const r = rich(editor);
            const mark = r.editable.querySelectorAll("em, strong, s, del")[run] as HTMLElement;
            const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
            const first = walker.nextNode() as Text;
            let last = first;
            for (let t = walker.nextNode(); t; t = walker.nextNode()) last = t as Text;
            if (where === "start") typeInto(first, ch, 0);
            else typeInto(last, ch);
            const typed = r.editable.textContent ?? "";
            vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
            tried++;
            const sent = local.text !== md;
            if (!sent && !editor.pending) lost.push(`${md} ${where} of run ${run}: ${ch}`);
            key(r.editable, "Escape");
            if (sent) {
              const shown = (root.querySelector("p")?.textContent ?? "").replace(/\s+/g, " ");
              if (
                shown !== typed.replace(/\s+/g, " ").trim() &&
                shown !== typed.replace(/\s+/g, " ")
              ) {
                lost.push(`${md} ${where} of run ${run}: ${ch} shows ${shown}, typed ${typed}`);
              }
            } else if (editor.openEditor !== r) lost.push(`${md}: ${ch} closed while pending`);
            editor.setEditing(false);
            document.body.innerHTML = "";
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(300);
    expect(lost).toEqual([]);
  });
});

// ---------- the rescue store (rooms) ----------

/**
 * A room as the editor sees it, answering lease requests when the test says (or at once while
 * `auto`): its lines change only with an edit the room took, as the real client's do on an ack.
 */
class FakeRoom {
  lines: string[];
  readonly ready = true;
  connected = true;
  readonly settled = true;
  mine: ClientLease | null = null;
  readonly leases = new Map<string, ClientLease>();
  readonly you = { id: "me", email: "ada@example.org", right: "write" as const };
  conflictVersion: number | null = null;
  ackedText: string | null = null;
  readonly durableText = null;
  asked: { start: number; end: number } | null = null;
  auto = true;
  editor!: DocEditor;
  keep = vi.fn(() => true);
  /** Acks this socket's edits at once; off, they wait for ack(). */
  ackNow = true;
  private seq = 0;
  private readonly ackedSeqs = new Set<number>();
  private n = 0;
  get lastSeq() {
    return this.seq;
  }
  acked(seq: number) {
    return this.ackedSeqs.has(seq);
  }
  /** The room acknowledges every edit sent so far. */
  ack() {
    for (let i = 1; i <= this.seq; i++) this.ackedSeqs.add(i);
    this.editor.changed();
  }
  constructor(text: string) {
    this.lines = text.split("\n");
  }
  get text() {
    return this.lines.join("\n");
  }
  lease(r: { start: number; end: number }) {
    if (!this.connected || this.conflictVersion !== null) return false;
    this.asked = { start: r.start, end: r.end };
    if (this.auto) this.grant();
    return true;
  }
  grant() {
    const r = this.asked as { start: number; end: number };
    this.asked = null;
    this.mine = { id: `l${++this.n}`, ...r, by: "", holder: "me", at: 0 };
    this.leases.set(this.mine.id, this.mine);
    this.ackedText = this.lines.slice(r.start, r.end).join("\n");
    this.editor.granted(this.mine);
  }
  deny(reason: LeaseDenial, by?: string) {
    this.asked = null;
    this.editor.denied(reason, by);
  }
  /** Edits are sent but never reach the room (the socket is about to close). */
  dropEdits = false;
  edit(text: string) {
    const l = this.mine;
    if (!l || !this.connected) return false;
    if (this.dropEdits) {
      this.seq += 1;
      return true;
    }
    const ins = text === "" ? [] : text.split("\n");
    this.lines = [...this.lines.slice(0, l.start), ...ins, ...this.lines.slice(l.end)];
    this.mine = { ...l, end: l.start + ins.length };
    this.leases.set(l.id, this.mine);
    this.ackedText = text;
    this.seq += 1;
    if (this.ackNow) this.ackedSeqs.add(this.seq);
    this.editor.changed();
    return true;
  }
  release() {
    if (!this.mine) return;
    this.leases.delete(this.mine.id);
    this.mine = null;
    this.editor.changed();
  }
  takeover() {
    return false;
  }
  /** The room takes this socket's lease away (a takeover, a freeze, a dropped socket). */
  lose(reason: LeaseLoss) {
    if (this.mine) this.leases.delete(this.mine.id);
    this.mine = null;
    this.editor.lost(reason);
  }
}

describe("the rescue store", () => {
  // The app's copy, as the app keeps it (merge-only, components/editor/draft.ts), answering
  // each report with the ids it holds.
  const USER = "u1";
  const ART = "art1";
  let reports: RescueReport[];
  let answer = true;
  const stored = () => readRescueItems(loadRescue(USER, ART)) ?? [];
  const kept = () => stored().map((i) => i.text);

  beforeEach(() => {
    sessionStorage.clear();
    reports = [];
    answer = true;
  });

  function app(editor: () => DocEditor) {
    return (r: RescueReport) => {
      reports.push(r);
      const ids = mergeRescue(USER, ART, r.upsert, [...r.written, ...r.gone]);
      if (answer) editor().rescueStored(ids, r.n);
    };
  }

  function roomSetup(text: string) {
    const room = new FakeRoom(text);
    room.editor = new DocEditor(root, window, room, {
      save,
      status: () => undefined,
      ask,
      rescue: app(() => room.editor),
    });
    room.editor.setEditing(true);
    return room;
  }

  /** A reload: a new frame on `text`, offered what the app kept. */
  function reload(text: string) {
    document.body.innerHTML = "";
    root = document.createElement("main");
    document.body.append(root);
    const again = roomSetup(text);
    again.editor.offerRescue(stored());
    return again;
  }

  /** Lets queued work run (the store writes from a microtask). */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** Opens the first paragraph and leaves typing in it that cannot be written as typed. */
  function stick(room: FakeRoom) {
    click(root.querySelector("p") as Element);
    const r = rich(room.editor);
    r.editable.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(room.editor.unsavable).toBe(true);
  }

  it("keeps the typing the moment it cannot be written, for the app to hold", () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    expect(kept()).toEqual(["abc"]);
    expect(room.editor.pending).toBe(true);
  });

  it("1. a freeze that takes the lease before the room says it froze: written after the review", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.auto = false;
    // The room revokes the lease ("closed") while the draft does not look frozen yet.
    room.lose("closed");
    expect(room.asked).not.toBeNull();
    // Then the conflict frame, then the answer to the lease request.
    room.conflictVersion = 4;
    room.editor.roomStatus();
    room.deny("frozen");
    await settle();
    expect(notice()).toContain(RESCUE_WAITS);
    expect(kept()).toEqual(["abc"]);
    expect(room.editor.pending).toBe(true);
    expect(room.asked).toBeNull();
    // The review ends (the draft is reset to the new version): the text goes in.
    room.conflictVersion = null;
    room.lines = ["ab", "", "next", "", "From the agent."];
    room.editor.roomStatus();
    room.editor.changed();
    await settle();
    expect(room.asked).not.toBeNull();
    room.grant();
    await settle();
    expect(room.text).toContain("abc");
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
  });

  it("2. edit mode ended while offline, and someone took the block meanwhile: written next to it", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.connected = false;
    room.lose("reconnect");
    room.editor.setEditing(false);
    expect(kept()).toEqual(["abc"]);
    expect(room.editor.pending).toBe(true);
    // Back, with someone else on the block: its place is held, so it goes in at a free place.
    room.leases.set("o1", {
      id: "o1",
      start: 0,
      end: 1,
      by: "bo@example.org",
      holder: "s2",
      at: 0,
    });
    room.connected = true;
    room.auto = false;
    room.editor.changed();
    await settle();
    expect(room.asked).toEqual({ start: 0, end: 1 });
    room.deny("held", "bo@example.org");
    await settle();
    expect(room.asked?.start).toBe(room.asked?.end);
    expect(room.asked?.start).toBeGreaterThan(1);
    room.grant();
    await settle();
    expect(room.text).toContain("ab\n\nabc");
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
  });

  it("3. a refusal from the room never resets typing that cannot be written", () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.editor.refused(REFUSED_EDIT);
    expect(rich(room.editor).editable.textContent).toBe("abc");
    expect(room.editor.unsavable).toBe(true);
    expect(kept()).toEqual(["abc"]);
  });

  it("4. a takeover whose salvage keeps meeting stale answers stays kept, with Copy", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.auto = false;
    room.lose("takeover");
    for (let i = 0; i < 40 && room.asked; i++) {
      room.deny("stale");
      await settle();
    }
    expect(room.asked).toBeNull();
    expect(room.text).toBe("ab\n\nnext");
    expect(kept()).toEqual(["abc"]);
    expect(room.editor.pending).toBe(true);
    expect(notice()).toContain(RESCUE_STUCK);
    const copy = [
      ...document.querySelectorAll<HTMLButtonElement>(".plinth-doc__notice button"),
    ].find((b) => b.textContent === "Copy");
    expect(copy).toBeDefined();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    copy?.click();
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("1. never takes a same block elsewhere for the kept text: a reload writes it", async () => {
    // The person's stuck "abc" replaces "ab"; another "abc" block already sits below it.
    const room = roomSetup("ab\n\nabc\n\nnext");
    stick(room);
    expect(kept()).toEqual(["abc"]);
    // The frame reports changes only, never its whole store.
    expect(reports.at(-1)).toMatchObject({ upsert: [{ text: "abc" }], written: [], gone: [] });
    // A reload: the new frame is offered the item, and its draft has the other "abc" only.
    const again = reload("ab\n\nabc\n\nnext");
    await settle();
    expect(again.text.match(/^abc$/gm)?.length).toBe(2);
    expect(kept()).toEqual([]);
    expect(reports.at(-1)?.written).toHaveLength(1);
    expect(again.editor.pending).toBe(false);
  });

  it("2. an insert whose send never reached the room is written again, even before a same block", async () => {
    // "ab" is taken over by someone else; the stuck "abc" goes in after it, at a free place just
    // before another "abc" block. The send is lost with the socket.
    const room = roomSetup("ab\n\nabc\n\nnext");
    stick(room);
    room.ackNow = false;
    room.dropEdits = true;
    room.lose("takeover");
    room.leases.set("o1", {
      id: "o1",
      start: 0,
      end: 1,
      by: "bo@example.org",
      holder: "s2",
      at: 0,
    });
    await settle();
    expect(room.text).toBe("ab\n\nabc\n\nnext");
    expect(kept()).toEqual(["abc"]);
    room.connected = false;
    room.mine = null;
    room.editor.disconnected();
    // Back: the place it was sent to holds an "abc" (the other block), which proves nothing.
    room.connected = true;
    room.dropEdits = false;
    room.ackNow = true;
    room.editor.changed();
    await settle();
    expect(room.text.match(/^abc$/gm)?.length).toBe(2);
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
  });

  it("drops the kept copy only on the room's ack, and keeps it while a send is unacknowledged", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.ackNow = false;
    room.auto = true;
    room.lose("closed");
    await settle();
    // Written in place, sent, not acknowledged yet: still kept, with where it went.
    expect(room.text).toBe("abc\n\nnext");
    expect(stored()).toEqual([{ id: expect.any(String), text: "abc", near: 0 }]);
    expect(room.editor.pending).toBe(true);
    room.ack();
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
  });

  it("2. a send that never lands does not leave the copy stuck: the next accepted one clears it", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    const r = rich(room.editor);
    // Writable again, but the socket is down: the send fails, the copy stays.
    room.connected = false;
    r.editable.innerHTML = "<em>a</em>bc";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(kept()).toEqual(["abc"]);
    // Back; the person types on, and that send is accepted and acknowledged.
    room.connected = true;
    r.editable.innerHTML = "<em>a</em>bc more";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(room.text).toBe("*a*bc more\n\nnext");
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
    // A reload now has nothing to offer, so nothing is written twice.
    key(r.editable, "Escape");
    await settle();
    expect(room.text).toBe("*a*bc more\n\nnext");
  });

  it("2. an unacknowledged send is written again after a reload: a copy at worst, never a loss", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    const r = rich(room.editor);
    room.ackNow = false;
    r.editable.innerHTML = "<em>a</em>bc more";
    r.editable.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    // Sent and landed, but the tab reloads before the ack: the app still has the item.
    expect(kept()).toEqual(["abc"]);
    const again = reload(room.text);
    await settle();
    expect(again.text).toContain("*a*bc more");
    expect(again.text).toContain("abc");
    expect(kept()).toEqual([]);
  });

  it("3. a discard drops everything kept", async () => {
    const room = roomSetup("ab\n\nnext");
    stick(room);
    room.connected = false;
    room.lose("reconnect");
    room.editor.setEditing(false);
    expect(kept()).toEqual(["abc"]);
    // The room's reset after a discard (boot.ts calls clearRescues on `reset` why "discarded").
    room.editor.clearRescues();
    expect(kept()).toEqual([]);
    expect(room.editor.pending).toBe(false);
  });

  it("4. solo: kept items go into the solo text, or stay kept with Copy when they cannot", async () => {
    const { local, editor } = setup("ab\n\nnext");
    (editor as unknown as { hooks: { rescue: (r: RescueReport) => void } }).hooks.rescue = app(
      () => editor,
    );
    mergeRescue(USER, ART, [{ id: "r1", text: "kept text", near: 0 }], []);
    editor.offerRescue(stored());
    await settle();
    expect(local.text).toContain("kept text");
    expect(kept()).toEqual([]);
    expect(editor.pending).toBe(false);
    // A doc at its size limit cannot take one: it stays kept, and the page offers Copy.
    const big = "x".repeat(LIMITS.maxDocBytes - 4);
    const full = setup(big);
    (full.editor as unknown as { hooks: { rescue: (r: RescueReport) => void } }).hooks.rescue = app(
      () => full.editor,
    );
    mergeRescue(USER, ART, [{ id: "r2", text: "more text", near: 0 }], []);
    full.editor.offerRescue(stored());
    await settle();
    expect(full.local.text).toBe(big);
    expect(kept()).toEqual(["more text"]);
    expect(full.editor.pending).toBe(true);
    expect(notice()).toContain(RESCUE_STUCK);
  });

  it("says an item the app did not keep is only on this page, and keeps saying so, with Copy", () => {
    const room = roomSetup("ab\n\nnext");
    // The app's store is full: it answers without the new item.
    answer = false;
    stick(room);
    const last = reports.at(-1) as RescueReport;
    room.editor.rescueStored([], last.n);
    // The block's own notice ("can't be saved as typed") stays until it goes; then this one.
    expect(notice()).toContain(UNSAVABLE);
    (document.querySelector(".plinth-doc__notice-close") as HTMLButtonElement).click();
    expect(notice()).toContain(RESCUE_FRAME_ONLY);
    expect(room.editor.pending).toBe(true);
    // Another notice replaces it; once that one goes, Copy is back.
    room.editor.notify("Not connected. Try again in a moment.");
    expect(notice()).not.toContain(RESCUE_FRAME_ONLY);
    (document.querySelector(".plinth-doc__notice-close") as HTMLButtonElement).click();
    expect(notice()).toContain(RESCUE_FRAME_ONLY);
    const copy = [
      ...document.querySelectorAll<HTMLButtonElement>(".plinth-doc__notice button"),
    ].find((b) => b.textContent === "Copy");
    expect(copy).toBeDefined();
    // Kept by the app after all (a later answer): back to the usual words, or none.
    room.editor.rescueStored([last.upsert[0]?.id as string], last.n);
    expect(notice()).not.toContain(RESCUE_FRAME_ONLY);
  });
});
