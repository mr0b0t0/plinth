// The share dialog's Data sources section: the owner reads each recipe as text and confirms
// exactly the config_hash shown, or removes a source; a lost pin is called out. Nobody but the
// owner loads the sources.
import { CSRF_HEADER, type DataSourceInfo } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { targetText } from "./DataSourcesSection.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { apiError, json, stubApi } from "./test-utils.ts";

const HASH = "0123456789abcdef0123456789abcdef";

const source = (over: Partial<DataSourceInfo> = {}): DataSourceInfo => ({
  id: "linear",
  label: "Open issues",
  connector: "Linear",
  collection: "issues",
  status: "awaiting_confirmation",
  last_fetched_at: null,
  confirmed_at: null,
  created_at: "2026-11-19T10:00:00.000Z",
  updated_at: "2026-11-19T10:00:00.000Z",
  recipe: "Linear: count open issues in team ENG by state.\nOne document per state.",
  target: { client_type: "claude", connection_id: null, connection_label: null },
  pin_lost_at: null,
  config_hash: HASH,
  ...over,
});

function renderDialog(isOwner = true, onSourcesChange = () => {}) {
  return render(
    <>
      <ShareDialog
        open
        onClose={() => undefined}
        link="http://app.localhost:8787/a/s1"
        slug="s1"
        visibility="allowlist"
        isOwner={isOwner}
        hasSources
        onSourcesChange={onSourcesChange}
      />
      <Toaster />
    </>,
  );
}

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Data sources in the share dialog", () => {
  it("shows the recipe in full as text in a <pre>, never markup", async () => {
    const evil = '<img src=x onerror="alert(1)"> count issues';
    stubApi({
      handle: (c) =>
        c.path === "/artifacts/s1/sources"
          ? json({ sources: [source({ recipe: evil })], untrusted: "U" })
          : undefined,
    });
    renderDialog();
    const pre = await waitFor(() => {
      const p = document.querySelector("pre.pl-share-sources__recipe");
      if (!p) throw new Error("no recipe yet");
      return p;
    });
    expect(pre.textContent).toBe(evil);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText(/Waiting for you to confirm/)).toBeTruthy();
    expect(screen.getByText(/Read the recipe before you confirm/)).toBeTruthy();
    expect(screen.getByText(/Any Claude connection/)).toBeTruthy();
  });

  it("Confirm sends the config_hash that was shown, with the CSRF header, then reloads", async () => {
    let confirmed = false;
    const onChange = vi.fn();
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/sources") {
          return json({
            sources: [source(confirmed ? { status: "active", confirmed_at: "x" } : {})],
            untrusted: "U",
          });
        }
        if (c.path === "/artifacts/s1/sources/linear/confirm" && c.method === "POST") {
          confirmed = true;
          return json(source({ status: "active" }));
        }
        return undefined;
      },
    });
    renderDialog(true, onChange);
    await userEvent.click(await screen.findByRole("button", { name: "Confirm Open issues" }));
    const post = calls.find((c) => c.path === "/artifacts/s1/sources/linear/confirm");
    expect(post?.body).toEqual({ config_hash: HASH });
    expect(post?.headers[CSRF_HEADER]).toBe("tok-123");
    await screen.findByText(/Confirmed/);
    expect(screen.queryByRole("button", { name: "Confirm Open issues" })).toBeNull();
    expect(onChange).toHaveBeenCalled();
  });

  it("a changed source (409) says so and reloads", async () => {
    stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/sources")
          return json({ sources: [source()], untrusted: "U" });
        if (c.path.endsWith("/confirm")) return apiError(409, "conflict", "changed");
        return undefined;
      },
    });
    renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Confirm Open issues" }));
    expect(await screen.findByText(/This source changed/)).toBeTruthy();
  });

  it("Remove deletes the source", async () => {
    let gone = false;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/sources") {
          return json({ sources: gone ? [] : [source({ status: "active" })], untrusted: "U" });
        }
        if (c.path === "/artifacts/s1/sources/linear" && c.method === "DELETE") {
          gone = true;
          return json({ removed: "linear" });
        }
        return undefined;
      },
    });
    renderDialog();
    await userEvent.click(await screen.findByRole("button", { name: "Remove Open issues" }));
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/artifacts/s1/sources/linear"),
    ).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Data sources:/)).toBeNull());
  });

  it("warns when the pinned connection was revoked", async () => {
    stubApi({
      handle: (c) =>
        c.path === "/artifacts/s1/sources"
          ? json({ sources: [source({ pin_lost_at: "2026-11-19T11:00:00.000Z" })], untrusted: "U" })
          : undefined,
    });
    renderDialog();
    expect(await screen.findByText(/was pinned to was revoked/)).toBeTruthy();
  });

  it("only the owner loads the sources", async () => {
    const { calls } = stubApi({ handle: () => json({ sources: [source()], untrusted: "U" }) });
    renderDialog(false);
    await screen.findByRole("dialog", { name: "Share this artifact" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.path.startsWith("/artifacts/s1/sources"))).toBe(false);
    expect(document.querySelector("pre.pl-share-sources__recipe")).toBeNull();
  });

  it("names the target in words", () => {
    expect(targetText(source())).toBe("Any Claude connection");
    expect(
      targetText(
        source({
          target: { client_type: "codex", connection_id: "c1", connection_label: "work laptop" },
        }),
      ),
    ).toBe("Pinned to the connection work laptop");
    expect(
      targetText(
        source({ target: { client_type: "other", connection_id: null, connection_label: null } }),
      ),
    ).toBe("Any of your other connections");
  });
});
