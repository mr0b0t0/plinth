// `edit { on: true, focus: "first" }` (the app's `?edit`, from New and Import): the doc opens its
// first block for typing once the draft is here, so a new doc's title takes the keyboard. When
// someone else holds that block, or this person cannot write, it only takes the focus and nothing
// is asked of the room. The message reader passes `focus` only as "first", and only to turn on.
import { RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEditMessage } from "../common/editSession.ts";
import type { ClientLease, LiveBackend } from "../common/live.ts";
import { DocEditor, headingLevel, LocalDoc, selectHeading } from "./edit.ts";

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

describe("focus on the first block", () => {
  it("opens a new doc's title for typing (solo)", () => {
    const events = {
      granted: (l: ClientLease) => editor.granted(l),
      changed: () => editor.changed(),
    };
    const local = new LocalDoc("# Untitled document\n", events);
    const editor: DocEditor = new DocEditor(root, window, local, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    const field = editor.fieldElement as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe("# Untitled document");
    expect(document.activeElement).toBe(field);
    // The title's text is selected, so the first keystroke replaces it.
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("Untitled document");
  });

  it("selects only a one-line heading's text", () => {
    const field = document.createElement("textarea");
    const sel = (v: string) => {
      field.value = v;
      field.setSelectionRange(0, 0);
      selectHeading(field);
      return field.value.slice(field.selectionStart, field.selectionEnd);
    };
    expect(sel("## Plan  ")).toBe("Plan");
    expect(sel("Body text")).toBe("");
    expect(sel("# Title\n\nMore")).toBe("");
    expect(sel("#nospace")).toBe("");
  });

  it("types a one-line heading in its heading's type", () => {
    expect(headingLevel("# Untitled document")).toBe(1);
    expect(headingLevel("### Notes ")).toBe(3);
    expect(headingLevel("# Title\n\nBody")).toBe(0);
    expect(headingLevel("Body")).toBe(0);
    const local = new LocalDoc("# Untitled document\n", {
      granted: (l: ClientLease) => editor.granted(l),
      changed: () => editor.changed(),
    });
    const editor: DocEditor = new DocEditor(root, window, local, hooks);
    editor.setEditing(true);
    editor.focusFirst();
    const field = editor.fieldElement as HTMLTextAreaElement;
    expect(field.dataset.heading).toBe("1");
    field.value = "Plain text";
    field.dispatchEvent(new Event("input"));
    expect(field.dataset.heading).toBeUndefined();
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
