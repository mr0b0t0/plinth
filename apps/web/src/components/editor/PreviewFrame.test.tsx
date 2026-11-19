import type { AppConfig } from "@plinth/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_DEBOUNCE_MS, PreviewFrame } from "./PreviewFrame.tsx";
import { MAX_PREVIEW_BYTES } from "./previewProtocol.ts";

// happy-dom never loads frame pages (it logs a NotSupportedError per frame); each frame's window is
// replaced by a stub below, which is all these tests need.

const ORIGIN = "http://art1.content.localhost:8787";
const config: AppConfig = {
  app_origin: "http://app.localhost:8787",
  content_host: "content.localhost:8787",
  content_protocol: "http:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  content_isolation: "origin",
  environment: "development",
  operator: null,
  email_provider: "console",
  max_artifacts_per_user: 100,
  source_url: null,
  limits: {
    max_html_bytes: 5242880,
    max_doc_bytes: 1048576,
    max_version_bytes: 52428800,
    max_assets_per_version: 511,
    max_asset_path_length: 200,
    max_request_bytes: 41943040,
    max_bundle_bytes: 60817408,
    max_bundle_file_bytes: 26214400,
    max_sheet_bytes: 1048576,
    max_sheet_rows: 10000,
    max_sheet_columns: 100,
  },
  cdn_allowlist: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
  upload_ticket_ttl_s: 1800,
  dictation: false,
};
const opaqueConfig: AppConfig = { ...config, content_isolation: "opaque" };
const ENTER = `${ORIGIN}/__plinth/enter?t=one-time&next=%2F__plinth%2Fpreview`;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

/** Stub windows by frame element: a new element (a new loader) gets a new window. */
const windows = new WeakMap<HTMLIFrameElement, FakeWindow>();

/** The current preview frame, its stub window and the nonce in its URL. */
function current() {
  const frame = screen.getByTitle("Preview of Demo") as HTMLIFrameElement;
  let win = windows.get(frame);
  if (!win) {
    const stub: FakeWindow = { postMessage: vi.fn() };
    win = stub;
    windows.set(frame, stub);
    Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => stub });
  }
  const src = frame.getAttribute("src") ?? "";
  const nonce = /#plinth-preview=([0-9a-f]+)$/.exec(src)?.[1] ?? "";
  return { frame, win, src, nonce };
}

async function renderFrame(html = "<p>one</p>", cfg = config, tooLargeText?: string) {
  const fetchMock = vi.fn(async (_url: string) =>
    json({ status: "ok", enter_url: ENTER, role: "owner", artifact: {} }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    <PreviewFrame
      artifactId="art1"
      title="Demo"
      html={html}
      config={cfg}
      tooLargeText={tooLargeText}
    />,
  );
  await screen.findByTitle("Preview of Demo");
  return { view, fetchMock, ...current() };
}

function message(data: unknown, origin: string, source: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  });
}

