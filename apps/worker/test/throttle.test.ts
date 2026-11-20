// The room's coalescing of live-view `data` frames (rooms/throttle.ts), on a clock the test drives.
import { describe, expect, it } from "vitest";
import { type ThrottleClock, TrailingThrottle } from "../src/rooms/throttle.ts";

function fakeClock() {
  let now = 10_000;
  let timers: { at: number; fn: () => void }[] = [];
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.push({ at: now + ms, fn });
    },
  };
  /** Move time forward, running due timers in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  return { clock, advance, pending: () => timers.length, now: () => now };
}

describe("TrailingThrottle", () => {
  const W = 2000;

  it("N requests inside one window: one call at once, then exactly one at the window's end", () => {
    const c = fakeClock();
    const fired: number[] = [];
    const t = new TrailingThrottle(() => fired.push(c.now()), c.clock);
    expect(t.request(W)).toBe("now");
    expect(fired).toEqual([10_000]);
    expect(t.request(W)).toBe("later");
    for (let i = 0; i < 50; i++) {
      c.advance(30);
      expect(t.request(W)).toBe("joined");
    }
    expect(c.pending()).toBe(1);
    c.advance(W);
    expect(fired).toEqual([10_000, 12_000]);
    c.advance(10 * W);
    expect(fired).toHaveLength(2);
  });

  it("a request after a quiet window fires at once", () => {
    const c = fakeClock();
    const fired: number[] = [];
    const t = new TrailingThrottle(() => fired.push(c.now()), c.clock);
    t.request(W);
    c.advance(W);
    expect(t.request(W)).toBe("now");
    c.advance(5 * W);
    expect(t.request(W)).toBe("now");
    expect(fired).toEqual([10_000, 12_000, 22_000]);
    expect(c.pending()).toBe(0);
  });

  it("never more than one call per window, and the last request is always followed by a call", () => {
    for (const gap of [1, 7, 150, 499, 1999, 2000, 2001, 3500]) {
      const c = fakeClock();
      const fired: number[] = [];
      const t = new TrailingThrottle(() => fired.push(c.now()), c.clock);
      let last = 0;
      for (let i = 0; i < 40; i++) {
        t.request(W);
        last = c.now();
        c.advance(gap);
      }
      c.advance(2 * W);
      for (let i = 1; i < fired.length; i++) {
        expect((fired[i] ?? 0) - (fired[i - 1] ?? 0)).toBeGreaterThanOrEqual(W);
      }
      expect(fired.at(-1)).toBeGreaterThanOrEqual(last);
      expect(c.pending()).toBe(0);
    }
  });
});
