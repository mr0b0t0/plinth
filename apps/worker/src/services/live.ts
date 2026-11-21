// On-page editing on the app host (#36, docs/spec.md "Editing"): the live draft's metadata,
// checkpoints (Publish, and "Publish your changes" in the review) and discard (the strip's, and
// "Discard your changes"). Every route goes through requireArtifact with the `live_edit` action (signed-in owners
// and editors only; never agents), and is for types people edit on their page only (docs and
// sheets). A checkpoint saves the room's own draft through the ordinary stager (updateArtifact),
// always with the version it replaces as base_version and the files of the draft's base version,
// so a stale draft is refused in SQL like any other stale save and nothing is ever overwritten.
// No route returns draft text: the renderer reads it on the draft socket. The room never creates a
// version.
import {
  isLiveType,
  LIVE_DEFAULTS,
  type LiveCheckpointInput,
  type LiveCheckpointResult,
  type LiveDiscardQuery,
  type LiveDraftInfo,
  type LiveDraftMeta,
  type LiveInfo,
  liveReplacesNote,
  liveRules,
  TYPE_REGISTRY,
  typeDef,
} from "@plinth/shared";
import { type Bindings, getConfig, liveEditMode, roomsActive } from "../config.ts";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { requireArtifact, updateArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

/** The note a checkpoint's version carries when the editor gave none. */
export const LIVE_NOTE = "Edited on the page";

interface DraftRow {
  base_version: number;
  conflict_version: number | null;
  updated_at: string;
  updated_by_email: string | null;
  rev: number;
}

async function draftRow(DB: D1Database, artifactId: string): Promise<DraftRow | null> {
  return DB.prepare(
    `SELECT d.base_version, d.conflict_version, d.updated_at, d.rev, u.email AS updated_by_email
       FROM live_drafts d LEFT JOIN users u ON u.id = d.updated_by_user
      WHERE d.artifact_id = ?1`,
  )
    .bind(artifactId)
    .first<DraftRow>();
}

/** The unsaved draft as editors are told about it (one D1 read), or null when there is none. */
export async function readLiveDraftInfo(
  DB: D1Database,
  artifactId: string,
): Promise<LiveDraftInfo | null> {
  const r = await draftRow(DB, artifactId);
  if (!r) return null;
  return {
    base_version: r.base_version,
    // A draft equal to its base is deleted, so a row is unsaved edits. The one exception is
    // kept only while a save of earlier edits runs: once that version lands, the row is them.
    dirty: true,
    conflict_version: r.conflict_version,
    updated_at: r.updated_at,
    updated_by_email: r.updated_by_email,
  };
}

/** The same, without who: what get_artifact tells owners' and editors' agents. */
export async function readLiveDraftMeta(
  DB: D1Database,
  artifactId: string,
): Promise<LiveDraftMeta | null> {
  const info = await readLiveDraftInfo(DB, artifactId);
  if (!info) return null;
  const { updated_by_email: _who, ...meta } = info;
  return meta;
}

function room(env: Bindings, artifactId: string) {
  const ns = env.ROOMS;
  if (!ns) return null;
  return ns.get(ns.idFromName(artifactId));
}

const unavailable = () =>
  new ApiError("unavailable", "Live editing is unavailable. Your edits are kept.", {
    reason: "live_unavailable",
  });

/** What can be edited on its page, for the refusal: "a doc or a deck or a sheet". */
const LIVE_KINDS = Object.values(TYPE_REGISTRY)
  .filter((d) => isLiveType(d))
  .map((d) => `a ${d.noun ?? (d.badge ?? d.label).toLowerCase()}`)
  .join(" or ");

/** Policy (live_edit), then a type edited on its page. */
async function requireLiveDoc(ctx: Ctx, ref: string): Promise<ArtifactRow> {
  const { artifact } = await requireArtifact(ctx, ref, "live_edit");
  if (!isLiveType(typeDef(artifact.type)) || !liveRules(artifact.type)) {
    throw new ApiError("invalid_input", `Only ${LIVE_KINDS} can be edited on its page`, {
      reason: "unsupported_type",
    });
  }
  return artifact;
}

/** And the room: these routes need live editing with rooms on this instance. */
function requireRoomMode(ctx: Ctx, artifactId: string) {
  if (liveEditMode(ctx.config, ctx.env) !== "room") throw unavailable();
  const stub = room(ctx.env, artifactId);
  if (!stub) throw unavailable();
  return stub;
}

/** GET /api/v1/artifacts/:ref/live */
export async function getLiveInfo(ctx: Ctx, ref: string): Promise<LiveInfo> {
  const a = await requireLiveDoc(ctx, ref);
  const mode = liveEditMode(ctx.config, ctx.env);
  let online: number | null = null;
  if (mode === "room") {
    try {
      online = (await room(ctx.env, a.id)?.docInfo())?.editors_online ?? null;
    } catch {
      online = null;
    }
  }
  return {
    mode,
    draft: await readLiveDraftInfo(ctx.env.DB, a.id),
    editors_online: online,
    idle_checkpoint_s: ctx.config.live.checkpointIdleS,
    auto_checkpoint_min_s: ctx.config.live.autoCheckpointMinS,
  };
}

/** Says a version froze the draft, in the type's words (a doc's overlapped; others always do). */
function frozenMessage(merges: boolean, n: number): string {
  return merges
    ? `v${n} changed the same lines. Review it.`
    : `v${n} was published while you edited. Review it.`;
}

/**
 * POST /api/v1/artifacts/:ref/live/checkpoint: save the live draft as the next version.
 * 1 policy; 2 snapshot (flush, 30 s lock), 503 when the room cannot be reached.
 * With `conflict_version` ("Publish your changes" in the review), before anything else: 3a another save or
 * choice holds the lock (200 busy); 3b the draft is no longer frozen, because another editor's
 * choice resolved it (409 live_resolved, never 200 clean); 3c it is frozen against a newer version
 * (409 live_conflict naming it); 3d `rev` is not the draft's (409 live_moved). Without it: 3 nothing
 * to save, another save running, or a frozen draft (409 live_conflict: only the review publishes
 * it). 4 the page's base_version must be the draft's; 5 a draft the type cannot publish yet (409
 * live_unpublishable); 6 an autosave only once the current version is LIVE_AUTO_CHECKPOINT_MIN_S
 * old (with when to try again); 7 the stager, with the room's own draft text, the version it
 * replaces as base_version (the draft's base, or the frozen version for "Publish your changes") and the
 * files of the draft's base version (files_from_version), and a stale base makes the room catch
 * up; 8 any refusal releases this save's lock; 9 the room takes the version as the draft's base.
 */
export async function liveCheckpoint(
  ctx: Ctx,
  ref: string,
  readInput: LiveCheckpointInput | (() => LiveCheckpointInput),
): Promise<LiveCheckpointResult> {
  const a = await requireLiveDoc(ctx, ref);
  // Validated after policy, so a stranger learns nothing from the shape of a refusal.
  const input = typeof readInput === "function" ? readInput() : readInput;
  const stub = requireRoomMode(ctx, a.id);
  let snap: Awaited<ReturnType<typeof stub.docSnapshot>>;
  try {
    snap = await stub.docSnapshot(a.id);
  } catch {
    throw unavailable();
  }
  if (snap.state === "gone") throw new ApiError("not_found", "Artifact not found");
  if (snap.state === "busy") return { saved: false, reason: "busy" };
  // Only the lock this snapshot took is released: a second save's abort never frees the first's.
  const abort = async () => {
    if (!snap.lock) return;
    try {
      await stub.docAbort(snap.lock);
    } catch {
      // The lock runs out on its own (30 s).
    }
  };
  // A doc's draft is merged with a version published meanwhile when that is clean; no other
  // type's ever is (liveTypes.ts), so its review has exactly two choices.
  const merges = liveRules(a.type)?.merge === "lines";
  const reviewed = input.conflict_version;
  if (reviewed !== undefined) {
    if (snap.conflict_version === null) {
      await abort();
      throw new ApiError(
        "conflict",
        "Another editor already published or discarded these page changes.",
        { current_version: snap.base_version, reason: "live_resolved" },
      );
    }
    if (reviewed !== snap.conflict_version) {
      // A newer version froze the draft: what the editor reviewed is not what they would replace.
      await abort();
      throw new ApiError(
        "conflict",
        `v${snap.conflict_version} was published while you reviewed. Review it.`,
        { current_version: snap.conflict_version, reason: "live_conflict" },
      );
    }
    if (input.rev !== snap.rev) {
      await abort();
      throw new ApiError("conflict", "The page changes moved on. Review them again.", {
        current_version: snap.conflict_version,
        reason: "live_moved",
      });
    }
  } else if (snap.state === "clean") {
    return { saved: false, reason: "clean" };
  } else if (snap.conflict_version !== null) {
    await abort();
    throw new ApiError("conflict", frozenMessage(merges, snap.conflict_version), {
      current_version: snap.conflict_version,
      reason: "live_conflict",
    });
  } else if (snap.unchanged) {
    await abort();
    return { saved: false, reason: "unchanged" };
  }
  if (input.base_version !== snap.base_version) {
    await abort();
    throw new ApiError("conflict", "The page edits are based on another version. Reload.", {
      current_version: snap.base_version,
    });
  }
  if (snap.unpublishable !== null) {
    await abort();
    throw new ApiError("conflict", "These page changes cannot be published yet.", {
      reason: "live_unpublishable",
      why: snap.unpublishable,
    });
  }
  if (input.reason === "idle" && reviewed === undefined) {
    const wait = await autosaveWait(ctx, a, input.rev !== snap.rev);
    if (wait !== 0) {
      await abort();
      return { saved: false, reason: "too_soon", ...(wait > 0 ? { retry_in_s: wait } : {}) };
    }
  }
  const own =
    (input.note?.trim() || LIVE_NOTE) +
    (input.reason === "idle" && !input.note ? " (autosaved)" : "");
  // "Publish your changes": the room's own frozen draft replaces the versions published since its base,
  // which stay in the history; the note names them.
  const base = reviewed ?? snap.base_version;
  const note =
    reviewed !== undefined ? liveReplacesNote(own, snap.base_version + 1, reviewed) : own;
  let version: Awaited<ReturnType<typeof updateArtifact>>;
  try {
    version = await updateArtifact(ctx, {
      id: a.id,
      content: snap.text,
      base_version: base,
      // The draft's files are its base version's: never the files of a version published
      // meanwhile, which "Publish your changes" leaves out together with its text.
      files_from_version: snap.base_version,
      note,
      checkpoint: true,
    });
  } catch (e) {
    await abort();
    throw await staleRoom(stub, a.id, base, e, merges);
  }
  let live = { rev: snap.rev, dirty: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      live = await stub.docFinish(
        a.id,
        version.version,
        snap.text,
        snap.lock,
        snap.epoch,
        snap.rev,
        reviewed !== undefined,
      );
      break;
    } catch {
      // Retried once; the version notify (its content hash) finishes it otherwise.
    }
  }
  return { saved: true, version, live };
}

