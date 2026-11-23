// useLiveEdit: the app side of on-page editing (#36), which is always on for whoever may edit here:
// the frame is told to edit as soon as the hook has it, with no toggle. The frame is a real iframe whose window
// stands in for the renderer; its messages are dispatched with that window as their source and
// carry the frame's key. The whole-draft review runs in the frame: the app only asks it to open
// (`review`), acts on the person's choice (`resolved`) and answers with what came of it
// (`reviewed`). No draft or version text reaches the app in room mode.
import { CSRF_HEADER, type ViewGate } from "@plinth/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRescue, savePageDraft } from "../editor/draft.ts";
import type { LiveFrameStatus } from "./rendererProtocol.ts";
import { apiError, CONFIG, json, stubApi } from "./test-utils.ts";
import { AUTOSAVE_FALLBACK_MS, CHOOSING_BUSY, useLiveEdit } from "./useLiveEdit.ts";

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

/** Makes savePageDraft fail (storage full), for the test that needs it. */
const failSave = vi.hoisted(() => ({ on: false }));
vi.mock("../editor/draft.ts", async (orig) => {
  const actual = await orig<typeof import("../editor/draft.ts")>();
  return {
    ...actual,
    savePageDraft: (...a: Parameters<typeof actual.savePageDraft>) =>
      failSave.on ? false : actual.savePageDraft(...a),
  };
});

type OkGate = Extract<ViewGate, { status: "ok" }>;
const ORIGIN = "http://art1.content.localhost:8787";
const KEY = "K".repeat(43);

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
  publishable: true,
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
  failSave.on = false;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

/** The frame posts a message to the app, with its key unless `key` says otherwise. */
function fromFrame(data: Record<string, unknown>, origin = ORIGIN, key: string | null = KEY) {
  act(() => {
    const e = new MessageEvent("message", {
      data: { source: "plinth-renderer", v: 1, ...(key ? { key } : {}), ...data },
      origin,
    });
    Object.defineProperty(e, "source", { value: frameWin });
    window.dispatchEvent(e);
  });
}

