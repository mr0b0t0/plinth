// Live rooms on an artifact's own content origin (#36, docs/security.md#live-rooms).
//
// /__plinth/room/v1/page (an HTML page that declares `room`) and /__plinth/room/v1/doc (Plinth's
// own doc editing channel) upgrade to a WebSocket served by the artifact's Durable Object. Every
// framed artifact shares one partitioned SameSite=None cookie jar, so a sibling artifact's
// `new WebSocket()` would carry this artifact's content cookie: a WebSocket handshake is not
// subject to CORS, and cross-site WebSocket hijacking is the threat. The checks, in this order,
// are load-bearing:
//   1. method: GET with Upgrade: websocket; OPTIONS and the rest get 405, a GET without Upgrade
//      426, and no response here ever carries an Access-Control-* header;
//   2. Origin: present and exactly this artifact's content origin. Browsers always send it on a
//      handshake and page script cannot forge it, so a sibling artifact, the app or "null" is
//      refused;
//   3. fetch metadata, when sent: Sec-Fetch-Site same-origin, Sec-Fetch-Mode websocket;
//   4. the plinth.room.v1 subprotocol (Sec-WebSocket-Protocol), the non-safelisted marker in place
//      of the data API's custom header, which the browser WebSocket API cannot send;
//   5. rooms active (ALLOW_ROOMS, the ROOMS binding, origin isolation) on an artifact subdomain;
//   6. the artifact: not deleted, not taken down;
//   7. the content pass at the current epoch, with an identity claim; preview and capture passes
//      never join. It comes before the kind check, so a caller without a pass learns no more than
//      the content path tells them (that the artifact exists), never its type or declaration;
//   8. the kind the path names (an HTML page that declares `room`, or a doc, which also needs
//      ALLOW_LIVE_EDITING);
//   9. policy (policy.ts roomAccess).
// The room then gets a fresh internal request whose only header is the one built here; no client
// header is copied. Only the status and a reason code are logged, never bodies.
//
// GET /__plinth/api/v1/room (served through the data API's caller checks, content/data-api.ts)
// tells the page's runtime whether it may join, before it opens a socket.
import {
  type ArtifactType,
  hasPageCapabilities,
  ROOM_LIMITS,
  ROOM_PATH_PREFIX,
  ROOM_PROTOCOL,
  type RoomInfo,
  type RoomKind,
  type RoomUnavailableReason,
  typeDef,
} from "@plinth/shared";
import { type Bindings, type Config, contentOrigin, liveEditMode, roomsActive } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { roomAccess } from "../policy.ts";
import {
  encodeConnect,
  ROOM_CONNECT_HEADER,
  ROOM_CONNECT_URL,
  type RoomConnect,
} from "../rooms/ArtifactRoom.ts";
import { versionCapabilities } from "../services/artifacts.ts";
import { namesByEmail } from "../services/users.ts";
import { applyContentHeaders } from "./csp.ts";
import type { HostRoute } from "./serve.ts";
import { readContentPass } from "./serve.ts";

/** Everything under it is a room upgrade; nothing there is ever an artifact file. */
export const ROOM_PREFIX = "/__plinth/room/";

/** The artifact's own WebSocket origin, for connect-src while rooms are active. */
export function roomSocketSource(config: Config, artifactId: string): string {
  return `${config.scheme === "http" ? "ws" : "wss"}://${artifactId}.${config.contentHost}`;
}

/** Why rooms are off on this instance, before anything about the artifact is read. */
export function roomUnavailableReason(
  config: Config,
  env: Bindings,
): Extract<RoomUnavailableReason, "disabled" | "opaque_isolation" | "not_configured"> | null {
  if (!config.allowRooms) return "disabled";
  if (config.contentIsolation !== "origin") return "opaque_isolation";
  if (!env.ROOMS) return "not_configured";
  return null;
}

interface RoomTarget {
  id: string;
  type: ArtifactType;
  accessEpoch: number;
  caps: ReturnType<typeof versionCapabilities>;
}

/** The live artifact with its current version's declaration, or null (deleted, taken down). */
async function loadRoomTarget(env: Bindings, artifactId: string): Promise<RoomTarget | null> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.type, a.access_epoch, a.taken_down_at, v.capabilities
       FROM artifacts a
       LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
      WHERE a.id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(artifactId)
    .first<{
      id: string;
      type: string;
      access_epoch: number;
      taken_down_at: string | null;
      capabilities: string | null;
    }>();
  if (!row || row.taken_down_at) return null;
  const def = typeDef(row.type);
  if (!def) return null;
  return {
    id: row.id,
    type: def.id,
    accessEpoch: row.access_epoch,
    caps: versionCapabilities(row),
  };
}

/** One person's display name, as pages see it (displayName.ts), or null. */
async function nameOf(env: Bindings, email: string): Promise<string | null> {
  return (await namesByEmail(env.DB, [email])).get(email) ?? null;
}

/** The room part of GET /__plinth/api/v1/room, after the data API's caller checks passed. */
export async function roomInfo(
  request: Request,
  env: Bindings,
  config: Config,
  artifactId: string,
): Promise<RoomInfo> {
  const off = roomUnavailableReason(config, env);
  if (off) return { available: false, reason: off };
  const target = await loadRoomTarget(env, artifactId);
  if (!target) throw new ApiError("not_found", "Not found");
  const pass = await readContentPass(request, config, target);
  if (!pass) {
    throw new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }
  if (pass.preview) return { available: false, reason: "preview" };
  if (pass.capture || !pass.claim) return { available: false, reason: "not_identified" };
  if (!hasPageCapabilities(typeDef(target.type)) || target.caps?.room !== true) {
    return { available: false, reason: "not_declared" };
  }
  const access = roomAccess(pass.claim, target.caps, "page", {
    active: roomsActive(config, env),
    type: target.type,
  });
  if (!access.join) return { available: false, reason: "not_identified" };
  return {
    available: true,
    reason: null,
    you: {
      viewer: pass.claim.viewerId,
      role: pass.claim.role,
      email: access.seeIdentity ? pass.claim.email : null,
      name: access.seeIdentity ? await nameOf(env, pass.claim.email) : null,
    },
    can_emit: access.emit,
    open_topics: access.openTopics,
    limits: {
      max_message_bytes: config.rooms.maxMessageBytes,
      messages_per_second: config.rooms.messagesPerSecond,
      presence_bytes: ROOM_LIMITS.presenceBytes,
      rooms_per_connection: ROOM_LIMITS.roomsPerConnection,
    },
  };
}

