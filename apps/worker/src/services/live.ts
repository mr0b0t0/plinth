// On-page editing on the app host (#36, docs/spec.md "Editing"): the live draft's metadata,
// its text for reviewing a conflict, checkpoints and discard. Every route goes through
// requireArtifact with the `live_edit` action (signed-in owners and editors only; never agents),
// and is for types with liveEdit only (docs and sheets). A checkpoint saves the draft through the
// ordinary stager (updateArtifact), always with the draft's own base_version, so a stale draft is
// refused in SQL like any other stale save and nothing is ever overwritten. The room never creates
// a version.
import {
  LIVE_DEFAULTS,
  type LiveCheckpointInput,
  type LiveCheckpointResult,
  type LiveDraftInfo,
  type LiveDraftMeta,
  type LiveDraftText,
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
import { resolveSource } from "./artifactTypes.ts";
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

/** What can be edited on its page, for the refusal: "a doc or a sheet". */
const LIVE_KINDS = Object.values(TYPE_REGISTRY)
  .filter((d) => d.liveEdit)
  .map((d) => `a ${(d.badge ?? d.label).toLowerCase()}`)
  .join(" or ");

/** Policy (live_edit), then a type edited on its page. */
async function requireLiveDoc(ctx: Ctx, ref: string): Promise<ArtifactRow> {
  const { artifact } = await requireArtifact(ctx, ref, "live_edit");
  if (!typeDef(artifact.type)?.liveEdit || !liveRules(artifact.type)) {
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

/** The text of one version's source file (the artifact's own type), for comparing a resolution. */
async function versionText(ctx: Ctx, a: ArtifactRow, n: number): Promise<string | null> {
  const v = await ctx.env.DB.prepare(
    "SELECT r2_prefix FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(a.id, n)
    .first<{ r2_prefix: string }>();
  const def = typeDef(a.type);
  if (!v || !def) return null;
  return readText(ctx.env.FILES, `${v.r2_prefix}${def.sourcePath}`);
}

/**
 * POST /api/v1/artifacts/:ref/live/checkpoint: save the live draft as the next version.
 * 1 policy; 2 snapshot (flush, 30 s lock), 503 when the room cannot be reached; 3 nothing to save
 * or another save running; 4 the page's base_version must be the draft's; 5 a resolution only
 * while in conflict, and only against the conflicting version the editor reviewed (409 when a
 * newer one conflicts now), based on that version; 6 a draft equal to its base writes nothing;
 * 7 an autosave only once the current version is LIVE_AUTO_CHECKPOINT_MIN_S old (with when to
 * try again); 8 the stager, with the draft's base_version, and a stale base makes the room catch
 * up; 9 any error releases this save's lock; 10 the room takes the version as the draft's base.
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
  // Only the lock this snapshot took is released: a second save's abort never frees the first's.
  const abort = async () => {
    try {
      await stub.docAbort(snap.lock);
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
  // A doc's draft is merged with a version published meanwhile when that is clean; a sheet's
  // never is (liveTypes.ts), so its review has exactly two choices.
  const merges = liveRules(a.type)?.merge !== false;
  /** A sheet's page edits published whole over this version (it stays in the history). */
  let replaced: number | null = null;
  if (input.resolved_text !== undefined) {
    if (snap.conflict_version === null) {
      await abort();
      throw new ApiError("invalid_input", "There is no conflict to resolve", {
        reason: "no_conflict",
      });
    }
    if (input.conflict_version === undefined) {
      await abort();
      throw new ApiError("invalid_input", "conflict_version is required with resolved_text", {
        reason: "no_conflict_version",
      });
    }
    if (input.conflict_version !== snap.conflict_version) {
      // A newer version conflicts now: what the editor reviewed is not what they would overwrite.
      await abort();
      throw new ApiError(
        "conflict",
        `v${snap.conflict_version} was published while you reviewed. Review it.`,
        { current_version: snap.conflict_version, reason: "live_conflict" },
      );
    }
    base = snap.conflict_version;
    // The text a version of this type stores (a sheet's canonical JSON lines; refused with the
    // type's own issues when it cannot hold it), so the room's draft is what the version holds.
    try {
      text = resolveSource({ content: input.resolved_text }, a.type).text;
    } catch (e) {
      await abort();
      throw e;
    }
    const published = await versionText(ctx, a, base);
    if (!merges) {
      // A type that never merges (a sheet) is resolved whole, against the draft the editor
      // reviewed: the page edits as they are ("Publish mine"), or the version published meanwhile
      // ("Discard mine"). Nothing in between is saved.
      if (input.rev !== snap.rev) {
        await abort();
        throw new ApiError("conflict", "The page edits changed meanwhile. Review them again.", {
          current_version: snap.conflict_version,
          reason: "live_conflict",
        });
      }
      if (text !== snap.text && text !== published) {
        await abort();
        throw new ApiError(
          "invalid_input",
          "Publish the page edits as they are, or discard them for the published version",
          { reason: "not_a_choice" },
        );
      }
      // The page edits published as they are over the version published meanwhile: the note
      // says what the new version leaves out (that version stays in the history).
      if (text === snap.text) replaced = base;
    }
    if (text === published) {
      // Resolved to the published version exactly: the draft goes, and no version is written.
      // The discard runs under this snapshot's lock (and releases it), so the other choice or a
      // save arriving meanwhile is busy, and only the version reviewed is taken.
      let ok = false;
      try {
        ok = (await stub.docDiscard(a.id, snap.rev, { lock: snap.lock, conflictVersion: base })).ok;
      } catch {
        // Answered below; the lock runs out on its own when the abort is lost too.
      }
      if (!ok) {
        await abort();
        throw new ApiError("conflict", "The page edits changed meanwhile. Review them again.", {
          current_version: snap.conflict_version,
        });
      }
      return { saved: false, reason: "unchanged" };
    }
    let held: boolean;
    try {
      held = await stub.docResolve(snap.lock, text);
    } catch {
      throw unavailable();
    }
    if (!held) return { saved: false, reason: "busy" };
  } else if (snap.conflict_version !== null) {
    await abort();
    throw new ApiError(
      "conflict",
      merges
        ? `v${snap.conflict_version} changed the same lines. Review it.`
        : `v${snap.conflict_version} was published while you edited. Review it.`,
      { current_version: snap.conflict_version, reason: "live_conflict" },
    );
  } else if (snap.unchanged) {
    await abort();
    return { saved: false, reason: "unchanged" };
  }
  if (input.reason === "idle") {
    const wait = await autosaveWait(ctx, a, input.rev !== snap.rev);
    if (wait !== 0) {
      await abort();
      return { saved: false, reason: "too_soon", ...(wait > 0 ? { retry_in_s: wait } : {}) };
    }
  }
  const own =
    (input.note?.trim() || LIVE_NOTE) +
    (input.reason === "idle" && !input.note ? " (autosaved)" : "");
  const note = replaced !== null ? liveReplacesNote(own, replaced) : own;
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
    throw await staleRoom(stub, a.id, base, e, merges);
  }
  let live = { rev: snap.rev, dirty: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      live = await stub.docFinish(a.id, version.version, text, snap.lock, snap.epoch);
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
 * now, merging the draft onto that version or freezing it for review, so the next save works or
 * the editor is sent to review instead of failing again and again. Other errors pass through.
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
  let after: LiveDraftText | null;
  try {
    await stub.docVersion(artifactId, current, null);
    after = await stub.docPeek(artifactId);
  } catch {
    return e;
  }
  if (after?.conflict_version != null) {
    return new ApiError(
      "conflict",
      merges
        ? `v${after.conflict_version} changed the same lines. Review it.`
        : `v${after.conflict_version} was published while you edited. Review it.`,
      {
        current_version: after.conflict_version,
        reason: "live_conflict",
      },
    );
  }
  return new ApiError(
    "conflict",
    `v${current} was published meanwhile. Your page edits were kept on top of it; save again.`,
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

/**
 * DELETE /api/v1/artifacts/:ref/live/draft?rev=n: drop the unsaved edits. Through the room while
 * rooms are active (open pages follow); otherwise the stored row goes directly (for example after
 * the binding was removed). 409 when the draft moved past `rev`, and 409 `live_busy` while a save
 * or the review's other choice holds the room's checkpoint lock, so a discard never lands under a
 * version being published from the same draft.
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
    let r: { ok: boolean; rev: number; busy?: true } | undefined;
    try {
      r = await stub?.docDiscard(a.id, rev);
    } catch {
      throw unavailable();
    }
    if (r?.busy) {
      throw new ApiError(
        "conflict",
        "These page edits are being published or discarded right now. Look again in a moment.",
        { rev: r.rev, reason: "live_busy" },
      );
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
