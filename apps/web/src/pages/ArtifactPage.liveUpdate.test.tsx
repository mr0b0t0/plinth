// The artifact page applying a newer version while keeping the reader's state (docs/spec.md "Live
// views"): with live views on, a page that declares `hold` waits while focus is in its frame and
// offers Update; a doc shows the version in place without a new frame; a page with the runtime
// lands the new version where it was. With live views off, every update is a swap, as before
// (ArtifactPage.test.tsx).
import type { AppConfig, ViewArtifact, ViewGate } from "@plinth/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";
import { VERSION_POLL_MS } from "../components/viewer/useVersionWatch.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactPage.tsx")).default;
}

const ORIGIN = "http://art123.content.localhost:8787";
const ENTER = (n: number) => `${ORIGIN}/__plinth/enter?t=token-${n}&next=%2F`;
const LIVE: AppConfig = { ...CONFIG, live_views: true };

const ARTIFACT: ViewArtifact = {
  id: "art123",
  slug: "garden-plan",
  title: "Garden plan",
  type: "html",
  current_version: 3,
  version: 3,
  visibility: "unlisted",
  owner_name: null,
};

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** A server whose current version moves when the test says; every gate read is recorded. */
function server(
  opts: {
    config?: AppConfig;
    type?: ViewArtifact["type"];
    hold?: boolean;
    /** A signed-in editor who can edit the doc solo on its page. */
    editor?: boolean;
  } = {},
) {
  const state = { current: 3, reads: [] as string[] };
  stubApi({
    config: opts.config ?? LIVE,
    me: opts.editor ? ME : null,
    handle: (c) => {
      if (!c.path.startsWith("/view/garden-plan")) return undefined;
      state.reads.push(c.path);
      const gate: OkGate = {
        status: "ok",
        artifact: {
          ...ARTIFACT,
          type: opts.type ?? "html",
          current_version: state.current,
          version: state.current,
        },
        enter_url: ENTER(state.reads.length),
        role: opts.editor ? "editor" : null,
        ...(opts.editor ? { live: { mode: "solo" as const, draft: null } } : {}),
        ...(opts.hold ? { hold: true as const } : {}),
      };
      return json(gate);
    },
  });
  return state;
}

/** Give the frame a window to post to, and record what the app sends it. */
function frameWindow(frame: HTMLIFrameElement) {
  const sent: [Record<string, unknown>, string][] = [];
  const win = {
    postMessage: (m: Record<string, unknown>, target: string) => void sent.push([m, target]),
  };
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: win });
  const fromFrame = (data: Record<string, unknown>, origin = ORIGIN) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: win as unknown as Window }),
      );
    });
  return { win, sent, fromFrame };
}

/** The first message of `type` the app sent the frame, once it has. */
function sentOf(sent: [Record<string, unknown>, string][], type: string) {
  return vi.waitFor(() => {
    const found = sent.find(([m]) => m.type === type);
    if (!found) throw new Error("not yet");
    return found[0];
  });
}

/** The doc renderer's status while the viewer edits solo with unsaved changes. */
const DIRTY = {
  type: "live",
  connected: false,
  failed: false,
  editing: true,
  holding: false,
  dirty: true,
  unflushed: false,
  rev: 0,
  base_version: 0,
  conflict_version: null,
  last_by_you: false,
  last_edit_at: null,
  editors: [],
};

/** Put focus inside `frame`, as when the viewer is typing in the page. */
function focusInto(frame: HTMLIFrameElement) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => frame });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/garden-plan");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as { activeElement?: unknown }).activeElement;
});

