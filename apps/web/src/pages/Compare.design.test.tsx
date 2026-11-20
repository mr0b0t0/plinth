// Compare for a type people never see the source of (a design): the change list and the rendered
// pages, and no Source tab at any point, the load included. A page compares the same way: Compare
// shows no source for any type.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/editor/CodeEditor.tsx", () => ({
  CodeEditor: (): ReactNode => <textarea aria-label="code" />,
  CodeDiff: (): ReactNode => <div data-testid="code-diff" />,
}));

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
const DESIGN = {
  id: "art1",
  slug: "kit",
  title: "Launch kit",
  type: "design",
  visibility: "allowlist",
  current_version: 2,
  version_count: 2,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  url: "http://app.localhost:8787/a/kit",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "me@example.com", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  version: 2,
  source_path: "design.html",
  content: '<!-- artboard name="Home" size="iphone" -->\n<h1>Hi</h1>',
  assets: [],
};
const PAGE = (() => {
  const { content: _content, ...rest } = DESIGN;
  return { ...rest, type: "html", source_path: "index.html", html: "<h1>Hi</h1>" };
})();
const VERSIONS = {
  items: [2, 1].map((number) => ({
    number,
    created_at: "2026-11-01T00:00:00Z",
    created_by: { kind: "user", id: "u1", label: "me@example.com" },
    size_bytes: 10,
    note: null,
  })),
  next_cursor: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let artifact: () => Promise<Response>;
/** What one version's detail answers: the artifact's own detail at that number. */
let detail: unknown = DESIGN;

beforeEach(() => {
  window.history.replaceState(null, "", "/a/kit/compare?from=1&to=2");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/\?.*$/, "");
      if (path === "/api/v1/config") return json(CONFIG);
      if (path === "/api/v1/me") return json(ME);
      if (path === "/api/v1/artifacts/kit") return artifact();
      if (path === "/api/v1/artifacts/kit/versions") return json(VERSIONS);
      const v = /^\/api\/v1\/artifacts\/kit\/versions\/(\d+)$/.exec(path);
      if (v) return json({ ...(detail as object), version: Number(v[1]) });
      return json({ error: { code: "not_found", message: "nope" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  vi.resetModules();
  const Compare = (await import("./Compare.tsx")).default;
  render(<Compare params={{ slug: "kit" }} />);
}

describe("comparing versions of a design", () => {
  it("shows no Source tab while the artifact loads", async () => {
    artifact = () => new Promise<Response>(() => {});
    await open();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("tab", { name: /source/i })).toBeNull();
    expect(screen.queryByText(/Loading the two versions/)).toBeNull();
  });

  it("shows only the rendered pages once it is a design", async () => {
    artifact = async () => json(DESIGN);
    detail = DESIGN;
    await open();
    await waitFor(() => expect(screen.getByLabelText("To")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /source/i })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("compares a page the same way, with no Source or Rendered tab", async () => {
    artifact = async () => json(PAGE);
    detail = PAGE;
    await open();
    await waitFor(() => expect(screen.getByRole("region", { name: "Changes" })).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /source/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /rendered/i })).toBeNull();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });
});
