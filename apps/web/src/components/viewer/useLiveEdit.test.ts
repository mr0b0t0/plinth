// useLiveEdit: the app side of on-page doc editing (#36). The frame is a real iframe whose window
// stands in for the doc renderer; its messages are dispatched with that window as their source.
import { CSRF_HEADER, type ViewGate } from "@plinth/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFrameStatus } from "./rendererProtocol.ts";
import { apiError, CONFIG, json, stubApi } from "./test-utils.ts";
import { AUTOSAVE_FALLBACK_MS, useLiveEdit } from "./useLiveEdit.ts";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../ui/index.ts", async (orig) => {
  const actual = await orig<typeof import("../ui/index.ts")>();
  return {
    ...actual,
    showToast: (o: { title: string }) => {
      toasts.push(o.title);
      return 1;
    },
  };
});

type OkGate = Extract<ViewGate, { status: "ok" }>;
const ORIGIN = "http://art1.content.localhost:8787";

const gate = (mode: "room" | "solo", over: Partial<OkGate> = {}): OkGate => ({
  status: "ok",
  artifact: {
    id: "art1",
    slug: "plan",
    title: "Plan",
    type: "doc",
    current_version: 3,
    version: 3,
    visibility: "allowlist",
    owner_name: null,
  },
  enter_url: `${ORIGIN}/__plinth/enter?t=x`,
  role: "editor",
  live: { mode, draft: null },
  ...over,
});

const STATUS: LiveFrameStatus = {
  connected: true,
  failed: false,
  editing: true,
  holding: true,
  dirty: true,
  unflushed: false,
  rev: 7,
  base_version: 3,
  conflict_version: null,
  last_by_you: true,
  last_edit_at: null,
  editors: [],
};

