// `edit { on: true, focus: "first" }` (the app's `?edit`, from New and Import): the doc opens its
// first block as formatted text once the draft is here, with a heading's text selected, so the
// first keystroke replaces a new doc's "Untitled document". When someone else holds that block, or
// this person cannot write, it only takes the focus and nothing is asked of the room. The message reader passes `focus` only as "first", and only to turn on.
import { RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEditMessage } from "../common/editSession.ts";
import type { ClientLease, LiveBackend } from "../common/live.ts";
import { DocEditor, LocalDoc } from "./edit.ts";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("main");
  root.id = "__plinth-doc";
  document.body.append(root);
});

afterEach(() => {
  document.body.innerHTML = "";
});

const hooks = { save: () => undefined, status: () => undefined };

/** A room backend that is not here yet, then arrives with these lines. */
function roomBackend(lines: string[], over: Partial<LiveBackend> = {}) {
  const b = {
    lines,
    ready: false,
    connected: false,
    settled: true,
    mine: null as ClientLease | null,
    leases: new Map<string, ClientLease>(),
    you: { id: "s1", email: "ada@example.org", right: "write" as "write" | "watch" },
    conflictVersion: null as number | null,
    ackedText: null,
    durableText: null,
    lease: vi.fn(() => true),
    edit: vi.fn(() => true),
    release: vi.fn(),
    takeover: vi.fn(() => false),
    ...over,
  };
  return b;
}

/** The selected text, and whether it lies in `el`. */
function selected(el: Element): string {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const r = sel.getRangeAt(0);
  return el.contains(r.startContainer) && el.contains(r.endContainer) ? r.toString() : "";
}

function solo(text: string) {
  const events = {
    granted: (l: ClientLease) => editor.granted(l),
    changed: () => editor.changed(),
  };
  const local = new LocalDoc(text, events);
  const editor: DocEditor = new DocEditor(root, window, local, hooks);
  return { local, editor };
}

describe("focus on the first block", () => {
  it("opens a new doc's title as formatted text, with its text selected (solo)", () => {
    const { editor } = solo("# Untitled document\n");
    editor.setEditing(true);
    editor.focusFirst();
    const rich = editor.openEditor;
    expect(rich).not.toBeNull();
    const editable = rich?.editable as HTMLElement;
    expect(editable.closest(".plinth-doc__open")).not.toBeNull();
    expect(rich?.kind).toBe("heading");
    expect(document.querySelector("textarea")).toBeNull();
    expect(editable.contains(document.activeElement)).toBe(true);
    // The title's text is selected, so the first keystroke replaces it; no Markdown is shown.
    expect(selected(editable)).toBe("Untitled document");
    expect(editable.textContent).not.toContain("#");
    // The page made that selection, so the format bar waits for the person's own.
    expect(document.querySelector<HTMLElement>(".plinth-rich__toolbar")?.hidden).toBe(true);
  });

  it("opens a first paragraph with the caret at its end, selecting nothing", () => {
    const { editor } = solo("Notes for Monday.\n");
    editor.setEditing(true);
    editor.focusFirst();
    const editable = editor.openEditor?.editable as HTMLElement;
    expect(editable.textContent).toBe("Notes for Monday.");
    expect(selected(editable)).toBe("");
  });

  it("opens a new paragraph in an empty doc", () => {
    const { local, editor } = solo("");
    editor.setEditing(true);
    editor.focusFirst();
    expect(editor.openEditor).not.toBeNull();
    expect(local.mine).not.toBeNull();
  });

  it("waits for the room's draft, then asks for the first block's lines once", () => {
    const b = roomBackend(["", "# Plan", "", "Body"]);
    const editor = new DocEditor(root, window, b, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    expect(b.lease).not.toHaveBeenCalled();
    b.ready = true;
    b.connected = true;
    editor.render();
    expect(b.lease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.lease).mock.calls[0]?.[0]?.start).toBe(1);
    editor.render();
    expect(b.lease).toHaveBeenCalledTimes(1);
  });

  it("only focuses the block when someone else holds it, and asks the room nothing", () => {
    const b = roomBackend(["# Plan", "", "Body"], { ready: true, connected: true });
    b.leases.set("l9", { id: "l9", start: 0, end: 1, by: "bo@example.org", holder: "s2", at: 0 });
    const editor = new DocEditor(root, window, b, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    expect(b.lease).not.toHaveBeenCalled();
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.querySelector(".plinth-doc__notice")).toBeNull();
    expect(editor.openEditor).toBeNull();
    expect(selected(root)).toBe("");
  });

  it("only focuses the block when this person cannot write, and asks the room nothing", () => {
    const b = roomBackend(["# Untitled document"], {
      ready: true,
      connected: true,
      you: { id: "s1", email: "ada@example.org", right: "watch" },
    });
    const editor = new DocEditor(root, window, b, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    expect(b.lease).not.toHaveBeenCalled();
    expect(editor.openEditor).toBeNull();
    expect(document.activeElement?.tagName).toBe("H1");
    expect(selected(root)).toBe("");
    // No "Sign in to edit" notice either: the person asked for nothing.
    expect(document.querySelector(".plinth-doc__notice")).toBeNull();
  });

  it("only focuses the block while edits wait for a review", () => {
    const b = roomBackend(["# Plan"], { ready: true, connected: true, conflictVersion: 4 });
    const editor = new DocEditor(root, window, b, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    expect(b.lease).not.toHaveBeenCalled();
    expect(document.activeElement?.tagName).toBe("H1");
  });

  it("does nothing outside edit mode, and forgets the wish when editing ends", () => {
    const b = roomBackend(["# Plan"]);
    const editor = new DocEditor(root, window, b, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    editor.setEditing(false);
    b.ready = true;
    editor.setEditing(true);
    expect(b.lease).not.toHaveBeenCalled();
  });
});

describe("readEditMessage focus", () => {
  const m = (x: Record<string, unknown>) => ({
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "edit",
    ...x,
  });

  it("takes focus only as first, and only when editing turns on", () => {
    expect(readEditMessage(m({ on: true, focus: "first" }))).toEqual({
      type: "edit",
      on: true,
      focus: "first",
    });
    expect(readEditMessage(m({ on: false, focus: "first" }))).toEqual({ type: "edit", on: false });
    expect(readEditMessage(m({ on: true, focus: "last" }))).toBeNull();
    expect(readEditMessage(m({ on: true, focus: 1 }))).toBeNull();
    expect(readEditMessage(m({ on: true }))).toEqual({ type: "edit", on: true });
  });
});
