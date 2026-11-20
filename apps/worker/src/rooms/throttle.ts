// Live views: the room's `data` frames, at most one per window (docs/spec.md "Live views"). Every
// shared-data write notifies the room, and each frame makes every open view re-read the change
// counter within spread_ms, so a burst of writes on a page many people have open would otherwise
// turn into a burst of reads per write. The first request in a quiet window fires at once; the
// rest of the window's requests join one call at its end, so the last change is always followed by
// a frame. In memory: an object that restarts drops a pending call, but a restart also closes its
// sockets, and every reconnect's welcome makes the page re-read its data.

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

/** Calls `fire` at most once per window: on the leading edge, then once more at the window's end. */
export class TrailingThrottle {
  private lastAt = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(
    private readonly fire: () => void,
    private readonly clock: ThrottleClock = realClock,
  ) {}

  /**
   * Ask for a call. `now`: it fired; `later`: one is scheduled for the window's end; `joined`: one
   * was already scheduled, and it fires after this request.
   */
  request(windowMs: number): "now" | "later" | "joined" {
    if (this.pending) return "joined";
    const wait = this.lastAt + windowMs - this.clock.now();
    if (wait <= 0) {
      this.run();
      return "now";
    }
    this.pending = true;
    this.clock.setTimeout(() => {
      this.pending = false;
      this.run();
    }, wait);
    return "later";
  }

  private run(): void {
    this.lastAt = this.clock.now();
    this.fire();
  }
}
