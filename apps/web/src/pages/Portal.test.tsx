// /p/:id: email_required asks for an email and a code against the portal endpoints; ok lists the
// shared category's artifacts, each linking to its page; an empty one says so; 404 is not found.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Portal.tsx")).default;
}

const ID = "share00000000000000c";
const item = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: "art1",
  slug: "q3-report",
  title: "Q3 report",
  type: "html",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-18T00:00:00Z",
  updated_at: "2026-11-18T00:00:00Z",
  url: "http://app.localhost:8787/a/q3-report",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u2", email: "ana@example.org", name: "Ana" },
  role: "viewer",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  ...over,
});
const OK = {
  status: "ok",
  portal: { id: ID, title: "Acme Corp: reports", owner_name: "Ana", role: "viewer" },
  items: [item()],
};

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Portal", () => {
  it("lists the shared category's artifacts with who shared it", async () => {
    stubApi({ handle: (c) => (c.path === `/portals/${ID}` ? json(OK) : undefined) });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    expect(await screen.findByRole("heading", { name: "Acme Corp: reports" })).toBeTruthy();
    expect(screen.getByText("Shared by Ana")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Q3 report" }).getAttribute("href")).toBe(
      "/a/q3-report",
    );
  });

  it("labels the owner's own view a preview", async () => {
    stubApi({
      handle: () => json({ ...OK, portal: { ...OK.portal, role: "owner" } }),
    });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    expect(await screen.findByRole("heading", { name: "Acme Corp: reports" })).toBeTruthy();
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.queryByText("Shared by Ana")).toBeNull();
  });

  it("says when nothing is in it yet", async () => {
    stubApi({ handle: () => json({ ...OK, items: [] }) });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    expect(await screen.findByText("Nothing here yet.")).toBeTruthy();
  });

  it("asks for an email and a code, then shows the shared category", async () => {
    let confirmed = false;
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET" && c.path === `/portals/${ID}`)
          return json(confirmed ? OK : { status: "email_required", portal: { id: ID } });
        if (c.method === "POST" && c.path === `/portals/${ID}/email`) return json({ ok: true });
        if (c.method === "POST" && c.path === `/portals/${ID}/code`) {
          confirmed = true;
          return json(OK);
        }
        return undefined;
      },
    });
    const Portal = await loadPage();
    const user = userEvent.setup();
    render(<Portal params={{ id: ID }} />);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getByText("Enter your email to get a one-time code.")).toBeTruthy();
    expect(screen.queryByText(/collection/i)).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Email" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByRole("textbox", { name: "Six-digit code" }), "123456");
    // The sent-code line is the only text above the code field.
    expect(screen.queryByText("Enter your email to get a one-time code.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm code" }));
    expect(await screen.findByRole("heading", { name: "Acme Corp: reports" })).toBeTruthy();
    const code = api.calls.find((c) => c.path === `/portals/${ID}/code`);
    expect(code?.body).toEqual({ email: "client@example.org", code: "123456" });
  });

  it("tells a signed-in person without access that confirming another address signs them in with it", async () => {
    stubApi({
      me: ME,
      handle: (c) =>
        c.path === `/portals/${ID}`
          ? json({ status: "email_required", portal: { id: ID } })
          : undefined,
    });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    const notice = await screen.findByText(/You are signed in as/);
    expect(notice.textContent).toBe(
      "You are signed in as ada@example.org, which has no access. Confirming another address switches you to it.",
    );
    // The notice is the only explanation: no lead asking a signed-in person to sign in.
    expect(screen.queryByText("Enter your email to get a one-time code.")).toBeNull();
    // Nor a heading that does: the person is signed in already.
    expect(screen.getByRole("heading", { name: "Confirm your email" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("on a single-user instance, the notice does not say the code switches accounts", async () => {
    stubApi({
      me: ME,
      config: { ...CONFIG, single_user_mode: true },
      handle: (c) =>
        c.path === `/portals/${ID}`
          ? json({ status: "email_required", portal: { id: ID } })
          : undefined,
    });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    const notice = await screen.findByText(/You are signed in as/);
    expect(notice.textContent).toContain("You can confirm another address below.");
    expect(notice.textContent).not.toContain("switches");
    expect(screen.getByRole("heading", { name: "Confirm your email" })).toBeTruthy();
  });

  it("an unknown portal is not found", async () => {
    stubApi({ handle: () => apiError(404, "not_found", "Portal not found") });
    const Portal = await loadPage();
    render(<Portal params={{ id: "nope" }} />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
  });
});
