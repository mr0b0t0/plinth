import type { VersionInfo } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionPicker } from "../artifact/VersionPicker.tsx";

const apiMock = vi.fn();
vi.mock("../../lib/api.ts", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiRequestError: class extends Error {},
}));

const v = (number: number, note: string | null, kind: "user" | "connection"): VersionInfo => ({
  number,
  note,
  size_bytes: 1000 * number,
  created_at: new Date(Date.now() - number * 60_000).toISOString(),
  restored_from: null,
  author: {
    kind,
    label: kind === "user" ? "Ana" : "Work agent",
    user_id: "u1",
    connection_id: kind === "user" ? null : "c1",
  },
});

const VERSIONS = [v(3, "Bigger chart", "connection"), v(2, "Fix typo", "user"), v(1, null, "user")];

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ items: VERSIONS });
  window.history.replaceState(null, "", "/a/doc-1");
});
afterEach(cleanup);

const focusedText = () => document.activeElement?.textContent ?? "";

describe("VersionPicker", () => {
  it("shows the version and loads the list only when opened", async () => {
    const user = userEvent.setup();
    render(<VersionPicker slug="doc-1" current={3} shown={2} />);
    const trigger = screen.getByRole("button", { name: /v2 of 3/ });
    expect(trigger.textContent).toContain("v2");
    expect(apiMock).not.toHaveBeenCalled();

    await user.click(trigger);
    expect(apiMock).toHaveBeenCalledWith("/artifacts/doc-1/versions");
    const items = await screen.findAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    // The shown version is checked and focused.
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(focusedText()).toContain("v2"));
    expect(items[0]?.textContent).toContain("current");
    expect(items[0]?.textContent).toContain("Work agent");
    expect(items[0]?.textContent).toContain("Bigger chart");
  });

  it("links versions to their permanent URLs and the current one to the bare URL", async () => {
    const user = userEvent.setup();
    render(<VersionPicker slug="doc-1" current={3} shown={2} />);
    await user.click(screen.getByRole("button", { name: /v2 of 3/ }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("href"))).toEqual([
      "/a/doc-1",
      "/a/doc-1/v/2",
      "/a/doc-1/v/1",
    ]);
    expect(screen.getByRole("menuitem", { name: "All versions" }).getAttribute("href")).toBe(
      "/a/doc-1/history",
    );
    expect(screen.getByRole("menuitem", { name: "Compare" }).getAttribute("href")).toBe(
      "/a/doc-1/compare?from=1&to=2",
    );
  });

  it("is keyboard operable: arrows, Home/End, digits, Enter navigates, Escape closes", async () => {
    const user = userEvent.setup();
    render(<VersionPicker slug="doc-1" current={3} shown={3} />);
    const trigger = screen.getByRole("button", { name: /v3, the current version/ });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findAllByRole("menuitemradio");
    await waitFor(() => expect(focusedText()).toContain("v3"));
    await user.keyboard("{ArrowDown}");
    expect(focusedText()).toContain("v2");
    await user.keyboard("{End}");
    expect(focusedText()).toBe("Compare");
    await user.keyboard("{Home}");
    expect(focusedText()).toContain("v3");
    await user.keyboard("1");
    expect(focusedText()).toContain("v1");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(focusedText()).toContain("v3"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(window.location.pathname).toBe("/a/doc-1/v/2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("hides Compare when there is only one version", async () => {
    apiMock.mockResolvedValue({ items: [v(1, null, "user")] });
    const user = userEvent.setup();
    render(<VersionPicker slug="doc-1" current={1} shown={1} />);
    await user.click(screen.getByRole("button", { name: /v1/ }));
    await screen.findAllByRole("menuitemradio");
    expect(screen.queryByRole("menuitem", { name: "Compare" })).toBeNull();
  });
});