/** A rescue report from the frame that only upserts `items`. */
function up(items: { id: string; text: string; near: number }[], n = 1) {
  return { type: "rescue", upsert: items, written: [] as string[], gone: [] as string[], n };
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

function hook(
  g: OkGate,
  onReload = vi.fn(),
  extra: { onLeave?: () => void; userId?: string | null } = {},
) {
  return renderHook(() =>
    useLiveEdit({
      gate: g,
      frame,
      contentOrigin: ORIGIN,
      config: CONFIG,
      frameKey: KEY,
      onReload,
      ...extra,
    }),
  );
}

const conflict409 = (n: number, reason = "live_conflict", message = `v${n} was published.`) =>
  json({ error: { code: "conflict", message, details: { current_version: n, reason } } }, 409);

describe("useLiveEdit", () => {
  it("tells the frame to edit at its exact origin at once, and follows its status, only with its key", async () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const { result } = hook(gate("room"));
    expect(result.current.available).toBe(true);
    expect(result.current.mode).toBe("room");
    // No toggle: edit mode is on from the start.
    expect(result.current.editing).toBe(true);
    expect(sentToFrame("edit").at(-1)).toEqual([
      { source: "plinth-renderer", v: 1, type: "edit", on: true },
      ORIGIN,
    ]);
    fromFrame({ type: "live", ...STATUS });
    expect(result.current.status?.rev).toBe(7);
    expect(result.current.phase).toBe("dirty");
    expect(result.current.pause).toBe("follow");
    // A message from another origin, without the key, or with another key changes nothing.
    fromFrame({ type: "live", ...STATUS, rev: 99 }, "http://evil.example");
    fromFrame({ type: "live", ...STATUS, rev: 98 }, ORIGIN, null);
    fromFrame({ type: "live", ...STATUS, rev: 97 }, ORIGIN, "x".repeat(43));
    expect(result.current.status?.rev).toBe(7);
  });

  it("leaves edit mode, with why, when the frame is too large to edit on the page, for this version", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const onAsk = vi.fn();
    const { result } = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        frameKey: KEY,
        onReload: vi.fn(),
        onAsk,
      }),
    );
    expect(result.current.editing).toBe(true);
    fromFrame({ type: "live", ...STATUS, editing: false, unavailable: "too_large" });
    expect(result.current.editing).toBe(false);
    expect(result.current.blocked).toBe(
      "This doc is too large to edit on the page. Mention @claude in a comment to change it.",
    );
    // Said once, in the bar's status: no toast.
    expect(toasts).toHaveLength(0);
    expect(sentToFrame("edit").at(-1)?.[0]).toMatchObject({ type: "edit", on: false });
    // Out of edit mode the frame no longer says so: the page stays read-only all the same.
    fromFrame({ type: "live", ...STATUS, editing: false });
    expect(result.current.editing).toBe(false);
    expect(sentToFrame("edit").at(-1)?.[0]).toMatchObject({ type: "edit", on: false });
  });

  it("tells the frame an artifact published from code is, only when the gate says so", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    hook(gate("room", { from_code: true }));
    expect(sentToFrame("edit").at(-1)?.[0]).toEqual({
      source: "plinth-renderer",
      v: 1,
      type: "edit",
      on: true,
      code: true,
    });
    cleanup();
    toFrame.mockClear();
    hook(gate("room"));
    expect(sentToFrame("edit").at(-1)?.[0]).not.toHaveProperty("code");
  });

  it("keeps the page read-only, with why, while the frame says only an agent can fix it", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const { result } = hook(
      gate("room", {
        artifact: { ...gate("room").artifact, type: "design_system" },
      }),
    );
    expect(result.current.blocked).toBeNull();
    fromFrame({ type: "live", ...STATUS, editing: false, unavailable: "invalid" });
    expect(result.current.blocked).toBe(
      "This design system has problems only an agent can fix, so it can't be edited on the page. Mention @claude in a comment to fix them.",
    );
    expect(result.current.editing).toBe(false);
    expect(sentToFrame("edit").at(-1)?.[0]).toMatchObject({ type: "edit", on: false });
  });

  it("has no on-page editing under opaque isolation", () => {
    stubApi();
    const { result } = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: { ...CONFIG, content_isolation: "opaque" },
        frameKey: null,
        onReload: vi.fn(),
      }),
    );
    expect(result.current.available).toBe(false);
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
    hook(gate("room"));
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
    // A frozen draft, or one that cannot be a version yet, is never autosaved.
    fromFrame({ type: "live", ...STATUS, rev: 10, conflict_version: 4 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    fromFrame({ type: "live", ...STATUS, rev: 11, publishable: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    expect(posts()).toHaveLength(2);
  });

  it("publishes with the frame's base and rev, and handles 429, 503, 403 and 401", async () => {
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
    fromFrame({ type: "live", ...STATUS });
    await act(() => result.current.publish("Tidy intro"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ base_version: 3, rev: 7, reason: "save", note: "Tidy intro" });
    // A cookie request: the CSRF header goes with it.
    expect(Object.keys(post?.headers ?? {})).toContain(CSRF_HEADER.toLowerCase());
    expect(result.current.savedVersion).toBe(4);

    answer = apiError(429, "rate_limited");
    await act(() => result.current.publish());
    expect(toasts.at(-1)).toBe("Hourly version limit reached. Your changes stay as a draft.");
    answer = apiError(503, "unavailable");
    await act(() => result.current.publish());
    expect(toasts.at(-1)).toBe("Live editing is unavailable. Your changes are kept.");
    answer = apiError(403, "forbidden");
    await act(() => result.current.publish());
    expect(toasts.at(-1)).toBe("You can no longer edit this doc.");
    answer = apiError(401, "unauthorized");
    await act(() => result.current.publish());
    expect(toasts.at(-1)).toBe("Sign in again to publish. Your changes are kept.");
    expect(onReload).toHaveBeenCalled();
  });

  it("a 409 live conflict opens the review in the frame; no text is fetched", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) return conflict409(4);
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    fromFrame({ type: "live", ...STATUS });
    await act(() => result.current.publish());
    // The room has frozen the draft by now; the frame reports it.
    fromFrame({ type: "live", ...STATUS, conflict_version: 4 });
    await act(() => result.current.openReview());
    const review = sentToFrame("review").at(-1);
    expect(review?.[1]).toBe(ORIGIN);
    expect(Object.keys(review?.[0] ?? {}).sort()).toEqual(["nonce", "source", "type", "v"]);
    expect(result.current.review).toMatchObject({ base: 3, current: 4, mode: "room" });
    expect(result.current.phase).toBe("conflict");
    expect(calls.some((c) => /\/versions\/|\/live\/draft/.test(c.path))).toBe(false);
  });

  /** A room-mode hook with the review of v4 open in the frame (draft rev 7 on base 3). */
  async function inReview(handle: (c: { method: string; path: string }) => Response | undefined) {
    const api = stubApi({
      handle: (c) => handle(c) ?? (c.path.endsWith("/live") ? json(INFO) : undefined),
    });
    const h = hook(gate("room"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS, conflict_version: 4 });
    await act(() => h.result.current.openReview());
    const nonce = sentToFrame("review").at(-1)?.[0].nonce as string;
    const reviewed = () => sentToFrame("reviewed").map((c) => c[0].result as string);
    return { ...api, ...h, nonce, reviewed };
  }

  it("Publish your changes checkpoints the room's draft against the version reviewed, and answers done", async () => {
    const t = await inReview((c) =>
      c.path.endsWith("/live/checkpoint")
        ? json({ saved: true, version: { version: 5 }, live: { rev: 8, dirty: false } })
        : undefined,
    );
    fromFrame({
      type: "resolved",
      nonce: t.nonce,
      outcome: "publish",
      version: 4,
      rev: 7,
      note: "Counted",
    });
    await waitFor(() => expect(t.reviewed()).toEqual(["done"]));
    expect(t.calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
      base_version: 3,
      rev: 7,
      reason: "save",
      conflict_version: 4,
      note: "Counted",
    });
    expect(t.result.current.savedVersion).toBe(5);
    expect(t.result.current.review).toBeNull();
  });

  it("Discard your changes deletes the draft at the rev reviewed, for the version reviewed", async () => {
    const t = await inReview((c) =>
      c.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
    );
    fromFrame(up([{ id: "r1", text: "Kept", near: 0 }]));
    expect(sessionStorage.getItem("plinth-draft:page-rescue:u1:art1")).not.toBeNull();
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "discard", version: 4, rev: 7 });
    // The app confirms it first, with its own dialog: nothing is deleted until then.
    expect(t.result.current.discardAsk).toBe(4);
    expect(t.calls.some((c) => c.method === "DELETE")).toBe(false);
    act(() => t.result.current.answerDiscard(true));
    expect(t.result.current.discardAsk).toBeNull();
    await waitFor(() => expect(t.reviewed()).toEqual(["done"]));
    expect(t.calls.find((c) => c.method === "DELETE")?.path).toBe(
      "/artifacts/art1/live/draft?rev=7&conflict_version=4",
    );
    // What was kept to rescue is discarded with it.
    expect(sessionStorage.getItem("plinth-draft:page-rescue:u1:art1")).toBeNull();
  });

  it("a cancelled Discard confirmation deletes nothing and gives the review its buttons back", async () => {
    const t = await inReview(() => undefined);
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "discard", version: 4, rev: 7 });
    expect(t.result.current.discardAsk).toBe(4);
    act(() => t.result.current.answerDiscard(false));
    expect(t.result.current.discardAsk).toBeNull();
    expect(t.reviewed()).toEqual(["failed"]);
    expect(t.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(t.result.current.review).not.toBeNull();
    // Back in the frame closes the confirmation's request with the review.
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "discard", version: 4, rev: 7 });
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "cancelled" });
    expect(t.result.current.discardAsk).toBeNull();
  });

  it("maps busy, resolved, conflict and a moved draft to the frame's answer", async () => {
    let answer: Response = json({ saved: false, reason: "busy" });
    const t = await inReview((c) => (c.path.endsWith("/live/checkpoint") ? answer : undefined));
    const choose = () =>
      fromFrame({ type: "resolved", nonce: t.nonce, outcome: "publish", version: 4, rev: 7 });
    choose();
    await waitFor(() => expect(t.reviewed()).toEqual(["busy"]));
    expect(t.result.current.review).not.toBeNull();
    answer = conflict409(5, "live_resolved");
    choose();
    await waitFor(() => expect(t.reviewed()).toEqual(["busy", "resolved"]));
    answer = conflict409(5, "live_conflict");
    choose();
    await waitFor(() => expect(t.reviewed().at(-1)).toBe("conflict"));
    answer = conflict409(4, "live_moved");
    choose();
    await waitFor(() => expect(t.reviewed().at(-1)).toBe("failed"));
    expect(toasts.at(-1)).toBe("The unpublished changes moved on. Review them again.");
  });

  it("drops a choice for another review, without the key, or naming text in room mode", async () => {
    const t = await inReview(() => json({ saved: true, version: { version: 5 } }));
    fromFrame({ type: "resolved", nonce: "x".repeat(24), outcome: "publish", version: 4, rev: 7 });
    fromFrame(
      { type: "resolved", nonce: t.nonce, outcome: "publish", version: 4, rev: 7 },
      ORIGIN,
      null,
    );
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "publish", text: "# Forged" });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // Cancel closes the review here; the draft stays frozen.
    fromFrame({ type: "resolved", nonce: t.nonce, outcome: "cancelled" });
    expect(t.result.current.review).toBeNull();
    expect(t.result.current.phase).toBe("conflict");
  });

  it("a review closes when the room unfreezes the draft (another editor's choice)", async () => {
    const t = await inReview(() => undefined);
    expect(t.result.current.reviewing).toBe(true);
    fromFrame({ type: "live", ...STATUS, base_version: 5, conflict_version: null });
    expect(t.result.current.reviewing).toBe(false);
  });

  it("solo: collects the text with a nonce, then publishes it with the shown version as base and files", async () => {
    const onReload = vi.fn();
    const { calls } = stubApi({
      handle: (c) =>
        c.method === "PUT" && c.path === "/artifacts/art1"
          ? json({ id: "art1", version: 4, type: "doc", warnings: [] })
          : undefined,
    });
    const { result } = hook(gate("solo"), onReload);
    expect(result.current.mode).toBe("solo");
    // Solo: the frame is told the version it shows, whose files the draft is drawn with.
    expect(sentToFrame("edit").at(-1)?.[0]).toMatchObject({ on: true, base: 3 });
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: true, rev: 0, base_version: 0 });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.publish("From the page");
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
    expect(put?.body).toEqual({
      content: "# Edited",
      base_version: 3,
      files_from_version: 3,
      note: "From the page",
    });
    expect(result.current.savedVersion).toBe(4);
    // The frame goes on editing its copy: no reload, and the next publish is based on v4.
    expect(onReload).not.toHaveBeenCalled();
    expect(result.current.ownVersion).toBe(4);
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: true, rev: 0, base_version: 0 });
    act(() => {
      saving = result.current.publish();
    });
    const again = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce: again, text: "# Edited more" });
    await act(() => saving);
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
      content: "# Edited more",
      base_version: 4,
      files_from_version: 4,
    });
    // The same text as the version this frame made: nothing new to publish.
    act(() => {
      saving = result.current.publish();
    });
    const same = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce: same, text: "# Edited more" });
    await act(() => saving);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("solo: a 409 opens the review in the frame with the files from the two versions' lists", async () => {
    let refuse = true;
    const onReload = vi.fn();
    const { calls } = stubApi({
      handle: (c) => {
        if (c.method === "PUT") {
          if (refuse) {
            refuse = false;
            return json(
              { error: { code: "conflict", message: "Stale", details: { current_version: 4 } } },
              409,
            );
          }
          return json({ id: "art1", version: 5, type: "doc", warnings: [] });
        }
        if (c.path === "/artifacts/art1/versions/3") {
          return json({
            type: "doc",
            content: "x",
            assets: [{ path: "chart.png", size_bytes: 10, sha256: "a".repeat(64) }],
          });
        }
        if (c.path === "/artifacts/art1/versions/4") {
          return json({
            type: "doc",
            content: "y",
            assets: [{ path: "chart.png", size_bytes: 12, sha256: "b".repeat(64) }],
          });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("solo"), onReload);
    fromFrame({ type: "live", ...STATUS, connected: false });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.publish();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Mine" });
    await act(() => saving);
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    const review = sentToFrame("review")[0]?.[0];
    expect(review).toMatchObject({ n: 4, base: 3 });
    expect(review.files).toMatchObject({
      replaced: [{ path: "chart.png", kind: "replaced", before: 10, after: 12 }],
      added: [],
      removed: [],
    });
    expect(result.current.review).toMatchObject({ base: 3, current: 4, mode: "solo" });
    // Publish your changes: the frame's own copy over v4, with v3's files and the note naming v4.
    fromFrame(
      { type: "resolved", nonce: review.nonce, outcome: "publish", text: "# Mine" },
      ORIGIN,
    );
    await waitFor(() => expect(sentToFrame("reviewed").at(-1)?.[0].result).toBe("done"));
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
      content: "# Mine",
      base_version: 4,
      files_from_version: 3,
      note: "Edited on the page. Replaces the changes in v4.",
    });
    expect(onReload).toHaveBeenCalled();
  });

  it("solo: Discard your changes drops the tab's copy and loads the current version", async () => {
    stubApi({
      handle: (c) => {
        if (c.method === "PUT") return conflict409(4, "");
        if (/\/versions\/\d$/.test(c.path)) return json({ type: "doc", content: "", assets: [] });
        return undefined;
      },
    });
    const onReload = vi.fn();
    const { result } = hook(gate("solo"), onReload);
    fromFrame({ type: "live", ...STATUS, connected: false });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.publish();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Mine" });
    await act(() => saving);
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    const r = sentToFrame("review")[0]?.[0].nonce as string;
    fromFrame({ type: "resolved", nonce: r, outcome: "discard" });
    expect(onReload).not.toHaveBeenCalled();
    act(() => result.current.answerDiscard(true));
    expect(onReload).toHaveBeenCalled();
    expect(result.current.review).toBeNull();
  });

  it("asks before leaving only while there is unflushed (room) or unpublished (solo) text", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    hook(gate("room"));
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

  // A doc block holding typing the page cannot save as typed (`unsavable`, doc-blocks).
  it("publishes nothing while a block holds typing it cannot save: room, by Publish and Cmd+S", async () => {
    const { calls } = stubApi({
      handle: (c) =>
        c.path.endsWith("/live")
          ? json(INFO)
          : c.path.endsWith("/live/checkpoint")
            ? json({ saved: true, version: { version: 4 } })
            : undefined,
    });
    const { result } = hook(gate("room"));
    fromFrame({ type: "live", ...STATUS, unflushed: true, publishable: false, unsavable: true });
    await act(() => result.current.publish());
    // The frame's Cmd/Ctrl+S reaches the app as `save`, and the app's own shortcut runs publish.
    fromFrame({ type: "save" });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.path.endsWith("/live/checkpoint"))).toBe(false);
    expect(toasts.at(-1)).toBe(
      "Some text on the page can't be saved as typed. Change it to continue.",
    );
    // Ask's "Publish my changes first" is refused the same way, with the words returned.
    // Once the text can be written, Publish goes out.
    fromFrame({ type: "live", ...STATUS });
    await act(() => result.current.publish());
    expect(calls.some((c) => c.path.endsWith("/live/checkpoint"))).toBe(true);
  });

  it("Publish waits for a value the frame is still sending before the checkpoint", async () => {
    const seen: number[] = [];
    stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint")) {
          seen.push((c.body as { rev: number }).rev);
          return json({ saved: true, version: { version: 4 } });
        }
        return undefined;
      },
    });
    const { result } = hook(gate("room"));
    // A token's value is on its way to the room (its lease asked for, not granted yet).
    fromFrame({ type: "live", ...STATUS, rev: 7, pending: true });
    let published = false;
    // Not inside act(): the frame's next status has to reach the hook while this waits.
    const p = result.current.publish().then(() => {
      published = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(published).toBe(false);
    expect(seen).toEqual([]);
    // The room has it now: the checkpoint is taken at the rev that holds it.
    fromFrame({ type: "live", ...STATUS, rev: 8 });
    await p;
    expect(seen).toEqual([8]);
  });

  it("publishes nothing while a block holds typing it cannot save: solo, even if the status lags", async () => {
    const onReload = vi.fn();
    const { calls } = stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({ id: "art1", version: 4, type: "doc", warnings: [] })
          : undefined,
    });
    const { result } = hook(gate("solo"), onReload);
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false, unsavable: true });
    await act(() => result.current.publish());
    expect(sentToFrame("collect")).toHaveLength(0);
    // A status that has not caught up yet: the frame's draft says so, and nothing is published.
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: true });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.publish();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Plan\n\nabc", unsavable: true });
    await act(() => saving);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(onReload).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toBe(
      "Some text on the page can't be saved as typed. Change it to continue.",
    );
  });

  it("solo: typing a block cannot save asks before leaving, and is kept without its formatting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi({ handle: () => undefined });
    const { unmount } = hook(gate("solo"));
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // The text never reached the frame's doc, so it is not dirty: unsavable is what counts.
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false, unflushed: false });
    expect(leave()).toBe(false);
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false, unsavable: true });
    expect(leave()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Plan\n\nabc", unsavable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    unmount();
    const again = hook(gate("solo"));
    expect(again.result.current.restore).toMatchObject({ text: "# Plan\n\nabc", base: 3 });
  });

  it("keeps the frame's rescue items in app storage, per person, and offers them to a new frame", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const key = "plinth-draft:page-rescue:u1:art1";
    const items = [{ id: "r1", text: "Kept *text*", near: 4 }];
    sessionStorage.setItem(key, JSON.stringify(items));
    // Another account's store, left in this tab: ignored, never offered, and not deleted.
    const other = "plinth-draft:page-rescue:u0:art1";
    sessionStorage.setItem(other, JSON.stringify([{ id: "x1", text: "Someone else's", near: 0 }]));
    // A reload: the session is still loading (undefined), then it is u1.
    let userId: string | null | undefined;
    const r = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        frameKey: KEY,
        onReload: vi.fn(),
        userId,
      }),
    );
    // Nothing read, offered or dropped before the session is known.
    expect(sentToFrame("rescue")).toHaveLength(0);
    expect(sessionStorage.getItem(key)).not.toBeNull();
    userId = "u1";
    r.rerender();
    expect(sentToFrame("rescue").at(-1)?.[0]).toMatchObject({ type: "rescue", items });
    expect(sessionStorage.getItem(other)).not.toBeNull();
    // Without the frame's key, malformed, or over the limits, a report changes nothing.
    fromFrame({ ...up([]), written: ["r1"] }, ORIGIN, null);
    fromFrame({ ...up([]), written: ["bad id!"] });
    fromFrame(up([{ id: "bad id!", text: "x", near: 0 }]));
    fromFrame({ type: "rescue", upsert: [], written: [], gone: [], n: -1 });
    fromFrame({ type: "rescue", items: [] });
    fromFrame(up(Array.from({ length: 21 }, (_, n) => ({ id: `c${n}`, text: "x", near: 0 }))));
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toEqual(items);
    // The frame wrote it: named as written, it leaves the store.
    fromFrame({ ...up([]), written: ["r1"] });
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem(other)).not.toBeNull();
  });

  it("A: what a new frame reports while the session loads is merged with what was kept, never put in its place", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const key = "plinth-draft:page-rescue:u1:art1";
    sessionStorage.setItem(key, JSON.stringify([{ id: "old1", text: "Old", near: 0 }]));
    let userId: string | null | undefined;
    const r = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        frameKey: KEY,
        onReload: vi.fn(),
        userId,
      }),
    );
    fromFrame(up([{ id: "new1", text: "New", near: 0 }]));
    userId = "u1";
    r.rerender();
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toEqual([
      { id: "old1", text: "Old", near: 0 },
      { id: "new1", text: "New", near: 0 },
    ]);
  });

  it("B: a new item written meanwhile leaves the store as it was, and a fresh frame's empty report changes nothing", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const key = "plinth-draft:page-rescue:u1:art1";
    const old = [{ id: "old1", text: "Old", near: 0 }];
    sessionStorage.setItem(key, JSON.stringify(old));
    hook(gate("room"), vi.fn(), { userId: "u1" });
    fromFrame(up([]));
    fromFrame(up([{ id: "new1", text: "New", near: 0 }]));
    fromFrame({ ...up([]), written: ["new1"] });
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toEqual(old);
    // Only written, gone, a discard or a sign-out take an item out.
    fromFrame({ ...up([]), gone: ["old1"] });
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("answers each report with the ids it keeps: what does not fit stays out", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    hook(gate("room"), vi.fn(), { userId: "u1" });
    const chunk = "y".repeat(60 * 1024);
    fromFrame(
      up(
        [0, 1, 2, 3].map((n) => ({ id: `a${n}`, text: chunk, near: 0 })),
        1,
      ),
    );
    fromFrame(up([{ id: "b0", text: chunk, near: 0 }], 2));
    const reply = sentToFrame("rescue").at(-1)?.[0];
    expect(reply).toMatchObject({ type: "rescue", items: [], n: 2 });
    expect(reply.stored).toHaveLength(4);
    expect(reply.stored).not.toContain("b0");
  });

  it("warns before leaving while any account's store for this page is in the tab, with no session", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    sessionStorage.setItem(
      "plinth-draft:page-rescue:u1:art1",
      JSON.stringify([{ id: "r1", text: "Kept", near: 0 }]),
    );
    // The session never resolved (/me failed): nothing is offered, but leaving still warns.
    hook(gate("room"), vi.fn(), { userId: undefined });
    expect(sentToFrame("rescue")).toHaveLength(0);
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("warns only about the signed-in account's store once the session is known", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    sessionStorage.setItem(
      "plinth-draft:page-rescue:u1:art1",
      JSON.stringify([{ id: "r1", text: "Kept", near: 0 }]),
    );
    const leaves = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Another account, or no one, signed in now: u1's store does not warn them (nor a viewer).
    for (const userId of ["u2", null]) {
      const r = hook(gate("room"), vi.fn(), { userId });
      expect(leaves(), String(userId)).toBe(false);
      r.unmount();
    }
    const own = hook(gate("room"), vi.fn(), { userId: "u1" });
    expect(leaves()).toBe(true);
    own.unmount();
  });

  it("solo: a tab copy that cannot be kept is tried again, then the items go back to the frame to copy", async () => {
    vi.useFakeTimers();
    stubApi({ handle: () => undefined });
    const stored = () => (loadRescue("u1", "art1") as unknown[] | null) ?? [];
    // The tab's copy cannot be written (storage full); the rescue store still can.
    failSave.on = true;
    hook(gate("solo"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false });
    fromFrame(up([{ id: "r1", text: "Kept", near: 0 }]));
    fromFrame({ ...up([]), written: ["r1"] });
    const answerCollect = async () => {
      const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
      fromFrame({ type: "draft", nonce, text: "# Plan\n\nKept" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    await answerCollect();
    // Not kept: the store keeps the item, and nothing goes back to the frame yet.
    expect(stored()).toHaveLength(1);
    const collects = sentToFrame("collect").length;
    for (const ms of [1000, 2000, 4000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await answerCollect();
    }
    expect(sentToFrame("collect").length).toBe(collects + 3);
    // Every try failed: the frame gets the item to copy (or dismiss), not to write again.
    expect(sentToFrame("rescue").at(-1)?.[0]).toMatchObject({
      type: "rescue",
      items: [{ id: "r1", text: "Kept", near: 0 }],
      copy: true,
    });
    expect(stored()).toHaveLength(1);
  });

  it("solo: items the frame wrote into its text are kept in the tab's copy before they leave the store", async () => {
    stubApi({ handle: () => undefined });
    const key = "plinth-draft:page-rescue:u1:art1";
    hook(gate("solo"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false });
    fromFrame(up([{ id: "r1", text: "Kept", near: 0 }]));
    // The frame wrote it into its own text: the app takes the text first.
    fromFrame({ ...up([]), written: ["r1"] });
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toHaveLength(1);
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    expect(nonce).toBeTruthy();
    fromFrame({ type: "draft", nonce, text: "# Plan\n\nKept" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      JSON.parse(sessionStorage.getItem("plinth-draft:page-edit:art1") ?? "null"),
    ).toMatchObject({ text: "# Plan\n\nKept", base: 3 });
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("3. a discard clears the rescue store, room and solo", async () => {
    stubApi({
      handle: (c) =>
        c.path.endsWith("/live")
          ? json(INFO)
          : c.method === "DELETE"
            ? new Response(null, { status: 204 })
            : undefined,
    });
    const key = "plinth-draft:page-rescue:u1:art1";
    const room = hook(gate("room"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS });
    fromFrame(up([{ id: "r1", text: "Kept", near: 0 }]));
    expect(sessionStorage.getItem(key)).not.toBeNull();
    await act(() => room.result.current.discard());
    expect(sessionStorage.getItem(key)).toBeNull();
    room.unmount();
    const solo = hook(gate("solo"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS, connected: false });
    fromFrame(up([{ id: "r2", text: "Kept", near: 0 }]));
    expect(sessionStorage.getItem(key)).not.toBeNull();
    await act(() => solo.result.current.discard());
    expect(sessionStorage.getItem(key)).toBeNull();
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

  it("room discard: the rev the frame shows, and says so on a 409 or while busy", async () => {
    let answer: Response = new Response(null, { status: 204 });
    const { calls } = stubApi({ handle: (c) => (c.method === "DELETE" ? answer : undefined) });
    const { result } = hook(gate("room"));
    // Not connected: nothing to name, nothing sent.
    await act(() => result.current.discard());
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    fromFrame({ type: "live", ...STATUS, editing: false, rev: 15 });
    await act(() => result.current.discard());
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
      "/artifacts/art1/live/draft?rev=15",
    );
    expect(toasts.at(-1)).toBe("Unpublished changes discarded.");
    answer = json(
      {
        error: {
          code: "conflict",
          message: "The page edits changed since you looked. Look again.",
          details: { rev: 16 },
        },
      },
      409,
    );
    await act(() => result.current.discard());
    expect(toasts.at(-1)).toBe("The page edits changed since you looked. Look again.");
    answer = conflict409(3, "live_busy", "busy");
    await act(() => result.current.discard());
    expect(toasts.at(-1)).toBe(CHOOSING_BUSY);
  });

  it("solo: a refused publish keeps editing and the changes, and says why", async () => {
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
    fromFrame({ type: "live", ...STATUS, connected: false });
    const publish = async () => {
      let p: Promise<void> = Promise.resolve();
      act(() => {
        p = result.current.publish();
      });
      const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
      fromFrame({ type: "draft", nonce, text: "# Edited" });
      await act(() => p);
    };
    await publish();
    expect(result.current.editing).toBe(true);
    expect(result.current.unpublished).toBe(true);
    expect(toasts.at(-1)).toBe("Hourly version limit reached. Your changes stay as a draft.");
    fail = false;
    await publish();
    expect(result.current.editing).toBe(true);
    expect(result.current.unpublished).toBe(false);
    expect(result.current.savedVersion).toBe(4);
  });

  it("solo: autosaves after the quiet spell over the version it last made, never over a newer one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let version = 4;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json({ ...INFO, mode: "solo" });
        if (c.method === "PUT") {
          const v = version;
          version += 1;
          return v === 6
            ? conflict409(6, "")
            : json({ id: "art1", version: v, type: "doc", warnings: [] });
        }
        return undefined;
      },
    });
    // The frame answers every collect (the tab's copy every 5 s, and the publish) with its text.
    const text = { now: "# One" };
    toFrame.mockImplementation((m: { type?: string; nonce?: string }) => {
      if (m?.type === "collect") {
        queueMicrotask(() => fromFrame({ type: "draft", nonce: m.nonce, text: text.now }));
      }
    });
    const onReload = vi.fn();
    const { result } = hook(gate("solo"), onReload);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/live"))).toBe(true));
    const puts = () => calls.filter((c) => c.method === "PUT");
    // A change report starts the quiet spell; the copy publishes itself when it ends.
    fromFrame({ type: "live", ...STATUS, connected: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_000);
    });
    expect(puts()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ content: "# One", base_version: 3, files_from_version: 3 });
    await waitFor(() => expect(result.current.ownVersion).toBe(4));
    expect(result.current.unpublished).toBe(false);
    expect(onReload).not.toHaveBeenCalled();
    // More typing: the next autosave keeps LIVE_AUTO_CHECKPOINT_MIN_S after the last one.
    text.now = "# Two";
    fromFrame({ type: "live", ...STATUS, connected: false });
    expect(result.current.unpublished).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(puts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(310_000);
    });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]?.body).toEqual({ content: "# Two", base_version: 4, files_from_version: 4 });
    // A newer version refused the next one: no toast, no review opened by itself, no reload; the
    // status says so, and the autosave waits for the review.
    text.now = "# Three";
    fromFrame({ type: "live", ...STATUS, connected: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(610_000);
    });
    await waitFor(() => expect(puts()).toHaveLength(3));
    await waitFor(() => expect(result.current.newerVersion).toBe(6));
    expect(result.current.phase).toBe("conflict");
    expect(toasts).toHaveLength(0);
    expect(sentToFrame("review")).toHaveLength(0);
    fromFrame({ type: "live", ...STATUS, connected: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700_000);
    });
    expect(puts()).toHaveLength(3);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("solo: a version published elsewhere loads when the page has no changes of its own", async () => {
    stubApi();
    const onReload = vi.fn();
    const g = gate("solo");
    const { result, rerender } = renderHook(
      (p: { g: OkGate }) =>
        useLiveEdit({
          gate: p.g,
          frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          frameKey: KEY,
          onReload,
        }),
      { initialProps: { g } },
    );
    // The frame is held while editing (never swapped under the editor).
    expect(result.current.pause).toBe("hold");
    fromFrame({ type: "live", ...STATUS, connected: false, dirty: false });
    rerender({ g: { ...g, artifact: { ...g.artifact, current_version: 4 } } });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("room: leaving the page publishes the draft, as Done did", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint"))
          return json({ saved: true, version: { version: 4 } });
        return undefined;
      },
    });
    const { unmount } = hook(gate("room"));
    fromFrame({ type: "live", ...STATUS });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const posts = () => calls.filter((c) => c.path.endsWith("/live/checkpoint"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({ base_version: 3, rev: 7, reason: "done" });
    // A frozen draft is left as it is.
    fromFrame({ type: "live", ...STATUS, rev: 8, conflict_version: 4 });
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts()).toHaveLength(1);
  });

  it("room: going elsewhere in the app publishes the draft too", async () => {
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path.endsWith("/live")) return json(INFO);
        if (c.path.endsWith("/live/checkpoint"))
          return json({ saved: true, version: { version: 4 } });
        return undefined;
      },
    });
    const { unmount } = hook(gate("room"));
    fromFrame({ type: "live", ...STATUS });
    unmount();
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/live/checkpoint"))).toHaveLength(1),
    );
  });

  it("asks the frame to pick a place, and takes its answer only for a pick it asked for", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const onPicked = vi.fn();
    const { result } = renderHook(() =>
      useLiveEdit({
        gate: gate("room"),
        frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        frameKey: KEY,
        onReload: vi.fn(),
        onPicked,
      }),
    );
    expect(result.current.canPick).toBe(true);
    // Not asked for: dropped.
    fromFrame({ type: "picked", anchor: { key: "block-1", text: "Hi" } });
    expect(onPicked).not.toHaveBeenCalled();
    act(() => {
      expect(result.current.pick(true)).toBe(true);
    });
    expect(sentToFrame("pick").at(-1)).toEqual([
      { source: "plinth-renderer", v: 1, type: "pick", on: true },
      ORIGIN,
    ]);
    // Without the frame's key: dropped.
    fromFrame({ type: "picked", anchor: { key: "block-1", text: "Hi" } }, ORIGIN, null);
    expect(onPicked).not.toHaveBeenCalled();
    fromFrame({ type: "picked", anchor: { key: "block-1", text: "Hi" }, what: "paragraph" });
    expect(onPicked).toHaveBeenCalledWith({ key: "block-1", text: "Hi" }, "paragraph");
    // Taken once.
    fromFrame({ type: "picked", anchor: { key: "block-2", text: "Again" } });
    expect(onPicked).toHaveBeenCalledTimes(1);
    // A cancelled pick in the frame comes back as null.
    act(() => {
      result.current.pick(true);
    });
    fromFrame({ type: "picked", anchor: null });
    expect(onPicked).toHaveBeenLastCalledWith(null, undefined);
    // Stopping tells the frame only when a pick is on.
    act(() => {
      result.current.pick(true);
      result.current.pick(false);
    });
    expect(sentToFrame("pick").at(-1)?.[0]).toMatchObject({ on: false });
  });

  it("solo keeps a copy while dirty, and a reload offers it back with its own base and files", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({ id: "art1", version: 4, type: "doc", warnings: [] })
          : undefined,
    });
    const first = hook(gate("solo"));
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
      files_from_version: 3,
    });
    expect(second.result.current.restore).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("solo: a kept copy refused because a newer version is current is reviewed as that copy", async () => {
    savePageDraft("art1", 3, "# Kept");
    let refuse = true;
    const onReload = vi.fn();
    const { calls } = stubApi({
      handle: (c) => {
        if (c.method === "PUT") {
          if (refuse) {
            refuse = false;
            return conflict409(4, "");
          }
          return json({ id: "art1", version: 5, type: "doc", warnings: [] });
        }
        if (/\/versions\/\d$/.test(c.path)) return json({ type: "doc", content: "", assets: [] });
        return undefined;
      },
    });
    const later = gate("solo");
    later.artifact = { ...later.artifact, version: 4, current_version: 4 };
    const { result } = hook(later, onReload);
    expect(result.current.restore).toMatchObject({ text: "# Kept", base: 3 });
    // Not in edit mode: the frame holds no copy of its own, so the review gets the kept one.
    await act(() => result.current.saveRestore());
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    const [review, target] = sentToFrame("review")[0] ?? [];
    expect(target).toBe(ORIGIN);
    expect(review).toMatchObject({ n: 4, base: 3, text: "# Kept" });
    expect(result.current.review).toMatchObject({ base: 3, current: 4, mode: "solo" });
    expect(result.current.restore).toMatchObject({ text: "# Kept" });
    // Publish your changes publishes the kept copy, whatever text the frame sends back.
    fromFrame({ type: "resolved", nonce: review.nonce, outcome: "publish", text: "# Other" });
    await waitFor(() => expect(sentToFrame("reviewed").at(-1)?.[0].result).toBe("done"));
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
      content: "# Kept",
      base_version: 4,
      files_from_version: 3,
      note: "Edited on the page. Replaces the changes in v4.",
    });
    expect(result.current.restore).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(onReload).toHaveBeenCalled();
  });

  it("solo: a kept copy refused with a 409 that names no newer version says so, and keeps the copy", async () => {
    savePageDraft("art1", 3, "# Kept");
    let message = "This artifact is being changed. Try again.";
    stubApi({
      handle: (c) =>
        c.method === "PUT"
          ? json({ error: { code: "conflict", message, details: { reason: "busy" } } }, 409)
          : undefined,
    });
    const later = gate("solo");
    later.artifact = { ...later.artifact, version: 3, current_version: 3 };
    const { result } = hook(later);
    await act(() => result.current.saveRestore());
    // Nothing to review against: the server's own words, and the copy stays to try again.
    expect(sentToFrame("review")).toHaveLength(0);
    expect(toasts.at(-1)).toBe("This artifact is being changed. Try again.");
    expect(result.current.restore).toMatchObject({ text: "# Kept" });
    // Without words of its own, a short generic line.
    message = "";
    toasts.length = 0;
    await act(() => result.current.saveRestore());
    expect(toasts.at(-1)).toBe("These changes could not be published. Try again.");
    expect(result.current.restore).toMatchObject({ text: "# Kept" });
  });

  it("solo: Discard your changes in the review of a kept copy drops the copy", async () => {
    savePageDraft("art1", 3, "# Kept");
    stubApi({
      handle: (c) => {
        if (c.method === "PUT") return conflict409(4, "");
        if (/\/versions\/\d$/.test(c.path)) return json({ type: "doc", content: "", assets: [] });
        return undefined;
      },
    });
    const later = gate("solo");
    later.artifact = { ...later.artifact, version: 4, current_version: 4 };
    const { result } = hook(later);
    await act(() => result.current.saveRestore());
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    const nonce = sentToFrame("review")[0]?.[0].nonce as string;
    fromFrame({ type: "resolved", nonce, outcome: "discard" });
    act(() => result.current.answerDiscard(true));
    expect(result.current.restore).toBeNull();
    expect(result.current.review).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("solo: the restore notice's Discard and a review's Discard drop the rescue store with the copy", async () => {
    // A deck at its size limit: the tab's copy is the deck as written, its typing is in the store.
    const key = "plinth-draft:page-rescue:u1:art1";
    const kept = [{ id: "r1", text: "Typed past the limit", near: 0 }];
    stubApi({
      handle: (c) => {
        if (c.method === "PUT") return conflict409(4, "");
        if (/\/versions\/\d$/.test(c.path)) return json({ type: "doc", content: "", assets: [] });
        return undefined;
      },
    });
    const later = gate("solo");
    later.artifact = { ...later.artifact, version: 4, current_version: 4 };

    // 1. The notice's Discard: nothing is offered to the next frame, and leaving does not warn.
    savePageDraft("art1", 3, "# Kept");
    sessionStorage.setItem(key, JSON.stringify(kept));
    const notice = hook(later, vi.fn(), { userId: "u1" });
    expect(notice.result.current.restore).toMatchObject({ text: "# Kept" });
    act(() => notice.result.current.dropRestore());
    expect(sessionStorage.getItem(key)).toBeNull();
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    notice.unmount();
    toFrame.mockClear();
    hook(later, vi.fn(), { userId: "u1" }).unmount();
    expect(sentToFrame("rescue")).toHaveLength(0);

    // 2. The kept copy's review (a newer version is current), then Discard.
    savePageDraft("art1", 3, "# Kept");
    sessionStorage.setItem(key, JSON.stringify(kept));
    const copy = hook(later, vi.fn(), { userId: "u1" });
    await act(() => copy.result.current.saveRestore());
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    fromFrame({ type: "resolved", nonce: sentToFrame("review")[0]?.[0].nonce, outcome: "discard" });
    act(() => copy.result.current.answerDiscard(true));
    expect(copy.result.current.review).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
    copy.unmount();

    // 3. The editing frame's own review, then Discard.
    toFrame.mockClear();
    sessionStorage.setItem(key, JSON.stringify(kept));
    const own = hook(gate("solo"), vi.fn(), { userId: "u1" });
    fromFrame({ type: "live", ...STATUS, connected: false });
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = own.result.current.publish();
    });
    const nonce = sentToFrame("collect").at(-1)?.[0].nonce as string;
    fromFrame({ type: "draft", nonce, text: "# Mine" });
    await act(() => saving);
    await waitFor(() => expect(sentToFrame("review")).toHaveLength(1));
    fromFrame({ type: "resolved", nonce: sentToFrame("review")[0]?.[0].nonce, outcome: "discard" });
    act(() => own.result.current.answerDiscard(true));
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("Esc at the top level of the frame moves focus to the strip", () => {
    stubApi({ handle: (c) => (c.path.endsWith("/live") ? json(INFO) : undefined) });
    const onLeave = vi.fn();
    hook(gate("room"), vi.fn(), { onLeave });
    fromFrame({ type: "leave" });
    expect(onLeave).toHaveBeenCalledTimes(1);
    fromFrame({ type: "leave" }, ORIGIN, null);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
