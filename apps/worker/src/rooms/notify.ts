// Telling an artifact's live room that access or the declaration changed (#36). Best effort, after
// the response (waitUntil), with one retry: the room's 60 s alarm re-checks D1 and closes what a
// lost call left open. Only artifacts that can have sockets are notified: with live views off, a
// doc, a deck (its follow channel) or an HTML artifact whose current or previous version declares
// `room`, so ordinary artifacts never instantiate an object; with live views on, every artifact,
// since anyone who opens one may hold a watch socket on it. Failures are logged with the operation
// only, never content.
//
// Live views (notifyViewers): a new version, or a change to the page's shared data, reaches the
// artifact's watch sockets the same way, as a signal made of integers and nothing else.
import { type Capabilities, typeDef } from "@plinth/shared";
import {
  type Bindings,
  type Config,
  liveEditMode,
  liveViewsActive,
  roomsActive,
} from "../config.ts";
import { roomOpenTopics } from "../policy.ts";
import { versionCapabilities } from "../services/artifacts.ts";

export type RoomOp = "revoke" | "gone" | "redeclare";

interface NotifyCtx {
  env: Bindings;
  config: Config;
  waitUntil: (p: Promise<unknown>) => void;
}

/**
 * What a version declares about rooms, as one comparable value: null when it declares no room.
 * Two versions with the same value admit the same sockets with the same rights, so a new version
 * alone causes no reconnects. The open topics are the effective ones (policy.ts roomOpenTopics),
 * so a whiteboard's settings version that lets only editors change it differs from the one
 * before, and its sockets reconnect with their new rights as soon as it commits.
 */
export function roomDeclaration(
  caps:
    | (Pick<Capabilities, "room" | "viewer" | "roomOpen"> & Pick<Partial<Capabilities>, "writers">)
    | null,
): string | null {
  if (caps?.room !== true) return null;
  return JSON.stringify({ viewer: caps.viewer, open: [...new Set(roomOpenTopics(caps))].sort() });
}

/** The artifact's type, epoch and the declarations of its current and previous versions. */
async function loadRoomFacts(env: Bindings, artifactId: string) {
  const row = await env.DB.prepare(
    `SELECT a.type, a.access_epoch,
            (SELECT capabilities FROM versions WHERE artifact_id = a.id AND number = a.current_version) AS cur,
            (SELECT capabilities FROM versions WHERE artifact_id = a.id AND number = a.current_version - 1) AS prev
       FROM artifacts a WHERE a.id = ?1`,
  )
    .bind(artifactId)
    .first<{ type: string; access_epoch: number; cur: string | null; prev: string | null }>();
  if (!row) return null;
  return {
    type: row.type,
    epoch: row.access_epoch,
    cur: versionCapabilities({ capabilities: row.cur }),
    prev: versionCapabilities({ capabilities: row.prev }),
  };
}

/**
 * Whether the artifact's object may hold sockets: watch sockets on every artifact while live views
 * are active, room sockets on a doc, on a type with `follow` (a deck's follow channel, which has no
 * declaration to redeclare), or on a page whose current or previous version declares `room`.
 */
function mayHaveSockets(
  facts: NonNullable<Awaited<ReturnType<typeof loadRoomFacts>>>,
  ctx: NotifyCtx,
): boolean {
  if (liveViewsActive(ctx.config, ctx.env)) return true;
  const def = typeDef(facts.type);
  if (def?.liveEdit || def?.follow) return true;
  return facts.cur?.room === true || facts.prev?.room === true;
}

async function call(env: Bindings, artifactId: string, op: RoomOp, epoch: number): Promise<void> {
  const ns = env.ROOMS;
  if (!ns) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stub = ns.get(ns.idFromName(artifactId));
      if (op === "revoke") await stub.revoke(epoch);
      else if (op === "gone") await stub.gone();
      else await stub.redeclare();
      return;
    } catch {
      // Retried once; the alarm is the backstop.
    }
  }
  console.error(`room notify failed: ${op}`);
}