function refuse(
  config: Config,
  status: number,
  reason: string,
  extra: Record<string, string> = {},
): Response {
  console.log(`room upgrade refused: ${status} ${reason}`);
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", ...extra });
  applyContentHeaders(config, headers);
  headers.set("Cache-Control", "no-store");
  return new Response(`${reason}\n`, { status, headers });
}

/** The kind of room a path names, or null for anything else under the prefix. */
function kindOf(path: string): RoomKind | null {
  if (path === `${ROOM_PATH_PREFIX}page`) return "page";
  if (path === `${ROOM_PATH_PREFIX}doc`) return "doc";
  return null;
}

function offersProtocol(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((p) => p.trim() === ROOM_PROTOCOL);
}

/** The upgrade gate. Every refusal is a plain 4xx with the content headers. */
export async function serveRoomUpgrade(
  request: Request,
  env: Bindings,
  config: Config,
  route: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  try {
    return await upgrade(request, env, config, route);
  } catch (e) {
    console.error("room upgrade error:", e instanceof Error ? e.message : "unknown");
    return refuse(config, 500, "error");
  }
}

async function upgrade(
  request: Request,
  env: Bindings,
  config: Config,
  { artifactId, path, base }: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  const h = request.headers;
  // 1. Method.
  if (request.method !== "GET") return refuse(config, 405, "method", { Allow: "GET" });
  if (h.get("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(config, 426, "upgrade_required", { Upgrade: "websocket" });
  }
  // 2. Origin: exactly this artifact's own; absent and "null" are refused.
  if (h.get("origin") !== contentOrigin(config, artifactId)) return refuse(config, 403, "origin");
  // 3. Fetch metadata, when sent.
  const site = h.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return refuse(config, 403, "cross_site");
  const mode = h.get("sec-fetch-mode");
  if (mode !== null && mode !== "websocket") return refuse(config, 403, "fetch_mode");
  // 4. Subprotocol.
  if (!offersProtocol(h.get("sec-websocket-protocol"))) return refuse(config, 400, "protocol");
  // 5. Rooms active, on an artifact's own subdomain (never the path fallback).
  const kind = kindOf(path);
  if (!roomsActive(config, env) || base !== "" || !kind) return refuse(config, 404, "unavailable");
  // 6. The artifact.
  const target = await loadRoomTarget(env, artifactId);
  if (!target) return refuse(config, 404, "gone");
  // 7. The content pass, identified, at the current epoch: before anything about the artifact's
  // type or declaration is told apart.
  const pass = await readContentPass(request, config, target);
  if (!pass) return refuse(config, 401, "expired");
  if (pass.preview) return refuse(config, 403, "preview");
  if (pass.capture || !pass.claim) return refuse(config, 403, "not_identified");
  // 8. The path matching the type. A doc socket also needs on-page editing on
  // (ALLOW_LIVE_EDITING).
  const fits =
    kind === "page"
      ? hasPageCapabilities(typeDef(target.type)) && target.caps?.room === true
      : typeDef(target.type)?.liveEdit === true && liveEditMode(config, env) === "room";
  if (!fits) return refuse(config, 404, "not_declared");
  // 9. Policy.
  const access = roomAccess(pass.claim, target.caps, kind, { active: true, type: target.type });
  if (!access.join) return refuse(config, 403, "forbidden");
  // The display name, read live only for a socket whose identity peers may see on a page room
  // (a refused upgrade never reads it; a doc socket shows emails only). A rename reaches the room
  // on the next connect.
  const name = kind === "page" && access.seeIdentity ? await nameOf(env, pass.claim.email) : null;

  const connect: RoomConnect = {
    artifactId,
    type: target.type,
    kind,
    epoch: target.accessEpoch,
    passExp: pass.exp,
    viewer: pass.claim.viewerId,
    role: pass.claim.role,
    email: pass.claim.email,
    name,
    seeIdentity: access.seeIdentity,
    emit: access.emit,
    openTopics: access.openTopics,
    doc: access.doc,
    limits: {
      maxConnections: config.rooms.maxConnectionsPerArtifact,
      maxMessageBytes: config.rooms.maxMessageBytes,
      messagesPerSecond: config.rooms.messagesPerSecond,
    },
  };
  // biome-ignore lint/style/noNonNullAssertion: roomsActive checked the binding
  const ns = env.ROOMS!;
  const res = await ns.get(ns.idFromName(artifactId)).fetch(
    new Request(ROOM_CONNECT_URL, {
      headers: { Upgrade: "websocket", [ROOM_CONNECT_HEADER]: encodeConnect(connect) },
    }),
  );
  if (res.status !== 101 || !res.webSocket) {
    await res.body?.cancel();
    return refuse(config, res.status >= 400 && res.status < 500 ? res.status : 503, "room");
  }
  const headers = new Headers({ "Sec-WebSocket-Protocol": ROOM_PROTOCOL });
  applyContentHeaders(config, headers);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 101, webSocket: res.webSocket, headers });
}
