// Live views on APP_HOST (docs/spec.md "Live views", docs/security.md#live-views): the app page
// opens GET /api/v1/view/:id/watch, a WebSocket upgrade served by the artifact's ArtifactRoom, and
// learns of new versions and shared-data changes without polling. The socket is receive-only and
// carries only version numbers and change signals.
//
// A WebSocket handshake is not subject to CORS, and the app's cookies ride on it, so cross-site
// WebSocket hijacking is the threat. The checks, in this order, are load-bearing:
//   1. method and upgrade: GET with Upgrade: websocket (a HEAD gets 405, a GET without Upgrade
//      426; other methods never reach this route, and the /api/v1 router refuses them);
//   2. Origin: present and exactly the app's origin. Absent and "null" are refused, and so is every
//      artifact: its frame's origin is its own content origin, or "null" under opaque isolation and
//      the path fallback;
//   3. fetch metadata, when sent: Sec-Fetch-Site same-origin, Sec-Fetch-Mode websocket;
//   4. the plinth.view.v1 subprotocol, a marker no plain page link or form can send;
//   5. no bearer token: agents never watch (they publish, and never pull);
//   6. live views active (ALLOW_LIVE_VIEWS and the ROOMS binding);
//   7. the artifact by id (never the slug, which can change): not deleted, not taken down, with a
//      version;
//   8. the gate's view decision (policy.ts, through decideFor) for the cookie principal, password
//      passes and viewer session `authenticate` resolved. Every refusal from 7 on is one identical
//      404, so the socket tells nobody more than the gate does;
//   9. policy.ts liveViewAccess.
// The room then gets a fresh internal request whose only custom header is built here; no client
// header is copied. Refusals log the status and a reason code only.
import { ARTIFACT_ID_RE, LIVE_VIEW_LIMITS, VIEW_WATCH_PROTOCOL } from "@plinth/shared";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { applyAppHeaders } from "../app/headers.ts";
import { type Config, liveViewsActive, sharedDataActive } from "../config.ts";
import { sessions, versions } from "../db/schema.ts";
import { appCookieName } from "../lib/cookies.ts";
import { hashToken, hmacHex, verifyToken } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";
import { liveViewAccess } from "../policy.ts";
import {
  ROOM_CONNECT_URL,
  WATCH_CONNECT_HEADER,
  type WatchConnect,
} from "../rooms/ArtifactRoom.ts";
import { decideFor, findArtifact, versionCapabilities } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { type AppContext, type AppEnv, type PasswordPassPayload, serviceCtx } from "./context.ts";

function refuse(
  config: Config,
  status: number,
  reason: string,
  extra: Record<string, string> = {},
) {
  console.log(`watch refused: ${status} ${reason}`);
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", ...extra });
  applyAppHeaders(config, headers);
  headers.set("Cache-Control", "no-store");
  return new Response(`${reason}\n`, { status, headers });
}

function offersProtocol(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((p) => p.trim() === VIEW_WATCH_PROTOCOL);
}

/**
 * Checks 1 to 5, before any cookie is read or any principal resolved: they need only the request.
 * Runs ahead of `authenticate`, so a bearer token is refused here rather than resolved.
 */
export const watchPreflight: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.get("config");
  const h = (k: string) => c.req.header(k);
  // 1. Method and upgrade.
  if (c.req.method !== "GET") return refuse(config, 405, "method", { Allow: "GET" });
  if (h("upgrade")?.toLowerCase() !== "websocket") {
    return refuse(config, 426, "upgrade_required", { Upgrade: "websocket" });
  }
  // 2. Origin: exactly the app's own; absent and "null" are refused.
  if (h("origin") !== config.appOrigin) return refuse(config, 403, "origin");
  // 3. Fetch metadata, when sent.
  const site = h("sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return refuse(config, 403, "cross_site");
  const mode = h("sec-fetch-mode");
  if (mode !== undefined && mode !== "websocket") return refuse(config, 403, "fetch_mode");
  // 4. Subprotocol.
  if (!offersProtocol(h("sec-websocket-protocol"))) return refuse(config, 400, "protocol");
  // 5. No bearer token.
  if (h("authorization") !== undefined) return refuse(config, 403, "bearer");
  await next();
};

/**
 * Who is connecting, as 16 hex characters: an HMAC (keyed by TOKEN_SIGNING_KEY, per artifact) of
 * the account, the confirmed email or the address. The raw value is never stored or logged.
 */
async function clientKey(ctx: Ctx, artifactId: string): Promise<string> {
  const p = ctx.principal;
  const who =
    p.kind === "user"
      ? `user:${p.userId}`
      : p.kind === "viewer"
        ? `viewer:${p.email}`
        : `ip:${ctx.ip ?? "unknown"}`;
  const mac = await hmacHex(
    ctx.config.tokenSigningKey,
    `plinth watch client v1|${artifactId}|${who}`,
  );
  return mac.slice(0, 16);
}

