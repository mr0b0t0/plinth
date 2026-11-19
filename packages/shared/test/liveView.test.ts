import { describe, expect, it } from "vitest";
import { LIVE_VIEW_LIMITS, readViewWatchFrame, spreadMs } from "../src/liveView.ts";

describe("spreadMs", () => {
  it("is a coarse band, never a count of open views", () => {
    const bands = new Set<number>();
    for (let n = 0; n <= 20_000; n++) bands.add(spreadMs(n));
    expect([...bands].sort((a, b) => a - b)).toEqual([0, 1000, 2000, 4000, 8000, 10_000]);
  });

  it("is 0 for a small audience, so one more or one fewer view never shows", () => {
    for (let n = 0; n < LIVE_VIEW_LIMITS.spreadFromRecipients; n++) expect(spreadMs(n)).toBe(0);
    expect(spreadMs(-1)).toBe(0);
    expect(spreadMs(Number.NaN)).toBe(0);
  });

  it("starts above what three clients' full socket caps can reach together", () => {
    expect(LIVE_VIEW_LIMITS.spreadFromRecipients).toBeGreaterThan(
      3 * LIVE_VIEW_LIMITS.socketsPerClient,
    );
  });

  it("doubles as the audience doubles, and stops at the cap", () => {
    expect(spreadMs(100)).toBe(1000);
    expect(spreadMs(101)).toBe(2000);
    expect(spreadMs(200)).toBe(2000);
    expect(spreadMs(201)).toBe(4000);
    expect(spreadMs(400)).toBe(4000);
    expect(spreadMs(401)).toBe(8000);
    expect(spreadMs(800)).toBe(8000);
    expect(spreadMs(801)).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
    expect(spreadMs(10_000)).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
    expect(spreadMs(Number.POSITIVE_INFINITY)).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
  });

  it("still bounds follow-ups to about 100 a second for a large audience", () => {
    for (let n = LIVE_VIEW_LIMITS.spreadFromRecipients; n <= 1000; n++) {
      expect(spreadMs(n)).toBeGreaterThanOrEqual(n * 10);
    }
  });

  it("every band is a spread the client accepts", () => {
    for (const n of [0, 100, 150, 300, 600, 5000]) {
      const frame = JSON.stringify({ t: "data", spread_ms: spreadMs(n) });
      expect(readViewWatchFrame(frame)).toEqual({ t: "data", spread_ms: spreadMs(n) });
    }
  });
});
