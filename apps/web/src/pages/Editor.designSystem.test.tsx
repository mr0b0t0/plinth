// The source editor on a design system: Monaco holds JSON (draft.json, which the JSON Schema is
// attached to), the preview is the design system shell, problems show above the editor with their
// paths while the preview keeps its last valid render, and Save waits until there are none.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE } from "../renderers/design_system/testFixture.ts";

const seen = vi.hoisted(() => ({
  editor: [] as Array<{ language?: string; wordWrap?: string; path: string; value: string }>,
  preview: [] as string[],
}));
vi.mock("../components/editor/CodeEditor.tsx", () => ({
  CodeEditor: (p: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
    path: string;
    language?: string;
    wordWrap?: string;
  }): ReactNode => {
    seen.editor.push(p);
    return (
      <textarea
        aria-label={p.ariaLabel}
        data-language={p.language}
        data-path={p.path}
        value={p.value}
        onChange={(e) => p.onChange(e.currentTarget.value)}
      />
    );
  },
  CodeDiff: (): ReactNode => <div data-testid="code-diff" />,
}));
vi.mock("../components/editor/PreviewFrame.tsx", () => ({
  PREVIEW_DEBOUNCE_MS: 300,
  PreviewFrame: (p: { html: string }): ReactNode => {
    seen.preview.push(p.html);
    return <div data-testid="preview" />;
  },
}));

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

const SOURCE = JSON.stringify(FIXTURE, null, 2);
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
  slug: "acme",
  title: "Acme UI",
  type: "design_system",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  url: "http://app.localhost:8787/a/acme",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "me@example.com", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  version: 1,
  source_path: "system.json",
  content: SOURCE,
  assets: [],
};

function mockApi() {
  const sent: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/\?.*$/, "");
      const method = init?.method ?? "GET";
      sent.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path === "/api/v1/config") return json(CONFIG);
      if (path === "/api/v1/me") return json(ME);
      if (path === "/api/v1/artifacts/art1" && method === "PUT") {
        return json({ id: "art1", version: 2, type: "design_system", warnings: [] });
      }
      if (path === "/api/v1/artifacts/acme") return json(DETAIL);
      return json({ error: { code: "not_found", message: "nope" } }, 404);
    }),
  );
  return sent;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/acme/edit");
  (
    window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
  ).happyDOM.setViewport({ width: 1280, height: 800 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  seen.editor.length = 0;
  seen.preview.length = 0;
});

describe("the editor on a design system", () => {
  it("holds JSON in draft.json and previews it in the design system shell", async () => {
    mockApi();
    const Editor = await loadPage();
    render(<Editor params={{ slug: "acme" }} />);
    const box = (await screen.findByRole("textbox", {
      name: /^design system JSON of Acme UI/,
    })) as HTMLTextAreaElement;
    expect(box.dataset.language).toBe("json");
    expect(box.dataset.path?.endsWith("/draft.json")).toBe(true);
    expect(seen.editor.at(-1)?.wordWrap).toBe("off");
    expect(box.value).toBe(SOURCE);
    await waitFor(() =>
      expect(seen.preview.at(-1)).toContain("/__plinth/types/design_system/ds.js"),
    );
  });

  it("shows each problem with its path and keeps Save off until they are fixed", async () => {
    const sent = mockApi();
    const Editor = await loadPage();
    render(<Editor params={{ slug: "acme" }} />);
    const box = (await screen.findByRole("textbox", {
      name: /^design system JSON of Acme UI/,
    })) as HTMLTextAreaElement;
    const broken = SOURCE.replace('"#ffffff"', '"#ffffff; }"');
    fireEvent.change(box, { target: { value: broken } });
    const list = await screen.findByRole("status", { name: "Fix the design system JSON to save" });
    expect(list.querySelector("code")?.textContent).toBe("tokens.color.bg.$value");
    const save = screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The preview keeps the last valid render instead of repeating the problems.
    expect(seen.preview.at(-1)).not.toContain("#ffffff; }");
    expect(seen.preview.at(-1)).toContain("#ffffff");

    const fixed = SOURCE.replace('"#ffffff"', '"#fafafa"');
    fireEvent.change(box, { target: { value: fixed } });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /^Fix the design system JSON/ })).toBeNull(),
    );
    await waitFor(() => expect(seen.preview.at(-1)).toContain("#fafafa"));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(sent.some((s) => s.method === "PUT")).toBe(true));
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.body).toEqual({ content: fixed, base_version: 1 });
  });
});