describe("ArtifactPage: applying a newer version (live views)", () => {
  it("holds a page that declares hold while focus is in its frame, until Update", async () => {
    const s = server({ hold: true });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    focusInto(frame);

    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const notice = await screen.findByText(/is available/);
    expect(notice.textContent).toContain("v4 is available");
    // The page on view stays, with its enter URL; the bar knows v4 exists.
    expect(screen.getByTitle("Garden plan, version 3").getAttribute("src")).toBe(ENTER(1));
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();
    expect(screen.queryByText("Updated to v4")).toBeNull();
    expect(screen.queryByText(/You are viewing/)).toBeNull();
    // Later polls do not replace it either.
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 2);
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Update" }));
    const next = await screen.findByTitle("Garden plan, version 4");
    fireEvent.load(next);
    expect(next.getAttribute("src")).toBe(ENTER(s.reads.length));
    expect(await screen.findByText("Updated to v4")).toBeTruthy();
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it("replaces a page that declares hold when focus is elsewhere, and one that does not", async () => {
    for (const hold of [true, false]) {
      const s = server({ hold });
      const ArtifactPage = await loadPage();
      render(<ArtifactPage params={{ slug: "garden-plan" }} />);
      const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
      if (!hold) focusInto(frame);
      s.current = 4;
      await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
      expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
      expect(screen.queryByText(/is available/)).toBeNull();
      cleanup();
      vi.restoreAllMocks();
      delete (document as unknown as { activeElement?: unknown }).activeElement;
    }
  });

  it("with live views off, swaps even a page that declares hold, as before", async () => {
    const s = server({ hold: true, config: CONFIG });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    focusInto((await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement);
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it("shows a doc's new version in place: no new frame, no new enter URL", async () => {
    const s = server({ type: "doc" });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);

    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const ask = await vi.waitFor(() => {
      const found = sent.find(([m]) => m.type === "version");
      if (!found) throw new Error("not yet");
      return found;
    });
    expect(ask[1]).toBe(ORIGIN);
    expect(ask?.[0]).toMatchObject({ source: "plinth-renderer", v: 1, type: "version", n: 4 });
    const nonce = ask?.[0].nonce as string;
    // A forged answer (another nonce, another origin) changes nothing.
    fromFrame({
      source: "plinth-renderer",
      v: 1,
      type: "shown",
      n: 4,
      nonce: "x".repeat(16),
      ok: true,
    });
    fromFrame({ source: "plinth-renderer", v: 1, type: "shown", n: 4, nonce, ok: true }, "null");
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();

    fromFrame({ source: "plinth-renderer", v: 1, type: "shown", n: 4, nonce, ok: true });
    const shown = await screen.findByTitle("Garden plan, version 4");
    // The same frame, renamed: its src (the first enter URL) never changed.
    expect(shown).toBe(frame);
    expect(shown.getAttribute("src")).toBe(ENTER(1));
    expect(screen.queryByTitle("Garden plan, version 3")).toBeNull();
    expect(await screen.findByText("Updated to v4")).toBeTruthy();
  });

  it("keeps a doc's frame when editing began while its renderer fetched the version", async () => {
    const s = server({ type: "doc", editor: true });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const ask = await sentOf(sent, "version");
    // Before the renderer answers, the viewer edits and the page has unsaved changes.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    // An editor's frame carries its key in its address; its editing messages carry it too.
    const key = /#plinth-k=([A-Za-z0-9_-]{43})$/.exec(frame.getAttribute("src") ?? "")?.[1];
    expect(key).toBeTruthy();
    fromFrame({ source: "plinth-renderer", v: 1, key, ...DIRTY });
    const n = s.reads.length;
    // The renderer refuses: it never replaces a draft. The frame must stay too.
    fromFrame({
      source: "plinth-renderer",
      v: 1,
      type: "shown",
      n: 4,
      nonce: ask.nonce,
      ok: false,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.getByTitle("Garden plan, version 3")).toBe(frame);
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();
    expect(s.reads.length).toBe(n);
  });

  it("swaps a doc whose renderer could not show the version, or did not answer", async () => {
    const s = server({ type: "doc" });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const nonce = (await sentOf(sent, "version")).nonce as string;
    fromFrame({ source: "plinth-renderer", v: 1, type: "shown", n: 4, nonce, ok: false });
    const next = await screen.findByTitle("Garden plan, version 4");
    expect(next).not.toBe(frame);
    expect(next.getAttribute("src")).toBe(ENTER(2));

    // No answer at all: after 5 s, a fresh frame.
    fireEvent.load(next);
    frameWindow(next as HTMLIFrameElement);
    s.current = 5;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(screen.queryByTitle("Garden plan, version 5")).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByTitle("Garden plan, version 5")).toBeTruthy();
  });

  it("asks a page with the runtime, and lands the new version where the page was", async () => {
    const s = server();
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "hello" });

    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const ask = await vi.waitFor(() => {
      const found = sent.find(([m]) => m.type === "update");
      if (!found) throw new Error("not yet");
      return found;
    });
    expect(ask[1]).toBe(ORIGIN);
    expect(ask?.[0]).toMatchObject({ source: "plinth-view", v: 1, from: 3, to: 4, force: false });
    const nonce = ask?.[0].nonce as string;
    fromFrame({
      source: "plinth-view",
      v: 1,
      type: "update:ok",
      nonce,
      path: "/guide.html?tab=2#q=salary%20of%20Jane",
    });
    expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
    // One more gate read, with the page's place as `next`, never its hash: the request URL (and
    // the enter URL the server builds from it) must not carry what the page keeps in its fragment.
    // `carried=1`: the server lands it on the root if version 4 has no file there.
    expect(s.reads.at(-1)).toBe(
      `/view/garden-plan?next=${encodeURIComponent("/guide.html?tab=2")}&carried=1`,
    );
    expect(s.reads.join(" ")).not.toContain("salary");
  });

  it("holds a page that declares hold and loads the runtime while focus is in its frame", async () => {
    const s = server({ hold: true });
    const ArtifactPage = await loadPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "hello" });
    focusInto(frame);

    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect((await screen.findByText(/is available/)).textContent).toContain("v4 is available");
    // The runtime is not asked (an update:ok would replace what the viewer is typing).
    expect(sent.filter(([m]) => m.type === "update")).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();
    expect(screen.getByTitle("Garden plan, version 3")).toBe(frame);

    // Update asks the runtime with force, so it records its state, then loads v4.
    await user.click(screen.getByRole("button", { name: "Update" }));
    const forced = await sentOf(sent, "update");
    expect(forced).toMatchObject({ from: 3, to: 4, force: true });
    fromFrame({ source: "plinth-view", v: 1, type: "update:ok", nonce: forced.nonce as string });
    expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
  });

  it("holds a page that declares hold when focus came into its frame while the runtime answered", async () => {
    const s = server({ hold: true });
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "hello" });
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const ask = await sentOf(sent, "update");
    focusInto(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "update:ok", nonce: ask.nonce as string });
    expect((await screen.findByText(/is available/)).textContent).toContain("v4 is available");
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();
  });

  it("holds when the page's runtime asks, and forces the update when the viewer chooses it", async () => {
    const s = server();
    const ArtifactPage = await loadPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { sent, fromFrame } = frameWindow(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "hello" });
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    const first = await sentOf(sent, "update");
    fromFrame({ source: "plinth-view", v: 1, type: "update:hold", nonce: first?.nonce as string });
    expect((await screen.findByText(/is available/)).textContent).toContain("v4");
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Update" }));
    const forced = await vi.waitFor(() => {
      const last = sent.filter(([m]) => m.type === "update").at(-1)?.[0];
      if (last?.force !== true) throw new Error("not yet");
      return last;
    });
    expect(forced).toMatchObject({ from: 3, to: 4, force: true });
    fromFrame({ source: "plinth-view", v: 1, type: "update:ok", nonce: forced?.nonce as string });
    expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
  });

  it("swaps a page with the runtime that does not answer within a second", async () => {
    const s = server();
    const ArtifactPage = await loadPage();
    render(<ArtifactPage params={{ slug: "garden-plan" }} />);
    const frame = (await screen.findByTitle("Garden plan, version 3")) as HTMLIFrameElement;
    const { fromFrame } = frameWindow(frame);
    fromFrame({ source: "plinth-view", v: 1, type: "hello" });
    s.current = 4;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(screen.queryByTitle("Garden plan, version 4")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await screen.findByTitle("Garden plan, version 4")).toBeTruthy();
  });
});
