import type { ViewArtifact, ViewGate } from "@plinth/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";
import { VERSION_POLL_MS } from "../components/viewer/useVersionWatch.ts";

// The session store is module state; load a fresh copy of the page for each test.
async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactPage.tsx")).default;
}

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
