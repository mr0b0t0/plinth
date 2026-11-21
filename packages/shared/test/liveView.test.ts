import { describe, expect, it } from "vitest";
import {
  LIVE_VIEW_BOUNDS,
  LIVE_VIEW_DEFAULTS,
  LIVE_VIEW_LIMITS,
  livePoolCap,
  readViewWatchFrame,
  spreadMs,
} from "../src/liveView.ts";

describe("spreadMs", () => {
  it("depends only on the instance's cap: 2 ms per socket an artifact may hold, up to 10 s", () => {
    expect(spreadMs(LIVE_VIEW_DEFAULTS.maxSocketsPerArtifact)).toBe(2000);
    expect(spreadMs(LIVE_VIEW_BOUNDS.maxSocketsPerArtifact[0])).toBe(20);
    expect(spreadMs(2500)).toBe(5000);
    expect(spreadMs(LIVE_VIEW_BOUNDS.maxSocketsPerArtifact[1])).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
    expect(spreadMs(0)).toBe(0);
    expect(spreadMs(-1)).toBe(0);
    expect(spreadMs(Number.NaN)).toBe(0);
  });

  it("bounds follow-ups to cap / spread a second, at most 1000, whatever the audience", () => {
    const [lo, hi] = LIVE_VIEW_BOUNDS.maxSocketsPerArtifact;
    for (let cap = lo; cap <= hi; cap += 10) {
      const spread = spreadMs(cap);
      // An instance capped this low acts at once: at most `cap` requests, all together.
      if (spread < LIVE_VIEW_LIMITS.spreadAtOnceMs) {
        expect(cap).toBeLessThan(50);
        continue;
      }
      expect(cap / (spread / 1000)).toBeLessThanOrEqual(1000);
    }
  });

  it("every spread is one the client accepts", () => {
    for (const cap of [10, 50, 1000, 10_000]) {
      const frame = JSON.stringify({ t: "data", spread_ms: spreadMs(cap) });
      expect(readViewWatchFrame(frame)).toEqual({ t: "data", spread_ms: spreadMs(cap) });
    }
  });
});

describe("readViewWatchFrame", () => {
  it("reads a welcome as the current version only", () => {
    expect(readViewWatchFrame(JSON.stringify({ t: "welcome", v: 1, version: 4 }))).toEqual({
      t: "welcome",
      v: 1,
      version: 4,
    });
    // Nothing else a welcome might carry reaches the app.
    expect(
      readViewWatchFrame(JSON.stringify({ t: "welcome", v: 1, version: 4, data: true })),
    ).toEqual({ t: "welcome", v: 1, version: 4 });
    expect(readViewWatchFrame(JSON.stringify({ t: "welcome", v: 2, version: 4 }))).toBeNull();
    expect(readViewWatchFrame(JSON.stringify({ t: "welcome", v: 1, version: -1 }))).toBeNull();
  });
});

describe("reconnect and lifetime spreads", () => {
  it("spread a reconnect wave and a lifetime wave over named, bounded windows", () => {
    expect(LIVE_VIEW_LIMITS.reconnectSpreadMs).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
    // Five or six of the room's 60 s alarms; a small part of the 12-hour lifetime.
    expect(LIVE_VIEW_LIMITS.lifetimeJitterS).toBe(300);
    expect(LIVE_VIEW_LIMITS.lifetimeJitterS).toBeLessThan(LIVE_VIEW_LIMITS.socketTtlS / 100);
  });
});

describe("livePoolCap", () => {
  it("splits the per-artifact cap between the member and open pools, never over it", () => {
    const [lo, hi] = LIVE_VIEW_BOUNDS.maxSocketsPerArtifact;
    for (let cap = lo; cap <= hi; cap++) {
      const member = livePoolCap(cap, "member");
      const open = livePoolCap(cap, "open");
      expect(member + open).toBe(cap);
      expect(Math.abs(member - open)).toBeLessThanOrEqual(1);
      expect(member).toBeGreaterThanOrEqual(5);
    }
    expect(livePoolCap(1000, "member")).toBe(500);
    expect(livePoolCap(1000, "open")).toBe(500);
  });
});
