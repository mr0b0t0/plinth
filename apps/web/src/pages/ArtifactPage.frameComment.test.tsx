// Asking an agent on the artifact page (docs/spec.md "Asking an agent"): comments are the one way
// in. No Ask an agent button, menu item or dialog for anyone; the composer suggests the owner's
// agents (@agent:other only when the owner has one) and posts a plain comment; a renderer's
// "Comment" opens the comments panel with the composer pinned to its place, under the rules for a
// page's own compose; and `?edit` where this person cannot edit on the page.
import type { ViewArtifact, ViewGate } from "@plinth/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactPage.tsx")).default;
}

const keyOf = (el: Element) =>
  /#plinth-k=([A-Za-z0-9_-]{43})$/.exec(el.getAttribute("src") ?? "")?.[1];
const ENTER = (n: number) =>
  `http://art123.content.localhost:8787/__plinth/enter?t=token-${n}&next=%2F`;

const PAGE: ViewArtifact = {
  id: "art123",
  slug: "garden-plan",
  title: "Garden plan",
  type: "html",
  current_version: 3,
  version: 3,
  visibility: "allowlist",
  owner_name: null,
};
const DOC: ViewArtifact = { ...PAGE, type: "doc", title: "Plan" };

type OkGate = Extract<ViewGate, { status: "ok" }>;
const gateOf = (over: Partial<OkGate> = {}, n = 1): ViewGate => ({
  status: "ok",
  artifact: PAGE,
  enter_url: ENTER(n),
  role: "owner",
  ask: { targets: ["claude", "other"] },
  ...over,
});

const created = (body: Record<string, unknown>) => ({
  id: "c1",
  artifact_id: "art123",
  version_number: body.version_number,
  parent_id: null,
  author: { label: "Ada", email: ME.email, connection_id: null },
  body: body.body,
  anchor: body.anchor ?? null,
  status: "open",
  created_at: new Date().toISOString(),
  mentions: [],
});

/** A stub API that answers the gate and the comments, and records every comment posted. */
function stub(
  gate: ViewGate | ((n: number) => ViewGate),
  extra?: (c: Call) => Response | undefined,
) {
  const posted: Record<string, unknown>[] = [];
  let views = 0;
  const api = stubApi({
    me: ME,
    handle: (c) => {
      if (c.path.startsWith("/view/")) {
        views += 1;
        return json(typeof gate === "function" ? gate(views) : gate);
      }
      const more = extra?.(c);
      if (more) return more;
      if (c.path === "/artifacts/art123/comments" && c.method === "POST") {
        const body = c.body as Record<string, unknown>;
        posted.push(body);
        return json(created(body), 201);
      }
      if (c.path.startsWith("/artifacts/art123/comments")) return json({ items: [] });
      return undefined;
    },
  });
  return { ...api, posted, views: () => views };
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/a/garden-plan");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("no Ask an agent: comments are the way in", () => {
  it("offers no Ask an agent button or menu item, whatever the type, role or editing", async () => {
    const DECK: ViewArtifact = { ...PAGE, type: "slides", title: "Plan" };
    for (const gate of [
      gateOf(),
      gateOf({ artifact: { ...PAGE, type: "design", title: "Plan" } }),
      gateOf({ artifact: DECK, no_editor: true }),
      gateOf({ artifact: DOC, role: "editor", live_off: { reason: "isolation" } }),
      gateOf({ artifact: DOC, role: "commenter" }),
    ]) {
      stub(gate);
      const ArtifactPage = await loadPage();
      const user = userEvent.setup();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      await screen.findByTitle(/version 3$/);
      expect(screen.queryByRole("button", { name: "Ask an agent" })).toBeNull();
      // Where editing on the page is off, nothing takes Edit's place either.
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Artifact actions" }));
      expect(screen.queryByRole("menuitem", { name: "Ask an agent" })).toBeNull();
      await user.keyboard("{Escape}");
      cleanup();
    }
  });

  it("suggests @agent:other when the owner has such an agent, and posts a plain comment", async () => {
    const s = stub(gateOf({ role: "commenter" }));
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement);
    const panel = await screen.findByRole("region", { name: "Comments" });
    const box = await within(panel).findByRole("textbox", { name: "New comment" });
    await user.type(box, "@ag");
    const list = within(panel).getByRole("listbox", { name: "Mention an agent" });
    const option = within(list).getByRole("option", { name: /@agent:other/ });
    expect(option.textContent).toContain("ChatGPT, Cursor, Gemini");
    await user.keyboard("{Enter}");
    await user.type(box, "add a footer");
    await user.click(within(panel).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    // The mention is in the text: no `request_to`.
    expect(s.posted[0]).toEqual({ body: "@agent:other add a footer", version_number: 3 });
  });

  it("suggests only @claude and @codex when the owner has no other agent", async () => {
    stub(gateOf({ ask: { targets: ["claude"] } }));
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement);
    const panel = await screen.findByRole("region", { name: "Comments" });
    await user.type(await within(panel).findByRole("textbox", { name: "New comment" }), "@");
    const list = within(panel).getByRole("listbox", { name: "Mention an agent" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["@claude", "@codex"]);
  });
});

