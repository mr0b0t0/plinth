import { BRIDGE_MESSAGE_SOURCE, type CommentInfo } from "@plinth/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api } from "../../lib/api.ts";
import { CommentsPanel, POLL_MS } from "./CommentsPanel.tsx";

vi.mock("../../lib/api.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api.ts")>();
  return { ...mod, api: vi.fn() };
});

const apiMock = vi.mocked(api);
const ORIGIN = "http://art1.content.localhost:8787";

let n = 0;
function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "art1",
    version_number: 2,
    parent_id: null,
    author: { email: "ed@example.com", connection_id: null, label: "Ed Itor" },
    body: "A comment",
    anchor: null,
    status: "open",
    created_at: new Date(Date.now() - 3_600_000 + 1000 * n).toISOString(),
    mentions: [],
    ...over,
  };
}

interface Server {
  items: CommentInfo[];
  /** Extra fields on the list response (can_comment, signed_in). */
  list?: Record<string, unknown>;
  post?: (body: Record<string, unknown>) => CommentInfo | Promise<CommentInfo>;
  calls: { path: string; method: string; body: unknown }[];
}

function serve(server: Server) {
  apiMock.mockImplementation(
    async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const method = opts.method ?? "GET";
      server.calls.push({ path, method, body: opts.body });
      if (method === "GET") return { items: server.items, ...server.list } as never;
      if (method === "POST") {
        const created = await (server.post?.(opts.body as Record<string, unknown>) ??
          comment({ body: String((opts.body as { body: string }).body) }));
        server.items = [...server.items, created];
        return created as never;
      }
      if (method === "PATCH") {
        const id = path.split("/").pop();
        const c = server.items.find((x) => x.id === id);
        if (!c) throw new ApiRequestError(404, "not_found", "Not found");
        c.status = (opts.body as { status: "open" | "resolved" }).status;
        return { ...c } as never;
      }
      throw new Error(`unexpected ${method} ${path}`);
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
  const send = (data: Record<string, unknown>, opts: { origin?: string; source?: unknown } = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: BRIDGE_MESSAGE_SOURCE, v: 1, ...data },
          origin: opts.origin ?? ORIGIN,
          source: (opts.source ?? frameWin) as MessageEventSource,
        }),
      );
    });
  const sent = () =>
    frameWin.postMessage.mock.calls.map(
      ([m, origin]) => ({ ...(m as Record<string, unknown>), origin }) as Record<string, unknown>,
    );
  return { frame, frameWin, send, sent };
}

function renderPanel(
  server: Server,
  props: Partial<Parameters<typeof CommentsPanel>[0]> = {},
  frameKit = fakeFrame(),
) {
  serve(server);
  const onClose = vi.fn();
  const utils = render(
    <CommentsPanel
      artifactId="art1"
      slug="my-art-abc"
      version={2}
      frame={frameKit.frame}
      contentOrigin={ORIGIN}
      onClose={onClose}
      {...props}
    />,
  );
  const panel = screen.getByRole("region", { name: "Comments" });
  return { ...utils, ...frameKit, onClose, panel };
}

