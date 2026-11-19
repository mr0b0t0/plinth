import type { ViewGate } from "@plinth/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "./test-utils.ts";
import { nextGate, useVersionWatch, VERSION_POLL_MS, versionPollMs } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const gate = (current: number, version: number, enter = `e${current}`): OkGate => ({
  status: "ok",
  artifact: {
    id: "a1",
    slug: "s",
    title: "T",
    type: "html",
    current_version: current,
    version,
    visibility: "unlisted",
    owner_name: null,
  },
  enter_url: enter,
  role: null,
});

describe("nextGate", () => {
  it("keeps the shown gate when nothing newer exists", () => {
    expect(nextGate(gate(3, 3), gate(3, 3, "other"), false)).toBeNull();
    expect(nextGate(gate(3, 3), gate(2, 2), false)).toBeNull();
  });

  it("ignores gates that are not ok", () => {
    expect(nextGate(gate(3, 3), { status: "not_found" }, false)).toBeNull();
  });

  it("follows the current version with the fresh gate", () => {
    const fresh = gate(4, 4);
    expect(nextGate(gate(3, 3), fresh, false)).toBe(fresh);
  });

  it("keeps a pinned frame and only moves the current version on", () => {
    const shown = gate(3, 2, "pinned");
    const next = nextGate(shown, gate(4, 2, "new"), true);
    expect(next?.enter_url).toBe("pinned");
    expect(next?.artifact.version).toBe(2);
    expect(next?.artifact.current_version).toBe(4);
  });
});

describe("nextGate while a doc is edited on its page", () => {
  it("follow: keeps the frame and moves the bar to the new version", () => {
    const shown = gate(3, 3, "live");
    const next = nextGate(shown, gate(4, 4, "new"), false, "follow");
    expect(next?.enter_url).toBe("live");
    expect(next?.artifact.version).toBe(4);
    expect(next?.artifact.current_version).toBe(4);
  });

  it("hold: keeps the frame and the shown version, so the page can say a newer one exists", () => {
    const shown = gate(3, 3, "solo");
    const next = nextGate(shown, gate(4, 4, "new"), false, "hold");
    expect(next?.enter_url).toBe("solo");
    expect(next?.artifact.version).toBe(3);
    expect(next?.artifact.current_version).toBe(4);
  });

  it("changes nothing when no newer version exists", () => {
    expect(nextGate(gate(3, 3), gate(3, 3, "x"), false, "follow")).toBeNull();
    expect(nextGate(gate(3, 3), gate(3, 3, "x"), false, "hold")).toBeNull();
  });
});

describe("useVersionWatch while the live-view socket is open", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls every 15 s, and every 5 minutes as a backstop while open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubApi({ handle: () => json(gate(3, 3)) });
    const { rerender } = renderHook(
      ({ ms }) => useVersionWatch("/view/s", gate(3, 3), false, () => undefined, ms),
      { initialProps: { ms: versionPollMs("connecting") } },
    );
    await act(() => vi.advanceTimersByTimeAsync(VERSION_POLL_MS));
    expect(calls).toHaveLength(1);
    rerender({ ms: versionPollMs("open") });
    await act(() => vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 4));
    expect(calls).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(calls).toHaveLength(2);
  });

  it("checkNow reads the gate at once, and a change of pace does not cancel it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    stubApi({
      handle: async () => {
        await held;
        return json(gate(4, 4, "fresh"));
      },
    });
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ ms }) => useVersionWatch("/view/s", gate(3, 3), false, (g) => seen.push(g.enter_url), ms),
      { initialProps: { ms: versionPollMs("connecting") } },
    );
    act(() => result.current.checkNow());
    // The socket's welcome both asks for the version and switches the pace.
    rerender({ ms: versionPollMs("open") });
    release();
    await act(async () => {
      await held;
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(seen).toEqual(["fresh"]);
  });
});
