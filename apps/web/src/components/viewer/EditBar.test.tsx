import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditBar, type EditBarProps, editStatus, editStatusShort } from "./EditBar.tsx";
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
      "v5 was published while you edited",
    );
    // A version (or a range of them) published meanwhile waits for review.
    expect(editStatus(props({ phase: "conflict" }))).toBe(
      "A newer version was published while you edited",
    );
    expect(editStatus(props({ phase: "conflict", conflictVersion: 5 }))).toBe(
      "v5 was published while you edited",
    );
    expect(editStatus(props({ phase: "conflict", conflictVersion: 7 }))).toBe(
      "v5 to v7 were published while you edited",
    );
  });

  it("has short words for phone width only where the long ones would wrap the strip", () => {
    expect(editStatusShort(props({ phase: "conflict", conflictVersion: 5 }))).toBe("v5 published");
    expect(editStatusShort(props({ phase: "conflict", conflictVersion: 7 }))).toBe(
      "v5 to v7 published",
    );
    expect(editStatusShort(props({ mode: "solo", newerVersion: 5 }))).toBe("v5 published");
    expect(editStatusShort(props({ dirty: true, rebasedVersion: 5 }))).toBe("Merged with v5");
    expect(editStatusShort(props({ connected: false, dirty: true }))).toBe("Not connected");
    expect(editStatusShort(props({ mode: "solo", dirty: true }))).toBe("Kept in this tab");
    expect(editStatusShort(props({ dirty: true }))).toBeNull();
    expect(editStatusShort(props({ savedVersion: 5 }))).toBeNull();
    expect(editStatusShort(props({ connected: false, connecting: true }))).toBeNull();
    // Both are in the live region; only the long words are read.
    render(<EditBar {...props({ dirty: true, phase: "conflict", conflictVersion: 5 })} />);
    const short = screen.getByText("v5 published");
    expect(short.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("v5 was published while you edited")).toBeTruthy();
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
    // How many others are here; who and where are its name (and its tooltip), never a list of
    // emails across the strip.
    const others = screen.getByRole("img", {
      name: "Also here: bo@example.org (editing row 12), cy@example.org (editing)",
    });
    expect(others.textContent).toBe("2");
    expect(others.tabIndex).toBe(0);
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.getAttribute("aria-keyshortcuts")).toBe("Meta+S Control+S");
    await userEvent.click(publish);
    expect(p.onPublish).toHaveBeenCalledTimes(1);
    // One action and no menu of its own: Discard is in the bar's ⋯ menu.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Publish"]);
  });

  it("shows Publish only once there is something to publish", () => {
    const { rerender } = render(<EditBar {...props()} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    rerender(<EditBar {...props({ savedVersion: 5 })} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    rerender(<EditBar {...props({ dirty: true, saving: true })} />);
    expect(screen.getByRole("button", { name: "Publish" }).getAttribute("aria-busy")).toBe("true");
  });

  it("has Done only at phone width, where the bar's Edit toggle is in the ⋯ menu", async () => {
    const { rerender } = render(<EditBar {...props({ dirty: true })} />);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    const p = props({ dirty: true, compact: true });
    rerender(<EditBar {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(p.onDone).toHaveBeenCalledTimes(1);
  });

  it("offers only Review changes, not Publish, while a version waits for review", async () => {
    const p = props({ dirty: true, phase: "conflict", compact: true });
    const { rerender } = render(<EditBar {...p} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(p.onReview).toHaveBeenCalled();
    // While the review is open in the frame, the strip shows its status only: the review's Back
    // is the one way out, so there is no Done beside it either.
    rerender(<EditBar {...p} reviewing />);
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.getByRole("region").textContent).toContain("published while you edited");
  });

  it("turns Publish off for a draft that cannot be a version yet, and says why in its tooltip", async () => {
    const p = props({ dirty: true, publishable: false, unpublishableReason: "Nothing to show." });
    render(<EditBar {...p} />);
    const publish = screen.getByRole("button", { name: "Publish" });
    // Off but focusable, so keyboard users reach the reason; no sentence across the strip.
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByRole("tooltip", { hidden: true });
    expect(reason.textContent).toBe("Nothing to show.");
    expect(publish.getAttribute("aria-describedby")).toBe(reason.id);
    await userEvent.click(publish);
    expect(p.onPublish).not.toHaveBeenCalled();
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

  it("names who left unpublished changes and when, in one short line, and offers no action", () => {
    render(<LiveDraftNotice draft={DRAFT} status={null} now={NOW} />);
    expect(screen.getByRole("note").textContent).toBe("Unpublished changes · Bo, 3 h ago");
    // The whole email is one hover away.
    expect(screen.getByText("Unpublished changes · Bo, 3 h ago").getAttribute("title")).toBe(
      "bo@example.org",
    );
    // The Edit toggle is the one way in; the edit strip holds Publish and Discard.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says who is editing, and that a version waits for review, as text only", () => {
    const { rerender } = render(
      <LiveDraftNotice
        draft={null}
        status={status({ editors: [{ email: "bo@example.org", block: true }] })}
      />,
    );
    expect(screen.getByRole("note").textContent).toBe("Bo is editing");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <LiveDraftNotice draft={null} status={status({ dirty: true, conflict_version: 5 })} />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "v5 was published over unpublished changes",
    );
    // Review changes is in the edit strip.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Publish and Discard for the copy this tab kept, which no frame holds", async () => {
    const onSaveRestore = vi.fn();
    const onDropRestore = vi.fn();
    render(
      <LiveDraftNotice
        draft={null}
        status={null}
        restore={{ text: "# Plan", base: 4, saved_at: "2026-11-18T07:00:00.000Z" }}
        onSaveRestore={onSaveRestore}
        onDropRestore={onDropRestore}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "Unpublished changes from earlier in this tab, based on v4",
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onSaveRestore).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDropRestore).toHaveBeenCalledTimes(1);
  });
});
