// A sheet has no source editor: its editor address sends people to the sheet's page, and no part
// of the editor (the code pane, its preview) is mounted.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ editor: 0 }));
vi.mock("../components/editor/CodeEditor.tsx", () => ({
  CodeEditor: (): ReactNode => {
    seen.editor++;
    return <textarea aria-label="code" />;
  },
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
const DETAIL = {
  id: "art1",
  slug: "budget",
  title: "Budget",
  type: "sheet",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  url: "http://app.localhost:8787/a/budget",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "me@example.com", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  version: 1,
  source_path: "sheet.jsonl",
  content: '{"plinth":"sheet","v":1,"columns":[{"name":"Item"}]}\n["Apples"]',
  assets: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  window.history.replaceState(null, "", "/a/budget/edit");
  (
    window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
  ).happyDOM.setViewport({ width: 1280, height: 800 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input).replace(/\?.*$/, "");
      if (path === "/api/v1/config") return json(CONFIG);
      if (path === "/api/v1/me") return json(ME);
      if (path === "/api/v1/artifacts/budget") return json(DETAIL);
      return json({ error: { code: "not_found", message: "nope" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  seen.editor = 0;
});

describe("the editor address of a sheet", () => {
  it("goes to the sheet's page, without mounting the editor", async () => {
    vi.resetModules();
    const Editor = (await import("./Editor.tsx")).default;
    render(<Editor params={{ slug: "budget" }} />);
    await waitFor(() => expect(window.location.pathname).toBe("/a/budget"));
    expect(seen.editor).toBe(0);
    expect(screen.queryByText(/needs a wider screen/)).toBeNull();
  });
});