/**
 * The stager refused the draft's base as stale: a version was published that the room never
 * heard of (its notify was lost, or it was published while rooms were off). The room catches up
 * now, merging a doc's draft onto that version or freezing it for review, so the next save works
 * or the editor is sent to review instead of failing again and again. Other errors pass through.
 */
async function staleRoom(
  stub: NonNullable<ReturnType<typeof room>>,
  artifactId: string,
  base: number,
  e: unknown,
  merges = true,
): Promise<unknown> {
  const current = (
    e instanceof ApiError && e.code === "conflict"
      ? (e.details as { current_version?: unknown } | undefined)?.current_version
      : undefined
  ) as number | undefined;
  if (typeof current !== "number" || current <= base) return e;
  let after: { conflict_version: number | null } | null;
  try {
    await stub.docVersion(artifactId, current, null);
    after = await stub.docPeek(artifactId);
  } catch {
    return e;
  }
  if (after?.conflict_version != null) {
    return new ApiError("conflict", frozenMessage(merges, after.conflict_version), {
      current_version: after.conflict_version,
      reason: "live_conflict",
    });
  }
  return new ApiError(
    "conflict",
    `v${current} was published meanwhile. Your page edits were kept on top of it; publish again.`,
    { current_version: current, reason: "live_rebased" },
  );
}