let frame: HTMLIFrameElement;
let toFrame: ReturnType<typeof vi.fn>;
let frameWin: { postMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  toasts.length = 0;
  frame = document.createElement("iframe");
  toFrame = vi.fn();
  frameWin = { postMessage: toFrame };
  Object.defineProperty(frame, "contentWindow", { value: frameWin });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

/** The frame posts a message to the app. */
function fromFrame(data: Record<string, unknown>, origin = ORIGIN) {
  act(() => {
    const e = new MessageEvent("message", {
      data: { source: "plinth-renderer", v: 1, ...data },
      origin,
    });
    Object.defineProperty(e, "source", { value: frameWin });
    window.dispatchEvent(e);
  });
}

function sentToFrame(type: string) {
  return toFrame.mock.calls.filter((c) => c[0]?.type === type);
}

const INFO = {
  mode: "room",
  draft: null,
  editors_online: 2,
  idle_checkpoint_s: 120,
  auto_checkpoint_min_s: 600,
};

function hook(g: OkGate, onReload = vi.fn()) {
  return renderHook(() =>
    useLiveEdit({ gate: g, frame, contentOrigin: ORIGIN, config: CONFIG, onReload }),
  );
}

describe("useLiveEdit", () => {
  it("tells the frame to edit at its exact origin, and follows its status", async () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const { result } = hook(gate("room"));
    expect(result.current.available).toBe(true);
    expect(result.current.mode).toBe("room");
    expect(sentToFrame("edit")).toHaveLength(0);
    act(() => result.current.start());
    expect(sentToFrame("edit").at(-1)).toEqual([
      { source: "plinth-renderer", v: 1, type: "edit", on: true },
      ORIGIN,
    ]);
    fromFrame({ type: "live", ...STATUS });
    expect(result.current.status?.rev).toBe(7);
    expect(result.current.phase).toBe("dirty");
    expect(result.current.pause).toBe("follow");
    // A message from another origin changes nothing.
    fromFrame({ type: "live", ...STATUS, rev: 99 }, "http://evil.example");
    expect(result.current.status?.rev).toBe(7);
  });

  it("has no on-page editing under opaque isolation", () => {
    stubApi();
    const { result } = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: { ...CONFIG, content_isolation: "opaque" },
        onReload: vi.fn(),
      }),
    );
    expect(result.current.available).toBe(false);
    act(() => result.current.start());
    expect(result.current.editing).toBe(false);
    expect(toFrame).not.toHaveBeenCalled();
  });

  it("autosaves after the quiet spell from the last writer, 30 s later from the others", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) return json({ saved: false, reason: "too_soon" });
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    act(() => result.current.start());
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/live"))).toBe(true));
    // Someone else typed last: wait the fallback too.
    fromFrame({ type: "live", ...STATUS, last_by_you: false });
    const posts = () => calls.filter((c) => c.method === "POST");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(posts()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_FALLBACK_MS);
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({ base_version: 3, rev: 7, reason: "idle" });
    // The last writer saves on time; a new rev restarts the spell.
    fromFrame({ type: "live", ...STATUS, rev: 8, last_by_you: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    fromFrame({ type: "live", ...STATUS, rev: 9, last_by_you: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_000);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toMatchObject({ rev: 9, reason: "idle" });
  });

  it("saves with the frame's base and rev, and handles 429, 503, 403 and 401", async () => {
    let answer: Response = json({
      saved: true,
      version: { version: 4 },
      live: { rev: 7, dirty: false },
    });
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) return answer;
        return undefined;
      },
    });
    const onReload = vi.fn();
    const { result } = hook(gate("room"), onReload);
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS });
    await act(() => result.current.save("Tidy intro"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ base_version: 3, rev: 7, reason: "save", note: "Tidy intro" });
    // A cookie request: the CSRF header goes with it.
    expect(Object.keys(post?.headers ?? {})).toContain(CSRF_HEADER.toLowerCase());
    expect(result.current.savedVersion).toBe(4);

    answer = apiError(429, "rate_limited");
    await act(() => result.current.save());
    expect(toasts.at(-1)).toBe("Hourly version limit reached. Your edits stay as a draft.");
    answer = apiError(503, "unavailable");
    await act(() => result.current.save());
    expect(toasts.at(-1)).toBe("Live editing is unavailable. Your edits are kept.");
    answer = apiError(403, "forbidden");
    await act(() => result.current.save());
    expect(toasts.at(-1)).toBe("You can no longer edit this doc.");
    answer = apiError(401, "unauthorized");
    await act(() => result.current.save());
    expect(onReload).toHaveBeenCalled();
  });

  it("opens the review on a 409 live conflict, and resolves with resolved_text", async () => {
    let checkpoints = 0;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) {
          checkpoints++;
          if (checkpoints === 1) {
            return json(
              {
                error: {
                  code: "conflict",
                  message: "v4 changed the same lines.",
                  details: { current_version: 4, reason: "live_conflict" },
                },
              },
              409,
            );
          }
          return json({ saved: true, version: { version: 5 }, live: { rev: 8, dirty: false } });
        }
        if (c.path.endsWith("/live/draft")) {
          return json({ text: "# Mine", base_version: 3, rev: 7, conflict_version: 4 });
        }
        if (c.path === "/artifacts/art1/versions/4") {
          return json({ type: "doc", content: "# Theirs", source_path: "content.md" });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS });
    await act(() => result.current.save());
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.reviewing).toBe(true);
    expect(result.current.conflict).toMatchObject({
      draft: "# Mine",
      currentText: "# Theirs",
      base: 3,
      current: 4,
      rev: 7,
    });
    expect(result.current.phase).toBe("conflict");
    await act(() => result.current.keepMine());
    const resolve = calls.filter((c) => c.method === "POST").at(-1);
    expect(resolve?.body).toEqual({
      base_version: 3,
      rev: 7,
      reason: "save",
      resolved_text: "# Mine",
      conflict_version: 4,
    });
    expect(result.current.conflict).toBeNull();
  });

  it("solo: collects the text with a nonce, then publishes it with the shown version as base", async () => {
    const onReload = vi.fn();
    const { calls } = stubApi({
      handle: (c) =>
        c.method === "PUT" && c.path === "/artifacts/art1"
          ? json({ id: "art1", version: 4, type: "doc", warnings: [] })
          : undefined,
    });
    const { result } = hook(gate("solo"), onReload);
    expect(result.current.mode).toBe("solo");
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: true, rev: 0, base_version: 0 });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save("From the page");
    });
    const collect = sentToFrame("collect").at(-1);
    expect(collect?.[1]).toBe(ORIGIN);
    const nonce = collect?.[0].nonce as string;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // A draft with another nonce is ignored.
    fromFrame({ type: "draft", nonce: "x".repeat(24), text: "forged" });
    fromFrame({ type: "draft", nonce, text: "# Edited" });
    await act(() => saving);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ content: "# Edited", base_version: 3, note: "From the page" });
    expect(result.current.savedVersion).toBe(4);
    expect(onReload).toHaveBeenCalled();
  });

  it("solo: a 409 from the save opens the review with the frame's text", async () => {
    stubApi({
      handle: (c) => {
        if (c.method === "PUT") {
          return json(
            { error: { code: "conflict", message: "Stale", details: { current_version: 4 } } },
            409,
          );
        }
        if (c.path === "/artifacts/art1/versions/4") {
          return json({ type: "doc", content: "# Theirs", source_path: "content.md" });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("solo"));
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS, connected: false });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Mine" });
    await act(() => saving);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict).toMatchObject({
      draft: "# Mine",
      currentText: "# Theirs",
      current: 4,
      base: 3,
    });
  });

  it("asks before leaving only while there is unflushed (room) or unsaved (solo) text", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const { result } = hook(gate("room"));
    act(() => result.current.start());
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    fromFrame({ type: "live", ...STATUS, unflushed: false });
    expect(leave()).toBe(false);
    fromFrame({ type: "live", ...STATUS, unflushed: true });
    expect(leave()).toBe(true);
  });

  /** A room-mode hook in review of a conflict with v4 (draft "# Mine", rev 7). */
  async function inReview(
    handle: (c: { method: string; path: string; body: unknown }) => Response | undefined,
  ) {
    let conflictVersion = 4;
    const api = stubApi({
      handle: (c) => {
        const r = handle(c);
        if (r) return r;
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/draft")) {
          return json({
            text: "# Mine",
            base_version: 3,
            rev: 7,
            conflict_version: conflictVersion,
          });
        }
        const m = /^\/artifacts\/art1\/versions\/(\d+)$/.exec(c.path);
        if (m)
          return json({ type: "doc", content: `# Theirs v${m[1]}`, source_path: "content.md" });
        return undefined;
      },
    });
    const h = hook(gate("room"));
    act(() => h.result.current.start());
    fromFrame({ type: "live", ...STATUS, conflict_version: 4 });
    await act(() => h.result.current.review());
    await waitFor(() => expect(h.result.current.conflict?.current).toBe(4));
    return { ...api, ...h, setConflict: (n: number) => (conflictVersion = n) };
  }

  it("a resolution names the conflict it reviewed; a newer conflict reopens the review on it", async () => {
    let refuse = true;
    const t = await inReview((c) => {
      if (!c.path.endsWith("/live/checkpoint")) return undefined;
      if (refuse) {
        refuse = false;
        return json(
          {
            error: {
              code: "conflict",
              message: "v5 was published while you reviewed. Review it.",
              details: { current_version: 5, reason: "live_conflict" },
            },
          },
          409,
        );
      }
      return json({ saved: true, version: { version: 6 }, live: { rev: 8, dirty: false } });
    });
    t.setConflict(5);
    await act(() => t.result.current.keepMine());
    expect(t.calls.filter((c) => c.method === "POST").at(-1)?.body).toMatchObject({
      resolved_text: "# Mine",
      conflict_version: 4,
    });
    // Not saved over v5: the review is open again, now against v5's text.
    await waitFor(() => expect(t.result.current.conflict?.current).toBe(5));
    expect(t.result.current.conflict?.currentText).toBe("# Theirs v5");
    expect(t.result.current.reviewing).toBe(true);
    expect(toasts).toContain("v5 was published while you reviewed. Review it.");
  });

  it("a choice refused as busy (the other choice is running) keeps the review open and says so", async () => {
    const t = await inReview((c) =>
      c.path.endsWith("/live/checkpoint") ? json({ saved: false, reason: "busy" }) : undefined,
    );
    const busy =
      "These page edits are being published or discarded right now. Look again in a moment.";
    await act(() => t.result.current.keepMine());
    expect(t.result.current.reviewing).toBe(true);
    expect(t.result.current.conflict?.current).toBe(4);
    expect(toasts.at(-1)).toBe(busy);
    toasts.length = 0;
    await act(() => t.result.current.takeLatest());
    expect(t.result.current.reviewing).toBe(true);
    expect(toasts).toEqual([busy]);
  });

  it("taking the latest posts that version's text for the conflict reviewed, then closes", async () => {
    const t = await inReview((c) =>
      c.path.endsWith("/live/checkpoint") ? json({ saved: false, reason: "unchanged" }) : undefined,
    );
    await act(() => t.result.current.takeLatest());
    expect(t.calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
      base_version: 3,
      rev: 7,
      reason: "save",
      resolved_text: "# Theirs v4",
      conflict_version: 4,
    });
    expect(t.result.current.conflict).toBeNull();
    expect(t.result.current.reviewing).toBe(false);
    expect(toasts.at(-1)).toBe("The page is back to v4.");
  });

  it("an idle autosave refused as too soon is tried again when the server says", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answers = 0;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) {
          answers++;
          return answers === 1
            ? json({ saved: false, reason: "too_soon", retry_in_s: 300 })
            : json({ saved: true, version: { version: 4 }, live: { rev: 7, dirty: false } });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    act(() => result.current.start());
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/live"))).toBe(true));
    fromFrame({ type: "live", ...STATUS });
    const posts = () => calls.filter((c) => c.method === "POST");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_500);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299_000);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toEqual({ base_version: 3, rev: 7, reason: "idle" });
    expect(result.current.savedVersion).toBe(4);
  });

  it("room discard: looks up the rev when the frame has not reported, and says so on a 409", async () => {
    let refuse = false;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live/draft")) {
          return json({ text: "x", base_version: 3, rev: 12, conflict_version: null });
        }
        if (c.method === "DELETE") {
          if (refuse) {
            return json(
              {
                error: {
                  code: "conflict",
                  message: "The page edits changed since you looked. Look again.",
                },
              },
              409,
            );
          }
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    await act(() => result.current.discard());
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
      "/artifacts/art1/live/draft?rev=12",
    );
    expect(toasts.at(-1)).toBe("Unsaved page edits discarded.");
    // With a status, its rev is the one discarded; someone typed since: 409, nothing claimed.
    fromFrame({ type: "live", ...STATUS, editing: false, rev: 15 });
    refuse = true;
    await act(() => result.current.discard());
    expect(calls.filter((c) => c.method === "DELETE").at(-1)?.path).toBe(
      "/artifacts/art1/live/draft?rev=15",
    );
    expect(toasts.at(-1)).toBe("The page edits changed since you looked. Look again.");
  });

  it("solo Done leaves edit mode only after the publish succeeded", async () => {
    let fail = true;
    stubApi({
      handle: (c) => {
        if (c.method !== "PUT") return undefined;
        return fail
          ? apiError(429, "rate_limited")
          : json({ id: "art1", version: 4, type: "doc", warnings: [] });
      },
    });
    const { result } = hook(gate("solo"));
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS, connected: false });
    const finish = async () => {
      let p: Promise<boolean> = Promise.resolve(false);
      act(() => {
        p = result.current.done();
      });
      const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
      fromFrame({ type: "draft", nonce, text: "# Edited" });
      let out = false;
      await act(async () => {
        out = await p;
      });
      return out;
    };
    expect(await finish()).toBe(false);
    expect(result.current.editing).toBe(true);
    expect(toasts.at(-1)).toBe("Hourly version limit reached. Your edits stay as a draft.");
    fail = false;
    expect(await finish()).toBe(true);
    expect(result.current.editing).toBe(false);
  });

  it("solo keeps a copy while dirty, and a reload offers it back with its own base", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({ id: "art1", version: 4, type: "doc", warnings: [] })
          : undefined,
    });
    const first = hook(gate("solo"));
    act(() => first.result.current.start());
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Kept" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    first.unmount();
    // After a reload, now showing v5: the copy keeps v3, the version it was edited from.
    const later = gate("solo");
    later.artifact = { ...later.artifact, version: 5, current_version: 5 };
    const second = hook(later);
    expect(second.result.current.restore).toMatchObject({ text: "# Kept", base: 3 });
    await act(() => second.result.current.saveRestore());
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      content: "# Kept",
      base_version: 3,
    });
    expect(second.result.current.restore).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("solo: dropping the kept copy clears it", () => {
    stubApi();
    sessionStorage.setItem(
      "plinth-draft:page-edit:art1",
      JSON.stringify({ text: "# Old", base: 2, saved_at: "2026-11-18T00:00:00.000Z" }),
    );
    const { result } = hook(gate("solo"));
    expect(result.current.restore?.base).toBe(2);
    act(() => result.current.dropRestore());
    expect(result.current.restore).toBeNull();
    expect(sessionStorage.getItem("plinth-draft:page-edit:art1")).toBeNull();
  });

  // A sheet's page edits are never merged: the review reads the base too (for its change lists),
  // and its two choices publish the draft as it is or go back to the version published meanwhile.
  const sheetGate = (mode: "room" | "solo") => {
    const g = gate(mode);
    g.artifact = { ...g.artifact, type: "sheet" };
    return g;
  };
  const sheetVersion = (path: string) => {
    const m = /^\/artifacts\/art1\/versions\/(\d+)$/.exec(path);
    return m
      ? json({ type: "sheet", content: `sheet v${m[1]}`, source_path: "sheet.jsonl" })
      : null;
  };

  it("a sheet: never merges, reads the base for the review, and Publish mine sends the draft as it is", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/draft")) {
          return json({ text: "sheet mine", base_version: 3, rev: 7, conflict_version: 4 });
        }
        if (c.path.endsWith("/live/checkpoint")) {
          return json({ saved: true, version: { version: 5 }, live: { rev: 8, dirty: false } });
        }
        return sheetVersion(c.path) ?? undefined;
      },
    });
    const { result } = hook(sheetGate("room"));
    expect(result.current.merges).toBe(false);
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS, conflict_version: 4 });
    await act(() => result.current.review());
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict).toEqual({
      draft: "sheet mine",
      base: 3,
      current: 4,
      currentText: "sheet v4",
      baseText: "sheet v3",
      rev: 7,
    });
    await act(() => result.current.keepMine());
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
      base_version: 3,
      rev: 7,
      reason: "save",
      resolved_text: "sheet mine",
      conflict_version: 4,
    });
    expect(result.current.conflict).toBeNull();
    expect(hook(gate("room")).result.current.merges).toBe(true);
  });

  it("a sheet, solo: Publish mine says in the note which version it replaces", async () => {
    let puts = 0;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.method === "PUT") {
          puts++;
          if (puts === 1) {
            return json(
              { error: { code: "conflict", message: "Stale", details: { current_version: 4 } } },
              409,
            );
          }
          return json({ id: "art1", version: 5, type: "sheet", warnings: [] });
        }
        return sheetVersion(c.path) ?? undefined;
      },
    });
    const { result } = hook(sheetGate("solo"));
    act(() => result.current.start());
    fromFrame({ type: "live", ...STATUS, connected: false });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "sheet mine" });
    await act(() => saving);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict).toMatchObject({
      baseText: "sheet v3",
      currentText: "sheet v4",
    });
    await act(() => result.current.keepMine());
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
      content: "sheet mine",
      base_version: 4,
      note: "Edited on the page. Replaces the changes in v4.",
    });
    expect(result.current.conflict).toBeNull();
  });
});
