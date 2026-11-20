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
    caret(r.editable.firstChild as Node, 0, 3);
    r.toggle("strong");
    expect(host.announce).toHaveBeenCalledWith(FORMAT_LOST);
    expect(md(r.model)).toBe("(a)b");
  });

  it("Enter in a paragraph hands the two halves to the host", () => {
    const { r, host } = make({ t: "paragraph", c: [text("onetwo")] });
    caret(r.editable.firstChild as Node, 3);
    key(r.editable, "Enter");
    expect(host.split).toHaveBeenCalledWith(
      { t: "paragraph", c: [text("one")] },
      { t: "paragraph", c: [text("two")] },
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

  it("drops the browser's own formatting and drops", () => {
    const { r } = make({ t: "paragraph", c: [text("x")] });
    for (const inputType of ["formatBold", "insertFromDrop", "insertLink"]) {
      const e = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      r.editable.dispatchEvent(e);
      expect(e.defaultPrevented, inputType).toBe(true);
    }
  });
});
