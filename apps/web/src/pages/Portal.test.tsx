// /p/:id: email_required asks for an email and a code against the portal endpoints; ok lists the
// collection's artifacts, each linking to its page; an empty collection says so; 404 is not found.
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
  it("lists the collection's artifacts with who shared it", async () => {
    stubApi({ handle: (c) => (c.path === `/portals/${ID}` ? json(OK) : undefined) });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    expect(await screen.findByRole("heading", { name: "Acme Corp: reports" })).toBeTruthy();
    expect(screen.getByText("Shared by Ana")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Q3 report" }).getAttribute("href")).toBe(
      "/a/q3-report",
    );
  });

  it("says when nothing is in it yet", async () => {
    stubApi({ handle: () => json({ ...OK, items: [] }) });
    const Portal = await loadPage();
    render(<Portal params={{ id: ID }} />);
    expect(await screen.findByText("Nothing here yet.")).toBeTruthy();
  });

  it("asks for an email and a code, then shows the collection", async () => {
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
    await screen.findByRole("heading", { name: "Confirm your email" });
    await user.type(screen.getByRole("textbox", { name: "Email" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByRole("textbox", { name: "Six-digit code" }), "123456");
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
      "You are signed in as ada@example.org, which is not on the list for this collection. If another address of yours is, confirm it below: you will then be signed in with that address instead.",
    );
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
    expect(notice.textContent).toContain("If another address of yours is, confirm it below.");
    expect(notice.textContent).not.toContain("instead");
    expect(screen.getByText(/You do not need an account\./)).toBeTruthy();
  });

  it("an unknown portal is not found", async () => {
    stubApi({ handle: () => apiError(404, "not_found", "Portal not found") });
    const Portal = await loadPage();
    render(<Portal params={{ id: "nope" }} />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
  });
});
