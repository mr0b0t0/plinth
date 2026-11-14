import type { ConnectionInfo } from "@plinth/shared";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, ME, stubApi } from "../components/viewer/test-utils.ts";

// The session store is module state; load a fresh copy of the page for each test.
async function loadPage() {
  vi.resetModules();
  return (await import("./Connections.tsx")).default;
}

const conn = (over: Partial<ConnectionInfo>): ConnectionInfo => ({
  id: "c1",
  label: "Work Claude",
  client_type: "claude",
  kind: "oauth",
  scopes: ["artifacts:read", "artifacts:write", "mentions"],
  created_at: "2026-11-14T09:00:00Z",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

/** A backend whose connection list the test changes; counts the list requests. */
function backend(initial: ConnectionInfo[]) {
  const s = { items: initial, fail: false, lists: 0 };
  stubApi({
    me: ME,
    handle: (c) => {
      if (c.path !== "/connections" || c.method !== "GET") return undefined;
      s.lists += 1;
      return s.fail ? apiError(500, "internal") : json({ items: s.items, next_cursor: null });
    },
  });
  return s;
}

const panelStatus = () =>
  within(screen.getByRole("region", { name: "Connect an agent" })).getByRole("status");
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.history.replaceState(null, "", "/connections");
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("Connections", () => {
  it("opens the Connect panel when nothing is connected; tokens sit under Advanced", async () => {
    backend([]);
    const Connections = await loadPage();
    render(<Connections />);
    expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect an agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New token/ })).toBeTruthy();
    const summary = screen.getByText("Advanced: personal access tokens for scripts and CI");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);
    expect(details?.contains(screen.getByRole("button", { name: "New token" }))).toBe(true);
  });

  it("polls while the panel is open and shows the agent that connects", async () => {
    const s = backend([]);
    const Connections = await loadPage();
    render(<Connections />);
    await screen.findByRole("heading", { name: "Connect an agent" });
    expect(s.lists).toBe(1);

    await advance(3000);
    expect(s.lists).toBe(2);
    expect(panelStatus().textContent).toContain("updates by itself");

    // A token someone else made is not "your agent connecting"; an OAuth connection is.
    s.items = [conn({ id: "t1", label: "CI token", kind: "token" })];
    await advance(3000);
    expect(screen.queryByText(/is connected/)).toBeNull();

    s.items = [conn({ id: "c2", label: "Claude Code" }), ...s.items];
    await advance(3000);
    expect(panelStatus().textContent).toBe("Claude Code is connected.");
    expect(screen.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(screen.getByText("Try this first")).toBeTruthy();

    // Detected: polling stops until "Connect another agent".
    const after = s.lists;
    await advance(15_000);
    expect(s.lists).toBe(after);

    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole("button", { name: "Connect another agent" }));
    expect(screen.queryByText(/is connected/)).toBeNull();
    await advance(3000);
    expect(s.lists).toBe(after + 1);
  });

  it("backs off after errors and stops when unmounted", async () => {
    const s = backend([]);
    const Connections = await loadPage();
    const { unmount } = render(<Connections />);
    await screen.findByRole("heading", { name: "Connect an agent" });
    s.fail = true;

    await advance(3000);
    expect(s.lists).toBe(2); // failed: next wait is 6 s
    await advance(3000);
    expect(s.lists).toBe(2);
    await advance(3000);
    expect(s.lists).toBe(3); // failed again: next wait is 12 s
    s.fail = false;
    await advance(12_000);
    expect(s.lists).toBe(4); // success: back to every 3 s
    await advance(3000);
    expect(s.lists).toBe(5);

    unmount();
    await advance(30_000);
    expect(s.lists).toBe(5);
  });

  it("pauses while the tab is hidden", async () => {
    const s = backend([]);
    const Connections = await loadPage();
    render(<Connections />);
    await screen.findByRole("heading", { name: "Connect an agent" });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(20_000);
    expect(s.lists).toBe(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(3000);
    expect(s.lists).toBe(2);
  });

  it("keeps the panel closed when an agent is connected, and opens it from the header", async () => {
    const s = backend([conn({})]);
    const Connections = await loadPage();
    render(<Connections />);
    expect(await screen.findByRole("heading", { name: "Work Claude" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect an agent" })).toBeNull();
    await advance(10_000);
    expect(s.lists).toBe(1); // no polling while closed

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Connect an agent" }));
    const heading = screen.getByRole("heading", { name: "Connect an agent" });
    expect(document.activeElement).toBe(heading);
    await advance(3000);
    expect(s.lists).toBe(2);
    // The connection that was already there is not announced as new.
    expect(screen.queryByText(/is connected/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("heading", { name: "Connect an agent" })).toBeNull();
  });

  it("opens the panel from ?connect=1 even with agents connected", async () => {
    window.history.replaceState(null, "", "/connections?connect=1");
    backend([conn({})]);
    const Connections = await loadPage();
    render(<Connections />);
    expect(await screen.findByRole("heading", { name: "Connect an agent" })).toBeTruthy();
  });
});
