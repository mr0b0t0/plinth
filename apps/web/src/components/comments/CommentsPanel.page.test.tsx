// The comments panel for a page that declares `comments`: the page's compose requests, its
// anchors and its pins. The rest of the panel is CommentsPanel.test.tsx.
import type { CommentInfo, PageAnchor } from "@plinth/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api.ts";
import type { PinPosition } from "./bridge.ts";
import { CommentsPanel, type CommentsPanelProps } from "./CommentsPanel.tsx";

vi.mock("../../lib/api.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api.ts")>();
  return { ...mod, api: vi.fn() };
});

const apiMock = vi.mocked(api);
const ORIGIN = "http://art1.content.localhost:8787";
const REQ = "request-0000000001";

let n = 0;
function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "art1",
    version_number: 1,
    parent_id: null,
    author: { email: "ed@example.com", connection_id: null, label: "Ed" },
    body: "A comment",
    anchor: null,
    status: "open",
    created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    mentions: [],
    kind: "comment",
    request_data: null,
    ...over,
  };
}

interface Server {
  items: CommentInfo[];
  list?: Record<string, unknown>;
  posts: Record<string, unknown>[];
}

function serve(server: Server) {
  apiMock.mockImplementation(
    async (_path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? "GET") === "GET") return { items: server.items, ...server.list } as never;
      const body = opts.body as Record<string, unknown>;
      server.posts.push(body);
      const created = comment({ body: String(body.body), anchor: (body.anchor ?? null) as never });
      server.items = [...server.items, created];
      return created as never;
    },
  );
}

function fakeFrame() {
  const frameWin = { postMessage: vi.fn() };
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentWindow", { value: frameWin, configurable: true });
  frame.getBoundingClientRect = () =>
    ({
      top: 100,
      left: 50,
      width: 800,
      height: 600,
      right: 850,
      bottom: 700,
      x: 50,
      y: 100,
    }) as DOMRect;
  Object.defineProperty(frame, "clientWidth", { value: 800 });
  Object.defineProperty(frame, "clientHeight", { value: 600 });
  return { frame, frameWin };
}

const ANCHOR: PageAnchor = { kind: "page", key: "canvas", x: 40, y: 30, text: "Top left" };

/** Something outside the panel that has focus (the frame, or a control in the app's bar). */
function focusElsewhere(): HTMLElement {
  const el = document.createElement("button");
  el.textContent = "Elsewhere";
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** Let the panel's effects and animation-frame callbacks run. */
const settle = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 10)));
  });

function renderPanel(server: Server, props: Partial<CommentsPanelProps> = {}) {
  serve(server);
  const { frame, frameWin } = fakeFrame();
  const settled = vi.fn();
  const base: CommentsPanelProps = {
    artifactId: "art1",
    slug: "board-abc",
    version: 1,
    frame,
    contentOrigin: ORIGIN,
    onClose: vi.fn(),
    pageOwnsAnchors: true,
    onPageComposeSettled: settled,
    ...props,
  };
  const utils = render(<CommentsPanel {...base} />);
  const panel = screen.getByRole("region", { name: "Comments" });
  const rerender = (p: Partial<CommentsPanelProps>) =>
    utils.rerender(<CommentsPanel {...base} {...p} />);
  return { ...utils, panel, frameWin, settled, rerender };
}

