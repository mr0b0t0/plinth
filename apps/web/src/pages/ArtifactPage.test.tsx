import type { ViewArtifact, ViewGate } from "@plinth/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";
import { VERSION_POLL_MS } from "../components/viewer/useVersionWatch.ts";

// The session store is module state; load a fresh copy of the page for each test.
async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactPage.tsx")).default;
}

/** The frame key an owner's or editor's frame carries in its address, and the address without it. */
const keyOf = (el: Element) =>
  /#plinth-k=([A-Za-z0-9_-]{43})$/.exec(el.getAttribute("src") ?? "")?.[1];
const srcOf = (el: Element) =>
  (el.getAttribute("src") ?? "").replace(/#plinth-k=[A-Za-z0-9_-]{43}$/, "");
const ENTER = (n: number) =>
  `http://art123.content.localhost:8787/__plinth/enter?t=token-${n}&next=%2F`;

const ARTIFACT: ViewArtifact = {
  id: "art123",
  slug: "garden-plan",
  title: "Garden plan",
  type: "html",
  current_version: 3,
  version: 3,
  visibility: "unlisted",
  owner_name: null,
};

function okGate(over: Partial<Extract<ViewGate, { status: "ok" }>> = {}, n = 1): ViewGate {
  return {
    status: "ok",
    artifact: ARTIFACT,
    enter_url: ENTER(n),
    role: null,
    ...over,
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/garden-plan");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ArtifactPage", () => {
  it("shows the artifact in a sandboxed frame on its content subdomain", async () => {
    stubApi({ handle: (c) => (c.path === "/view/garden-plan" ? json(okGate()) : undefined) });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(ENTER(1));
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox.split(" ")).toEqual([
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-modals",
      "allow-downloads",
    ]);
    expect(sandbox).not.toContain("top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(screen.getByRole("heading", { level: 1, name: "Garden plan" })).toBeTruthy();
    expect(document.title).toBe("Garden plan · Plinth");
    // Viewers get no Edit and no visibility badge; everyone gets History, Report and the banner.
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByText("Visibility:")).toBeNull();
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toBe(
      "/a/garden-plan/history",
    );
    expect(screen.getByRole("link", { name: "Report this artifact" }).getAttribute("href")).toBe(
      "/a/garden-plan/report",
    );
    expect(screen.getByRole("contentinfo").textContent).toContain("Hosted on Plinth");
    const source = screen.getByRole("link", { name: "open source" });
    expect(source.getAttribute("href")).toBe("https://github.com/mr0b0t0/plinth");
    expect(source.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("leaves the source link out when the operator turned it off", async () => {
    stubApi({
      me: ME,
      config: { ...CONFIG, source_url: null },
      handle: (c) => (c.path.startsWith("/view/") ? json(okGate()) : undefined),
    });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    expect(screen.getByRole("contentinfo").textContent).toContain("Hosted on Plinth");
    expect(screen.queryByRole("link", { name: "open source" })).toBeNull();
    expect(screen.getByRole("link", { name: "Report this artifact" })).toBeTruthy();
  });

  it("gives owners Edit, the visibility badge and the sharing settings", async () => {
    stubApi({
      me: ME,
      handle: (c) => (c.path.startsWith("/view/") ? json(okGate({ role: "owner" })) : undefined),
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    // Edit and Settings live in the ⋯ menu; owners get the breadcrumb back to their artifacts.
    expect(screen.getByRole("link", { name: "Artifacts" }).getAttribute("href")).toBe("/dashboard");
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" }).getAttribute("href")).toBe(
      "/a/garden-plan/edit",
    );
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe(
      "/a/garden-plan/settings",
    );
    expect(screen.getByRole("menuitem", { name: "Stats" }).getAttribute("href")).toBe(
      "/a/garden-plan/stats",
    );
    expect(screen.queryByRole("menuitem", { name: "Report" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Visibility:")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this artifact" });
    expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe(
      "http://app.localhost:8787/a/garden-plan",
    );
    expect(dialog.querySelector('a[href="/a/garden-plan/settings"]')).toBeTruthy();
  });

  it("tells the viewer what a page with shared data sees, and nothing otherwise", async () => {
    stubApi({
      handle: (c) =>
        c.path === "/view/garden-plan"
          ? json(
              okGate({
                role: "viewer",
                data: {
                  available: true,
                  capabilities: ["data", "viewer"],
                  identified: true,
                  can_write: true,
                  email: "guest@example.org",
                },
              }),
            )
          : undefined,
    });
    let ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("This page can see that you are guest@example.org");
    expect(note.closest("main")).toBeTruthy();
    cleanup();

    stubApi({ handle: (c) => (c.path === "/view/garden-plan" ? json(okGate()) : undefined) });
    ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("asks for a version and says when it is not the current one", async () => {
    window.history.replaceState(null, "", "/a/garden-plan/v/2");
    const { calls } = stubApi({
      handle: (c) =>
        c.path === "/view/garden-plan?version=2"
          ? json(okGate({ artifact: { ...ARTIFACT, version: 2 } }))
          : undefined,
    });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan", n: "2" }} />);
    await screen.findByTitle("Garden plan, version 2");
    expect(calls.some((c) => c.path === "/view/garden-plan?version=2")).toBe(true);
    expect(screen.getByText(/You are viewing/).textContent).toContain("v2");
    expect(screen.getByRole("link", { name: /Go to current/ }).getAttribute("href")).toBe(
      "/a/garden-plan",
    );
  });

  it("reloads the frame with a fresh review-mode gate when comments open", async () => {
    let n = 0;
    const { calls } = stubApi({
      handle: (c) => (c.path.startsWith("/view/") ? json(okGate({}, ++n)) : undefined),
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    // One toggle in the bar, at every width.
    const toggle = screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(calls.at(-1)?.path).toBe("/view/garden-plan?review=1"));
    await waitFor(() =>
      expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(n)),
    );
    expect(n).toBeGreaterThanOrEqual(2);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps review mode after comments close, so toggling again does not reload the frame", async () => {
    let n = 0;
    const { calls } = stubApi({
      handle: (c) => (c.path.startsWith("/view/") ? json(okGate({}, ++n)) : undefined),
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    const toggle = screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement;
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(2)),
    );
    const gates = () => calls.filter((c) => c.path.startsWith("/view/")).length;
    const before = gates();
    await user.click(toggle); // close
    await user.click(toggle); // open again
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(gates()).toBe(before);
    expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(2));
  });

  it("opens comments on a page that declares them without a review-mode reload", async () => {
    let n = 0;
    const { calls } = stubApi({
      handle: (c) =>
        c.path.startsWith("/view/")
          ? json(okGate({ page_comments: true }, ++n))
          : c.path.endsWith("/comments")
            ? json({ items: [] })
            : undefined,
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Garden plan, version 3");
    const toggle = screen.getAllByRole("button", { name: "Comments" })[0] as HTMLElement;
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("region", { name: "Comments" });
    // No pick button: the page places its own anchors.
    expect(screen.queryByRole("button", { name: "Pin to an element" })).toBeNull();
    await act(async () => undefined);
    expect(calls.filter((c) => c.path.includes("review=1"))).toEqual([]);
    expect(calls.filter((c) => c.path.startsWith("/view/")).length).toBe(1);
    expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(1));
  });

  describe("when a newer version is published", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it("loads it in place of the shown one and says so", async () => {
      let current = 3;
      let n = 0;
      stubApi({
        handle: (c) =>
          c.path === "/view/garden-plan"
            ? json(
                okGate(
                  { artifact: { ...ARTIFACT, current_version: current, version: current } },
                  ++n,
                ),
              )
            : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      await screen.findByTitle("Garden plan, version 3");

      // Nothing new: the frame stays as it is.
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(1));

      current = 4;
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      // The new version loads under the old one, which stays on screen until it has loaded.
      const frame = await screen.findByTitle("Garden plan, version 4");
      expect(frame.getAttribute("src")).toBe(ENTER(3));
      expect(screen.getByTitle("Garden plan, version 3").hasAttribute("inert")).toBe(true);
      fireEvent.load(frame);
      expect(screen.queryByTitle("Garden plan, version 3")).toBeNull();
      expect(await screen.findByText("Updated to v4")).toBeTruthy();
      expect(document.title).toBe("Garden plan · Plinth");
    });

    it("with live views, a pushed version loads at once and the gate poll is only a backstop", async () => {
      const sockets: { url: string; onmessage: ((e: { data: string }) => void) | null }[] = [];
      class FakeSocket {
        onmessage: ((e: { data: string }) => void) | null = null;
        onclose = null;
        onerror = null;
        constructor(
          public url: string,
          public protocol: string,
        ) {
          sockets.push(this);
        }
        send() {}
        close() {}
      }
      vi.stubGlobal("WebSocket", FakeSocket);
      let current = 3;
      const reads: string[] = [];
      stubApi({
        handle: (c) => {
          if (c.path !== "/view/garden-plan") return undefined;
          reads.push(c.path);
          return json(
            okGate(
              {
                watch: true,
                artifact: { ...ARTIFACT, current_version: current, version: current },
              },
              reads.length,
            ),
          );
        },
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      await screen.findByTitle("Garden plan, version 3");
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toMatch(/\/api\/v1\/view\/art123\/watch$/);
      const frame = (f: unknown) => act(() => sockets[0]?.onmessage?.({ data: JSON.stringify(f) }));
      frame({ t: "welcome", v: 1, version: 3 });
      // While the socket is open, the gate is not read on the 15 s pace.
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 2);
      expect(reads).toHaveLength(1);
      current = 4;
      frame({ t: "version", version: 4, spread_ms: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
      expect(reads).toHaveLength(2);
      expect(await screen.findByText("Updated to v4")).toBeTruthy();
      // The same socket stays open for the new version.
      expect(sockets).toHaveLength(1);
      // Another version right after: its notice replaces the last one; they never stack.
      current = 5;
      frame({ t: "version", version: 5, spread_ms: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(await screen.findByText("Updated to v5")).toBeTruthy();
      expect(screen.queryByText("Updated to v4")).toBeNull();
      expect(screen.getAllByText(/^Updated to v/)).toHaveLength(1);
    });

    it("keeps a permanent version link on its version and points to the new current one", async () => {
      window.history.replaceState(null, "", "/a/garden-plan/v/3");
      let current = 3;
      stubApi({
        handle: (c) =>
          c.path === "/view/garden-plan?version=3"
            ? json(okGate({ artifact: { ...ARTIFACT, current_version: current, version: 3 } }))
            : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan", n: "3" }} />);
      await screen.findByTitle("Garden plan, version 3");
      expect(screen.queryByText(/You are viewing/)).toBeNull();

      current = 4;
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      expect((await screen.findByText(/You are viewing/)).textContent).toContain("v3");
      expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(1));
      expect(screen.queryByText("Updated to v4")).toBeNull();
    });
  });

  describe("printing a doc", () => {
    const PRINT = { source: "plinth-renderer", v: 1, type: "print" };
    const DOC: ViewArtifact = { ...ARTIFACT, type: "doc" };

    async function openMenu(gate: ViewGate, config = CONFIG) {
      stubApi({ config, handle: (c) => (c.path.startsWith("/view/") ? json(gate) : undefined) });
      const ArtifactPage = await loadPage();
      const user = userEvent.setup();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
      // happy-dom does not load frames; give this one a window to post to.
      const toFrame = vi.fn();
      Object.defineProperty(frame, "contentWindow", {
        configurable: true,
        value: { postMessage: toFrame },
      });
      const toApp = vi.spyOn(window, "postMessage");
      await user.click(screen.getByRole("button", { name: "Artifact actions" }));
      return { user, toFrame, toApp };
    }

    it("is not offered for an HTML page", async () => {
      await openMenu(okGate());
      expect(screen.queryByRole("menuitem", { name: "Print or save as PDF" })).toBeNull();
    });

    it("posts the print message to the doc's frame at its exact content origin", async () => {
      const { user, toFrame, toApp } = await openMenu(okGate({ artifact: DOC }));
      await user.click(screen.getByRole("menuitem", { name: "Print or save as PDF" }));
      expect(toFrame).toHaveBeenCalledTimes(1);
      expect(toFrame).toHaveBeenCalledWith(PRINT, "http://art123.content.localhost:8787");
      expect(toApp).not.toHaveBeenCalledWith(PRINT, expect.anything());
    });

    it("posts to '*' under opaque isolation, where the frame's origin is 'null'", async () => {
      const { user, toFrame } = await openMenu(okGate({ artifact: DOC }), {
        ...CONFIG,
        content_isolation: "opaque",
      });
      await user.click(screen.getByRole("menuitem", { name: "Print or save as PDF" }));
      expect(toFrame).toHaveBeenCalledWith(PRINT, "*");
    });

    it("posts to '*' in the path fallback", async () => {
      const { user, toFrame } = await openMenu(
        okGate({
          artifact: DOC,
          enter_url: "http://app.localhost:8787/__content/art123/__plinth/enter?t=x&next=%2F",
        }),
        { ...CONFIG, content_path_fallback: true, content_isolation: "opaque" },
      );
      await user.click(screen.getByRole("menuitem", { name: "Print or save as PDF" }));
      expect(toFrame).toHaveBeenCalledWith(PRINT, "*");
    });
  });

  it("runs the password gate, then shows the artifact", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/view/garden-plan")
          return json({
            status: "password_required",
            artifact: { id: "art123", slug: "garden-plan", title: "Garden plan" },
          });
        if (c.path === "/view/garden-plan/password") {
          return (c.body as { password: string }).password === "right"
            ? json(okGate())
            : apiError(403, "forbidden", "Wrong password");
        }
        return undefined;
      },
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const input = await screen.findByLabelText("Password");
    expect(screen.queryByTitle(/Garden plan, version/)).toBeNull();
    await user.type(input, "wrong");
    await user.click(screen.getByRole("button", { name: "Open artifact" }));
    expect(await screen.findByText("That password is not right.")).toBeTruthy();
    await user.type(screen.getByLabelText("Password"), "right");
    await user.click(screen.getByRole("button", { name: "Open artifact" }));
    expect(await screen.findByTitle("Garden plan, version 3")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("shows the takedown notice and never a frame", async () => {
    stubApi({
      handle: () =>
        json({
          status: "taken_down",
          artifact: { id: "art123", slug: "garden-plan", title: "Garden plan" },
        }),
    });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    expect(await screen.findByText("No longer on view")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("treats a malformed version link as not found", async () => {
    stubApi({ handle: () => json(okGate()) });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan", n: "abc" }} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("ArtifactPage: editing a doc on its page (#36)", () => {
  const DOC: ViewArtifact = { ...ARTIFACT, type: "doc", title: "Plan" };
  const live = (over: Record<string, unknown> = {}) => ({
    mode: "room" as const,
    draft: null,
    ...over,
  });
  const docGate = (over: Partial<Extract<ViewGate, { status: "ok" }>> = {}, n = 1) =>
    okGate({ artifact: DOC, role: "editor", live: live(), ...over }, n);

  it("gives owners and editors an Edit toggle, the one way in, and viewers none", async () => {
    stubApi({ me: ME, handle: (c) => (c.path.startsWith("/view/") ? json(docGate()) : undefined) });
    let ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    const toggle = screen.getByRole("button", { name: "Edit" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Artifact actions" }));
    // No source beside it: the menu has no editor item for a doc edited on its page.
    expect(screen.queryByRole("menuitem", { name: "Edit source" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Before the frame reports, the room is still connecting.
    expect(screen.getByRole("region", { name: "Editing on the page" }).textContent).toContain(
      "Connecting…",
    );
    // Focus moves into the edit bar, and back to the toggle when editing ends.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("region", { name: "Editing on the page" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.queryByRole("region", { name: "Editing on the page" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    cleanup();

    // A commenter's gate has no `live`: no toggle, no notice, the menu keeps no edit item.
    stubApi({
      me: ME,
      handle: (c) =>
        c.path.startsWith("/view/")
          ? json(okGate({ artifact: DOC, role: "commenter" }))
          : undefined,
    });
    ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("asks a code-confirmed editor to sign in instead", async () => {
    stubApi({
      handle: (c) =>
        c.path.startsWith("/view/") ? json(docGate({ live: live({ sign_in: true }) })) : undefined,
    });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in to edit" }).getAttribute("href")).toBe(
      "/login?next=%2Fa%2Fgarden-plan",
    );
  });

  it("tells editors about unpublished page changes, and turns comments off while editing", async () => {
    const draft = {
      base_version: 3,
      dirty: true,
      conflict_version: null,
      updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      updated_by_email: "bo@example.org",
    };
    stubApi({
      me: ME,
      handle: (c) => {
        if (c.path.startsWith("/view/")) return json(docGate({ live: live({ draft }) }));
        if (c.path.startsWith("/artifacts/art123/comments")) return json({ items: [] });
        return undefined;
      },
    });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.getByRole("note").textContent).toContain(
      "Unpublished changes on the page by bo@example.org, 2 h ago",
    );
    await user.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByRole("button", { name: "Comments" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The notice offers no action of its own: the bar's Edit toggle is the one way in, and the edit
    // strip holds Publish and Discard.
    expect(screen.queryByRole("button", { name: "Continue editing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    // Editing and review mode exclude each other: the panel closes.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Comments" }).getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("true");
    // Focus is in the edit bar, not on the body.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("region", { name: "Editing on the page" }),
      ),
    );
  });

  it("says the shared draft exists before the room is reachable, with no action of its own", async () => {
    const draft = {
      base_version: 3,
      dirty: true,
      conflict_version: null,
      updated_at: new Date().toISOString(),
      updated_by_email: "bo@example.org",
    };
    stubApi({
      me: ME,
      handle: (c) =>
        c.path.startsWith("/view/") ? json(docGate({ live: live({ draft }) })) : undefined,
    });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    await screen.findByTitle("Plan, version 3");
    expect(screen.getByRole("note").textContent).toContain("Unpublished changes on the page");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  describe("while the frame follows the room", () => {
    const wins = new WeakMap<HTMLIFrameElement, { postMessage: ReturnType<typeof vi.fn> }>();
    let restore: PropertyDescriptor | undefined;
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
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
      vi.useRealTimers();
      if (restore) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", restore);
    });

    it("keeps the frame (no swap) and moves the bar to the new version", async () => {
      let current = 3;
      let n = 0;
      stubApi({
        me: ME,
        handle: (c) =>
          c.path.startsWith("/view/")
            ? json(
                docGate({ artifact: { ...DOC, current_version: current, version: current } }, ++n),
              )
            : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
      // An editor's frame has a fresh key in its address; its editing messages carry it.
      expect(keyOf(frame)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const e = new MessageEvent("message", {
        origin: "http://art123.content.localhost:8787",
        data: {
          source: "plinth-renderer",
          v: 1,
          key: keyOf(frame),
          type: "live",
          connected: true,
          failed: false,
          editing: false,
          holding: false,
          dirty: false,
          unflushed: false,
          rev: 2,
          base_version: 3,
          conflict_version: null,
          last_by_you: false,
          last_edit_at: null,
          editors: [],
        },
      });
      Object.defineProperty(e, "source", { value: frame.contentWindow });
      act(() => {
        window.dispatchEvent(e);
      });
      current = 4;
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      const shown = await screen.findByTitle("Plan, version 4");
      expect(shown).toBe(frame);
      expect(srcOf(shown)).toBe(ENTER(1));
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
    });

    it("while editing, a newer version raises no toast: the edit strip says it", async () => {
      let current = 3;
      let n = 0;
      stubApi({
        me: ME,
        handle: (c) =>
          c.path.startsWith("/view/")
            ? json(
                docGate({ artifact: { ...DOC, current_version: current, version: current } }, ++n),
              )
            : undefined,
      });
      const ArtifactPage = await loadPage();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
      roomStatus(frame, true);
      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByRole("region", { name: "Editing on the page" })).toBeTruthy();
      current = 4;
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      await screen.findByTitle("Plan, version 4");
      expect(screen.queryByText("Updated to v4")).toBeNull();
    });

    /** A stand-in watch socket the test can send frames and a close through. */
    function stubWatchSocket() {
      const sockets: FakeWatch[] = [];
      class FakeWatch {
        onmessage: ((e: { data: string }) => void) | null = null;
        onclose: ((e: { code: number; reason: string }) => void) | null = null;
        onerror = null;
        constructor(public url: string) {
          sockets.push(this);
        }
        send() {}
        close() {}
      }
      vi.stubGlobal("WebSocket", FakeWatch);
      return {
        sockets,
        frame: (f: unknown) => act(() => sockets.at(-1)?.onmessage?.({ data: JSON.stringify(f) })),
        /** A sharing change: the `access` frame, then the 4401 close. */
        revoke: () =>
          act(() => {
            sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ t: "access", spread_ms: 0 }) });
            sockets.at(-1)?.onclose?.({ code: 4401, reason: "access_changed" });
          }),
      };
    }

    /** The renderer reports the doc room's state; `connected` true puts the frame in "follow". */
    function roomStatus(frame: HTMLIFrameElement, connected: boolean) {
      const e = new MessageEvent("message", {
        origin: "http://art123.content.localhost:8787",
        data: {
          source: "plinth-renderer",
          v: 1,
          key: keyOf(frame),
          type: "live",
          connected,
          failed: false,
          editing: false,
          holding: false,
          dirty: false,
          unflushed: false,
          rev: 2,
          base_version: 3,
          conflict_version: null,
          last_by_you: false,
          last_edit_at: null,
          editors: [],
        },
      });
      Object.defineProperty(e, "source", { value: frame.contentWindow });
      act(() => {
        window.dispatchEvent(e);
      });
    }

    it("a sharing change keeps a paused frame, and renews it once the pause ends", async () => {
      const ws = stubWatchSocket();
      let n = 0;
      stubApi({
        me: ME,
        handle: (c) =>
          c.path.startsWith("/view/") ? json(docGate({ watch: true }, ++n)) : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
      ws.frame({ t: "welcome", v: 1, version: 3 });
      roomStatus(frame, true);
      ws.revoke();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // The gate was read again, but the frame that follows the room stays.
      expect(n).toBe(2);
      expect(screen.getByTitle("Plan, version 3")).toBe(frame);
      expect(srcOf(frame)).toBe(ENTER(1));
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
      // The pause ends (the room socket closed with the old pass): a fresh gate renews the frame,
      // with a key of its own.
      roomStatus(frame, false);
      await waitFor(() => expect(srcOf(screen.getByTitle("Plan, version 3"))).not.toBe(ENTER(1)));
      expect(keyOf(screen.getByTitle("Plan, version 3"))).not.toBe(keyOf(frame));
    });

    it("a sharing change that ends access shows the gate, even while paused", async () => {
      const ws = stubWatchSocket();
      let n = 0;
      stubApi({
        me: ME,
        handle: (c) =>
          c.path.startsWith("/view/")
            ? ++n === 1
              ? json(docGate({ watch: true }))
              : json({ status: "not_found" })
            : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
      ws.frame({ t: "welcome", v: 1, version: 3 });
      roomStatus(frame, true);
      ws.revoke();
      await waitFor(() => expect(screen.queryByTitle("Plan, version 3")).toBeNull());
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it("a sharing change renews a frame that is not paused", async () => {
      const ws = stubWatchSocket();
      let n = 0;
      stubApi({
        me: ME,
        handle: (c) =>
          c.path.startsWith("/view/") ? json(docGate({ watch: true }, ++n)) : undefined,
      });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      await screen.findByTitle("Plan, version 3");
      ws.frame({ t: "welcome", v: 1, version: 3 });
      ws.revoke();
      const fresh = await waitFor(() => {
        const f = [...document.querySelectorAll("iframe")].find((x) => srcOf(x) === ENTER(2));
        if (!f) throw new Error("not renewed yet");
        return f;
      });
      expect(fresh.getAttribute("title")).toBe("Plan, version 3");
    });

    it("solo: opening Comments when the save on Done fails keeps editing and the frame", async () => {
      let views = 0;
      stubApi({
        me: ME,
        handle: (c) => {
          if (c.path.startsWith("/view/"))
            return json(docGate({ live: live({ mode: "solo" }) }, ++views));
          if (c.path.startsWith("/artifacts/art123/comments")) return json({ items: [] });
          if (c.method === "PUT") {
            return json({ error: { code: "rate_limited", message: "Too many" } }, 429);
          }
          return undefined;
        },
      });
      const ArtifactPage = await loadPage();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Plan, version 3")) as HTMLIFrameElement;
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const post = (data: Record<string, unknown>) => {
        const e = new MessageEvent("message", {
          origin: "http://art123.content.localhost:8787",
          data: { source: "plinth-renderer", v: 1, key: keyOf(frame), ...data },
        });
        Object.defineProperty(e, "source", { value: frame.contentWindow });
        act(() => {
          window.dispatchEvent(e);
        });
      };
      post({
        type: "live",
        connected: false,
        failed: false,
        editing: true,
        holding: false,
        dirty: true,
        unflushed: false,
        rev: 0,
        base_version: 0,
        conflict_version: null,
        last_by_you: false,
        last_edit_at: null,
        editors: [],
      });
      const viewsBefore = views;
      await user.click(screen.getByRole("button", { name: "Comments" }));
      const sent = (frame.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
        .postMessage.mock.calls;
      const collect = sent.filter((c) => c[0]?.type === "collect").at(-1);
      expect(collect).toBeTruthy();
      post({ type: "draft", nonce: collect?.[0].nonce, text: "# Edited on the page" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe(
          "true",
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // The save failed: still editing, the panel stays closed and no review-mode gate reloads
      // the frame (the unsaved edits live only in it).
      expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(screen.getByRole("button", { name: "Comments" }).getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(views).toBe(viewsBefore);
      expect(screen.getByTitle("Plan, version 3")).toBe(frame);
    });
  });
});
