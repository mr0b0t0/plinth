// Timing checks that hold on a slow or busy machine. Each compares two timings taken in the same
// run, so a machine that is slow throughout slows both sides alike, and each side is the fastest
// of a few runs, so a pause on a busy machine (another test file, a garbage collection) does not
// count. A fixed limit in milliseconds did not hold: CI runs these 5 to 10 times slower than a
// laptop, and twice as slow again under load.
import { expect } from "vitest";

/** Runs of each side: the fastest counts. */
const RUNS = 3;

export interface WithinOptions {
  /** `work` may take this many times the baseline. */
  factor: number;
  /**
   * A baseline under this many milliseconds counts as this many, so a tiny one's timer noise
   * cannot fail the check, and `work` always gets at least `factor × floorMs`. Default 2.
   */
  floorMs?: number;
}

/** Milliseconds one run of `work` takes. `performance` is in Node but not in the package's types. */
function time(work: () => unknown): number {
  const clock = (globalThis as unknown as { performance: { now(): number } }).performance;
  const t = clock.now();
  work();
  return clock.now() - t;
}

/**
 * Expects `work` to take under `factor` times what `baseline` takes, both measured here. The
 * baseline is the fastest of three runs; `work` is run again, up to three times, only while it is
 * over the limit.
 */
export function expectWithin(
  work: () => unknown,
  baseline: () => unknown,
  { factor, floorMs = 2 }: WithinOptions,
): void {
  let base = Number.POSITIVE_INFINITY;
  for (let r = 0; r < RUNS; r++) base = Math.min(base, time(baseline));
  const limit = factor * Math.max(base, floorMs);
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < RUNS && best >= limit; r++) best = Math.min(best, time(work));
  expect(best, `${best.toFixed(1)} ms against a baseline of ${base.toFixed(1)} ms`).toBeLessThan(
    limit,
  );
}

/**
 * Expects `make(n)`'s work to grow linearly with `n`: the full input in under 50 times what a
 * tenth of it takes (`factor`), where linear work takes about 10 times and a quadratic 100.
 * `make` builds the input outside the timing and returns the work to time.
 */
export function expectLinear(
  make: (n: number) => () => unknown,
  n: number,
  { factor = 50, floorMs }: Partial<WithinOptions> = {},
): void {
  expectWithin(make(n), make(Math.round(n / 10)), { factor, floorMs });
}
