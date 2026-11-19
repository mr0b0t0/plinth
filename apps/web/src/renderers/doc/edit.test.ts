// The on-page editor (doc-blocks): a block opens as formatted text, with no Markdown shown, drawn
// with createElement after the page was sanitized; typing is sent at most every 250 ms, written
// back as Markdown by the serializer; Esc gives the block back; Cmd/Ctrl+S goes to the app; blocks
// other people hold show who holds them; the block menu turns, inserts, moves and deletes blocks;
// blocks the model cannot show are read-only with Ask an agent; images keep their bytes.
import { LIMITS } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientLease } from "../common/live.ts";
import { FORMAT_LOST, type RichBlockEditor } from "../common/richblock.ts";
import {
  composeBlock,
  DOC_FULL,
  DocEditor,
  EDIT_DEBOUNCE_MS,
  JOINED_BLOCKS,
  LocalDoc,
  padded,
  READ_ONLY_NOTE,
  REFUSED_EDIT,
  unpadded,
} from "./edit.ts";

let root: HTMLElement;
let save: ReturnType<typeof vi.fn<() => void>>;
let ask: ReturnType<typeof vi.fn<(a: { key: string; text: string }) => void>>;

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

/**
 * Opens the block menu of the open (or selected) block and runs the item `label`, in the group
 * `group` ("Turn into", "Insert below") when one is named.
 */
function menu(label: string, group?: string) {
  const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
  if (!button) throw new Error("no menu button");
  click(button);
  const scope = group
    ? [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu [role='group']")].find(
        (g) => g.querySelector(".plinth-doc__menu-label")?.textContent === group,
      )
    : document.querySelector<HTMLElement>(".plinth-doc__menu");
  const item = [...(scope?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])].find(
    (i) => i.textContent === label,
  );
  if (!item) throw new Error(`no menu item ${label}`);
  click(item);
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("main");
  root.id = "__plinth-doc";
  document.body.append(root);
  save = vi.fn<() => void>();
  ask = vi.fn<(a: { key: string; text: string }) => void>();
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
    const { local, editor } = setup("(a)b");
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    select(r.editable, 0, 3);
    key(r.editable, "b", { metaKey: true });
    expect(r.editable.querySelector("strong")).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(FORMAT_LOST);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("(a)b");
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

  it("adds a paragraph between two with +, keeping blank lines around it", () => {
    const { local, editor } = setup("one\n\ntwo");
    const plus = root.querySelectorAll(".plinth-doc__insert");
    // One before the first block and one after each.
    expect(plus.length).toBe(3);
    click(plus[1] as Element);
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
    const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
    click(button as Element);
    const inputs = document.querySelectorAll<HTMLInputElement>(".plinth-doc__menu-table input");
    (inputs[0] as HTMLInputElement).value = "1";
    (inputs[1] as HTMLInputElement).value = "3";
    click(
      [...document.querySelectorAll(".plinth-doc__menu-item")].find(
        (b) => b.textContent === "Insert table",
      ) as Element,
    );
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
    const button = [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-button")].at(-1);
    click(button as Element);
    const inputs = document.querySelectorAll<HTMLInputElement>(".plinth-doc__menu-table input");
    (inputs[0] as HTMLInputElement).value = "1";
    (inputs[1] as HTMLInputElement).value = "2";
    click(
      [...document.querySelectorAll(".plinth-doc__menu-item")].find(
        (b) => b.textContent === "Insert table",
      ) as Element,
    );
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
});

describe("DocEditor: read-only blocks and images", () => {
  it("shows a block the model cannot hold read-only, with Ask an agent, Move and Delete", () => {
    const md = "Intro\n\n- item\n\n  ```\n  code\n  ```\n\nEnd";
    const { local, editor } = setup(md);
    click(root.querySelector("ul") as Element);
    // Not opened for editing: a bar says why and offers what can be done.
    expect(editor.openEditor).toBeNull();
    const bar = root.querySelector(".plinth-doc__blockbar") as HTMLElement;
    expect(bar.textContent).toContain(READ_ONLY_NOTE);
    expect(root.querySelector("ul")?.classList.contains("plinth-doc__selected")).toBe(true);
    click(
      [...bar.querySelectorAll("button")].find(
        (b) => b.textContent === "Ask an agent to change this",
      ) as Element,
    );
    expect(ask).toHaveBeenCalledWith({ key: "block-2", text: "Block 2" });
    // Move and Delete keep its bytes.
    click(root.querySelector("ul") as Element);
    menu("Move up");
    expect(local.text).toBe("- item\n\n  ```\n  code\n  ```\n\nIntro\n\nEnd");
    click(root.querySelector("ul") as Element);
    menu("Delete");
    expect(local.text).toBe("Intro\n\nEnd");
  });

  it("edits an image's alt text, keeps its file, and asks an agent to change the image", () => {
    const { local, editor } = setup('![Chart](chart.png "Sales")\n\nText');
    click(root.querySelector("p") as Element);
    const r = rich(editor);
    expect(r.kind).toBe("image");
    const alt = r.el.querySelector<HTMLInputElement>(".plinth-rich__alt input") as HTMLInputElement;
    expect(alt.value).toBe("Chart");
    alt.value = "Sales [chart]";
    alt.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe('![Sales \\[chart\\]](chart.png "Sales")\n\nText');
    click(
      [...r.el.querySelectorAll("button")].find(
        (b) => b.textContent === "Add or replace an image: Ask an agent",
      ) as Element,
    );
    expect(ask).toHaveBeenCalledWith({ key: "block-1:image", text: "Block 1, image" });
    expect(editor.openEditor).toBeNull();
  });

  it("Insert below ends with Add or replace an image: Ask an agent", () => {
    setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    menu("Add or replace an image: Ask an agent");
    expect(ask).toHaveBeenCalledWith({ key: "block-2:image", text: "Block 2, image" });
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
      root.querySelector(".plinth-doc__held, .plinth-doc__holder, .plinth-doc__insert"),
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
});
