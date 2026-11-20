// Ask an agent on the artifact page (docs/spec.md "Ask an agent"): the bar's Edit slot for pages and
// designs and where editing on the page is off, the ⋯ item for commenters, request mode in the
// comments panel with the agent choice and `request_to`, nothing at all when no agent can take a
// request, `?edit`, and the Ask dialog in edit mode, which keeps edit mode, the frame and the
// closed comments panel.
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
  mentions: body.request_to
    ? [{ task_id: "t1", target: "@claude", state: "pending", result_version: null }]
    : [],
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

beforeEach(() => {
  window.history.replaceState(null, "", "/a/garden-plan");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ask an agent: not editing", () => {
  it("takes the Edit slot for an owner of a page, and asks in request mode with request_to", async () => {
    const s = stub(gateOf());
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    // In the bar, so not again in the ⋯ menu; the source editor item stays until it is removed.
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    expect(screen.queryByRole("menuitem", { name: "Ask an agent" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Ask an agent" }));
    const panel = await screen.findByRole("region", { name: "Comments" });
    const form = within(panel).getByRole("form", { name: "Ask an agent" });
    // One review-mode reload for the pick.
    await waitFor(() => expect(s.views()).toBe(2));
    expect(within(form).getByRole("button", { name: "Point at something" })).toBeTruthy();
    // One heading and one close button: closing the panel ends the request. No @mention hint.
    expect(within(panel).getAllByRole("button", { name: /^Close|instead$/ })).toHaveLength(1);
    expect(within(panel).queryByText(/mention @claude/)).toBeNull();
    // The choice is labelled "Ask", on its own row: Send is the only button beside the point icon.
    const choice = within(form).getByRole("group", { name: "Ask" });
    const claude = within(choice).getByRole("radio", { name: "Claude" }) as HTMLInputElement;
    expect(claude.checked).toBe(true);
    expect(within(choice).queryByRole("button")).toBeNull();
    expect(within(form).getByRole("radio", { name: /My other agent/ })).toBeTruthy();
    await user.type(within(form).getByRole("textbox", { name: "What should change?" }), "Bigger");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toEqual({ body: "Bigger", version_number: 3, request_to: "claude" });
    // The composer is a plain comment again.
    await waitFor(() =>
      expect(within(panel).queryByRole("form", { name: "Ask an agent" })).toBeNull(),
    );
  });

  it("forgets the request once the panel closes: Comments opens a plain composer again", async () => {
    const s = stub(gateOf());
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getByRole("button", { name: "Ask an agent" }));
    let panel = await screen.findByRole("region", { name: "Comments" });
    expect(within(panel).getByRole("form", { name: "Ask an agent" })).toBeTruthy();
    // Closed without sending anything.
    await user.click(within(panel).getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Comments" })).toBeNull());

    await user.click(screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement);
    panel = await screen.findByRole("region", { name: "Comments" });
    const box = await within(panel).findByRole("textbox");
    expect(within(panel).queryByRole("form", { name: "Ask an agent" })).toBeNull();
    expect(within(panel).queryByRole("radio", { name: "Claude" })).toBeNull();
    await user.type(box, "Nice");
    await user.click(within(panel).getByRole("button", { name: /^(Post|Comment|Send)/ }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toEqual({ body: "Nice", version_number: 3 });

    // Asking again still opens request mode.
    await user.click(within(panel).getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Comments" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Ask an agent" }));
    panel = await screen.findByRole("region", { name: "Comments" });
    expect(await within(panel).findByRole("form", { name: "Ask an agent" })).toBeTruthy();
  });

  it("offers commenters a ⋯ item, never the bar, and posts to the agent they pick", async () => {
    const s = stub(gateOf({ role: "commenter", artifact: DOC }));
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.queryByRole("button", { name: "Ask an agent" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask an agent" }));
    const panel = await screen.findByRole("region", { name: "Comments" });
    const form = within(panel).getByRole("form", { name: "Ask an agent" });
    await user.click(within(form).getByRole("radio", { name: "The owner's other agent" }));
    await user.type(within(form).getByRole("textbox", { name: "What should change?" }), "Fix");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted[0]).toMatchObject({ request_to: "other" }));
  });

  it("offers three agents as one select labelled Ask", async () => {
    const s = stub(gateOf({ ask: { targets: ["claude", "codex", "other"] } }));
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getByRole("button", { name: "Ask an agent" }));
    const panel = await screen.findByRole("region", { name: "Comments" });
    const form = within(panel).getByRole("form", { name: "Ask an agent" });
    expect(within(form).queryByRole("radio")).toBeNull();
    const select = within(form).getByRole("combobox", { name: "Ask" }) as HTMLSelectElement;
    expect(Array.from(select.options, (o) => o.text)).toEqual([
      "Claude",
      "Codex",
      "My other agent",
    ]);
    await user.selectOptions(select, "codex");
    await user.type(within(form).getByRole("textbox", { name: "What should change?" }), "Do");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted[0]).toMatchObject({ request_to: "codex" }));
  });

  it("is not offered to viewers", async () => {
    stub(gateOf({ role: "viewer", ask: undefined }));
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    expect(screen.queryByRole("button", { name: "Ask an agent" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    expect(screen.queryByRole("menuitem", { name: "Ask an agent" })).toBeNull();
  });

  it("is not offered when the owner has no agent that takes requests", async () => {
    stub(gateOf({ role: "commenter", ask: { targets: [] } }));
    let ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    expect(screen.queryByRole("menuitem", { name: "Ask an agent" })).toBeNull();
    cleanup();

    stub(gateOf({ ask: { targets: [] } }));
    ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    expect(screen.queryByRole("button", { name: "Ask an agent" })).toBeNull();
  });

  it("reads the agents again when the one picked was disconnected (no_agent)", async () => {
    let targets: ("claude" | "codex" | "other")[] = ["claude", "codex"];
    const s = stub(
      () => gateOf({ role: "editor", ask: { targets } }),
      (c) =>
        c.path === "/artifacts/art123/comments" && c.method === "POST"
          ? json(
              {
                error: {
                  code: "invalid_input",
                  message: "No agent",
                  details: { field: "request_to", reason: "no_agent" },
                },
              },
              400,
            )
          : undefined,
    );
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    await user.click(screen.getByRole("button", { name: "Ask an agent" }));
    const panel = await screen.findByRole("region", { name: "Comments" });
    targets = ["codex"];
    await user.type(within(panel).getByRole("textbox", { name: "What should change?" }), "Do");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(
      await within(panel).findByText(
        "That agent was disconnected. Pick another, or post as a comment.",
      ),
    ).toBeTruthy();
    // One agent left: no choice, and the button names it.
    expect(await within(panel).findByRole("button", { name: "Send to Codex" })).toBeTruthy();
    expect(within(panel).queryByRole("radio", { name: "Claude" })).toBeNull();
    // The description is kept for another try.
    expect(
      (within(panel).getByRole("textbox", { name: "What should change?" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Do");
    expect(s.posted).toHaveLength(0);
  });
});

describe("Ask an agent where editing on the page is off", () => {
  const off = (reason: "disabled" | "isolation") =>
    gateOf({ artifact: DOC, role: "editor", live_off: { reason } });

  it("shows Ask an agent in the Edit slot with the reason, and no Edit", async () => {
    stub(off("isolation"));
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    const ask = screen.getByRole("button", { name: "Ask an agent" });
    const tip = document.getElementById(ask.getAttribute("aria-describedby") ?? "");
    expect(tip?.textContent).toBe(
      "Editing on the page isn't available with this instance's content isolation.",
    );
  });

  it("?edit adds no notice where this person cannot edit, and is dropped from the address", async () => {
    for (const gate of [
      off("disabled"),
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
      expect(screen.queryByText(/can edit this page|Ask an agent to make the change/)).toBeNull();
      cleanup();
    }
  });

  it("?edit focuses Sign in to edit for an editor confirmed by code", async () => {
    window.history.replaceState(null, "", "/a/garden-plan?edit");
    stub(
      gateOf({ artifact: DOC, role: "editor", live: { mode: "room", draft: null, sign_in: true } }),
    );
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const link = await screen.findByRole("link", { name: "Sign in to edit" });
    await waitFor(() => expect(document.activeElement).toBe(link));
  });
});

describe("Ask an agent in edit mode: the Ask dialog", () => {
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
  const docGate = (n = 1) =>
    gateOf({ artifact: DOC, role: "editor", live: { mode: "room", draft: null } }, n);

  /** Open the page, start editing, and have the frame report a dirty room draft. */
  async function editing(extra?: (c: Call) => Response | undefined, dirty = true) {
    const s = stub((n) => docGate(n), extra);
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
    const post = (data: Record<string, unknown>, key: string | undefined = keyOf(frame)) => {
      const e = new MessageEvent("message", {
        origin: "http://art123.content.localhost:8787",
        data: { source: "plinth-renderer", v: 1, ...(key ? { key } : {}), ...data },
      });
      Object.defineProperty(e, "source", { value: frame.contentWindow });
      act(() => {
        window.dispatchEvent(e);
      });
    };
    await user.click(screen.getByRole("button", { name: "Edit" }));
    post({
      type: "live",
      connected: true,
      failed: false,
      editing: true,
      holding: false,
      dirty,
      unflushed: false,
      rev: 7,
      base_version: 3,
      conflict_version: null,
      last_by_you: true,
      last_edit_at: null,
      editors: [],
      publishable: true,
    });
    return { s, user, frame, post, viewsAtStart: s.views() };
  }

  it("opens from the ⋯ item, keeps edit mode, the frame and the closed panel, and posts against the version edited", async () => {
    const { s, user, frame, viewsAtStart } = await editing();
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask an agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    const first = within(dialog).getByRole("checkbox", {
      name: /Publish my changes first/,
    }) as HTMLInputElement;
    expect(first.checked).toBe(false);
    expect(within(dialog).getByText("Otherwise the agent works from v3.")).toBeTruthy();
    // The agent choice sits in the body; the footer holds only Cancel and Send.
    expect(within(dialog).getByRole("group", { name: "Ask" })).toBeTruthy();
    const footer = dialog.querySelector(".pl-dialog__footer") as HTMLElement;
    expect(within(footer).queryByRole("radio")).toBeNull();
    expect(
      within(footer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cancel", "Send"]);
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Tidy");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ask an agent" })).toBeNull());
    expect(s.posted).toEqual([{ body: "Tidy", version_number: 3, request_to: "claude" }]);
    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    expect(s.views()).toBe(viewsAtStart);
    expect(screen.getByTitle("Plan, version 3")).toBe(frame);
    expect(s.calls.some((c) => c.path.includes("/live/checkpoint"))).toBe(false);
  });

  it("with Publish my changes first, publishes, then posts against the new version", async () => {
    const { s, user } = await editing((c) =>
      c.path === "/artifacts/art123/live/checkpoint"
        ? json({
            saved: true,
            version: { id: "art123", slug: "garden-plan", version: 4, url: "", warnings: [] },
            live: { rev: 7, dirty: false },
          })
        : undefined,
    );
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask an agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Publish my changes first/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Next");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    const order = s.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.path.replace("/artifacts/art123", ""));
    expect(order).toEqual(["/live/checkpoint", "/comments"]);
    expect(s.posted[0]).toMatchObject({ version_number: 4, request_to: "claude" });
  });

  it("posts nothing when that Publish is refused, and offers to post without publishing", async () => {
    const { s, user } = await editing((c) =>
      c.path === "/artifacts/art123/live/checkpoint"
        ? json(
            {
              error: {
                code: "conflict",
                message: "conflict",
                details: { current_version: 4, reason: "live_conflict" },
              },
            },
            409,
          )
        : undefined,
    );
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask an agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Publish my changes first/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Next");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(
      await within(dialog).findByText(/v4 was published while you edited. Review it to go on./),
    ).toBeTruthy();
    expect(s.posted).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Post without publishing" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({ version_number: 3 });
  });

  it("hides Publish my changes first when there are no unpublished changes", async () => {
    const { user } = await editing(undefined, false);
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask an agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("an in-frame ask with the frame's key opens the dialog about that place; a bad key is dropped", async () => {
    const { s, user, post } = await editing();
    post({ type: "ask", anchor: { key: "slide-3:image-1", text: "Slide 3, image 1" } });
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    expect(within(dialog).getByText("Slide 3, image 1")).toBeTruthy();
    expect(within(dialog).getByText(/Pointing at/)).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Swap");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({
      anchor: { kind: "page", key: "slide-3:image-1", text: "Slide 3, image 1" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Another document's key, no key at all, or a key that is no structural name: nothing opens.
    post({ type: "ask", anchor: { key: "slide-3", text: "x" } }, "A".repeat(43));
    post({ type: "ask", anchor: { key: "block-1", text: "Misleading" } }, "");
    post({ type: "ask" }, "");
    post({ type: "ask", anchor: { key: "<b>", text: "x" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Stop pointing makes the request about the whole page", async () => {
    const { s, user, post } = await editing();
    post({ type: "ask", anchor: { key: "slide-3:image-1", text: "Slide 3, image 1" } });
    const dialog = await screen.findByRole("dialog", { name: "Ask an agent" });
    await user.click(within(dialog).getByRole("button", { name: "Stop pointing" }));
    expect(within(dialog).queryByText(/Pointing at/)).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "Tidy");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).not.toHaveProperty("anchor");
  });
});
