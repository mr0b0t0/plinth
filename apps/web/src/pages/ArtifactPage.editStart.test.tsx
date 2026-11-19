// `?edit` on the artifact page for an owner or editor who can edit here (docs/spec.md "New and
// Import"): the page drops the parameter and opens in edit mode, and the frame is asked, at its
// exact origin and with its key, to focus its first block. Where this person cannot edit, the
// notices of ArtifactPage.ask.test.tsx apply instead.
import type { ViewArtifact, ViewGate } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactPage.tsx")).default;
}

const ORIGIN = "http://art123.content.localhost:8787";
const DOC: ViewArtifact = {
  id: "art123",
  slug: "untitled-document",
  title: "Untitled document",
  type: "doc",
  current_version: 1,
  version: 1,
  visibility: "allowlist",
  owner_name: null,
};

const gate = (over: Partial<Extract<ViewGate, { status: "ok" }>> = {}): ViewGate => ({
  status: "ok",
  artifact: DOC,
  enter_url: `${ORIGIN}/__plinth/enter?t=token-1&next=%2F`,
  role: "owner",
  live: { mode: "room", draft: null },
  ask: { targets: [] },
  ...over,
});

function stub(g: ViewGate) {
  return stubApi({
    me: ME,
    handle: (c) => {
      if (c.path.startsWith("/view/")) return json(g);
      if (c.path.startsWith("/artifacts/art123/comments")) return json({ items: [] });
      if (c.path === "/artifacts/art123/live") {
        return json({
          mode: "room",
          draft: null,
          editors_online: 0,
          idle_checkpoint_s: 120,
          auto_checkpoint_min_s: 600,
        });
      }
      return undefined;
    },
  });
}

// The test DOM does not load frames: give each one a window to post to.
const wins = new WeakMap<HTMLIFrameElement, { postMessage: ReturnType<typeof vi.fn> }>();
let restore: PropertyDescriptor | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", "/a/untitled-document?edit");
  restore = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      let w = wins.get(this);
      if (!w) {
        w = { postMessage: vi.fn() };
        wins.set(this, w);
      }
      return w;
    },
  });
});
afterEach(() => {
  cleanup();
  if (restore) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", restore);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("?edit where the page can be edited", () => {
  it("opens in edit mode and asks the frame to focus its first block", async () => {
    stub(gate());
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "untitled-document" }} />);
    const frame = (await screen.findByTitle("Untitled document, version 1")) as HTMLIFrameElement;
    const win = frame.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> };
    frame.dispatchEvent(new Event("load"));
    expect(await screen.findByRole("region", { name: "Editing on the page" })).toBeTruthy();
    expect(window.location.search).toBe("");
    await waitFor(() =>
      expect(win.postMessage.mock.calls).toContainEqual([
        { source: "plinth-renderer", v: 1, type: "edit", on: true, focus: "first" },
        ORIGIN,
      ]),
    );
    // The frame carries its key, so its answers are accepted.
    expect(frame.getAttribute("src")).toMatch(/#plinth-k=[A-Za-z0-9_-]{43}$/);
  });

  it("stays out of edit mode for a viewer, and leaves nothing behind", async () => {
    stub(gate({ role: "viewer", live: undefined, ask: undefined }));
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "untitled-document" }} />);
    await screen.findByTitle("Untitled document, version 1");
    expect(screen.queryByRole("region", { name: "Editing on the page" })).toBeNull();
    expect(screen.queryByRole("status", { name: /edit/i })).toBeNull();
  });
});