beforeEach(() => {
  apiMock.mockReset();
  window.history.replaceState(null, "", "/a/my-art-abc");
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("CommentsPanel", () => {
  it("is a labelled region that takes focus and closes on Escape", async () => {
    const server: Server = { items: [], calls: [] };
    const { onClose, panel } = renderPanel(server);
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Comments" }));
    await screen.findByText("No comments yet.");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Close comments" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders threads with authors, agents, versions, Markdown and mention chips", async () => {
    const root = comment({
      body: "**Bold** ask @claude please",
      version_number: 1,
      anchor: { selector: "h1", text: "The heading", x: 0.5, y: 0.5 },
      mentions: [
        { task_id: "t1", target: "@claude", state: "done", delivery: null, result_version: 3 },
      ],
    });
    const reply = comment({
      parent_id: root.id,
      body: "Done in v3",
      author: { email: null, connection_id: "conn1", label: "Work Claude" },
      version_number: 2,
    });
    const other = comment({
      mentions: [
        {
          task_id: "t2",
          target: "@codex",
          state: "pending",
          delivery: "waiting" as const,
          result_version: null,
        },
        {
          task_id: "t5",
          target: "@claude",
          state: "pending",
          delivery: "sent" as const,
          result_version: null,
        },
        {
          task_id: "t3",
          target: "@work-claude",
          state: "claimed",
          delivery: null,
          result_version: null,
        },
        { task_id: "t4", target: "@claude", state: "failed", delivery: null, result_version: null },
      ],
    });
    const { panel } = renderPanel({ items: [root, reply, other], calls: [] });
    await screen.findByText("Bold");
    expect(within(panel).getByTestId("comments-count").textContent).toBe("2 open");
    expect(panel.querySelector("strong")?.textContent).toBe("Bold");
    expect(panel.querySelector(".mention")?.textContent).toBe("@claude");
    // "on v1": made on an older version than the one shown.
    expect(within(panel).getByText("on v1")).toBeTruthy();
    expect(within(panel).queryByText("on v2")).toBeNull();
    // Agent author is marked.
    const agentComment = within(panel).getByText("Work Claude").closest(".cm-comment");
    expect(agentComment?.textContent).toContain("Agent");
    // Chips: done links the version.
    const done = panel.querySelector('[data-state="done"]');
    expect(done?.textContent).toContain("@claude");
    expect(done?.textContent).toContain("done");
    const link = within(done as HTMLElement).getByRole("link", { name: "v3" });
    expect(link.getAttribute("href")).toBe("/a/my-art-abc/v/3");
    // A pending request says whether an agent session has it.
    expect(panel.querySelector('[data-state="pending"]')?.textContent).toContain("waiting");
    expect(
      [...panel.querySelectorAll('[data-state="pending"]')].map((e) => e.textContent).join(" "),
    ).toContain("sent");
    expect(panel.querySelector('[data-state="claimed"]')?.textContent).toContain("claimed");
    expect(panel.querySelector('[data-state="failed"]')?.textContent).toContain("failed");
    // Relative date with the full timestamp as a tooltip.
    const time = panel.querySelector("time");
    expect(time?.getAttribute("title")).toMatch(/\d{4}/);
    expect(time?.textContent).toMatch(/ago|just now/);
    // Pinned thread shows its number and excerpt.
    expect(within(panel).getByText(/The heading/)).toBeTruthy();
  });

  it("renders hostile comment text inert", async () => {
    const hostile = comment({
      body: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>alert(2)</script> <a href="javascript:alert(3)">y</a>',
      author: { email: null, connection_id: null, label: "<b>Mallory</b>" },
      anchor: { selector: "h1", text: "<img src=y onerror=alert(4)>" },
    });
    const { panel } = renderPanel({ items: [hostile], calls: [] });
    await screen.findByText("<b>Mallory</b>");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("script")).toBeNull();
    expect(panel.querySelector("b")).toBeNull();
    for (const a of panel.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    }
    expect(panel.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });

  it("filters open, resolved and all threads; resolves and reopens", async () => {
    const a = comment({ body: "Open one" });
    const b = comment({ body: "Closed one", status: "resolved" });
    const server: Server = { items: [a, b], calls: [] };
    const { panel } = renderPanel(server);
    const user = userEvent.setup();
    await screen.findByText("Open one");
    expect(within(panel).queryByText("Closed one")).toBeNull();
    await user.click(within(panel).getByRole("radio", { name: "Resolved" }));
    expect(within(panel).getByText("Closed one")).toBeTruthy();
    expect(within(panel).queryByText("Open one")).toBeNull();
    await user.click(within(panel).getByRole("radio", { name: "All" }));
    expect(within(panel).getByText("Open one")).toBeTruthy();
    expect(within(panel).getByText("Closed one")).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(server.calls).toContainEqual({
        path: `/comments/${a.id}`,
        method: "PATCH",
        body: { status: "resolved" },
      }),
    );
    await waitFor(() =>
      expect(within(panel).getAllByRole("button", { name: "Reopen" })).toHaveLength(2),
    );
  });

  it("posts a comment with Ctrl+Enter on the shown version and announces it", async () => {
    const server: Server = {
      items: [],
      calls: [],
      post: (body) =>
        comment({
          body: String(body.body),
          mentions: [
            {
              task_id: "t9",
              target: "@claude",
              state: "pending",
              delivery: "waiting" as const,
              result_version: null,
            },
          ],
        }),
    };
    const { panel } = renderPanel(server);
    const user = userEvent.setup();
    await screen.findByText("No comments yet.");
    const box = within(panel).getByRole("textbox", { name: "New comment" });
    await user.type(box, "Make it pop @claude");
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(server.calls).toContainEqual({
        path: "/artifacts/art1/comments",
        method: "POST",
        body: { body: "Make it pop @claude", version_number: 2 },
      }),
    );
    const chip = await waitFor(() => {
      const el = panel.querySelector('[data-state="pending"]');
      if (!el) throw new Error("no chip yet");
      return el;
    });
    expect(chip.textContent).toContain("@claude");
    expect((box as HTMLTextAreaElement).value).toBe("");
    await waitFor(() => expect(panel.textContent).toContain("Comment posted. @claude waiting."));
  });

  it("offers @claude and @codex with keyboard navigation", async () => {
    const { panel } = renderPanel({ items: [], calls: [] });
    const user = userEvent.setup();
    const box = within(panel).getByRole("textbox", { name: "New comment" }) as HTMLTextAreaElement;
    await user.type(box, "Ask @");
    const list = within(panel).getByRole("listbox", { name: "Mention an agent" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["@claude", "@codex"]);
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await user.keyboard("{Enter}");
    expect(box.value).toBe("Ask @codex ");
    expect(within(panel).queryByRole("listbox")).toBeNull();
    // The caret sits after the mention, so typing goes on from there.
    await user.keyboard("now ");
    expect(box.value).toBe("Ask @codex now ");
    // Escape in the list closes the list, not the panel.
    await user.type(box, "and @cl");
    expect(within(panel).getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(within(panel).queryByRole("listbox")).toBeNull();
  });

  it("says up front when the viewer cannot comment, before anything is typed", async () => {
    const server: Server = { items: [], calls: [], list: { can_comment: false, signed_in: false } };
    const { panel, unmount } = renderPanel(server);
    await within(panel).findByRole("link", { name: "Sign in to comment" });
    expect(within(panel).queryByRole("textbox", { name: "New comment" })).toBeNull();
    expect(panel.textContent).not.toContain("mention @claude");
    unmount();
  });

  it("shows sign in on 401 and a view-only note on 403", async () => {
    const server: Server = {
      items: [comment({ body: "Existing" })],
      calls: [],
      post: () => {
        throw new ApiRequestError(401, "unauthorized", "Sign in");
      },
    };
    const { panel, unmount } = renderPanel(server);
    const user = userEvent.setup();
    await screen.findByText("Existing");
    await user.type(within(panel).getByRole("textbox", { name: "New comment" }), "Hello");
    await user.click(within(panel).getByRole("button", { name: "Comment" }));
    const link = await within(panel).findByRole("link", { name: "Sign in to comment" });
    expect(link.getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/a/my-art-abc")}`);
    expect(within(panel).queryByRole("button", { name: "Reply" })).toBeNull();
    unmount();

    server.post = () => {
      throw new ApiRequestError(403, "forbidden", "No");
    };
    const second = renderPanel(server);
    await screen.findByText("Existing");
    await user.type(within(second.panel).getByRole("textbox", { name: "New comment" }), "Hi");
    await user.click(within(second.panel).getByRole("button", { name: "Comment" }));
    expect(
      await within(second.panel).findByText("You can view this artifact but not comment on it"),
    ).toBeTruthy();
  });

  it("replies in a thread", async () => {
    const root = comment({ body: "Root" });
    const server: Server = { items: [root], calls: [] };
    const { panel } = renderPanel(server);
    const user = userEvent.setup();
    await screen.findByText("Root");
    await user.click(within(panel).getByRole("button", { name: "Reply" }));
    const box = within(panel).getByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await user.type(box, "Thanks");
    await user.click(within(panel).getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(server.calls).toContainEqual({
        path: "/artifacts/art1/comments",
        method: "POST",
        body: { body: "Thanks", parent_id: root.id, version_number: 2 },
      }),
    );
  });

  it("pins a comment to an element through the bridge, ignoring forged or unrequested picks", async () => {
    const server: Server = { items: [], calls: [] };
    const { panel, send, sent, frameWin } = renderPanel(server);
    const user = userEvent.setup();
    await screen.findByText("No comments yet.");

    // A pick nobody asked for is ignored.
    send({ type: "pick", anchor: { selector: "h1", text: "Sneaky", x: 0, y: 0 } });
    expect(within(panel).queryByText(/Sneaky/)).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Pin to an element" }));
    expect(sent()).toContainEqual({
      type: "pick:start",
      source: BRIDGE_MESSAGE_SOURCE,
      v: 1,
      origin: ORIGIN,
    });
    expect(
      within(panel).getByText("Click an element in the artifact (Esc to cancel)"),
    ).toBeTruthy();

    // Wrong origin, wrong window, malformed: all ignored.
    send(
      { type: "pick", anchor: { selector: "h1", text: "Evil", x: 0, y: 0 } },
      { origin: "http://other.content.localhost:8787" },
    );
    send(
      { type: "pick", anchor: { selector: "h1", text: "Evil", x: 0, y: 0 } },
      { source: window },
    );
    send({ type: "pick", anchor: { selector: "h1", text: "Evil", x: 9, y: 0 } });
    expect(within(panel).queryByText(/Evil/)).toBeNull();
    expect(
      within(panel).getByText("Click an element in the artifact (Esc to cancel)"),
    ).toBeTruthy();

    send({
      type: "pick",
      anchor: { selector: "body > h1:nth-of-type(1)", text: "Hello world", x: 0.2, y: 0.4 },
    });
    expect(within(panel).getByText("Hello world")).toBeTruthy();
    expect(within(panel).queryByText(/Click an element/)).toBeNull();

    await user.type(within(panel).getByRole("textbox", { name: "New comment" }), "Red please");
    await user.click(within(panel).getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(server.calls).toContainEqual({
        path: "/artifacts/art1/comments",
        method: "POST",
        body: {
          body: "Red please",
          version_number: 2,
          anchor: { selector: "body > h1:nth-of-type(1)", text: "Hello world", x: 0.2, y: 0.4 },
        },
      }),
    );
    // Every post went to the content origin, never "*".
    for (const call of frameWin.postMessage.mock.calls) expect(call[1]).toBe(ORIGIN);
  });

  it("pins through the bridge under opaque isolation: origin null from the frame's window", async () => {
    const server: Server = { items: [], calls: [] };
    const { panel, send, sent } = renderPanel(server, { opaque: true });
    const user = userEvent.setup();
    await screen.findByText("No comments yet.");
    await user.click(within(panel).getByRole("button", { name: "Pin to an element" }));
    // An opaque origin cannot be named: the post goes to "*", and carries no secret.
    expect(sent()).toContainEqual({
      type: "pick:start",
      source: BRIDGE_MESSAGE_SOURCE,
      v: 1,
      origin: "*",
    });
    // The artifact origin (which an opaque document never reports) and other windows: ignored.
    send(
      { type: "pick", anchor: { selector: "h1", text: "Evil", x: 0, y: 0 } },
      { origin: ORIGIN },
    );
    send(
      { type: "pick", anchor: { selector: "h1", text: "Evil", x: 0, y: 0 } },
      { origin: "null", source: window },
    );
    expect(within(panel).queryByText(/Evil/)).toBeNull();
    send(
      { type: "pick", anchor: { selector: "body > h1:nth-of-type(1)", text: "Hello", x: 0, y: 0 } },
      { origin: "null" },
    );
    expect(within(panel).getByText("Hello")).toBeTruthy();
  });

  it("cancels picking with Escape without closing the panel, and the anchor chip is removable", async () => {
    const { panel, send, sent, onClose } = renderPanel({ items: [], calls: [] });
    const user = userEvent.setup();
    await screen.findByText("No comments yet.");
    await user.click(within(panel).getByRole("button", { name: "Pin to an element" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(sent().at(-1)).toMatchObject({ type: "pick:stop" });
    expect(within(panel).queryByText(/Click an element/)).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Pin to an element" }));
    send({ type: "pick", anchor: { selector: "p", text: "Para", x: 0, y: 0 } });
    await user.click(within(panel).getByRole("button", { name: "Remove pin" }));
    expect(within(panel).queryByText("Para")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Pin to an element" })).toBeTruthy();
  });

  it("highlights open anchors, re-sends on ready, and draws pins from positions", async () => {
    const pinned = comment({
      body: "Pinned",
      anchor: { selector: "h1", text: "Head", x: 0.5, y: 0.5 },
    });
    const closed = comment({ body: "Closed", status: "resolved", anchor: { selector: "p" } });
    const plain = comment({ body: "Plain" });
    const { panel, send, sent } = renderPanel({ items: [pinned, closed, plain], calls: [] });
    await screen.findByText("Pinned");
    await waitFor(() =>
      expect(sent()).toContainEqual({
        type: "highlight",
        anchors: [{ id: pinned.id, selector: "h1" }],
        source: BRIDGE_MESSAGE_SOURCE,
        v: 1,
        origin: ORIGIN,
      }),
    );
    const before = sent().filter((m) => m.type === "highlight").length;
    send({ type: "ready" });
    expect(sent().filter((m) => m.type === "highlight").length).toBe(before + 1);

    send({
      type: "positions",
      items: [
        { id: pinned.id, top: 40, left: 100, width: 200, height: 20, visible: true },
        { id: "unknown", top: 0, left: 0, width: 10, height: 10, visible: true },
      ],
    });
    const layer = document.querySelector<HTMLElement>('[data-testid="comment-pins"]');
    expect(layer).toBeTruthy();
    expect(panel.contains(layer)).toBe(false);
    // The layer sits on the frame's content box and passes pointer events through (CSS).
    expect(layer?.style.top).toBe("100px");
    expect(layer?.style.left).toBe("50px");
    const pins = layer?.querySelectorAll("button") ?? [];
    expect(pins).toHaveLength(1);
    const pin = pins[0] as HTMLButtonElement;
    expect(pin.textContent).toBe("1");
    expect(pin.getAttribute("aria-label")).toBe("Comment 1: Head");
    // left + width * x, top + height * y
    expect(pin.style.transform).toBe("translate(200px, 50px)");

    await userEvent.setup().click(pin);
    const thread = panel.querySelector(`[data-thread-id="${pinned.id}"]`);
    await waitFor(() => expect(document.activeElement).toBe(thread));
    expect(thread?.hasAttribute("data-active")).toBe(true);
    expect(pin.hasAttribute("data-active")).toBe(true);

    send({
      type: "positions",
      items: [{ id: pinned.id, top: 40, left: 100, width: 200, height: 20, visible: false }],
    });
    expect(document.querySelectorAll('[data-testid="comment-pins"] button')).toHaveLength(0);
  });

  it("focusing a thread highlights its pin", async () => {
    const pinned = comment({ body: "Pinned", anchor: { selector: "h1", text: "Head" } });
    const { panel, send } = renderPanel({ items: [pinned], calls: [] });
    await screen.findByText("Pinned");
    send({
      type: "positions",
      items: [{ id: pinned.id, top: 10, left: 10, width: 10, height: 10, visible: true }],
    });
    const pin = document.querySelector<HTMLElement>('[data-testid="comment-pins"] button');
    expect(pin?.hasAttribute("data-active")).toBe(false);
    act(() => panel.querySelector<HTMLElement>(`[data-thread-id="${pinned.id}"]`)?.focus());
    expect(pin?.hasAttribute("data-active")).toBe(true);
  });

  it("does not draw pins that would sit on top of the panel (narrow screens)", async () => {
    const pinned = comment({ body: "Pinned", anchor: { selector: "h1", text: "Head" } });
    const { panel, send } = renderPanel({ items: [pinned], calls: [] });
    await screen.findByText("Pinned");
    // The panel covers the whole frame, as on a phone.
    panel.getBoundingClientRect = () =>
      ({ top: 100, left: 50, width: 800, height: 600, right: 850, bottom: 700 }) as DOMRect;
    send({
      type: "positions",
      items: [{ id: pinned.id, top: 10, left: 10, width: 10, height: 10, visible: true }],
    });
    expect(document.querySelectorAll('[data-testid="comment-pins"] button')).toHaveLength(0);
  });

  it("polls every 15 seconds while visible and announces new comments", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server: Server = { items: [comment({ body: "First" })], calls: [] };
    const { panel } = renderPanel(server);
    await screen.findByText("First");
    const gets = () => server.calls.filter((c) => c.method === "GET").length;
    expect(gets()).toBe(1);
    server.items = [...server.items, comment({ body: "Second" })];
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    await screen.findByText("Second");
    expect(gets()).toBe(2);
    await waitFor(() => expect(panel.textContent).toContain("1 new comment"));

    // Hidden tab: no polling.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS * 2);
    });
    expect(gets()).toBe(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    await userEvent.setup().click(within(panel).getByRole("button", { name: "Refresh comments" }));
    await waitFor(() => expect(gets()).toBe(3));
  });

  it("does not use the bridge without a frame or content origin", async () => {
    const kit = fakeFrame();
    const { panel } = renderPanel({ items: [], calls: [] }, { contentOrigin: "" }, kit);
    await screen.findByText("No comments yet.");
    const pick = within(panel).getByRole("button", {
      name: "Pin to an element",
    }) as HTMLButtonElement;
    expect(pick.disabled).toBe(true);
    expect(kit.frameWin.postMessage).not.toHaveBeenCalled();
  });
});
