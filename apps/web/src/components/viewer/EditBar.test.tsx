import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditBar, type EditBarProps, editStatus } from "./EditBar.tsx";
import { LiveDraftNotice, noticeKind } from "./LiveDraftNotice.tsx";
import type { LiveFrameStatus } from "./rendererProtocol.ts";

afterEach(cleanup);

const props = (over: Partial<EditBarProps> = {}): EditBarProps => ({
  phase: "editing",
  mode: "room",
  version: 4,
  connected: true,
  dirty: false,
  saving: false,
  savedVersion: null,
  rebasedVersion: null,
  editors: [],
  onSave: vi.fn(),
  onDiscard: vi.fn(),
  onDone: vi.fn(),
  onReview: vi.fn(),
  ...over,
});

describe("EditBar", () => {
  it("says what is happening, most urgent first", () => {
    expect(editStatus(props())).toBe("Editing v4");
    expect(editStatus(props({ dirty: true }))).toBe("Unsaved changes");
    expect(editStatus(props({ dirty: true, saving: true }))).toBe("Saving…");
    expect(editStatus(props({ savedVersion: 5 }))).toBe("Saved as v5");
    expect(editStatus(props({ dirty: true, rebasedVersion: 5 }))).toBe(
      "v5 was published; your edits were kept",
    );
    expect(editStatus(props({ connected: false, dirty: true }))).toBe(
      "Not connected, your edits are kept",
    );
    expect(editStatus(props({ connected: false, connecting: true }))).toBe("Connecting…");
    // Solo has no socket: being "not connected" is normal there.
    expect(editStatus(props({ mode: "solo", connected: false }))).toBe("Editing v4");
    expect(editStatus(props({ mode: "solo", newerVersion: 5 }))).toBe(
      "v5 was published while you were editing",
    );
  });

  it("announces the status politely and offers Save version with its shortcut", async () => {
    const p = props({ dirty: true, editors: [{ email: "bo@example.org", block: true }] });
    render(<EditBar {...p} />);
    const status = screen.getByText("Unsaved changes");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("bo@example.org").textContent).toContain("(editing)");
    const save = screen.getByRole("button", { name: "Save version" });
    expect(save.getAttribute("aria-keyshortcuts")).toBe("Meta+S Control+S");
    await userEvent.click(save);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding, and only discards on confirm", async () => {
    const p = props({ dirty: true });
    const user = userEvent.setup();
    render(<EditBar {...p} />);
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Discard unsaved changes" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    expect(dialog).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Discard unsaved changes" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(p.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("saves with a note from the menu", async () => {
    const p = props({ dirty: true });
    const user = userEvent.setup();
    render(<EditBar {...p} />);
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Save with a note…" }));
    await user.type(await screen.findByLabelText("Note"), "Tidy the intro");
    const dialog = screen.getByRole("dialog", { name: "Save version" });
    await user.click(dialog.querySelector(".pl-dialog__footer button:last-child") ?? dialog);
    expect(p.onSave).toHaveBeenCalledWith("Tidy the intro");
  });

  it("offers Review changes instead of Save while frozen by a conflict", async () => {
    const p = props({ dirty: true, phase: "conflict" });
    render(<EditBar {...p} />);
    expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(p.onReview).toHaveBeenCalled();
  });
});

describe("LiveDraftNotice", () => {
  const status = (over: Partial<LiveFrameStatus> = {}): LiveFrameStatus => ({
    connected: true,
    failed: false,
    editing: false,
    holding: false,
    dirty: false,
    unflushed: false,
    rev: 1,
    base_version: 3,
    conflict_version: null,
    last_by_you: false,
    last_edit_at: null,
    editors: [],
    ...over,
  });
  const handlers = () => ({
    onSave: vi.fn(),
    onContinue: vi.fn(),
    onDiscard: vi.fn(),
    onReview: vi.fn(),
  });
  const DRAFT = {
    base_version: 3,
    dirty: true,
    conflict_version: null,
    updated_at: "2026-11-18T07:00:00.000Z",
    updated_by_email: "bo@example.org",
  };
  const NOW = Date.parse("2026-11-18T10:00:00.000Z");

  it("picks the most urgent line", () => {
    expect(noticeKind({ draft: null, status: null })).toBeNull();
    expect(noticeKind({ draft: DRAFT, status: null })).toBe("draft");
    // A connected frame knows better than the gate.
    expect(noticeKind({ draft: DRAFT, status: status() })).toBeNull();
    expect(
      noticeKind({
        draft: null,
        status: status({ editors: [{ email: "bo@example.org", block: true }] }),
      }),
    ).toBe("editing");
    expect(noticeKind({ draft: null, status: status({ dirty: true, conflict_version: 5 }) })).toBe(
      "conflict",
    );
  });

  it("names who left unsaved edits and when, with save, continue and discard", async () => {
    const h = handlers();
    render(<LiveDraftNotice draft={DRAFT} status={null} now={NOW} {...h} />);
    expect(screen.getByRole("note").textContent).toContain(
      "Unsaved page edits by bo@example.org, 3 h ago",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save as version" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(h.onSave).toHaveBeenCalled();
    expect(h.onContinue).toHaveBeenCalled();
    expect(h.onDiscard).toHaveBeenCalled();
  });

  it("says who is editing with Join, and a conflict with Review changes", async () => {
    const h = handlers();
    const { rerender } = render(
      <LiveDraftNotice
        draft={null}
        status={status({ editors: [{ email: "bo@example.org", block: true }] })}
        {...h}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain("bo@example.org is editing");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(h.onContinue).toHaveBeenCalled();
    rerender(
      <LiveDraftNotice draft={null} status={status({ dirty: true, conflict_version: 5 })} {...h} />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "v5 changed the same paragraphs as the unsaved page edits",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(h.onReview).toHaveBeenCalled();
  });

  it("gives a code-confirmed editor no editing actions", () => {
    render(<LiveDraftNotice draft={DRAFT} status={null} signIn {...handlers()} />);
    expect(screen.getByRole("note").textContent).toContain("Sign in to edit.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
