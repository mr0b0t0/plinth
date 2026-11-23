// The comments panel beside a page edited on it: no review-mode bridge (the frame is never
// reloaded into review mode), and "Pin to an element" asks the editing frame to pick instead; the
// place it names becomes the composer's anchor, and a pick cancelled in the frame leaves none.
import type { PageAnchor } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../viewer/test-utils.ts";
import { CommentsPanel } from "./CommentsPanel.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORIGIN = "http://art1.content.localhost:8787";

function setup() {
  stubApi({
    me: ME,
    handle: (c) =>
      c.path.startsWith("/artifacts/art1/comments")
        ? json({ items: [], can_comment: true, signed_in: true })
        : undefined,
  });
  const frame = document.createElement("iframe");
  const toFrame = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: toFrame } });
  const start = vi.fn(() => true);
  const stop = vi.fn();
  const props = (picked: { n: number; anchor: PageAnchor | null } | null) => (
    <CommentsPanel
      artifactId="art1"
      slug="plan"
      version={3}
      frame={frame}
      contentOrigin={ORIGIN}
      onClose={() => undefined}
      framePick={{ start, stop, picked }}
    />
  );
  return { toFrame, start, stop, props };
}

describe("CommentsPanel while the page is edited on it", () => {
  it("connects no bridge and picks with the editing frame", async () => {
    const { toFrame, start, props } = setup();
    const user = userEvent.setup();
    const { rerender } = render(props(null));
    const panel = await screen.findByRole("region", { name: "Comments" });
    // No review-mode bridge: nothing of the bridge's protocol goes to the frame.
    expect(toFrame).not.toHaveBeenCalled();
    const pin = await within(panel).findByRole("button", { name: /Pin to an element/ });
    await user.click(pin);
    expect(start).toHaveBeenCalledTimes(1);
    expect(panel.getAttribute("data-picking")).toBe("true");
    rerender(props({ n: 1, anchor: { kind: "page", key: "block-2", text: "Second paragraph" } }));
    await waitFor(() => expect(panel.getAttribute("data-picking")).toBeNull());
    expect(within(panel).getByText(/Second paragraph/)).toBeTruthy();
    expect(toFrame).not.toHaveBeenCalled();
  });

  it("leaves no anchor when the pick was cancelled in the frame, and stops a pick on Escape", async () => {
    const { start, stop, props } = setup();
    const user = userEvent.setup();
    const { rerender } = render(props(null));
    const panel = await screen.findByRole("region", { name: "Comments" });
    await user.click(await within(panel).findByRole("button", { name: /Pin to an element/ }));
    rerender(props({ n: 1, anchor: null }));
    await waitFor(() => expect(panel.getAttribute("data-picking")).toBeNull());
    expect(within(panel).queryByText(/Second paragraph/)).toBeNull();
    await user.click(within(panel).getByRole("button", { name: /Pin to an element/ }));
    expect(start).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    expect(stop).toHaveBeenCalled();
  });
});