describe("Comment from the page", () => {
  // happy-dom does not load frames: give each one a window to post to and receive from.
  const wins = new WeakMap<HTMLIFrameElement, { postMessage: ReturnType<typeof vi.fn> }>();
  let restore: PropertyDescriptor | undefined;
  beforeEach(() => {
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
    if (restore) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", restore);
  });
  // An editor who must sign in first is not editing: a keyless "Comment" is a hint the page may
  // give. Owners and editors who edit (always, from the moment the page opens) are below.
  const docGate = (n = 1) =>
    gateOf(
      { artifact: DOC, role: "editor", live: { mode: "room", draft: null, sign_in: true } },
      n,
    );
  const editingGate = (n = 1) =>
    gateOf({ artifact: DOC, role: "editor", live: { mode: "room", draft: null } }, n);

  /** Post a renderer message from the frame the page shows now (`key`: the frame's, or none). */
  function poster() {
    return (data: Record<string, unknown>, key?: string | "frame") => {
      const frame = screen.getByTitle("Plan, version 3") as HTMLIFrameElement;
      const k = key === "frame" ? keyOf(frame) : key;
      const e = new MessageEvent("message", {
        origin: "http://art123.content.localhost:8787",
        data: { source: "plinth-renderer", v: 1, ...(k ? { key: k } : {}), ...data },
      });
      Object.defineProperty(e, "source", { value: frame.contentWindow });
      act(() => {
        window.dispatchEvent(e);
      });
    };
  }

  async function open(extra?: (c: Call) => Response | undefined, gate = docGate) {
    const s = stub((n) => gate(n), extra);
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    return { s, user, post: poster() };
  }

  it("opens the comments panel pinned to the place, and posts a plain comment about it", async () => {
    const { s, user, post } = await open();
    post({ type: "ask", anchor: { key: "slide-3:image-1", text: "Slide 3, image 1" } });
    const panel = await screen.findByRole("region", { name: "Comments" });
    const form = within(panel).getByRole("form", { name: "New comment" });
    expect(await within(form).findByText(/Pinned to/)).toBeTruthy();
    expect(within(form).getByText("Slide 3, image 1")).toBeTruthy();
    const box = within(form).getByRole("textbox", { name: "New comment" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    // A plain composer: no agent choice, no title of its own.
    expect(within(form).queryByRole("radio")).toBeNull();
    expect(within(form).queryByRole("combobox")).toBeNull();
    expect(within(panel).getByRole("heading", { name: "Comments" })).toBeTruthy();
    await user.type(box, "@claude swap it");
    await user.click(within(form).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toEqual({
      body: "@claude swap it",
      version_number: 3,
      anchor: { kind: "page", key: "slide-3:image-1", text: "Slide 3, image 1" },
    });
    // The panel stays, with the thread.
    expect(screen.getByRole("region", { name: "Comments" })).toBe(panel);
  });

  it("Remove pin makes the comment about the whole page", async () => {
    const { s, user, post } = await open();
    post({ type: "ask", anchor: { key: "block-1", text: "Intro" }, what: "paragraph" });
    const panel = await screen.findByRole("region", { name: "Comments" });
    await within(panel).findByText("Intro");
    await user.click(within(panel).getByRole("button", { name: "Remove pin" }));
    expect(within(panel).queryByText(/Pinned to/)).toBeNull();
    await user.type(within(panel).getByRole("textbox", { name: "New comment" }), "Tidy");
    await user.click(within(panel).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).not.toHaveProperty("anchor");
  });

  it("takes at most one a second, even with the panel open, and drops a malformed place", async () => {
    const { post } = await open();
    post({ type: "ask", anchor: { key: "block-1", text: "First block" } });
    const panel = await screen.findByRole("region", { name: "Comments" });
    expect(await within(panel).findByText("First block")).toBeTruthy();
    // The panel is open, so nothing is reopened: still, a second one right away changes nothing
    // (it would pin the composer elsewhere and take the focus again).
    post({ type: "ask", anchor: { key: "block-2", text: "Second block" } });
    await wait(20);
    expect(within(panel).queryByText("Second block")).toBeNull();
    await wait(1000);
    post({ type: "ask", anchor: { key: "<b>", text: "x" } });
    await wait(20);
    expect(within(panel).getByText("First block")).toBeTruthy();
    post({ type: "ask", anchor: { key: "block-2", text: "Second block" } });
    expect(await within(panel).findByText("Second block")).toBeTruthy();
  });

  it("names a new image below a doc block, a block only in the draft, and a place with no words", async () => {
    const { user, post } = await open();
    const chip = async () => {
      const panel = await screen.findByRole("region", { name: "Comments" });
      return (await within(panel).findByText(/Pinned to|New image below/)).textContent;
    };
    const closeAndWait = async () => {
      await user.click(screen.getByRole("button", { name: "Close comments" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Comments" })).toBeNull());
      await wait(1000);
    };
    post({ type: "ask", anchor: { key: "block-2:add-image", text: "Intro" }, what: "paragraph" });
    // Not "Pinned to the image": there is no image there yet.
    expect(await chip()).toBe("New image below Intro");
    await closeAndWait();
    post({ type: "ask", anchor: { key: "new-1:add-image", text: "" }, what: "divider" });
    expect(await chip()).toBe("New image below the divider (not published yet)");
    await closeAndWait();
    post({ type: "ask", anchor: { key: "new-1", text: "Draft words" }, what: "paragraph" });
    expect(await chip()).toBe("Pinned to Draft words (not published yet)");
    await closeAndWait();
    post({ type: "ask", anchor: { key: "block-4", text: "" }, what: "divider" });
    expect(await chip()).toBe("Pinned to the divider");
  });

  it("is refused while the tab is hidden or a dialog is open, and reopens a closed panel at most once a second", async () => {
    const { user, post } = await open();
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      post({ type: "ask", anchor: { key: "block-1", text: "Intro" } });
      await wait(20);
      expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    } finally {
      // The own property shadowed the prototype's getter.
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (visibility) expect(document.visibilityState).toBe("visible");
    }
    await user.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("dialog");
    post({ type: "ask", anchor: { key: "block-1", text: "Intro" } });
    await wait(20);
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    post({ type: "ask", anchor: { key: "block-1", text: "Intro" } });
    await screen.findByRole("region", { name: "Comments" });
    await user.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Comments" })).toBeNull());
    // Closed by the person: the frame cannot open it again at once.
    post({ type: "ask", anchor: { key: "block-2", text: "Again" } });
    await wait(20);
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    await wait(1000);
    post({ type: "ask", anchor: { key: "block-2", text: "Again" } });
    const panel = await screen.findByRole("region", { name: "Comments" });
    expect(await within(panel).findByText("Again")).toBeTruthy();
  });

  it("in edit mode, takes it only with the frame's key, and opens the comments panel pinned there, still editing", async () => {
    const { s, user, post } = await open(undefined, editingGate);
    // Edit mode is on from the start: no toggle to press.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    const views = s.views();
    post(
      {
        type: "live",
        connected: true,
        failed: false,
        editing: true,
        holding: false,
        dirty: true,
        unflushed: false,
        rev: 7,
        base_version: 3,
        conflict_version: null,
        last_by_you: true,
        last_edit_at: null,
        editors: [],
        publishable: true,
      },
      "frame",
    );
    // Another document's key, or none at all: dropped while editing.
    post({ type: "ask", anchor: { key: "block-1", text: "Misleading" } }, "A".repeat(43));
    post({ type: "ask", anchor: { key: "block-1", text: "Misleading" } });
    await wait(20);
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();

    post({ type: "ask", anchor: { key: "block-1", text: "Intro" }, what: "paragraph" }, "frame");
    const panel = await screen.findByRole("region", { name: "Comments" });
    expect(await within(panel).findByText("Intro")).toBeTruthy();
    // Still editing, with the changes unpublished: nothing was published and the frame was not
    // read again into review mode.
    expect(screen.getByRole("region", { name: "Editing on the page" })).toBeTruthy();
    expect(s.calls.some((c) => c.path.includes("/live/checkpoint"))).toBe(false);
    expect(s.views()).toBe(views);
    await user.type(within(panel).getByRole("textbox", { name: "New comment" }), "@claude fix");
    await user.click(within(panel).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({
      body: "@claude fix",
      anchor: { kind: "page", key: "block-1", text: "Intro" },
    });
    expect(s.posted[0]).not.toHaveProperty("request_to");
  });
});

describe("?edit where this person cannot edit on the page", () => {
  it("adds no notice, and is dropped from the address", async () => {
    for (const gate of [
      gateOf({ artifact: DOC, role: "editor", live_off: { reason: "disabled" } }),
      gateOf({ artifact: DOC, role: "commenter" }),
      gateOf({ artifact: DOC, role: "viewer", ask: undefined }),
    ]) {
      window.history.replaceState(null, "", "/a/garden-plan?edit");
      stub(gate);
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      await screen.findByTitle("Plan, version 3");
      await waitFor(() => expect(window.location.search).toBe(""));
      expect(screen.queryByRole("status", { name: /edit/i })).toBeNull();
      expect(screen.queryByText(/can edit this page/)).toBeNull();
      cleanup();
    }
  });

  it("focuses the ⋯ menu, which holds Sign in to edit, for an editor confirmed by code", async () => {
    window.history.replaceState(null, "", "/a/garden-plan?edit");
    stub(
      gateOf({ artifact: DOC, role: "editor", live: { mode: "room", draft: null, sign_in: true } }),
    );
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const menu = await screen.findByRole("button", { name: "Artifact actions" });
    await waitFor(() => expect(document.activeElement).toBe(menu));
    await user.click(menu);
    expect(screen.getByRole("menuitem", { name: "Sign in to edit" })).toBeTruthy();
  });
});
