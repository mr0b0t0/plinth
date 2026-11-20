// The owner's mark on comments (docs/security.md "Display name used to impersonate"): "Owner" sits
// beside the owner's own comments, from the server's is_owner, never from the name, so a commenter
// who names themself after the owner looks different. Styled as the "Agent" mark.
import type { CommentInfo } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommentItem } from "./Thread.tsx";

afterEach(cleanup);

const comment = (author: Partial<CommentInfo["author"]>): CommentInfo => ({
  id: "c1",
  artifact_id: "art1",
  version_number: 1,
  parent_id: null,
  author: { email: null, connection_id: null, label: "Ana Owner", is_owner: false, ...author },
  body: "Hello",
  anchor: null,
  status: "open",
  created_at: new Date().toISOString(),
  mentions: [],
});

const meta = (c: CommentInfo) => {
  const { container } = render(<CommentItem comment={c} slug="notes" version={1} />);
  const out = container.querySelector(".cm-meta");
  cleanup();
  return out;
};

describe("CommentItem: the owner's mark", () => {
  it("marks the owner's comment, and not a lookalike's with the same name", () => {
    const mine = meta(comment({ is_owner: true }));
    expect(mine?.querySelector(".cm-agent")?.textContent).toBe("Owner");
    const lookalike = meta(comment({ is_owner: false }));
    expect(lookalike?.querySelector(".cm-agent")).toBeNull();
    expect(lookalike?.textContent).not.toContain("Owner ");
    // Absent (an older Worker) reads as not the owner.
    const older = meta(comment({ is_owner: undefined }));
    expect(older?.querySelector(".cm-agent")).toBeNull();
  });

  it("an agent's comment keeps the one Agent mark, whoever it acts for", () => {
    const agent = meta(comment({ connection_id: "k1", label: "Work Claude", is_owner: true }));
    const marks = [...(agent?.querySelectorAll(".cm-agent") ?? [])].map((e) => e.textContent);
    expect(marks).toEqual(["Agent"]);
  });
});
