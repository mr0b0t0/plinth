// Live rooms (#36): presence and broadcast among the people viewing one artifact, through the
// artifact's own Durable Object at /__plinth/room/v1/ on its content origin. This file holds the
// wire protocol of a page room, its close codes and its fixed limits. Pure code, used by the
// Worker (the gate and the room) and by tests; the page's client is the static runtime script.
// Nothing in a room persists: durable state belongs in shared data.
import { z } from "zod";
import type { EffectiveRole } from "./constants.ts";

// The handshake and close codes live in roomCodes.ts (no zod), so the doc renderer bundle can use
// them without carrying the schemas below.
export * from "./roomCodes.ts";

/**
 * <meta name="plinth-room-open" content="cursor note.move">: topics commenters may emit too
 * (owners and editors emit any topic; viewers never emit). `*` opens every topic.
 */
export const ROOM_OPEN_META = "plinth-room-open";
export const ROOM_OPEN_ALL = "*";

/** A topic a page emits: a lowercase letter, then up to 39 of a-z 0-9 _ . : - */
export const ROOM_TOPIC_RE = /^[a-z][a-z0-9_.:-]{0,39}$/;
/** A sub-room name: a lowercase letter, then up to 39 of a-z 0-9 _ - */
export const ROOM_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** The room `plinth.room` is before any `join`. */
export const ROOM_DEFAULT_NAME = "main";

/** Fixed room rules, not env vars (the env-var caps are ROOM_DEFAULTS). */
export const ROOM_LIMITS = {
  /** UTF-8 bytes of one socket's presence state in one room, as JSON. */
  presenceBytes: 400,
  /** Rooms (the main one included) one socket may have joined at once. */
  roomsPerConnection: 3,
  /** Sockets one viewer may hold on one artifact (tabs, devices). */
  socketsPerViewer: 8,
  /** Connects one viewer may make to one artifact per minute. */
  connectsPerViewerPerMinute: 20,
  /** Topics in a page's plinth-room-open tag. */
  maxOpenTopics: 16,
  /** A socket's hibernation attachment stays under the platform's 2 KiB limit. */
  attachmentBytes: 1900,
  /** Rate-limited messages within `rateDropWindowS` that close the socket (4429). */
  rateDropsToClose: 50,
  rateDropWindowS: 10,
  /** Presence updates a client sends per second at most (it keeps only the latest). */
  presencePerSecond: 10,
  /** A tab hidden this long closes its socket; it reconnects when visible again. */
  hiddenCloseS: 60,
  /** The client sends the literal text `ping` this often; the room answers `pong` asleep. */
  pingIntervalS: 30,
  /** While any socket is open, the room re-checks access in D1 this often. */
  recheckIntervalS: 60,
  /** Reconnect delays in seconds, with jitter; the last one repeats. */
  backoffS: [1, 2, 5, 10, 30],
} as const;

/** Env-var defaults for rooms (ROOM_* env vars) and their bounds. */
export const ROOM_DEFAULTS = {
  /** ROOM_MAX_CONNECTIONS_PER_ARTIFACT */
  maxConnectionsPerArtifact: 50,
  /** ROOM_MAX_MESSAGE_BYTES: one page-room frame. Doc frames use LIMITS.liveDocFrameBytes. */
  maxMessageBytes: 8192,
  /** ROOM_MESSAGES_PER_SECOND: per connection, with a burst of twice this. */
  messagesPerSecond: 20,
} as const;

export const ROOM_BOUNDS = {
  maxConnectionsPerArtifact: [2, 1000],
  maxMessageBytes: [512, 65536],
  messagesPerSecond: [1, 100],
} as const;

/**
 * Which topics a participant may emit: `all` for owners and editors, `open` (the page's
 * plinth-room-open topics) for commenters, `none` for viewers, who join, set presence and receive.
 */
export type RoomEmitRight = "all" | "open" | "none";

/** Why `plinth.room` is unavailable to a page (`room.ready` resolves with one of these). */
export type RoomUnavailableReason =
  | "opaque_isolation"
  | "disabled"
  | "not_configured"
  | "not_declared"
  | "preview"
  | "not_identified"
  | "expired"
  | "full"
  | "rate_limited"
  | "network";

/** Who a participant is, as the room stamps it. `role` and `email` only when the page may see them. */
export interface RoomIdentity {
  /** Random per socket: one person with two tabs is two peers with the same `viewer`. */
  id: string;
  /** The per-artifact `u_` viewer id. */
  viewer: string;
  role?: EffectiveRole;
  email?: string;
}

export interface RoomPeer extends RoomIdentity {
  presence: Record<string, unknown>;
}

/** GET /__plinth/api/v1/room. Always 200 once the caller checks pass; `available: false` says why. */
export type RoomInfo =
  | { available: false; reason: RoomUnavailableReason }
  | {
      available: true;
      reason: null;
      you: { viewer: string; role: EffectiveRole; email: string | null };
      can_emit: RoomEmitRight;
      open_topics: string[];
      limits: {
        max_message_bytes: number;
        messages_per_second: number;
        presence_bytes: number;
        rooms_per_connection: number;
      };
    };

// ---------- page-room frames (JSON text) ----------

const roomName = z.string().regex(ROOM_NAME_RE);
const topic = z.string().regex(ROOM_TOPIC_RE);
const presenceState = z.record(z.string().max(64), z.unknown());

/** What a page's client sends. Sizes are checked on the raw frame before parsing. */
export const roomClientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join"), room: roomName }),
  z.object({ t: z.literal("leave"), room: roomName }),
  z.object({ t: z.literal("presence"), room: roomName, state: presenceState.nullable() }),
  z.object({ t: z.literal("emit"), room: roomName, topic, data: z.unknown() }),
]);
export type RoomClientFrame = z.infer<typeof roomClientFrameSchema>;

export type RoomErrorCode =
  | "forbidden_topic"
  | "rate_limited"
  | "too_large"
  | "invalid"
  | "not_joined";

export type RoomServerFrame =
  | {
      t: "welcome";
      v: 1;
      you: RoomIdentity;
      limits: { max_message_bytes: number; messages_per_second: number; presence_bytes: number };
    }
  | { t: "peers"; room: string; peers: RoomPeer[] }
  | { t: "peer"; room: string; peer: RoomPeer }
  | { t: "gone"; room: string; id: string }
  | { t: "event"; room: string; topic: string; data: unknown; from: RoomIdentity }
  | { t: "error"; code: RoomErrorCode };

// ---------- pure helpers ----------

/**
 * A presence update applied to the previous state: a shallow merge where a `null` value deletes
 * its key, and a `null` patch clears everything.
 */
export function mergePresence(
  prev: Record<string, unknown>,
  patch: Record<string, unknown> | null,
): Record<string, unknown> {
  if (patch === null) return {};
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/**
 * May a participant emit this topic? `all` (owners and editors) any; `open` (commenters) only the
 * page's open topics; `none` (viewers) never.
 */
export function canEmitTopic(
  emit: RoomEmitRight,
  openTopics: readonly string[],
  t: string,
): boolean {
  if (!ROOM_TOPIC_RE.test(t) || emit === "none") return false;
  return emit === "all" || openTopics.includes(ROOM_OPEN_ALL) || openTopics.includes(t);
}
