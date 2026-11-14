import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Monaco and the preview frame cannot run in happy-dom: stand-ins record what the workspace gives
// them. Only the doc tests below reach the workspace.
const seen = vi.hoisted(() => ({
  editor: [] as Array<{ language?: string; wordWrap?: string; path: string; value: string }>,
  diff: [] as Array<{ language?: string; original: string; modified: string; path: string }>,
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
  CodeDiff: (p: {
    original: string;
    modified: string;
    path: string;
    language?: string;
    originalLabel: string;
  }): ReactNode => {
    seen.diff.push(p);
    return <div data-testid="code-diff" data-language={p.language} data-label={p.originalLabel} />;
  },
}));
vi.mock("../components/editor/PreviewFrame.tsx", () => ({
  PREVIEW_DEBOUNCE_MS: 300,
  PreviewFrame: (p: { html: string }): ReactNode => {
    seen.preview.push(p.html);
    return <div data-testid="preview" />;
  },
}));

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
  type: "html",
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
  source_path: "index.html",
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
  sessionStorage.clear();
  seen.editor.length = 0;
  seen.diff.length = 0;
  seen.preview.length = 0;
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

  describe("a doc", () => {
    const DOC = "# Plan\n\nShip the doc type.\n";
    const docArtifact = (extra: Record<string, unknown> = {}) =>
      artifact("owner", {
        type: "doc",
        source_path: "content.md",
        html: undefined,
        content: DOC,
        ...extra,
      });

    interface Sent {
      method: string;
      path: string;
      body: unknown;
    }

    function docApi(put: (body: unknown) => Response, more: Record<string, () => Response> = {}) {
      const sent: Sent[] = [];
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const path = String(input).replace(/\?.*$/, "");
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        sent.push({ method, path, body });
        if (path === "/api/v1/config") return json(CONFIG);
        if (path === "/api/v1/me") return json(ME);
        if (path === "/api/v1/artifacts/art1" && method === "PUT") return put(body);
        if (path === "/api/v1/artifacts/demo") return json(docArtifact());
        const handler = more[path];
        return handler ? handler() : json({ error: { code: "not_found", message: "nope" } }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      return sent;
    }

    const editorBox = async () =>
      (await screen.findByRole("textbox", {
        name: /^Markdown of Demo piece/,
      })) as HTMLTextAreaElement;

    /** The payload a preview shell embeds for its renderer. */
    function payloadOf(shell: string) {
      // The stylesheet link is read as text: happy-dom would try to fetch it.
      const style = shell.match(/<link rel="stylesheet" href="([^"]*)">/)?.[1];
      const doc = new DOMParser().parseFromString(shell.replace(/<link [^>]*>/g, ""), "text/html");
      const block = doc.getElementById("__plinth-content");
      return {
        payload: JSON.parse(block?.textContent ?? "null") as Record<string, unknown>,
        script: doc.querySelector("script[src]")?.getAttribute("src"),
        style,
        title: doc.title,
      };
    }

    it("edits the Markdown in Monaco, previews it in the doc shell, and saves content", async () => {
      const sent = docApi(() => json({ id: "art1", version: 4, type: "doc" }));
      const Editor = await loadPage();
      render(<Editor params={{ slug: "demo" }} />);
      const box = await editorBox();
      expect(box.dataset.language).toBe("markdown");
      expect(box.dataset.path?.endsWith("/draft.md")).toBe(true);
      expect(seen.editor.at(-1)?.wordWrap).toBe("on");
      expect(box.value).toBe(DOC);
      expect(screen.getByText("Markdown", { selector: ".pl-editor-pane__label" })).toBeTruthy();

      const draft = `${DOC}\n| a | b |\n| - | - |\n| 1 | 2 |\n\n</script><script>alert(1)</script>\n`;
      fireEvent.change(box, { target: { value: draft } });
      await waitFor(() => expect(payloadOf(seen.preview.at(-1) ?? "").payload?.text).toBe(draft));
      const shown = payloadOf(seen.preview.at(-1) ?? "");
      expect(shown.payload).toEqual({
        v: 1,
        type: "doc",
        path: "content.md",
        app_origin: "http://app.localhost:8787",
        text: draft,
      });
      expect(shown.script).toBe("/__plinth/types/doc/doc.js");
      expect(shown.style).toBe("/__plinth/types/doc/doc.css");
      expect(shown.title).toBe("Demo piece");
      // The draft cannot close the data block: the shell has exactly its own two scripts.
      expect((seen.preview.at(-1) ?? "").match(/<script/g)).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Saved as v4")).toBeTruthy();
      const puts = sent.filter((s) => s.method === "PUT");
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).toEqual({ content: draft, base_version: 3 });
      expect(puts[0]?.body).not.toHaveProperty("html");
    });

    it("uses the path fallback base for the preview's renderer URLs", async () => {
      docApi(() => json({}));
      vi.stubGlobal(
        "fetch",
        api({
          "/api/v1/config": () =>
            json({ ...CONFIG, content_path_fallback: true, content_isolation: "opaque" }),
          "/api/v1/me": () => json(ME),
          "/api/v1/artifacts/demo": () => json(docArtifact()),
        }),
      );
      const Editor = await loadPage();
      render(<Editor params={{ slug: "demo" }} />);
      await editorBox();
      await waitFor(() => expect(seen.preview.length).toBeGreaterThan(0));
      expect(payloadOf(seen.preview.at(-1) ?? "").script).toBe(
        "/__content/art1/__plinth/types/doc/doc.js",
      );
    });

    it("shows a conflict in Markdown and keeps the draft", async () => {
      const theirs = "# Plan\n\nTheir change.\n";
      docApi(
        () =>
          json(
            {
              error: {
                code: "conflict",
                message: "stale",
                details: { current_version: 4 },
              },
            },
            409,
          ),
        {
          "/api/v1/artifacts/art1/versions/4": () =>
            json(docArtifact({ version: 4, current_version: 4, content: theirs })),
          "/api/v1/artifacts/art1/versions": () => json({ items: [], next_cursor: null }),
        },
      );
      const Editor = await loadPage();
      render(<Editor params={{ slug: "demo" }} />);
      const box = await editorBox();
      fireEvent.change(box, { target: { value: `${DOC}Mine.\n` } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(
        await screen.findByRole("heading", { name: /v4 was published while you were editing/ }),
      ).toBeTruthy();
      const diff = seen.diff.at(-1);
      expect(diff?.language).toBe("markdown");
      expect(diff?.original).toBe(theirs);
      expect(diff?.modified).toBe(`${DOC}Mine.\n`);
      expect(screen.getByTestId("code-diff").dataset.label).toContain("Markdown");
    });

    it("refuses to save Markdown over the doc limit and says why", async () => {
      docApi(() => json({}));
      const Editor = await loadPage();
      render(<Editor params={{ slug: "demo" }} />);
      const box = await editorBox();
      fireEvent.change(box, { target: { value: "a".repeat(1024 * 1024 + 1) } });
      expect(await screen.findByText(/larger than 1 MB, the most a doc can hold/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });
});
