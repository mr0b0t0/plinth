import type { ViewArtifact, ViewGate } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, ME, stubApi } from "../components/viewer/test-utils.ts";

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
    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(
      "/a/garden-plan/edit",
    );
    expect(screen.getByText("Visibility:")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share this artifact" });
    expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe(
      "http://app.localhost:8787/a/garden-plan",
    );
    expect(dialog.querySelector('a[href="/a/garden-plan/settings"]')).toBeTruthy();
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
    const toggle = screen.getByRole("button", { name: "Comments" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(calls.at(-1)?.path).toBe("/view/garden-plan?review=1"));
    await waitFor(() =>
      expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(n)),
    );
    expect(n).toBeGreaterThanOrEqual(2);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
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
