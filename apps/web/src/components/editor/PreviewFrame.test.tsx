import type { AppConfig } from "@plinth/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_DEBOUNCE_MS, PreviewFrame } from "./PreviewFrame.tsx";

// happy-dom never loads frame pages (it logs a NotSupportedError per frame); the frame's window is
// replaced by a stub below, which is all these tests need.

const ORIGIN = "http://art1.content.localhost:8787";
const config: AppConfig = {
  app_origin: "http://app.localhost:8787",
  content_host: "content.localhost:8787",
  content_protocol: "http:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  environment: "development",
};
const ENTER = `${ORIGIN}/__plinth/enter?t=one-time&next=%2F__plinth%2Fpreview`;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** A stand-in for the frame's window, so posted messages can be inspected. */
function fakeFrameWindow() {
  return { postMessage: vi.fn(), location: { replace: vi.fn() } };
}

async function renderFrame(html = "<p>one</p>") {
  const fetchMock = vi.fn(async (_url: string) =>
    json({ status: "ok", enter_url: ENTER, role: "owner", artifact: {} }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<PreviewFrame artifactId="art1" title="Demo" html={html} config={config} />);
  const frame = (await screen.findByTitle("Preview of Demo")) as HTMLIFrameElement;
  const win = fakeFrameWindow();
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => win });
  return { view, frame, win, fetchMock };
}

function message(data: unknown, origin: string, source: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  });
}

const READY = { source: "plinth-preview", v: 1, type: "ready" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PreviewFrame", () => {
  it("opens the loader through a one-time gate, in the artifact sandbox", async () => {
    const { frame, fetchMock } = await renderFrame();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/v1/view/art1?next=%2F__plinth%2Fpreview",
    );
    expect(frame.getAttribute("src")).toBe(ENTER);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
  });

  it("posts the draft to the artifact origin only after a ready from its own frame", async () => {
    const { win } = await renderFrame("<p>draft</p>");
    message(READY, "https://evil.example", win);
    message(READY, ORIGIN, window);
    message({ ...READY, type: "pick" }, ORIGIN, win);
    expect(win.postMessage).not.toHaveBeenCalled();

    message(READY, ORIGIN, win);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: "plinth-preview", v: 1, type: "render", html: "<p>draft</p>" },
      ORIGIN,
    );
  });

  it("reloads the loader (no history entry) when the draft changes, then renders again", async () => {
    const { view, win } = await renderFrame("<p>one</p>");
    message(READY, ORIGIN, win);
    view.rerender(
      <PreviewFrame artifactId="art1" title="Demo" html="<p>two</p>" config={config} />,
    );
    expect(win.location.replace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(win.location.replace).toHaveBeenCalledWith(`${ORIGIN}/__plinth/preview`);
    message(READY, ORIGIN, win);
    expect(win.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "render", html: "<p>two</p>" }),
      ORIGIN,
    );
  });

  it("does not offer a preview in the staging path fallback", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <PreviewFrame
        artifactId="art1"
        title="Demo"
        html="<p>x</p>"
        config={{ ...config, content_path_fallback: true }}
      />,
    );
    expect(screen.getByText(/Live preview is not available on this instance/)).toBeTruthy();
    expect(screen.queryByTitle("Preview of Demo")).toBeNull();
  });
});
