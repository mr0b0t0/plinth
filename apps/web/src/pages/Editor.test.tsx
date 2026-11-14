import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session store is module state; load a fresh copy of the page for each test.
async function loadPage() {
  vi.resetModules();
  return (await import("./Editor.tsx")).default;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIG = {
  app_origin: "http://app.localhost:8787",
  content_host: "content.localhost:8787",
  content_protocol: "http:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  content_isolation: "origin",
  environment: "development",
};
const ME = {
  id: "u1",
  email: "me@example.com",
  name: null,
  created_at: "2026-11-01T00:00:00Z",
  artifact_limit: 100,
  artifact_count: 1,
  is_admin: false,
};
const artifact = (role: string, extra: Record<string, unknown> = {}) => ({
  id: "art1",
  slug: "demo",
  title: "Demo piece",
  visibility: "unlisted",
  current_version: 3,
  version_count: 3,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  url: "http://app.localhost:8787/a/demo",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u0", email: "owner@example.com", name: null },
  role,
  taken_down: false,
  version: 3,
  html: "<p>v3</p>",
  assets: [],
  ...extra,
});

function api(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string) => {
    const path = String(input).replace(/\?.*$/, "");
    const handler = routes[path];
    return handler ? handler() : json({ error: { code: "not_found", message: "nope" } }, 404);
  });
}

type HappyWindow = Window & {
  happyDOM: { setViewport(v: { width: number; height: number }): void };
};
const setViewport = (width: number) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 800 });

beforeEach(() => {
  window.history.replaceState(null, "", "/a/demo/edit");
  setViewport(1280);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Editor page", () => {
  it("asks a signed-out visitor to sign in and come back", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "/api/v1/config": () => json(CONFIG),
        "/api/v1/me": () => json({ error: { code: "unauthorized", message: "no" } }, 401),
      }),
    );
    const Editor = await loadPage();
    render(<Editor params={{ slug: "demo" }} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in to edit" })).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Sign in" });
    expect(links.at(-1)?.getAttribute("href")).toBe("/login?next=%2Fa%2Fdemo%2Fedit");
    expect(document.title).toBe("Sign in to edit · Plinth");
  });

  for (const role of ["viewer", "commenter"]) {
    it(`tells a ${role} they cannot edit`, async () => {
      vi.stubGlobal(
        "fetch",
        api({
          "/api/v1/config": () => json(CONFIG),
          "/api/v1/me": () => json(ME),
          "/api/v1/artifacts/demo": () => json(artifact(role)),
        }),
      );
      const Editor = await loadPage();
      render(<Editor params={{ slug: "demo" }} />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "You can't edit this" }),
      ).toBeTruthy();
      expect(screen.getByText(/You can view “Demo piece”/)).toBeTruthy();
      expect(screen.getByRole("link", { name: "View artifact" }).getAttribute("href")).toBe(
        "/a/demo",
      );
    });
  }

  it("refuses a taken-down artifact even for its owner", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "/api/v1/config": () => json(CONFIG),
        "/api/v1/me": () => json(ME),
        "/api/v1/artifacts/demo": () => json(artifact("owner", { taken_down: true })),
      }),
    );
    const Editor = await loadPage();
    render(<Editor params={{ slug: "demo" }} />);
    expect(
      await screen.findByText("This artifact was taken down and cannot be changed."),
    ).toBeTruthy();
  });

  it("says when the artifact does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      api({ "/api/v1/config": () => json(CONFIG), "/api/v1/me": () => json(ME) }),
    );
    const Editor = await loadPage();
    render(<Editor params={{ slug: "demo" }} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Artifact not found" }),
    ).toBeTruthy();
  });

  it("below 900px, says the editor needs a wider screen and links to the artifact and history", async () => {
    setViewport(360);
    vi.stubGlobal(
      "fetch",
      api({
        "/api/v1/config": () => json(CONFIG),
        "/api/v1/me": () => json(ME),
        "/api/v1/artifacts/demo": () => json(artifact("editor")),
      }),
    );
    const Editor = await loadPage();
    render(<Editor params={{ slug: "demo" }} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "The editor needs a wider screen" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "View artifact" }).getAttribute("href")).toBe(
      "/a/demo",
    );
    expect(screen.getByRole("link", { name: "Version history" }).getAttribute("href")).toBe(
      "/a/demo/history",
    );
    expect(document.title).toBe("Edit Demo piece · Plinth");
    expect(document.querySelector(".pl-editor")).toBeNull();
  });
});