const ready = (nonce: string) => ({ source: "plinth-preview", v: 2, type: "ready", nonce });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PreviewFrame", () => {
  it("opens the loader through a one-time gate, in the artifact sandbox, with a nonce", async () => {
    const { frame, fetchMock, src, nonce } = await renderFrame();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/v1/view/art1?next=%2F__plinth%2Fpreview",
    );
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(src).toBe(`${ENTER}#plinth-preview=${nonce}`);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
  });

  it("posts the draft to the artifact origin only after a ready from its own frame", async () => {
    const { win, nonce } = await renderFrame("<p>draft</p>");
    message(ready(nonce), "https://evil.example", win);
    message(ready(nonce), "null", win);
    message(ready(nonce), ORIGIN, window);
    message({ ...ready(nonce), type: "pick" }, ORIGIN, win);
    message(ready("f".repeat(32)), ORIGIN, win);
    expect(win.postMessage).not.toHaveBeenCalled();

    message(ready(nonce), ORIGIN, win);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: "plinth-preview", v: 2, type: "render", html: "<p>draft</p>" },
      ORIGIN,
    );
    // The nonce is spent: a second ready (say, from the rendered draft) gets nothing.
    message(ready(nonce), ORIGIN, win);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  it("opens a new frame with a new nonce when the draft changes, then renders again", async () => {
    const { view, win, frame, nonce } = await renderFrame("<p>one</p>");
    message(ready(nonce), ORIGIN, win);
    view.rerender(
      <PreviewFrame artifactId="art1" title="Demo" html="<p>two</p>" config={config} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
    });
    const next = current();
    expect(next.frame).not.toBe(frame);
    expect(next.nonce).not.toBe(nonce);
    // Later loaders skip the gate: the loader holds no data, and the cookie is already set.
    expect(next.src).toBe(`${ORIGIN}/__plinth/preview#plinth-preview=${next.nonce}`);
    // The old frame's nonce no longer works, even from the new window.
    message(ready(nonce), ORIGIN, next.win);
    expect(next.win.postMessage).not.toHaveBeenCalled();
    message(ready(next.nonce), ORIGIN, next.win);
    expect(next.win.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "render", html: "<p>two</p>" }),
      ORIGIN,
    );
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  describe("over the preview cap", () => {
    it("says the HTML wording by default and posts nothing", async () => {
      // 1.75 M three-byte characters: under the cap in UTF-16 units, over it in UTF-8 bytes.
      const { win, nonce } = await renderFrame(
        "\u20ac".repeat(Math.floor(MAX_PREVIEW_BYTES / 3) + 1),
      );
      message(ready(nonce), ORIGIN, win);
      expect(win.postMessage).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe(
        "The draft is larger than 5 MB, the most a version can hold, so it cannot be previewed or saved.",
      );
    });

    it("shows the caller's text for a typed artifact's shell", async () => {
      const text = "Too large to preview. Saving still works.";
      const { win, nonce } = await renderFrame("<".repeat(MAX_PREVIEW_BYTES + 1), config, text);
      message(ready(nonce), ORIGIN, win);
      expect(win.postMessage).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe(text);
    });

    it("renders a draft exactly at the cap", async () => {
      const draft = "a".repeat(MAX_PREVIEW_BYTES);
      const { win, nonce } = await renderFrame(draft);
      message(ready(nonce), ORIGIN, win);
      expect(win.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "render", html: draft }),
        ORIGIN,
      );
    });
  });

  describe("under opaque isolation", () => {
    it("drops allow-same-origin from the frame sandbox", async () => {
      const { frame } = await renderFrame("<p>x</p>", opaqueConfig);
      expect(frame.getAttribute("sandbox")).toBe(
        "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
      );
    });

    it("accepts a ready with origin null from its own frame and nonce, and posts to *", async () => {
      const { win, nonce } = await renderFrame("<p>secret draft</p>", opaqueConfig);
      // The artifact origin is not what an opaque document reports.
      message(ready(nonce), ORIGIN, win);
      // Origin null from another window, or without the nonce: ignored.
      message(ready(nonce), "null", window);
      message(ready("a".repeat(32)), "null", win);
      message({ source: "plinth-preview", v: 2, type: "ready" }, "null", win);
      expect(win.postMessage).not.toHaveBeenCalled();

      message(ready(nonce), "null", win);
      expect(win.postMessage).toHaveBeenCalledTimes(1);
      expect(win.postMessage).toHaveBeenCalledWith(
        { source: "plinth-preview", v: 2, type: "render", html: "<p>secret draft</p>" },
        "*",
      );
      // One render per frame.
      message(ready(nonce), "null", win);
      expect(win.postMessage).toHaveBeenCalledTimes(1);
    });

    it("never posts a draft to a frame that has been replaced", async () => {
      const { view, win, nonce } = await renderFrame("<p>one</p>", opaqueConfig);
      message(ready(nonce), "null", win);
      view.rerender(
        <PreviewFrame artifactId="art1" title="Demo" html="<p>two</p>" config={opaqueConfig} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
      });
      // The first frame (and whatever document it now holds) is gone; its window gets nothing more,
      // whatever it posts.
      message(ready(nonce), "null", win);
      expect(win.postMessage).toHaveBeenCalledTimes(1);
      const next = current();
      message(ready(next.nonce), "null", next.win);
      expect(next.win.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "render", html: "<p>two</p>" }),
        "*",
      );
    });
  });
});
