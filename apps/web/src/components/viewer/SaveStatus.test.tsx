// The save status in the artifact bar (editing on the page is always on) and the one line above
// the page for owners and editors who are not editing it.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveDraftNotice, noticeKind } from "./LiveDraftNotice.tsx";
import type { LiveFrameStatus } from "./rendererProtocol.ts";
import { SaveStatus, type SaveStatusProps, saveStatus, saveStatusShort } from "./SaveStatus.tsx";

afterEach(cleanup);

const props = (over: Partial<SaveStatusProps> = {}): SaveStatusProps => ({
  phase: "editing",
  mode: "room",
  version: 4,
  connected: true,
  dirty: false,
  saving: false,
  savedVersion: null,
  rebasedVersion: null,
  editors: [],
  onReview: vi.fn(),
  ...over,
});

describe("SaveStatus", () => {
  it("says what happens to the changes, most urgent first, and nothing when there is nothing", () => {
    expect(saveStatus(props())).toBe("");
    expect(saveStatus(props({ dirty: true }))).toBe("Draft saved");
    expect(saveStatus(props({ dirty: true, flushed: false }))).toBe("Saving…");
    expect(saveStatus(props({ dirty: true, saving: true }))).toBe("Publishing…");
    expect(saveStatus(props({ savedVersion: 5 }))).toBe("Published as v5");
    expect(saveStatus(props({ dirty: true, rebasedVersion: 5 }))).toBe(
      "v5 was published; your changes were kept",
    );
    expect(saveStatus(props({ connected: false, dirty: true }))).toBe(
      "Not connected, your changes are kept",
    );
    expect(saveStatus(props({ mode: "solo", dirty: true }))).toBe(
      "Unpublished changes, kept in this tab",
    );
    expect(saveStatus(props({ connected: false, connecting: true }))).toBe("Connecting…");
    // Solo has no socket: being "not connected" is normal there.
    expect(saveStatus(props({ mode: "solo", connected: false }))).toBe("");
    // A version (or a range of them) published meanwhile waits for review.
    expect(saveStatus(props({ phase: "conflict" }))).toBe(
      "A newer version was published while you edited",
    );
    expect(saveStatus(props({ phase: "conflict", conflictVersion: 5 }))).toBe(
      "v5 was published while you edited",
    );
    expect(saveStatus(props({ phase: "conflict", conflictVersion: 7 }))).toBe(
      "v5 to v7 were published while you edited",
    );
    // A page this person may edit but that stays read-only says why, before anything else.
    expect(saveStatus(props({ blocked: "Too large.", dirty: true }))).toBe("Too large.");
  });

  it("has short words for phone width, so the bar stays one line", () => {
    expect(saveStatusShort(props({ phase: "conflict", conflictVersion: 5 }))).toBe("v5 published");
    expect(saveStatusShort(props({ phase: "conflict", conflictVersion: 7 }))).toBe(
      "v5 to v7 published",
    );
    expect(saveStatusShort(props({ dirty: true, rebasedVersion: 5 }))).toBe("Merged with v5");
    expect(saveStatusShort(props({ connected: false, dirty: true }))).toBe("Not connected");
    expect(saveStatusShort(props({ mode: "solo", dirty: true }))).toBe("Unpublished");
    expect(saveStatusShort(props({ dirty: true }))).toBe("Saved");
    expect(saveStatusShort(props({ savedVersion: 5 }))).toBe("Published");
    expect(saveStatusShort(props({ blocked: "Too large." }))).toBe("Read-only");
    expect(saveStatusShort(props({ dirty: true, flushed: false }))).toBeNull();
    expect(saveStatusShort(props({ connected: false, connecting: true }))).toBeNull();
    // Both are in the live region; only the long words are read.
    render(<SaveStatus {...props({ dirty: true, phase: "conflict", conflictVersion: 5 })} />);
    const short = screen.getByText("v5 published");
    expect(short.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("v5 was published while you edited")).toBeTruthy();
  });

  it("announces the status politely, counts the others, and has no button of its own", () => {
    const p = props({
      dirty: true,
      editors: [
        { email: "bo@example.org", block: true, where: "row 12" },
        { email: "cy@example.org", block: true },
      ],
    });
    render(<SaveStatus {...p} />);
    const status = screen.getByText("Draft saved");
    expect(status.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    // How many others are here; who and where are its name (and its tooltip).
    const others = screen.getByRole("img", {
      name: "Also here: bo@example.org (editing row 12), cy@example.org (editing)",
    });
    expect(others.textContent).toBe("2");
    expect(others.tabIndex).toBe(0);
    // No Edit, Done or Publish: changes publish on their own, Publish changes is in the ⋯ menu.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Editing on the page" })).toBeTruthy();
  });

  it("offers Review changes while a version waits for review, and nothing while it is open", async () => {
    const p = props({ dirty: true, phase: "conflict" });
    const { rerender } = render(<SaveStatus {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(p.onReview).toHaveBeenCalled();
    // While the review is open in the frame, the line shows its status only: the review's Back
    // is the one way out.
    rerender(<SaveStatus {...p} reviewing />);
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    expect(screen.getByRole("region").textContent).toContain("published while you edited");
  });

  it("says once, without buttons, why a page stays read-only for someone who may edit it", () => {
    render(
      <SaveStatus
        {...props({
          blocked: "This design system has problems only an agent can fix.",
          editors: [{ email: "bo@example.org", block: true }],
        })}
      />,
    );
    expect(screen.getByRole("region").textContent).toContain(
      "This design system has problems only an agent can fix.",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
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
    // It only says so: the ⋯ menu holds Publish changes and Discard while editing.
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
    // Review changes is in the save status while editing.
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