/**
 * How long an idle autosave waits, in seconds: 0 to save now; -1 when it never will on its own
 * (LIVE_CHECKPOINT_IDLE_S=0, or someone typed since the page asked, whose next quiet spell asks
 * again); otherwise until the current version is LIVE_AUTO_CHECKPOINT_MIN_S old, when the page
 * tries again.
 */
async function autosaveWait(ctx: Ctx, a: ArtifactRow, typedSince: boolean): Promise<number> {
  if (ctx.config.live.checkpointIdleS === 0 || typedSince) return -1;
  const v = await ctx.env.DB.prepare(
    "SELECT created_at FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(a.id, a.currentVersion)
    .first<{ created_at: string }>();
  if (!v) return 0;
  const left = ctx.config.live.autoCheckpointMinS * 1000 - (Date.now() - Date.parse(v.created_at));
  return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
}

/** Someone's save or choice holds the room's checkpoint lock. */
const busy = (rev: number) =>
  new ApiError(
    "conflict",
    "Someone else is publishing or discarding these changes right now. Look again in a moment.",
    { rev, reason: "live_busy" },
  );

/**
 * DELETE /api/v1/artifacts/:ref/live/draft?rev=n[&conflict_version=v]: drop the unpublished
 * edits. Through the room while rooms are active (open pages follow); otherwise the stored row goes
 * directly (for example after the binding was removed). 409 when the draft moved past `rev`, and
 * 409 `live_busy` while a save or the review's other choice holds the room's checkpoint lock, so a
 * discard never lands under a version being published from the same draft. With
 * `conflict_version` ("Discard your changes" in the review) it drops only a draft frozen against exactly
 * that version: 409 `live_resolved` when the draft is no longer frozen, `live_conflict` when a
 * newer version froze it.
 */
export async function discardLiveDraft(
  ctx: Ctx,
  ref: string,
  readQuery: LiveDiscardQuery | (() => LiveDiscardQuery),
): Promise<void> {
  const a = await requireLiveDoc(ctx, ref);
  const q = typeof readQuery === "function" ? readQuery() : readQuery;
  const { rev } = q;
  const reviewed = q.conflict_version;
  if (roomsActive(ctx.config, ctx.env)) {
    const stub = room(ctx.env, a.id);
    let r: Awaited<ReturnType<NonNullable<typeof stub>["docDiscard"]>> | undefined;
    try {
      r = await stub?.docDiscard(
        a.id,
        rev,
        reviewed !== undefined ? { conflictVersion: reviewed } : {},
      );
    } catch {
      throw unavailable();
    }
    if (!r || r.ok) return;
    if (r.busy) throw busy(r.rev);
    if (r.reason === "resolved") {
      throw new ApiError(
        "conflict",
        "Another editor already published or discarded these page changes.",
        { rev: r.rev, current_version: r.version, reason: "live_resolved" },
      );
    }
    if (r.reason === "conflict") {
      throw new ApiError("conflict", `v${r.version} was published while you reviewed. Review it.`, {
        rev: r.rev,
        current_version: r.version,
        reason: "live_conflict",
      });
    }
    throw new ApiError("conflict", "The page edits changed since you looked. Look again.", {
      rev: r.rev,
    });
  }
  const row = await draftRow(ctx.env.DB, a.id);
  if (!row) {
    if (reviewed !== undefined) {
      throw new ApiError(
        "conflict",
        "Another editor already published or discarded these page changes.",
        { rev: 0, reason: "live_resolved" },
      );
    }
    return;
  }
  if (reviewed !== undefined && row.conflict_version !== reviewed) {
    throw new ApiError(
      "conflict",
      row.conflict_version === null
        ? "Another editor already published or discarded these page changes."
        : `v${row.conflict_version} was published while you reviewed. Review it.`,
      {
        rev: row.rev,
        ...(row.conflict_version !== null ? { current_version: row.conflict_version } : {}),
        reason: row.conflict_version === null ? "live_resolved" : "live_conflict",
      },
    );
  }
  if (row.rev !== rev) {
    throw new ApiError("conflict", "The page edits changed since you looked. Look again.", {
      rev: row.rev,
    });
  }
  await ctx.env.DB.prepare("DELETE FROM live_drafts WHERE artifact_id = ?1 AND rev = ?2")
    .bind(a.id, rev)
    .run();
}

/** The hourly cron: drafts nobody touched for LIVE_DRAFT_RETENTION_DAYS go. */
export async function pruneLiveDrafts(
  DB: D1Database,
  retentionDays: number,
  now: number,
): Promise<number> {
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  const r = await DB.prepare("DELETE FROM live_drafts WHERE updated_at < ?1").bind(cutoff).run();
  return r.meta.changes ?? 0;
}

/** LIVE_DRAFT_RETENTION_DAYS, or its default when the host configuration cannot be read. */
export function liveRetentionDays(env: Bindings): number {
  try {
    return getConfig(env as unknown as Record<string, unknown>).live.draftRetentionDays;
  } catch {
    return LIVE_DEFAULTS.draftRetentionDays;
  }
}
