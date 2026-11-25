// Mention wake-ups (docs/spec.md "Mention wake-ups"): watches bring @mentions to the agent session
// that should act on them, with no subscribe step for the user.
//
// A watch is a session waiting for requests. An agent starts a task watch with watch_mentions right
// after it publishes (an MCP task its client polls with tasks/get; when the task completes, an idle
// client starts a turn on it). The mention relay on the user's computer starts relay watches for
// sessions in clients that have no MCP tasks (Codex, Cursor, Copilot, Claude Code hosts without
// tasks) and wakes them its own way. Both kinds are routed here, by one rule:
//
//   a pending mention is offered to one live watch at a time: the best watch that hears it (on its
//   artifact before one on every artifact, a task before a relay, the newest first), never twice to
//   the same watch, at most MENTION_WATCH.maxOffers times, and again to the next watch once an offer
//   lapses (TTL.mentionOfferMs) without a claim_mention.
//
// Offers are decided lazily, when a watch polls, so nothing runs in the background: a Worker
// request reads the pending mentions its watch hears and takes the ones it is the best live watch
// for, with a conditional UPDATE so two polls never take one mention. What a wake-up carries is ids
// only (task and artifact ids, and a fixed sentence the server writes): the agent reads the request
// itself with list_mentions or claim_mention, whose output says it is untrusted.
import {
  type ClientType,
  MENTION_WATCH,
  type MentionDelivery,
  type MentionWatchInfo,
  type MentionWatchPoll,
  TTL,
} from "@plinth/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { artifacts, type MentionWatchRow, mentionTasks, mentionWatches } from "../db/schema.ts";
import { randomString } from "../lib/crypto.ts";
import { ApiError, notFound, unauthorized } from "../lib/errors.ts";
import { mayWatchMentions, ownsWatch, type Principal, watchHears } from "../policy.ts";
import { findArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

type AgentPrincipal = Extract<Principal, { kind: "agent" }>;
type WatchKind = MentionWatchRow["kind"];

/** One mention handed to a watch: ids only. */
export interface MentionOffer {
  task_id: string;
  artifact_id: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A pending mention's delivery for people reading the thread: sent to a session, or waiting. */
export function deliveryOf(
  t: { state: string; offeredUntil: string | null },
  now = Date.now(),
): MentionDelivery | null {
  if (t.state !== "pending") return null;
  return t.offeredUntil && t.offeredUntil > iso(now) ? "sent" : "waiting";
}

function requireAgent(ctx: Ctx): AgentPrincipal {
  const p = ctx.principal;
  if (p.kind === "anonymous") throw unauthorized();
  if (p.kind !== "agent") {
    throw new ApiError("forbidden", "Mention watches are started by agent connections, not people");
  }
  return p;
}

/** A watch id: as unguessable as a token, since the MCP tasks extension treats task ids as handles. */
const watchId = () => `mw_${randomString(32)}`;

/** The watch this connection started, or not found (whoever else's it is). */
async function ownWatch(ctx: Ctx, id: string): Promise<MentionWatchRow> {
  const row = await ctx.db.select().from(mentionWatches).where(eq(mentionWatches.id, id)).get();
  if (!row || !ownsWatch(ctx.principal, row)) throw notFound("Mention watch");
  return row;
}

function info(w: MentionWatchRow): MentionWatchInfo {
  return {
    id: w.id,
    kind: w.kind,
    artifact_id: w.artifactId,
    client_type: w.clientType,
    status: w.status,
    created_at: w.createdAt,
    expires_at: w.expiresAt,
  };
}

/**
 * The artifact a watch is for: the caller's own, live. Requests on an artifact go to its owner's
 * agents only, so watching someone else's would never hear one.
 */
async function ownArtifact(ctx: Ctx, p: AgentPrincipal, ref: string) {
  const a = await findArtifact(ctx, ref);
  if (!a || a.takenDownAt) throw notFound();
  if (a.ownerId !== p.userId) {
    throw new ApiError(
      "forbidden",
      "Requests on this artifact go to its owner's agents, so only the owner's agents can watch it",
    );
  }
  return a;
}

/** End the oldest working watches of a connection past its cap ("made room for a newer watch"). */
async function makeRoom(ctx: Ctx, connectionId: string, kind: WatchKind, now: number) {
  const cap =
    kind === "task"
      ? MENTION_WATCH.maxTaskWatchesPerConnection
      : MENTION_WATCH.maxRelayWatchesPerConnection;
  const working = await ctx.db
    .select({ id: mentionWatches.id })
    .from(mentionWatches)
    .where(
      and(
        eq(mentionWatches.connectionId, connectionId),
        eq(mentionWatches.kind, kind),
        eq(mentionWatches.status, "working"),
      ),
    )
    .orderBy(desc(mentionWatches.createdAt))
    .all();
  const over = working.slice(cap - 1).map((w) => w.id);
  if (over.length === 0) return;
  await ctx.db
    .update(mentionWatches)
    .set({ status: "cancelled", completedAt: iso(now) })
    .where(and(inArray(mentionWatches.id, over), eq(mentionWatches.status, "working")))
    .run();
}

/**
 * watch_mentions as an MCP task: a task watch on one of the caller's artifacts. A newer task watch
 * of the same connection on the same artifact replaces the older one, which ends cancelled (a
 * client does not start a turn for a cancelled task), as Claude's own artifact watches make room
 * for a newer one.
 */
export async function startTaskWatch(ctx: Ctx, artifactRef: string): Promise<MentionWatchRow> {
  const p = requireAgent(ctx);
  if (!mayWatchMentions(p, "task", p.clientType)) {
    throw new ApiError(
      "forbidden",
      "This connection can't receive mentions: it needs the mentions scope and must not be limited to one artifact",
    );
  }
  const artifact = await ownArtifact(ctx, p, artifactRef);
  const now = Date.now();
  const connectionId = p.connectionId as string;
  await ctx.db
    .update(mentionWatches)
    .set({ status: "cancelled", completedAt: iso(now) })
    .where(
      and(
        eq(mentionWatches.connectionId, connectionId),
        eq(mentionWatches.kind, "task"),
        eq(mentionWatches.artifactId, artifact.id),
        eq(mentionWatches.status, "working"),
      ),
    )
    .run();
  await makeRoom(ctx, connectionId, "task", now);
  const row: MentionWatchRow = {
    id: watchId(),
    userId: p.userId,
    connectionId,
    kind: "task",
    artifactId: artifact.id,
    clientType: p.clientType,
    status: "working",
    createdAt: iso(now),
    lastSeenAt: iso(now),
    expiresAt: iso(now + MENTION_WATCH.taskLifetimeMs),
    completedAt: null,
    result: null,
  };
  await ctx.db.insert(mentionWatches).values(row).run();
  return row;
}

/** POST /api/v1/mention-watches: the relay listens for one session (or every artifact). */
export async function startRelayWatch(
  ctx: Ctx,
  input: { artifact_id: string | null; client_type: ClientType },
): Promise<MentionWatchInfo> {
  const p = requireAgent(ctx);
  if (!mayWatchMentions(p, "relay", input.client_type)) {
    throw new ApiError(
      "forbidden",
      p.scopes.has("mentions")
        ? `This connection hears only @${p.clientType === "other" ? "agent:other" : p.clientType} mentions; connect the relay again to hear the others`
        : "This token lacks the mentions:watch scope",
    );
  }
  const artifact = input.artifact_id ? await ownArtifact(ctx, p, input.artifact_id) : null;
  const now = Date.now();
  const connectionId = p.connectionId as string;
  await makeRoom(ctx, connectionId, "relay", now);
  const row: MentionWatchRow = {
    id: watchId(),
    userId: p.userId,
    connectionId,
    kind: "relay",
    artifactId: artifact?.id ?? null,
    clientType: input.client_type,
    status: "working",
    createdAt: iso(now),
    lastSeenAt: iso(now),
    expiresAt: iso(now + MENTION_WATCH.relayIdleMs),
    completedAt: null,
    result: null,
  };
  await ctx.db.insert(mentionWatches).values(row).run();
  return info(row);
}

/** DELETE /api/v1/mention-watches/:id and tasks/cancel: the watch ends, nothing more is offered. */
export async function cancelWatch(ctx: Ctx, id: string): Promise<MentionWatchRow> {
  requireAgent(ctx);
  const w = await ownWatch(ctx, id);
  if (w.status !== "working") return w;
  const now = iso(Date.now());
  await ctx.db
    .update(mentionWatches)
    .set({ status: "cancelled", completedAt: now })
    .where(and(eq(mentionWatches.id, id), eq(mentionWatches.status, "working")))
    .run();
  return { ...w, status: "cancelled", completedAt: now };
}

/** Pending mentions this watch could be offered now (its own live offers included). */
async function candidates(ctx: Ctx, w: MentionWatchRow, now: number) {
  const nowIso = iso(now);
  const target: SQL | undefined =
    w.kind === "task"
      ? or(
          and(
            isNull(mentionTasks.targetConnection),
            eq(mentionTasks.targetClientType, w.clientType),
          ),
          eq(mentionTasks.targetConnection, w.connectionId),
        )
      : and(isNull(mentionTasks.targetConnection), eq(mentionTasks.targetClientType, w.clientType));
  const mine = and(eq(mentionTasks.offeredTo, w.id), gt(mentionTasks.offeredUntil, nowIso));
  const open = and(
    or(isNull(mentionTasks.offeredUntil), lt(mentionTasks.offeredUntil, nowIso)),
    lt(mentionTasks.offerCount, MENTION_WATCH.maxOffers),
    sql`NOT EXISTS (SELECT 1 FROM json_each(${mentionTasks.offeredWatches}) WHERE json_each.value = ${w.id})`,
  );
  return ctx.db
    .select({
      id: mentionTasks.id,
      artifactId: mentionTasks.artifactId,
      targetConnection: mentionTasks.targetConnection,
      targetClientType: mentionTasks.targetClientType,
      offeredTo: mentionTasks.offeredTo,
      offeredUntil: mentionTasks.offeredUntil,
      offeredWatches: mentionTasks.offeredWatches,
      ownerId: artifacts.ownerId,
    })
    .from(mentionTasks)
    .innerJoin(artifacts, eq(artifacts.id, mentionTasks.artifactId))
    .where(
      and(
        eq(mentionTasks.state, "pending"),
        eq(artifacts.ownerId, w.userId),
        isNull(artifacts.deletedAt),
        isNull(artifacts.takenDownAt),
        w.artifactId ? eq(mentionTasks.artifactId, w.artifactId) : undefined,
        target,
        or(mine, open),
      ),
    )
    .orderBy(asc(mentionTasks.createdAt), sql`${mentionTasks}.rowid`)
    .limit(MENTION_WATCH.maxOffersPerWake)
    .all();
}

/** Better first: on its artifact before on all, a task before a relay, the newest first. */
function rank(a: MentionWatchRow, b: MentionWatchRow): number {
  const specific = Number(b.artifactId !== null) - Number(a.artifactId !== null);
  if (specific) return specific;
  const task = Number(b.kind === "task") - Number(a.kind === "task");
  if (task) return task;
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** The user's live working watches that could hear mentions on these artifacts. */
async function liveWatches(ctx: Ctx, userId: string, artifactIds: string[], now: number) {
  return ctx.db
    .select()
    .from(mentionWatches)
    .where(
      and(
        eq(mentionWatches.userId, userId),
        eq(mentionWatches.status, "working"),
        gt(mentionWatches.lastSeenAt, iso(now - MENTION_WATCH.liveMs)),
        gt(mentionWatches.expiresAt, iso(now)),
        or(isNull(mentionWatches.artifactId), inArray(mentionWatches.artifactId, artifactIds)),
      ),
    )
    .all();
}

/**
 * Poll one watch: note that it is alive, then take the mentions it is the best live watch for.
 * Returns the offers it holds now (a relay's earlier, still-open offers included, so a relay that
 * restarted mid-delivery gets them again; it announces each task once).
 */
async function offersFor(ctx: Ctx, w: MentionWatchRow, now: number): Promise<MentionOffer[]> {
  const found = await candidates(ctx, w, now);
  if (found.length === 0) return [];
  const self = { ...w, lastSeenAt: iso(now) };
  const others = (
    await liveWatches(ctx, w.userId, [...new Set(found.map((t) => t.artifactId))], now)
  ).filter((x) => x.id !== w.id);
  const out: MentionOffer[] = [];
  for (const t of found) {
    if (t.offeredTo === w.id && t.offeredUntil && t.offeredUntil > iso(now)) {
      out.push({ task_id: t.id, artifact_id: t.artifactId });
      continue;
    }
    const tried = new Set<string>(JSON.parse(t.offeredWatches) as string[]);
    const best = [self, ...others]
      .filter((x) => !tried.has(x.id) && watchHears(x, t, t.ownerId))
      .sort(rank)[0];
    if (best?.id !== w.id) continue;
    const won = await ctx.db
      .update(mentionTasks)
      .set({
        offeredTo: w.id,
        offeredUntil: iso(now + TTL.mentionOfferMs),
        offerCount: sql`${mentionTasks.offerCount} + 1`,
        offeredWatches: sql`json_insert(${mentionTasks.offeredWatches}, '$[#]', ${w.id})`,
      })
      .where(
        and(
          eq(mentionTasks.id, t.id),
          eq(mentionTasks.state, "pending"),
          or(isNull(mentionTasks.offeredUntil), lt(mentionTasks.offeredUntil, iso(now))),
          lt(mentionTasks.offerCount, MENTION_WATCH.maxOffers),
        ),
      )
      .returning({ id: mentionTasks.id })
      .get();
    if (won) out.push({ task_id: t.id, artifact_id: t.artifactId });
  }
  return out;
}

/** What a finished task watch says, read by tasks/get. */
export type TaskOutcome =
  | { status: "working" }
  | { status: "cancelled" }
  | { status: "completed"; kind: "offers"; offers: MentionOffer[]; artifactId: string }
  | { status: "completed"; kind: "ended"; artifactId: string };

function outcomeOf(w: MentionWatchRow): TaskOutcome {
  if (w.status === "working") return { status: "working" };
  if (w.status === "cancelled" || w.status === "expired") return { status: "cancelled" };
  const result = (w.result ? JSON.parse(w.result) : { kind: "ended" }) as
    | { kind: "offers"; offers: MentionOffer[] }
    | { kind: "ended" };
  const artifactId = w.artifactId as string;
  return result.kind === "offers"
    ? { status: "completed", kind: "offers", offers: result.offers, artifactId }
    : { status: "completed", kind: "ended", artifactId };
}

/**
 * tasks/get for a task watch. A working watch takes the mentions it is offered and completes with
 * them; one past its lifetime completes with "ended", so the agent starts a new watch and its
 * client, which follows a task for seven days in cloud sessions and chats, never loses track. A
 * finished watch keeps answering with its outcome.
 */
export async function pollTaskWatch(
  ctx: Ctx,
  id: string,
): Promise<{ watch: MentionWatchRow; outcome: TaskOutcome }> {
  requireAgent(ctx);
  const w = await ownWatch(ctx, id);
  if (w.kind !== "task") throw notFound("Mention watch");
  if (w.status !== "working") return { watch: w, outcome: outcomeOf(w) };
  const now = Date.now();
  if (w.expiresAt <= iso(now)) {
    const done = await finish(ctx, w, { kind: "ended" }, now);
    return { watch: done, outcome: outcomeOf(done) };
  }
  // Seen before offering, so a mention arriving between two polls counts this watch as live.
  await ctx.db
    .update(mentionWatches)
    .set({ lastSeenAt: iso(now) })
    .where(eq(mentionWatches.id, w.id))
    .run();
  const offers = await offersFor(ctx, w, now);
  if (offers.length === 0) return { watch: { ...w, lastSeenAt: iso(now) }, outcome: outcomeOf(w) };
  const done = await finish(ctx, w, { kind: "offers", offers }, now);
  return { watch: done, outcome: outcomeOf(done) };
}

async function finish(
  ctx: Ctx,
  w: MentionWatchRow,
  result: { kind: "offers"; offers: MentionOffer[] } | { kind: "ended" },
  now: number,
): Promise<MentionWatchRow> {
  const set = {
    status: "completed" as const,
    completedAt: iso(now),
    lastSeenAt: iso(now),
    result: JSON.stringify(result),
  };
  await ctx.db
    .update(mentionWatches)
    .set(set)
    .where(and(eq(mentionWatches.id, w.id), eq(mentionWatches.status, "working")))
    .run();
  return { ...w, ...set };
}

/**
 * POST /api/v1/mention-watches/poll: the relay's watches, one request per round. Each working
 * watch is kept alive (its expiry slides) and handed its offers; ended ones say so, and ids that
 * are not this connection's are left out.
 */
export async function pollRelayWatches(ctx: Ctx, ids: string[]): Promise<MentionWatchPoll[]> {
  const p = requireAgent(ctx);
  const rows = await ctx.db
    .select()
    .from(mentionWatches)
    .where(
      and(
        inArray(mentionWatches.id, [...new Set(ids)]),
        eq(mentionWatches.connectionId, p.connectionId ?? ""),
        eq(mentionWatches.kind, "relay"),
      ),
    )
    .all();
  const now = Date.now();
  const out: MentionWatchPoll[] = [];
  for (const w of rows) {
    if (w.status !== "working") {
      out.push({ id: w.id, status: w.status, offers: [] });
      continue;
    }
    if (w.expiresAt <= iso(now)) {
      await ctx.db
        .update(mentionWatches)
        .set({ status: "expired", completedAt: iso(now) })
        .where(and(eq(mentionWatches.id, w.id), eq(mentionWatches.status, "working")))
        .run();
      out.push({ id: w.id, status: "expired", offers: [] });
      continue;
    }
    await ctx.db
      .update(mentionWatches)
      .set({ lastSeenAt: iso(now), expiresAt: iso(now + MENTION_WATCH.relayIdleMs) })
      .where(eq(mentionWatches.id, w.id))
      .run();
    out.push({ id: w.id, status: "working", offers: await offersFor(ctx, w, now) });
  }
  return out;
}

/**
 * Does this connection have a live task watch on the artifact? publish_artifact and
 * update_artifact ask, to say "watch it" only when nothing watches it yet.
 */
export async function hasLiveTaskWatch(
  ctx: Ctx,
  connectionId: string,
  artifactId: string,
): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db
    .select({ id: mentionWatches.id })
    .from(mentionWatches)
    .where(
      and(
        eq(mentionWatches.connectionId, connectionId),
        eq(mentionWatches.kind, "task"),
        eq(mentionWatches.artifactId, artifactId),
        eq(mentionWatches.status, "working"),
        gt(mentionWatches.lastSeenAt, iso(now - MENTION_WATCH.liveMs)),
      ),
    )
    .get();
  return !!row;
}

/**
 * Housekeeping (the cleanup cron): working watches past their expiry end (a task nobody polled
 * before its lifetime ran out; a relay silent for MENTION_WATCH.relayIdleMs), and ended ones go a
 * week later, long past the hour a client may still read a finished task's result.
 */
export async function sweepMentionWatches(ctx: Pick<Ctx, "db">, now = Date.now()) {
  await ctx.db
    .update(mentionWatches)
    .set({ status: "expired", completedAt: iso(now) })
    .where(and(eq(mentionWatches.status, "working"), lt(mentionWatches.expiresAt, iso(now))))
    .run();
  await ctx.db
    .delete(mentionWatches)
    .where(
      and(
        inArray(mentionWatches.status, ["completed", "cancelled", "expired"]),
        lt(mentionWatches.completedAt, iso(now - 7 * 24 * 60 * 60 * 1000)),
      ),
    )
    .run();
}

export { info as mentionWatchInfo };
