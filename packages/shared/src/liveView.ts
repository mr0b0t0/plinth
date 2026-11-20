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
  /**
   * LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: watch sockets on one artifact, half for the people it is
   * shared with and half for everyone else (livePoolCap).
   */
  maxSocketsPerArtifact: 1000,
} as const;

export const LIVE_VIEW_BOUNDS = {
  maxSocketsPerArtifact: [10, 10000],
} as const;

/** Fixed live-view rules, not env vars. */
export const LIVE_VIEW_LIMITS = {
  /**
   * Watch sockets one client may hold on one artifact: a person's tabs and devices, or, for an
   * anonymous viewer, one network (an IPv4 address or an IPv6 /64, which one line or one server
   * usually gets whole).
   */
  socketsPerClient: 32,
  /** Watch connects one client may make to one artifact per minute. */
  connectsPerClientPerMinute: 60,
  /**
   * A watch socket lives at most as long as a content pass (less up to lifetimeJitterS, at
   * random): the room closes it with 4401 `expired` then, and the app reconnects.
   */
  socketTtlS: TTL.contentCookieS,
  /**
   * Clients wait random(0, spread_ms) before acting. spread_ms depends only on the instance's
   * LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT, never on how many views are open (that would be presence,
   * and anyone who can open enough sockets of their own could read it at a band edge):
   * spread_ms = min(spreadMaxMs, maxSockets * spreadMsPerCapSocket) (spreadMs()).
   */
  spreadMsPerCapSocket: 2,
  spreadMaxMs: 10_000,
  /** Under this spread (an instance capped below 50 watch sockets an artifact) clients act at once. */
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
  /**
   * The first reconnect after a socket closed on its own (a dropped network, a Worker deploy that
   * restarts every object, a lifetime that ended) waits random(0, reconnectSpreadMs): full jitter.
   * A deploy closes every watch socket on the instance at the same moment, so without it every open
   * view would reconnect, a handshake with its D1 reads and then a data re-read, within a second.
   * 10 s, the widest signal spread, so 1000 views of one artifact reconnect at about 100 a second.
   */
  reconnectSpreadMs: 10_000,
  /** Later reconnect delays in seconds while the socket keeps failing; then refusedRetryS. */
  backoffS: [1, 2, 5, 10, 30],
  /**
   * A socket's lifetime (socketTtlS) ends up to this much earlier, at random per handshake, so the
   * sockets one reconnect wave opened do not all reach their lifetime in the same alarm 12 hours
   * later and reconnect together again. The room's 60 s alarm closes them, so 300 s spreads one
   * wave over five or six alarms.
   */
  lifetimeJitterS: 300,
  /**
   * Applying a new version while keeping the reader's state (docs/spec.md "Live views"): how long
   * the app waits for the page runtime's answer to `update` before deciding itself.
   */
  updateReplyMs: 1000,
  /** How long the page's onVersion handlers may take, all together, before the runtime answers. */
  versionBudgetMs: 800,
  /** How long the app waits for the doc renderer to show a version in place before it swaps. */
  inPlaceReplyMs: 5000,
  /** Page state (plinth.onVersion's `{ state }`) handed to the next version, as JSON. */
  carryMaxBytes: 16384,
  /** A carry record older than this is ignored (and removed). */
  carryMaxAgeS: 30,
  /** The longest path inside the artifact a frame may report to land the next version on. */
  maxCarryPathLength: 2048,
} as const;

/** The content origin's sessionStorage key for the state carried to the next version. */
export const VIEW_CARRY_KEY = "__plinth_carry";

/**
 * The app names each viewer frame for the version it loads there (`plinth-v5`), which the page
 * reads as `window.name`. The runtime takes a carry record only in a frame named for the record's
 * `to`, so a record the old version wrote and the app then did not act on (the update was held,
 * the frame stayed, the gate could not be read) is never read by a reload or a sub-page of that
 * old frame. A page can rename its own window: that only changes what its own record does.
 */
export const VIEW_FRAME_NAME_PREFIX = "plinth-v";

/** The name of the viewer frame that shows `version`. */
export function viewFrameName(version: number): string {
  return `${VIEW_FRAME_NAME_PREFIX}${version}`;
}

/** Server -> client, JSON text frames. The client only ever sends the text "ping". */
export type ViewWatchFrame =
  /** First frame: the current version. */
  | { t: "welcome"; v: 1; version: number }
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

/**
 * How long clients spread their follow-up requests, for an instance whose
 * LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT is `maxSockets`: 2 ms per socket the artifact may hold, at most
 * 10 s (2 s at the default of 1000). It is the same in every frame of every artifact on the
 * instance, whoever else has the artifact open, so it tells a watcher nothing about the audience.
 * Since an artifact never has more than `maxSockets` watchers, one artifact sees at most
 * maxSockets / spread follow-up requests a second: 500 at the default, 1000 at the top bound.
 */
export function spreadMs(maxSockets: number): number {
  const { spreadMsPerCapSocket, spreadMaxMs } = LIVE_VIEW_LIMITS;
  if (!(maxSockets > 0)) return 0;
  return Math.min(spreadMaxMs, Math.floor(maxSockets * spreadMsPerCapSocket));
}

/**
 * Watch sockets on one artifact are counted in two pools that never affect each other: `member`
 * for the owner and the people the artifact is shared with (the view decision has a role), and
 * `open` for everyone else the gate lets in (link viewers, anonymous or signed in, and password
 * holders). A full pool closes new sockets 4409, so a caller who fills a pool with sockets of its
 * own can tell when another socket in that pool opens or closes; with separate pools, nobody
 * outside the artifact's sharing list can ever learn that its owner or a collaborator has it open.
 */
export type LiveViewPool = "member" | "open";

/** How many watch sockets a pool may hold: half of LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT each. */
export function livePoolCap(maxSockets: number, pool: LiveViewPool): number {
  const member = Math.floor(maxSockets / 2);
  return pool === "member" ? member : maxSockets - member;
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
    }
  /**
   * A newer version is about to replace the page (the runtime's version fragment): the page's
   * onVersion handlers run, and the runtime records scroll, location and the page's own state in
   * the content origin's sessionStorage, or answers `update:hold`. `force`: the viewer asked for
   * it, so a hold does not count. The nonce is the app's own; the answer echoes it.
   */
  | {
      source: typeof VIEW_MESSAGE_SOURCE;
      v: typeof VIEW_MESSAGE_VERSION;
      type: "update";
      from: number;
      to: number;
      nonce: string;
      force: boolean;
    };

/**
 * Frame -> app messages from the page runtime, posted only to the parent at the app origin. The app
 * reads them only from the frame it holds, at the exact content origin (origin isolation), and
 * treats them as untrusted: `hello` (this frame can answer `update`), `update:ok` (carry recorded;
 * `path` is where the page is, which only becomes the gate's `next`) and `update:hold` (the page
 * asks to keep it until the viewer chooses Update).
 */
export type ViewPageMessage =
  | { type: "hello" }
  | { type: "update:ok"; nonce: string; path: string | null }
  | { type: "update:hold"; nonce: string };

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
  if (f.t === "welcome" && f.v === 1 && count(f.version)) {
    return { t: "welcome", v: 1, version: f.version as number };
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
