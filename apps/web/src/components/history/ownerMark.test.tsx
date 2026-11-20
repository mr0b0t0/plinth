// The owner's mark on versions (docs/security.md "Display name used to impersonate"): History's
// author label and the version picker say "Owner" beside the owner's own versions, from the
// server's is_owner, never from the name.
import type { Author, VersionInfo } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionPicker } from "../artifact/VersionPicker.tsx";
import { AuthorLabel } from "./common.tsx";

const apiMock = vi.fn();
vi.mock("../../lib/api.ts", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiRequestError: class extends Error {},
}));

afterEach(cleanup);

const person = (is_owner: boolean | undefined): Author => ({
  kind: "user",
  label: "Ana Owner",
  user_id: null,
  connection_id: null,
  is_owner,
});

describe("AuthorLabel: the owner's mark", () => {
  it("marks the owner's version, and not a lookalike's with the same name", () => {
    const { container, rerender } = render(<AuthorLabel author={person(true)} />);
    expect(container.querySelector(".hx-author__owner")?.textContent).toBe("Owner");
    rerender(<AuthorLabel author={person(false)} />);
    expect(container.querySelector(".hx-author__owner")).toBeNull();
    rerender(<AuthorLabel author={person(undefined)} />);
    expect(container.querySelector(".hx-author__owner")).toBeNull();
    // An agent's version keeps its robot icon and no mark.
    rerender(
      <AuthorLabel
        author={{
          kind: "connection",
          label: "Work",
          user_id: null,
          connection_id: null,
          is_owner: true,
        }}
      />,
    );
    expect(container.querySelector(".hx-author__owner")).toBeNull();
  });
});

describe("VersionPicker: the owner's mark", () => {
  const v = (number: number, is_owner: boolean): VersionInfo => ({
    number,
    note: null,
    size_bytes: 1000,
    created_at: new Date(Date.now() - number * 60_000).toISOString(),
    restored_from: null,
    author: person(is_owner),
  });

  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ items: [v(2, false), v(1, true)] });
    window.history.replaceState(null, "", "/a/doc-1");
  });

  it("says (owner) only beside the owner's version", async () => {
    const user = userEvent.setup();
    render(<VersionPicker slug="doc-1" current={2} shown={1} />);
    await user.click(screen.getByRole("button", { name: /v1 of 2/ }));
    const options = await screen.findAllByRole("menuitemradio");
    const text = options.map((o) => o.textContent ?? "");
    expect(text.find((t) => t.includes("v1"))).toContain("Ana Owner (owner)");
    expect(text.find((t) => t.includes("v2"))).not.toContain("(owner)");
  });
});