/**
 * When the earliest credential this request opened the socket with expires (ms since the epoch), or
 * null when it carries none: the app session or viewer session `authenticate` resolved, and the
 * password pass for this artifact at its current epoch. The socket never outlives it: the room
 * closes it then (4401 `expired`) and the app's reconnect is decided again with what the browser
 * still holds. Counting every credential present, not only the one the decision needed, can only
 * close a socket early, which costs one reconnect.
 */
async function credentialExpiry(
  c: AppContext,
  ctx: Ctx,
  a: { id: string; accessEpoch: number },
): Promise<number | null> {
  const { config } = ctx;
  const cookies = c.get("cookies");
  const times: number[] = [];
  const ids: string[] = [];
  const session = cookies.get(appCookieName(config, "session"));
  if (session && ctx.principal.kind === "user") ids.push(await hashToken(session));
  const viewer = cookies.get(appCookieName(config, "viewer"));
  if (viewer && (ctx.viewerEmail || ctx.principal.kind === "viewer")) {
    ids.push(await hashToken(viewer));
  }
  if (ids.length) {
    const rows = await ctx.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(inArray(sessions.id, ids), gt(sessions.expiresAt, nowIso())))
      .all();
    for (const r of rows) {
      const t = Date.parse(r.expiresAt);
      if (Number.isFinite(t)) times.push(t);
    }
  }
  if (ctx.passwordPasses.get(a.id) === a.accessEpoch) {
    const name = `${appCookieName(config, "passwordPassPrefix")}${a.id}`;
    const value = cookies.get(name);
    const pass = value
      ? await verifyToken<PasswordPassPayload>(config.tokenSigningKey, value, "pw")
      : null;
    if (pass && pass.a === a.id) times.push(pass.exp);
  }
  return times.length ? Math.min(...times) : null;
}

/** Checks 6 to 9, then the room. */
export async function serveViewWatch(c: AppContext): Promise<Response> {
  const config = c.get("config");
  try {
    return await upgrade(c);
  } catch (e) {
    console.error("watch error:", e instanceof Error ? e.message : "unknown");
    return refuse(config, 500, "error");
  }
}

async function upgrade(c: AppContext): Promise<Response> {
  const ctx = serviceCtx(c);
  const { config, env } = ctx;
  // 6. Live views active.
  if (!liveViewsActive(config, env)) return refuse(config, 404, "unavailable");
  // 7. The artifact, by id.
  const ref = c.req.param("ref") ?? "";
  const a = ARTIFACT_ID_RE.test(ref) ? await findArtifact(ctx, ref) : null;
  if (!a || a.takenDownAt || a.currentVersion < 1) return refuse(config, 404, "not_found");
  // 8. The view decision, as the gate takes it. Any refusal is the same 404.
  const d = await decideFor(ctx, a, "view");
  if (!d.allow) return refuse(config, 404, "not_found");
  // 9. Policy, with the current version's declaration (it decides the data right).
  const row = await ctx.db
    .select({ capabilities: versions.capabilities })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  const access = liveViewAccess(ctx.principal, d, versionCapabilities(row), {
    active: true,
    sharedData: sharedDataActive(config),
    type: a.type,
  });
  if (!access.watch) return refuse(config, 404, "not_found");

  // The socket lives a content pass's lifetime, and never past the credential that opened it.
  const lifetime = Date.now() + LIVE_VIEW_LIMITS.socketTtlS * 1000;
  const credential = await credentialExpiry(c, ctx, a);
  const connect: WatchConnect = {
    artifactId: a.id,
    kind: "watch",
    epoch: a.accessEpoch,
    passExp: credential === null ? lifetime : Math.min(lifetime, credential),
    version: a.currentVersion,
    data: access.data,
    client: await clientKey(ctx, a.id),
    limits: { maxSockets: config.liveViews.maxSocketsPerArtifact },
  };
  // biome-ignore lint/style/noNonNullAssertion: liveViewsActive checked the binding
  const ns = env.ROOMS!;
  const res = await ns.get(ns.idFromName(a.id)).fetch(
    new Request(ROOM_CONNECT_URL, {
      headers: { Upgrade: "websocket", [WATCH_CONNECT_HEADER]: JSON.stringify(connect) },
    }),
  );
  if (res.status !== 101 || !res.webSocket) {
    await res.body?.cancel();
    return refuse(config, res.status >= 400 && res.status < 500 ? res.status : 503, "room");
  }
  // The app's own headers on the 101, so the outer fetch handler returns it as it is.
  const headers = new Headers({ "Sec-WebSocket-Protocol": VIEW_WATCH_PROTOCOL });
  applyAppHeaders(config, headers);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 101, webSocket: res.webSocket, headers });
}
