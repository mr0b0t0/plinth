// Fixed-window counters in D1. One row per key per window; old rows are pruned opportunistically.
// D1 is the only state store Plinth needs (no KV or Durable Objects), which keeps self-hosting and
// the staging footprint to one Worker, one database and one bucket.
import { ApiError } from "./errors.ts";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export async function hit(
  d1: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const nowS = Math.floor(now / 1000);
  const windowStart = nowS - (nowS % windowSeconds);
  const row = await d1
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (Math.random() < 0.01) {
    await d1
      .prepare("DELETE FROM rate_limits WHERE window_start < ?1")
      .bind(nowS - 2 * 86400)
      .run();
  }
  return { allowed: count <= limit, count, limit, retryAfter: windowStart + windowSeconds - nowS };
}

/** Count a hit and throw `rate_limited` if over the limit. */
export async function enforce(
  d1: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  message = "Too many requests, try again later",
): Promise<void> {
  const r = await hit(d1, key, limit, windowSeconds);
  if (!r.allowed) throw new ApiError("rate_limited", message, { retry_after: r.retryAfter });
}

/** Read the current count without counting a hit. */
export async function peek(d1: D1Database, key: string, windowSeconds: number, now = Date.now()) {
  const nowS = Math.floor(now / 1000);
  const windowStart = nowS - (nowS % windowSeconds);
  const row = await d1
    .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2")
    .bind(key, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
