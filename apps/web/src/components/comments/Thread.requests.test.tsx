// A page-request thread in the Comments panel (docs/spec.md "Page requests"): a "Sent from the
// page" chip, the page's data as plain text in a collapsed disclosure, "Dismiss request" for the
// owner and editors and "Withdraw request" for the requester, and a hint over the reply box.
import type { CommentInfo } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThreads } from "./model.ts";
import { PAGE_REQUEST_REPLY_HINT, Thread } from "./Thread.tsx";

afterEach(cleanup);

function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  return {
    id: "c1",
    artifact_id: "art1",
    version_number: 1,
    parent_id: null,
    author: { email: "ann@example.com", connection_id: null, label: "ann@example.com" },
    body: "Regenerate the chart for Q3",
    anchor: null,
    status: "open",
    created_at: "2026-11-19T10:00:00.000Z",
    mentions: [],
    kind: "comment",
    request_data: null,
    ...over,
  };
}

function renderThread(root: CommentInfo, opts: { moderator?: boolean; readOnly?: boolean } = {}) {
  const [thread] = buildThreads([root]);
  if (!thread) throw new Error("no thread");
  const onSetStatus = vi.fn(async () => undefined);
  render(
    <Thread
      thread={thread}
      slug="s"
      version={1}
      active={false}
      readOnly={opts.readOnly ?? false}
      moderator={opts.moderator}
      onActivate={() => undefined}
      onReply={async () => true}
      onSetStatus={onSetStatus}
    />,
  );
  return { onSetStatus };
}

describe("Thread: page requests", () => {
  it("shows the chip and the attached data as text, never as markup", async () => {
    renderThread(
      comment({
        kind: "page_request",
        request_data: { note: "<script>alert(1)</script>", q: 3 },
      }),
    );
    expect(screen.getByText("Sent from the page")).toBeTruthy();
    const summary = screen.getByText("Data the page attached");
    expect(summary.closest("details")?.open).toBe(false);
    const pre = summary.closest("details")?.querySelector("pre");
    expect(pre?.textContent).toContain('"note": "<script>alert(1)</script>"');
    expect(document.querySelector("script")).toBeNull();
  });

  it("says Dismiss to the owner and editors, Withdraw to the requester, and resolves the thread", async () => {
    const root = comment({ kind: "page_request" });
    const { onSetStatus } = renderThread(root, { moderator: true });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss request" }));
    expect(onSetStatus).toHaveBeenCalledWith("c1", "resolved");
    cleanup();
    renderThread(root, { moderator: false });
    expect(screen.getByRole("button", { name: "Withdraw request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("puts the hint over the reply box of request threads only", async () => {
    renderThread(comment({ kind: "page_request" }));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByText(PAGE_REQUEST_REPLY_HINT)).toBeTruthy();
    cleanup();
    renderThread(comment());
    expect(screen.queryByText("Sent from the page")).toBeNull();
    expect(screen.queryByText("Data the page attached")).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.queryByText(PAGE_REQUEST_REPLY_HINT)).toBeNull();
  });
});