beforeEach(() => {
  apiMock.mockReset();
  window.history.replaceState(null, "", "/a/board-abc");
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("CommentsPanel, comments from the page", () => {
  it("shows the page's anchor, posts it as a page anchor and settles posted with the id", async () => {
    const server: Server = { items: [], posts: [] };
    const k = renderPanel(server, { pageCompose: { req: REQ, anchor: ANCHOR } });
    await screen.findByText("No comments yet.");
    expect(within(k.panel).getByText(/Placed by the page/).textContent).toBe(
      "Placed by the page: Top left",
    );
    // The page owns anchoring: no pick button, and no bridge message to the frame.
    expect(within(k.panel).queryByRole("button", { name: "Pin to an element" })).toBeNull();
    expect(k.frameWin.postMessage).not.toHaveBeenCalled();
    const user = userEvent.setup();
    const box = within(k.panel).getByRole("textbox", { name: "New comment" });
    await user.type(box, "Move this");
    await user.click(within(k.panel).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(server.posts.length).toBe(1));
    expect(server.posts[0]).toEqual({ body: "Move this", version_number: 1, anchor: ANCHOR });
    await waitFor(() =>
      expect(k.settled).toHaveBeenCalledWith(REQ, { status: "posted", id: server.items[0]?.id }),
    );
    expect(k.settled).toHaveBeenCalledTimes(1);
  });

  it("settles closed when the chip is removed, and when the panel closes", async () => {
    const server: Server = { items: [], posts: [] };
    const k = renderPanel(server, { pageCompose: { req: REQ, anchor: ANCHOR } });
    await screen.findByText("No comments yet.");
    // The person opened the panel, so it took focus; the page's request moved it nowhere.
    expect(document.activeElement).toBe(within(k.panel).getByRole("heading", { name: "Comments" }));
    await userEvent.setup().click(within(k.panel).getByRole("button", { name: "Remove pin" }));
    expect(k.settled).toHaveBeenCalledWith(REQ, { status: "closed" });
    k.rerender({ pageCompose: { req: "request-0000000002", anchor: null } });
    k.unmount();
    await waitFor(() =>
      expect(k.settled).toHaveBeenLastCalledWith("request-0000000002", { status: "closed" }),
    );
    expect(k.settled).toHaveBeenCalledTimes(2);
  });

  it("keeps a request through React's strict-mode effect re-run", async () => {
    serve({ items: [], posts: [] });
    const { frame } = fakeFrame();
    const settled = vi.fn();
    render(
      <StrictMode>
        <CommentsPanel
          artifactId="art1"
          slug="board-abc"
          version={1}
          frame={frame}
          contentOrigin={ORIGIN}
          onClose={vi.fn()}
          pageOwnsAnchors
          pageCompose={{ req: REQ, anchor: ANCHOR }}
          onPageComposeSettled={settled}
        />
      </StrictMode>,
    );
    await screen.findByText("No comments yet.");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(settled).not.toHaveBeenCalled();
    expect(screen.getByText(/Placed by the page/)).toBeTruthy();
  });

  it("is busy while someone writes, and replaces an earlier request nobody wrote for", async () => {
    const server: Server = { items: [], posts: [] };
    const k = renderPanel(server, { pageCompose: { req: REQ, anchor: ANCHOR } });
    await screen.findByText("No comments yet.");
    const second: PageAnchor = { kind: "page", key: "slide-2" };
    k.rerender({ pageCompose: { req: "request-0000000002", anchor: second } });
    expect(k.settled).toHaveBeenCalledWith(REQ, { status: "closed" });
    expect(within(k.panel).getByText(/Placed by the page/).textContent).toBe(
      "Placed by the page: slide-2",
    );
    await userEvent
      .setup()
      .type(within(k.panel).getByRole("textbox", { name: "New comment" }), "Hi");
    k.rerender({ pageCompose: { req: "request-0000000003", anchor: ANCHOR } });
    expect(k.settled).toHaveBeenCalledWith("request-0000000003", { status: "busy" });
    // The anchor under the draft did not change.
    expect(within(k.panel).getByText(/Placed by the page/).textContent).toBe(
      "Placed by the page: slide-2",
    );
  });

  it("holds a request from someone who cannot comment like any other", async () => {
    const server: Server = { items: [], posts: [], list: { can_comment: false, signed_in: false } };
    const k = renderPanel(server, { pageCompose: { req: REQ, anchor: ANCHOR } });
    const link = await within(k.panel).findByRole("link", { name: "Sign in to comment" });
    // The page is not told, not even by how soon it hears back, that this person cannot comment.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(k.settled).not.toHaveBeenCalled();
    // A request while the panel is open is held too, and replaces the earlier one, as for a
    // commenter who has not written anything; focus stays where it was.
    const elsewhere = focusElsewhere();
    k.rerender({ pageCompose: { req: "request-0000000002", anchor: ANCHOR } });
    expect(k.settled).toHaveBeenCalledWith(REQ, { status: "closed" });
    await settle();
    expect(document.activeElement).toBe(elsewhere);
    expect(link).toBeTruthy();
    expect(k.settled).toHaveBeenCalledTimes(1);
    // Closing the panel ends it.
    k.unmount();
    await waitFor(() =>
      expect(k.settled).toHaveBeenLastCalledWith("request-0000000002", { status: "closed" }),
    );
    expect(k.settled).toHaveBeenCalledTimes(2);
  });

  it("never moves focus on a page's compose, so keystrokes meant for the page stay there", async () => {
    // The person is typing in the page (focus is in the frame) when the page asks to compose.
    const k = renderPanel({ items: [], posts: [] });
    await screen.findByText("No comments yet.");
    const frame = focusElsewhere();
    k.rerender({ pageCompose: { req: REQ, anchor: ANCHOR } });
    await settle();
    expect(document.activeElement).toBe(frame);
    expect(within(k.panel).getByText(/Placed by the page/)).toBeTruthy();
    // Screen readers hear that the page asked.
    await waitFor(() =>
      expect(within(k.panel).getByRole("status").textContent).toBe("The page asked for a comment."),
    );
    // The same for a viewer who may not comment: focus says nothing about the role.
    cleanup();
    const v = renderPanel({
      items: [],
      posts: [],
      list: { can_comment: false, signed_in: true },
    });
    await within(v.panel).findByText("You can view this artifact but not comment on it");
    const there = focusElsewhere();
    v.rerender({ pageCompose: { req: REQ, anchor: ANCHOR } });
    await settle();
    expect(document.activeElement).toBe(there);
    expect(v.settled).not.toHaveBeenCalled();
  });

  it("does not take focus when a page request opened it", async () => {
    // The person closed the panel; focus went back to the Comments toggle in the app bar.
    const toggle = focusElsewhere();
    const k = renderPanel(
      { items: [], posts: [] },
      { openedByPage: true, pageCompose: { req: REQ, anchor: ANCHOR } },
    );
    await screen.findByText("No comments yet.");
    await settle();
    expect(document.activeElement).toBe(toggle);
    expect(within(k.panel).getByText(/Placed by the page/)).toBeTruthy();
    // Opened by the person, it takes focus as before.
    cleanup();
    focusElsewhere();
    const p = renderPanel({ items: [], posts: [] });
    expect(document.activeElement).toBe(within(p.panel).getByRole("heading", { name: "Comments" }));
  });

  it("shows a thread the page asked for before the list had loaded", async () => {
    const pinned = comment({ anchor: { kind: "page", key: "canvas", x: 1, y: 2 } });
    const resolved = comment({ status: "resolved", anchor: { kind: "page", key: "b" } });
    const active = vi.fn();
    // The page's own marker opened the panel: the request is there when the panel mounts.
    const frame = focusElsewhere();
    const k = renderPanel(
      { items: [pinned, resolved], posts: [] },
      { onActiveChange: active, pageOpen: { id: resolved.id, n: 1 }, openedByPage: true },
    );
    await waitFor(() => expect(active).toHaveBeenCalledWith(resolved.id));
    expect((within(k.panel).getByRole("radio", { name: "All" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(k.panel.querySelector(`[data-thread-id="${CSS.escape(resolved.id)}"]`)).toBeTruthy();
    // The thread is shown, but focus stays where it was: a page request never moves it.
    await settle();
    expect(document.activeElement).toBe(frame);
    // Showing the thread tells the page, as for a pin click; nothing else does.
    expect(active.mock.calls.every(([id]) => id === resolved.id)).toBe(true);
    const calls = active.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(active.mock.calls.length).toBe(calls);
  });

  it("renders anchor text from the page inert", async () => {
    const hostile: PageAnchor = { kind: "page", key: "a", text: '<img src=x onerror="alert(1)">' };
    const thread = comment({ anchor: { ...hostile, text: "<b>bold</b>" } });
    const k = renderPanel(
      { items: [thread], posts: [] },
      {
        pageCompose: { req: REQ, anchor: hostile },
      },
    );
    await within(k.panel).findByText(/<b>bold<\/b>/);
    expect(within(k.panel).getByText(/Placed by the page/).textContent).toContain("<img src=x");
    expect(k.panel.querySelector("img")).toBeNull();
    expect(k.panel.querySelector("b")).toBeNull();
  });

  it("draws pins where the page says, tells the page the picked thread and opens a thread", async () => {
    const pinned = comment({ anchor: { kind: "page", key: "canvas", x: 1, y: 2 } });
    const resolved = comment({ status: "resolved", anchor: { kind: "page", key: "b" } });
    const positions = new Map<string, PinPosition>([
      [pinned.id, { id: pinned.id, left: 100, top: 50, width: 0, height: 0, visible: true }],
    ]);
    const active = vi.fn();
    const items = vi.fn();
    const k = renderPanel(
      { items: [pinned, resolved], posts: [] },
      { pagePositions: positions, onActiveChange: active, onItemsChange: items },
    );
    await within(k.panel).findByText(/canvas/);
    expect(items).toHaveBeenCalledWith([pinned, resolved]);
    const pin = await screen.findByRole("button", { name: "Comment 1: canvas" });
    expect(pin.getAttribute("style")).toContain("translate(100px, 50px)");
    await userEvent.setup().click(pin);
    expect(active).toHaveBeenLastCalledWith(pinned.id);
    // The page asks for the resolved thread: the filter widens to show it.
    k.rerender({
      pagePositions: positions,
      onActiveChange: active,
      onItemsChange: items,
      pageOpen: { id: resolved.id, n: 1 },
    });
    await waitFor(() => expect(active).toHaveBeenLastCalledWith(resolved.id));
    expect((within(k.panel).getByRole("radio", { name: "All" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(within(k.panel).getByRole("button", { name: "Reopen" })).toBeTruthy();
    await act(async () => undefined);
  });
});
