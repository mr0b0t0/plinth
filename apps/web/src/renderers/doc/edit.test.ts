// The on-page editor: a block opens as a textarea made with createElement after the page was
// sanitized, typing is sent at most every 250 ms, Esc gives the block back, Cmd/Ctrl+S goes to the
// app, blocks other people hold show who holds them, and touch screens get a 16px field.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientLease } from "../common/live.ts";
import { DocEditor, EDIT_DEBOUNCE_MS, LocalDoc, padded, REFUSED_EDIT, unpadded } from "./edit.ts";

let root: HTMLElement;
let save: ReturnType<typeof vi.fn<() => void>>;

function setup(text: string) {
  const events = {
    granted: (l: ClientLease) => editor.granted(l),
    changed: () => editor.changed(),
  };
  const local = new LocalDoc(text, events);
  const editor: DocEditor = new DocEditor(root, window, local, { save, status: () => undefined });
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

function type(field: HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("main");
  root.id = "__plinth-doc";
  document.body.append(root);
  save = vi.fn<() => void>();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("DocEditor", () => {
  it("opens a block as a plain textarea holding its Markdown, sanitized page around it", () => {
    const { editor } = setup("# Title\n\nA <img src=x onerror=alert(1)> para\n\nLast");
    // The page around the field is the sanitized render: the tag shows as text.
    expect(root.querySelector("img")).toBeNull();
    const para = root.querySelector("p") as HTMLElement;
    click(para);
    const field = editor.fieldElement as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe("A <img src=x onerror=alert(1)> para");
    expect(field.parentNode).toBe(root);
    expect(document.activeElement).toBe(field);
    // The field holds text, never markup.
    expect(field.children.length).toBe(0);
    expect(root.querySelector("img")).toBeNull();
  });

  it("sends the block at most every 250 ms while typing", () => {
    const { local, editor } = setup("one\n\ntwo");
    const edit = vi.spyOn(local, "edit");
    click(root.querySelector("p") as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    type(field, "o");
    type(field, "on");
    type(field, "one!");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS - 1);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("one!");
    expect(local.text).toBe("one!\n\ntwo");
    expect(local.dirty).toBe(true);
  });

  it("gives the block back on Escape, sending what was pending", () => {
    const { local, editor } = setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    type(field, "two, **edited**");
    key(field, "Escape");
    expect(editor.fieldElement).toBeNull();
    expect(local.mine).toBeNull();
    expect(local.text).toBe("one\n\ntwo, **edited**");
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelectorAll("p")[1]?.querySelector("strong")?.textContent).toBe("edited");
  });

  it("moves to the next block with Tab", () => {
    const { editor } = setup("one\n\ntwo\n\nthree");
    click(root.querySelector("p") as Element);
    key(editor.fieldElement as Element, "Tab");
    expect(editor.fieldElement?.value).toBe("two");
  });

  it("Tab in the last block (Shift+Tab in the first) closes it and keeps focus on that block", () => {
    const { editor } = setup("one\n\ntwo");
    click(root.querySelectorAll("p")[1] as Element);
    key(editor.fieldElement as Element, "Tab");
    expect(editor.fieldElement).toBeNull();
    expect(document.activeElement).toBe(root.querySelectorAll("p")[1]);
    click(root.querySelector("p") as Element);
    key(editor.fieldElement as Element, "Tab", { shiftKey: true });
    expect(editor.fieldElement).toBeNull();
    expect(document.activeElement).toBe(root.querySelector("p"));
  });

  it("posts save to the app on Cmd/Ctrl+S, after sending the pending block", () => {
    const { local, editor } = setup("one");
    click(root.querySelector("p") as Element);
    type(editor.fieldElement as HTMLTextAreaElement, "uno");
    key(editor.fieldElement as Element, "s", { metaKey: true });
    expect(local.text).toBe("uno");
    expect(save).toHaveBeenCalledTimes(1);
    key(document.body, "s", { ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("adds a block between two with +, keeping blank lines around it", () => {
    const { local, editor } = setup("one\n\ntwo");
    const plus = root.querySelectorAll(".plinth-doc__insert");
    // One before the first block and one after each.
    expect(plus.length).toBe(3);
    click(plus[1] as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    expect(field.value).toBe("");
    type(field, "between");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("one\n\nbetween\n\ntwo");
    expect(padded("x", { before: true, after: true })).toBe("\nx\n");
    expect(unpadded("\nx\n", { before: true, after: true })).toBe("x");
  });

  it("uses a 16px field on touch screens, so mobile browsers do not zoom", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q === "(pointer: coarse)" }) as MediaQueryList,
    );
    const { editor } = setup("one");
    click(root.querySelector("p") as Element);
    expect(editor.fieldElement?.style.fontSize).toBe("16px");
  });

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

  it("keeps the field and its text through a reconnect, then re-takes the block and resends", () => {
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
      const field = editor.fieldElement as HTMLTextAreaElement;
      expect(field.value).toBe("two");
      // The socket drops: the lease is gone, the field stays with its text.
      backend.connected = false;
      mine = null;
      backend.leases.clear();
      editor.lost("reconnect");
      expect(root.contains(field)).toBe(true);
      type(field, "two, typed offline");
      vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
      expect(sent).toEqual([]);
      // The room is back with a reloaded draft in which the block moved down a line.
      backend.connected = true;
      backend.lines = ["zero", "one", "", "two"];
      editor.changed();
      expect(backend.lease).toHaveBeenLastCalledWith(expect.objectContaining({ start: 3, end: 4 }));
      await Promise.resolve();
      expect(editor.fieldElement).toBe(field);
      expect(field.value).toBe("two, typed offline");
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(["two, typed offline"]);
    })();
  });
});

