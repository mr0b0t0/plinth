// Live views (docs/spec.md "Live views"): an open artifact page learns of a new version, and a
// page that keeps shared data learns that it changed, without polling. The app page opens one
// receive-only WebSocket on the app host (`/api/v1/view/:ref/watch`) into the artifact's
// ArtifactRoom; the room pushes only server-made signals: version numbers and "data changed". It
// never carries artifact content, document data, emails or anything a page wrote. No zod here: the
// app imports it, and a renderer bundle may.
import { TTL } from "./constants.ts";

/** The WebSocket subprotocol the watch handshake must offer, and the 101 echoes. */
export const VIEW_WATCH_PROTOCOL = "plinth.view.v1";

/** Env-var defaults for live views (LIVE_VIEW_* env vars). */
export const LIVE_VIEW_DEFAULTS = {
  /** LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: watch sockets on one artifact. */
  maxSocketsPerArtifact: 1000,
} as const;

export const LIVE_VIEW_BOUNDS = {
  maxSocketsPerArtifact: [10, 10000],
} as const;

/** Fixed live-view rules, not env vars. */
export const LIVE_VIEW_LIMITS = {
  /** Watch sockets one client (a person's tabs and devices, or one address) may hold on one artifact. */
  socketsPerClient: 32,
  /** Watch connects one client may make to one artifact per minute. */
  connectsPerClientPerMinute: 60,
  /**
   * A watch socket lives at most as long as a content pass: the room closes it with 4401 when it
   * expires, and the app re-reads the gate and reconnects.
   */
  socketTtlS: TTL.contentCookieS,
  /** Clients wait random(0, spread_ms) before acting; spread_ms = min(max, recipients * this). */
  spreadMsPerSocket: 10,
  spreadMaxMs: 10_000,
  /** Under this spread (fewer than 10 recipients) clients act at once. */
  spreadAtOnceMs: 100,
  /** While pushed, the page runtime still re-reads /changes this often (a lost `data` signal). */
  pollBackstopMs: 60_000,
  /** While pushed, the app still re-reads its gate this often (a lost `version` signal). */
  gateBackstopMs: 300_000,
  /** A tab hidden this long closes its watch socket; showing it again reconnects. */
  hiddenCloseS: 60,
  /** The client sends the literal text `ping` this often; the room answers `pong` asleep. */
  pingIntervalS: 30,
  /** After a refusal (full, rate, invalid), the app polls and tries the socket again after this. */
  refusedRetryS: 300,
  /** Reconnect delays in seconds after a network failure; the last one repeats. */
  backoffS: [1, 2, 5, 10, 30],
} as const;

/** Server -> client, JSON text frames. The client only ever sends the text "ping". */
export type ViewWatchFrame =
  /** First frame: the current version, and whether this socket gets `data` signals. */
  | { t: "welcome"; v: 1; version: number; data: boolean }
  /** A new version was published: re-read the gate (after random(0, spread_ms) ms). */
  | { t: "version"; version: number; spread_ms: number }
  /** The page's shared data changed: the page re-reads it (after random(0, spread_ms) ms). */
  | { t: "data"; spread_ms: number }
  /**
   * Sent just before a sharing change closes the socket (4401 `access_changed`): the page re-reads
   * its gate and reconnects only after random(0, spread_ms) ms, so a large audience does not do
   * both at the same moment.
   */
  | { t: "access"; spread_ms: number };

/** How long clients spread their follow-up requests when `recipients` sockets got a signal. */
export function spreadMs(recipients: number): number {
  return Math.min(
    LIVE_VIEW_LIMITS.spreadMaxMs,
    Math.max(0, recipients) * LIVE_VIEW_LIMITS.spreadMsPerSocket,
  );
}

/**
 * App -> frame messages (the page runtime's live fragment listens on this `source`), posted only
 * at the exact content origin, never "*": `{ source, v, type: "data" }` (re-read shared data now)
 * and `{ source, v, type: "push", on }` (signals are pushed: poll /changes only as a backstop).
 * Page script can forge either on its own window, so both are hints that only make the page re-read
 * its own data or change its own poll.
 */
export const VIEW_MESSAGE_SOURCE = "plinth-view";
export const VIEW_MESSAGE_VERSION = 1;

export type ViewFrameMessage =
  | { source: typeof VIEW_MESSAGE_SOURCE; v: typeof VIEW_MESSAGE_VERSION; type: "data" }
  | {
      source: typeof VIEW_MESSAGE_SOURCE;
      v: typeof VIEW_MESSAGE_VERSION;
      type: "push";
      on: boolean;
    };

/** Parse one watch frame from the server, or null when it is not one. */
export function readViewWatchFrame(raw: unknown): ViewWatchFrame | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const spread = (n: unknown) => count(n) && (n as number) <= LIVE_VIEW_LIMITS.spreadMaxMs;
  if (f.t === "welcome" && f.v === 1 && count(f.version) && typeof f.data === "boolean") {
    return { t: "welcome", v: 1, version: f.version as number, data: f.data };
  }
  if (f.t === "version" && count(f.version) && spread(f.spread_ms)) {
    return { t: "version", version: f.version as number, spread_ms: f.spread_ms as number };
  }
  if (f.t === "data" && spread(f.spread_ms)) return { t: "data", spread_ms: f.spread_ms as number };
  if (f.t === "access" && spread(f.spread_ms)) {
    return { t: "access", spread_ms: f.spread_ms as number };
  }
  return null;
}
