// On-page doc editing on the app host (#36, docs/spec.md "Editing"): the live draft's metadata,
// its text for reviewing a conflict, checkpoints and discard. Every route goes through
// requireArtifact with the `live_edit` action (signed-in owners and editors only; never agents),
// and is for doc artifacts only. A checkpoint saves the draft through the ordinary stager
// (updateArtifact), always with the draft's own base_version, so a stale draft is refused in SQL
// like any other stale save and nothing is ever overwritten. The room never creates a version.
import {
  LIVE_DEFAULTS,
  type LiveCheckpointInput,
  type LiveCheckpointResult,
  type LiveDraftInfo,
  type LiveDraftMeta,
  type LiveDraftText,
  type LiveInfo,
  typeDef,
} from "@plinth/shared";
import { type Bindings, getConfig, liveEditMode, roomsActive } from "../config.ts";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { requireArtifact, updateArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { readText } from "./storage.ts";

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
    // A draft equal to its base is deleted, so a row is always unsaved edits.
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

/** Policy (live_edit), then a doc. */
async function requireLiveDoc(ctx: Ctx, ref: string): Promise<ArtifactRow> {
  const { artifact } = await requireArtifact(ctx, ref, "live_edit");
  if (!typeDef(artifact.type)?.liveEdit) {
    throw new ApiError("invalid_input", "Only a doc can be edited on its page", {
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

/** GET /api/v1/artifacts/:ref/live/draft: the freshest draft text, to review a conflict. */
export async function getLiveDraft(ctx: Ctx, ref: string): Promise<LiveDraftText> {
  const a = await requireLiveDoc(ctx, ref);
  const stub = requireRoomMode(ctx, a.id);
  let out: LiveDraftText | null;
  try {
    out = await stub.docPeek(a.id);
  } catch {
    throw unavailable();
  }
  if (!out) throw new ApiError("not_found", "Artifact not found");
  return out;
}

/** The text of one version's source, for comparing a resolution with it. */
async function versionText(ctx: Ctx, artifactId: string, n: number): Promise<string | null> {
  const v = await ctx.env.DB.prepare(
    "SELECT r2_prefix FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(artifactId, n)
    .first<{ r2_prefix: string }>();
  const def = typeDef("doc");
  if (!v || !def) return null;
  return readText(ctx.env.FILES, `${v.r2_prefix}${def.sourcePath}`);
}

/**
 * POST /api/v1/artifacts/:ref/live/checkpoint: save the live draft as the next version.
 * 1 policy; 2 snapshot (flush, 30 s lock), 503 when the room cannot be reached; 3 nothing to save
 * or another save running; 4 the page's base_version must be the draft's; 5 a resolution only
 * while in conflict, based on the conflicting version; 6 a draft equal to its base writes nothing;
 * 7 an autosave only as often as LIVE_AUTO_CHECKPOINT_MIN_S; 8 the stager, with the draft's
 * base_version; 9 any error releases the lock; 10 the room takes the version as the draft's base.
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
  if (snap.state === "clean" || snap.state === "busy") {
    return { saved: false, reason: snap.state };
  }
  const abort = async () => {
    try {
      await stub.docAbort();
    } catch {
      // The lock runs out on its own (30 s).
    }
  };
  if (input.base_version !== snap.base_version) {
    await abort();
    throw new ApiError("conflict", "The page edits are based on another version. Reload.", {
      current_version: snap.base_version,
    });
  }
  let text = snap.text;
  let base = snap.base_version;
  if (input.resolved_text !== undefined) {
    if (snap.conflict_version === null) {
      await abort();
      throw new ApiError("invalid_input", "There is no conflict to resolve", {
        reason: "no_conflict",
      });
    }
    base = snap.conflict_version;
    text = input.resolved_text;
    if (text === (await versionText(ctx, a.id, base))) {
      // Resolved to the published version exactly: the draft goes, and no version is written.
      try {
        await stub.docAbort();
        const d = await stub.docDiscard(a.id, snap.rev);
        if (!d.ok) throw new Error("moved");
      } catch {
        throw new ApiError("conflict", "The page edits changed meanwhile. Review them again.", {
          current_version: snap.conflict_version,
        });
      }
      return { saved: false, reason: "unchanged" };
    }
    try {
      await stub.docResolve(text);
    } catch {
      throw unavailable();
    }
  } else if (snap.conflict_version !== null) {
    await abort();
    throw new ApiError("conflict", `v${snap.conflict_version} changed the same lines. Review it.`, {
      current_version: snap.conflict_version,
      reason: "live_conflict",
    });
  } else if (snap.unchanged) {
    await abort();
    return { saved: false, reason: "unchanged" };
  }
  if (input.reason === "idle") {
    const tooSoon = await autosaveTooSoon(ctx, a, input.rev !== snap.rev);
    if (tooSoon) {
      await abort();
      return { saved: false, reason: "too_soon" };
    }
  }
  const note =
    (input.note?.trim() || LIVE_NOTE) +
    (input.reason === "idle" && !input.note ? " (autosaved)" : "");
  let version: Awaited<ReturnType<typeof updateArtifact>>;
  try {
    version = await updateArtifact(ctx, {
      id: a.id,
      content: text,
      base_version: base,
      note,
      checkpoint: true,
    });
  } catch (e) {
    await abort();
    throw e;
  }
  let live = { rev: snap.rev, dirty: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      live = await stub.docFinish(a.id, version.version, text);
      break;
    } catch {
      // Retried once; the version notify (its content hash) finishes it otherwise.
    }
  }
  return { saved: true, version, live };
}

/**
 * An idle autosave waits: off (LIVE_CHECKPOINT_IDLE_S=0), someone typed since the page asked, or
 * the current version is younger than LIVE_AUTO_CHECKPOINT_MIN_S.
 */
async function autosaveTooSoon(ctx: Ctx, a: ArtifactRow, typedSince: boolean): Promise<boolean> {
  if (ctx.config.live.checkpointIdleS === 0 || typedSince) return true;
  const v = await ctx.env.DB.prepare(
    "SELECT created_at FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(a.id, a.currentVersion)
    .first<{ created_at: string }>();
  if (!v) return false;
  return Date.now() - Date.parse(v.created_at) < ctx.config.live.autoCheckpointMinS * 1000;
}

/**
 * DELETE /api/v1/artifacts/:ref/live/draft?rev=n: drop the unsaved edits. Through the room while
 * rooms are active (open pages follow); otherwise the stored row goes directly (for example after
 * the binding was removed). 409 when the draft moved past `rev`.
 */
export async function discardLiveDraft(
  ctx: Ctx,
  ref: string,
  readRev: number | (() => number),
): Promise<void> {
  const a = await requireLiveDoc(ctx, ref);
  const rev = typeof readRev === "function" ? readRev() : readRev;
  if (roomsActive(ctx.config, ctx.env)) {
    const stub = room(ctx.env, a.id);
    let r: { ok: boolean; rev: number } | undefined;
    try {
      r = await stub?.docDiscard(a.id, rev);
    } catch {
      throw unavailable();
    }
    if (r && !r.ok) {
      throw new ApiError("conflict", "The page edits changed since you looked. Look again.", {
        rev: r.rev,
      });
    }
    return;
  }
  const row = await draftRow(ctx.env.DB, a.id);
  if (!row) return;
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
