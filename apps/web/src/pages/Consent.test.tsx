import type { ConnectionInfo, OAuthRequestInfo } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, type Call, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Consent.tsx")).default;
}

const REQ = (over: Partial<OAuthRequestInfo> = {}): OAuthRequestInfo => ({
  id: "r1",
  client_id: "cl1",
  client_name: "Claude Code",
  redirect_host: "localhost:54123",
  redirect_uri: "http://localhost:54123/callback",
  scopes: ["artifacts:read", "artifacts:write", "mentions"],
  expires_at: "2026-11-14T12:00:00Z",
  ...over,
});

const existing = (label: string, revoked = false): ConnectionInfo => ({
  id: `c-${label}`,
  label,
  client_type: "claude",
  kind: "oauth",
  scopes: ["artifacts:read"],
  created_at: "2026-11-01T00:00:00Z",
  last_used_at: null,
  revoked_at: revoked ? "2026-11-02T00:00:00Z" : null,
  artifact: null,
});

// Same page plus a hash: happy-dom treats it as a fragment change, not a navigation.
const BACK = () => `${window.location.origin}/oauth/consent?request=r1#back`;

function backend(opts: { req?: OAuthRequestInfo; connections?: ConnectionInfo[] | "error" }) {
  const consents: Call[] = [];
  stubApi({
    me: ME,
    handle: (c) => {
      if (c.path === "/oauth/requests/r1") return json(opts.req ?? REQ());
      if (c.path === "/connections") {
        return opts.connections === "error"
          ? apiError(500, "internal")
          : json({ items: opts.connections ?? [], next_cursor: null });
      }
      if (c.path === "/oauth/consent" && c.method === "POST") {
        consents.push(c);
        return json({ redirect_to: BACK() });
      }
      return undefined;
    },
  });
  return consents;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/oauth/consent?request=r1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Consent", () => {
  it("is one click: who asks, where it returns, what it may do, then Allow", async () => {
    const consents = backend({});
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
      "Connect Claude Code to Plinth?",
    );
    // The security content stays: self-claimed name, return host, scopes, warning.
    expect(screen.getByText(/chosen by the application itself/)).toBeTruthy();
    expect(screen.getByText("localhost:54123")).toBeTruthy();
    expect(screen.getByText(/This is your own computer/)).toBeTruthy();
    expect(screen.getByText("Read artifacts")).toBeTruthy();
    expect(screen.getByText("Answer mentions")).toBeTruthy();
    expect(screen.getByText(/Only allow agents you started yourself/)).toBeTruthy();
    // No required fields: the name is filled in and the form is folded away.
    expect(screen.queryByLabelText("Name this connection")).toBeNull();
    expect(screen.getByText("Saved as").parentElement?.textContent).toContain("Claude Code");

    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toEqual({
      request_id: "r1",
      label: "Claude Code",
      client_type: "claude",
      approve: true,
    });
    await waitFor(() => expect(window.location.hash).toBe("#back"));
  });

  it("gives a second connection from the same client a distinct name", async () => {
    const consents = backend({
      req: REQ({ client_name: "Codex" }),
      connections: [existing("Codex"), existing("codex 2"), existing("Codex 3", true)],
    });
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("Saved as").parentElement?.textContent).toContain("Codex 3");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toMatchObject({ label: "Codex 3", client_type: "codex" });
  });

  it("still works when the connection list cannot be read", async () => {
    const consents = backend({ req: REQ({ client_name: "Cursor" }), connections: "error" });
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toMatchObject({ label: "Cursor", client_type: "other" });
  });

  it("lets the person change the name and client type first", async () => {
    const consents = backend({ req: REQ({ client_name: null }) });
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });

    const toggle = screen.getByRole("button", { name: "Change name" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const name = screen.getByLabelText("Name this connection") as HTMLInputElement;
    expect(name.value).toBe("Agent");
    await user.clear(name);
    await user.type(name, "Laptop Claude");
    await user.selectOptions(screen.getByLabelText(/Client/), "claude");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toMatchObject({ label: "Laptop Claude", client_type: "claude" });
  });

  it("says how comments reach the connection, from the scopes the client asked for", async () => {
    backend({ req: REQ({ client_name: "Gemini CLI" }) });
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Change name" }));
    const name = screen.getByLabelText("Name this connection");
    const hint = document.getElementById(`${name.id}-hint`)?.textContent ?? "";
    expect(hint).toContain("Collaborators reach it by writing @gemini-cli in a comment.");
  });

  it("warns that a client without the mentions scope cannot pick up requests", async () => {
    backend({
      req: REQ({ client_name: "Gemini CLI", scopes: ["artifacts:read", "artifacts:write"] }),
    });
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Change name" }));
    const name = screen.getByLabelText("Name this connection");
    const hint = document.getElementById(`${name.id}-hint`)?.textContent ?? "";
    expect(hint).toContain("does not have the Answer mentions permission");
    expect(hint).not.toContain("@gemini-cli");
  });

  it("falls back to the default name when the field is cleared", async () => {
    const consents = backend({});
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Change name" }));
    await user.clear(screen.getByLabelText("Name this connection"));
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toMatchObject({ label: "Claude Code" });
  });

  it("Deny sends approve: false", async () => {
    const consents = backend({});
    const Consent = await loadPage();
    const user = userEvent.setup();
    render(<Consent />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(consents).toHaveLength(1));
    expect(consents[0]?.body).toMatchObject({ approve: false });
  });
});