describe("DocEditor: refusals, the leading < escape, files and leaving", () => {
  it("writes a leading <html in any block as \\<html, which renders the same and is published", () => {
    const { local, editor } = setup("Intro\n\nText");
    click(root.querySelectorAll("p")[1] as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    type(field, "<html> basics\n\nand <html> inside");
    field.setSelectionRange(13, 13);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(local.text).toBe("Intro\n\n\\<html> basics\n\nand <html> inside");
    expect(field.value).toBe("\\<html> basics\n\nand <html> inside");
    // The caret moved with the backslash.
    expect(field.selectionStart).toBe(14);
    key(field, "Escape");
    // Deleting the first block now leaves an escaped block first: still a doc.
    expect(root.textContent).toContain("<html> basics");
  });

  it("a change that would make the doc start like a web page is not kept, and says why", () => {
    // An agent wrote a second block that starts like an HTML document.
    const { local, editor } = setup("Intro\n\n<html> basics");
    const status = vi.fn();
    (editor as unknown as { hooks: { status: () => void } }).hooks.status = status;
    click(root.querySelector("p") as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    type(field, "");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    // Not applied: the block is back as the doc has it, still open, with the reason.
    expect(local.text).toBe("Intro\n\n<html> basics");
    expect(field.value).toBe("Intro");
    expect(editor.fieldElement).toBe(field);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(REFUSED_EDIT);
  });

  it("a refusal from the room puts the block back from the room's lines", () => {
    const { editor } = setup("one\n\ntwo");
    click(root.querySelector("p") as Element);
    const field = editor.fieldElement as HTMLTextAreaElement;
    type(field, "changed");
    editor.refused(REFUSED_EDIT);
    expect(field.value).toBe("one");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(REFUSED_EDIT);
  });

  it("draws images from the draft's base version, and Esc at the top level leaves", () => {
    const leave = vi.fn();
    const events = {
      granted: (l: ClientLease) => editor.granted(l),
      changed: () => editor.changed(),
    };
    const local = new LocalDoc("![Chart](chart.png)\n\nText", events);
    const editor: DocEditor = new DocEditor(root, window, local, {
      save,
      status: () => undefined,
      leave,
      fileVersion: () => 5,
    });
    editor.setEditing(true);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/__plinth/v/5/chart.png");
    key(root.querySelector("p") as Element, "Escape");
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
