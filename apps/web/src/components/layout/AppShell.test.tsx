import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session store is module state; load a fresh copy of the shell for each test.
async function loadShell() {
  vi.resetModules();
  return import("./AppShell.tsx");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("renders the skip link, banner and main landmark even when the API is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { AppShell } = await loadShell();
    render(
      <AppShell>
        <p>Page body</p>
      </AppShell>,
    );
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(screen.getByRole("banner")).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.textContent).toContain("Page body");
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("shows primary nav with the current page marked, and a user menu with sign-out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return json({ single_user_mode: false });
        if (url.endsWith("/me")) return json({ id: "u1", email: "ada@example.org" });
        return json({}, 404);
      }),
    );
    const onSignOut = vi.fn();
    const { AppShell } = await loadShell();
    const user = userEvent.setup();
    render(
      <AppShell onSignOut={onSignOut}>
        <p>Page body</p>
      </AppShell>,
    );
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(nav.contains(dashboard)).toBe(true);
    expect(dashboard.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("link", { name: "Connections" }).getAttribute("aria-current"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Account: ada@example.org" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