/**
 * After a sharing change (revoke, with the artifact's new epoch), a delete or takedown (gone), or
 * a version that changed the room declaration (redeclare). A no-op while neither rooms nor live
 * views are active; a redeclare only concerns page rooms.
 */
export function notifyRoom(ctx: NotifyCtx, artifactId: string, op: RoomOp): void {
  const rooms = roomsActive(ctx.config, ctx.env);
  if (!rooms && (op === "redeclare" || !liveViewsActive(ctx.config, ctx.env))) return;
  ctx.waitUntil(
    (async () => {
      try {
        const facts = await loadRoomFacts(ctx.env, artifactId);
        if (!facts || !mayHaveSockets(facts, ctx)) return;
        await call(ctx.env, artifactId, op, facts.epoch);
      } catch {
        console.error(`room notify failed: ${op}`);
      }
    })(),
  );
}

/**
 * After version `n` of an HTML page or a whiteboard committed (a type with page capabilities, its
 * restores included): page sockets reconnect only when what the
 * version declares about rooms differs from version n - 1.
 */
export function notifyVersion(
  ctx: NotifyCtx,
  artifactId: string,
  n: number,
  capabilities: string | null,
): void {
  if (n < 2 || !roomsActive(ctx.config, ctx.env)) return;
  ctx.waitUntil(
    (async () => {
      try {
        const prev = await ctx.env.DB.prepare(
          "SELECT capabilities FROM versions WHERE artifact_id = ?1 AND number = ?2",
        )
          .bind(artifactId, n - 1)
          .first<{ capabilities: string | null }>();
        const before = roomDeclaration(versionCapabilities(prev));
        const after = roomDeclaration(versionCapabilities({ capabilities }));
        if (before === after) return;
        await call(ctx.env, artifactId, "redeclare", 0);
      } catch {
        console.error("room notify failed: redeclare");
      }
    })(),
  );
}

/**
 * After version `n` of a doc committed (an agent, the source editor, a restore or a checkpoint):
 * its room merges the live draft onto it, or freezes the draft for review, and open pages follow.
 * `hash` is the version's content.md sha256, which lets the room recognize its own checkpoint.
 * Only while on-page editing runs with rooms; a draft left from before is rebased when it loads.
 */
export function notifyDocVersion(
  ctx: NotifyCtx,
  artifactId: string,
  n: number,
  hash: string | null,
): void {
  if (liveEditMode(ctx.config, ctx.env) !== "room") return;
  const ns = ctx.env.ROOMS;
  if (!ns) return;
  ctx.waitUntil(
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await ns.get(ns.idFromName(artifactId)).docVersion(artifactId, n, hash);
          return;
        } catch {
          // Retried once.
        }
      }
      console.error("room notify failed: version");
    })(),
  );
}

/** What a live-view notify tells the watch sockets: a new version, or a change to shared data. */
export type ViewerSignal = { version: number; data: boolean } | "data";

/**
 * Live views (docs/spec.md "Live views"): after version `n` committed (`{ version, data }`, `data`
 * whether it declares `data`), or after the page's shared data changed (`"data"`), the artifact's
 * watch sockets get the signal. Best effort, after the response, with one retry: the room's alarm
 * re-sends a lost version within a minute, and the page runtime's backstop poll catches a lost data
 * signal. A no-op while live views are not active; nothing but the signal reaches the room.
 */
export function notifyViewers(ctx: NotifyCtx, artifactId: string, signal: ViewerSignal): void {
  if (!liveViewsActive(ctx.config, ctx.env)) return;
  const ns = ctx.env.ROOMS;
  if (!ns) return;
  const op = signal === "data" ? "data" : "published";
  ctx.waitUntil(
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stub = ns.get(ns.idFromName(artifactId));
          if (signal === "data") await stub.dataChanged();
          else await stub.published(signal.version, signal.data);
          return;
        } catch {
          // Retried once; the alarm and the runtime's backstop poll cover a loss.
        }
      }
      console.error(`viewer notify failed: ${op}`);
    })(),
  );
}
