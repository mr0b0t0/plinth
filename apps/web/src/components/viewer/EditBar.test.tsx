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
  onPublish: vi.fn(),
  onDiscard: vi.fn(),
  onDone: vi.fn(),
  onReview: vi.fn(),
  ...over,
});

describe("EditBar", () => {
  it("says what is happening, most urgent first", () => {
    expect(editStatus(props())).toBe("Editing v4");
    expect(editStatus(props({ dirty: true }))).toBe("Draft saved");
    expect(editStatus(props({ dirty: true, flushed: false }))).toBe("Saving draft…");
    expect(editStatus(props({ dirty: true, saving: true }))).toBe("Publishing…");
    expect(editStatus(props({ savedVersion: 5 }))).toBe("Published as v5");
    expect(editStatus(props({ dirty: true, rebasedVersion: 5 }))).toBe(
      "v5 was published; your changes were kept",
    );
    expect(editStatus(props({ connected: false, dirty: true }))).toBe(
      "Not connected, your changes are kept",
    );
    expect(editStatus(props({ mode: "solo", dirty: true }))).toBe(
      "Unpublished changes, kept in this tab",
    );
    expect(editStatus(props({ connected: false, connecting: true }))).toBe("Connecting…");
    // Solo has no socket: being "not connected" is normal there.
    expect(editStatus(props({ mode: "solo", connected: false }))).toBe("Editing v4");
    expect(editStatus(props({ mode: "solo", newerVersion: 5 }))).toBe(
      "v5 was published while you were editing",
    );
    // A version (or a range of them) published meanwhile waits for review.
    expect(editStatus(props({ phase: "conflict" }))).toBe(
      "A newer version was published while you edited. Review it to go on.",
    );
    expect(editStatus(props({ phase: "conflict", conflictVersion: 5 }))).toBe(
      "v5 was published while you edited. Review it to go on.",
    );
    expect(editStatus(props({ phase: "conflict", conflictVersion: 7 }))).toBe(
      "v5 to v7 were published while you edited. Review them to go on.",
    );
  });

  it("announces the status politely and offers Publish with its shortcut", async () => {
    const p = props({
      dirty: true,
      editors: [
        { email: "bo@example.org", block: true, where: "row 12" },
        { email: "cy@example.org", block: true },
      ],
    });
    render(<EditBar {...p} />);
    const status = screen.getByText("Draft saved");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(/bo@example\.org/).textContent).toBe("bo@example.org (editing row 12)");
    expect(screen.getByText(/cy@example\.org/).textContent).toBe("cy@example.org (editing)");
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.getAttribute("aria-keyshortcuts")).toBe("Meta+S Control+S");
    await userEvent.click(publish);
    expect(p.onPublish).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding, and only discards on confirm", async () => {
    const p = props({ dirty: true });
    const user = userEvent.setup();
    render(<EditBar {...p} />);
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Discard unpublished changes" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard unpublished changes?",
    });
    expect(dialog.textContent).toContain("for everyone editing it");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Discard unpublished changes" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(p.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("publishes with a note from the menu", async () => {
    const p = props({ dirty: true });
    const user = userEvent.setup();
    render(<EditBar {...p} />);
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Publish with a note…" }));
    await user.type(await screen.findByLabelText("Note"), "Tidy the intro");
    const dialog = screen.getByRole("dialog", { name: "Publish with a note" });
    await user.click(dialog.querySelector(".pl-dialog__footer button:last-child") ?? dialog);
    expect(p.onPublish).toHaveBeenCalledWith("Tidy the intro");
  });

  it("Enter in the note field publishes with the note", async () => {
    const p = props({ dirty: true });
    const user = userEvent.setup();
    render(<EditBar {...p} />);
    await user.click(screen.getByRole("button", { name: "More editing actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Publish with a note…" }));
    await user.type(await screen.findByLabelText("Note"), "Fix typos{Enter}");
    expect(p.onPublish).toHaveBeenCalledWith("Fix typos");
  });

  it("offers Review changes instead of Publish while a version waits for review", async () => {
    const p = props({ dirty: true, phase: "conflict" });
    render(<EditBar {...p} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(p.onReview).toHaveBeenCalled();
  });

  it("turns Publish off, with the reason, for a draft that cannot be a version yet", () => {
    const p = props({ dirty: true, publishable: false, unpublishableReason: "Nothing to show." });
    render(<EditBar {...p} />);
    const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    const reason = screen.getByText("Nothing to show.");
    expect(publish.getAttribute("aria-describedby")).toBe(reason.id);
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
    publishable: true,
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

  it("names who left unpublished changes and when, with publish, continue and discard", async () => {
    const h = handlers();
    render(<LiveDraftNotice draft={DRAFT} status={null} now={NOW} {...h} />);
    expect(screen.getByRole("note").textContent).toContain(
      "Unpublished changes on the page by bo@example.org, 3 h ago",
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(h.onSave).toHaveBeenCalled();
    expect(h.onContinue).toHaveBeenCalled();
  });

  it("asks before discarding someone's page changes, and only discards on confirm", async () => {
    const h = handlers();
    const user = userEvent.setup();
    render(<LiveDraftNotice draft={DRAFT} status={null} now={NOW} {...h} />);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard the unpublished changes?",
    });
    expect(dialog.textContent).toContain("The changes by bo@example.org are not kept anywhere.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(h.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables publishing and discarding with the reason while the live draft is out of reach", () => {
    const h = handlers();
    render(
      <LiveDraftNotice
        draft={DRAFT}
        status={null}
        unavailable="Live editing is unavailable right now."
        {...h}
      />,
    );
    const reason = screen.getByText("Live editing is unavailable right now.");
    for (const name of ["Publish", "Discard"]) {
      const b = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-describedby")).toBe(reason.id);
    }
    // Continuing to edit stays possible.
    expect(
      (screen.getByRole("button", { name: "Continue editing" }) as HTMLButtonElement).disabled,
    ).toBe(false);
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
      "v5 changed the same paragraphs as the unpublished changes on the page",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(h.onReview).toHaveBeenCalled();
    rerender(
      <LiveDraftNotice
        draft={null}
        status={status({ dirty: true, conflict_version: 5 })}
        merges={false}
        {...h}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "v5 was published while there were unpublished changes on the page. Review them to go on.",
    );
  });

  it("gives a code-confirmed editor no editing actions", () => {
    render(<LiveDraftNotice draft={DRAFT} status={null} signIn {...handlers()} />);
    expect(screen.getByRole("note").textContent).toContain("Sign in to edit.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
