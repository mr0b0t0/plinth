// Publishing a whiteboard (docs/spec.md "Whiteboards"). A board's blocks and arrows are shared
// data; a version stores only its settings (board.json). A publish, or an update of a board whose
// shared data has no blocks or arrows, may carry a starting board: after a data_write decision
// before anything is staged, and again once the version has committed, it is written in one
// guarded D1 statement, stamped with the publisher's role, counted as one write against the rate
// limits, and never stored in the version. A restore never seeds.
import {
  BoardContentError,
  boardSettingsText,
  type PublishResult,
  type PublishWarning,
  parseBoardContent,
  type SeedDoc,
} from "@plinth/shared";
import { ApiError } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { decide } from "../policy.ts";
import { notifyViewers } from "../rooms/notify.ts";
import { writerOf } from "./artifactData.ts";
import { denialError, requireArtifact } from "./artifacts.ts";
import type { PreparedSource, PrepareInput } from "./artifactTypes.ts";
import type { Ctx } from "./context.ts";
import {
  ARTIFACT_LIVE_SQL,
  DOC_INSERT_COLUMNS,
  limitWrites,
  measureDoc,
  quotaExceeded,
  USER_BYTES_SQL,
  unavailableReason,
} from "./data.ts";

/** Said to an agent whose board.json does not parse. */
const CONTENT_NEXT =
  'Fix the value at path and send board.json again: {"v": 1, "blocks": [...], "arrows": [...]}; see the plinth-artifacts skill, "Whiteboards"';

/** board.json refused, with the path of the first problem. */
export function boardContentError(e: BoardContentError): ApiError {
  return new ApiError("invalid_input", `board.json: ${e.message}`, {
    type: "whiteboard",
    field: "content",
    path: e.path,
    next: CONTENT_NEXT,
  });
}

/** parseBoardContent, its error as the API's. */
export function parseBoard(text: string): ReturnType<typeof parseBoardContent> {
  try {
    return parseBoardContent(text);
  } catch (e) {
    if (e instanceof BoardContentError) throw boardContentError(e);
    throw e;
  }
}

/** A board's documents measured as every shared-data write measures them (data.ts measureDoc). */
interface Measured {
  seed: SeedDoc;
  json: string;
  size: number;
}

/** Which documents a board's shared data holds already: blocks or arrows. */
async function boardHasDocs(d1: D1Database, artifactId: string): Promise<boolean> {
  const row = await d1
    .prepare(
      "SELECT 1 AS one FROM artifact_docs WHERE artifact_id = ?1 AND collection IN ('blocks', 'arrows') LIMIT 1",
    )
    .bind(artifactId)
    .first();
  return row !== null;
}

/**
 * The text a whiteboard's version stages (its canonical settings), and the seeding step for its
 * starting board. Runs before the publish rate and any R2 operation, in this order: availability
 * (shared data on, origin isolation), the board's shape, then, only when there is a starting
 * board, the data_write decision (on the facts of the artifact about to be created, or on the
 * artifact), the empty-board check (update), and the quotas.
 */
export async function prepareBoardSource(ctx: Ctx, p: PrepareInput): Promise<PreparedSource> {
  const off = unavailableReason(ctx.config, null, { assumeDeclared: true });
  if (off) {
    throw new ApiError(
      "feature_disabled",
      "Whiteboards keep their blocks in shared data, which this instance turns off",
      { type: "whiteboard", reason: off },
    );
  }
  const { settings, seed } = parseBoard(p.text);
  const text = boardSettingsText(settings);
  // No starting board: nothing goes to shared data, so there is nothing more to decide.
  if (seed.length === 0) return { text };

  const t = p.target;
  if (t.mode === "publish") {
    const d = decide(
      ctx.principal,
      "data_write",
      {
        id: t.artifactId,
        ownerId: t.ownerId,
        visibility: t.visibility,
        hasPassword: t.hasPassword,
        deleted: false,
        takenDown: false,
      },
      { grantRole: null, passwordPassed: false },
    );
    if (!d.allow) throw denialError(ctx, d, "data_write");
  } else {
    await requireArtifact(ctx, t.artifact.id, "data_write");
    if (await boardHasDocs(ctx.env.DB, t.artifact.id)) {
      throw new ApiError(
        "invalid_input",
        "This board already has blocks in its shared data: add, move or delete them with write_artifact_data",
        {
          type: "whiteboard",
          field: "content",
          reason: "board_not_empty",
          next: "Send board.json with settings only (no blocks or arrows), and change blocks with write_artifact_data",
        },
      );
    }
  }

  const measured: Measured[] = seed.map((s) => ({
    seed: s,
    ...measureDoc(ctx.config, s.collection, s.id, s.data, "whiteboard"),
  }));
  const bytes = measured.reduce((n, m) => n + m.size, 0);
  const artifactId = t.mode === "publish" ? t.artifactId : t.artifact.id;
  const ownerId = t.mode === "publish" ? t.ownerId : t.artifact.ownerId;
  const [usage, user] = await ctx.env.DB.batch<Record<string, unknown>>([
    ctx.env.DB.prepare("SELECT docs, bytes FROM artifact_data_usage WHERE artifact_id = ?1").bind(
      artifactId,
    ),
    ctx.env.DB.prepare(USER_BYTES_SQL).bind(ownerId),
  ]);
  const u = (usage?.results[0] as { docs: number; bytes: number } | undefined) ?? {
    docs: 0,
    bytes: 0,
  };
  const userBytes = Number((user?.results[0] as { total?: number } | undefined)?.total ?? 0);
  const limits = ctx.config.data.board;
  if (u.docs + measured.length > limits.maxDocsPerArtifact) throw quotaExceeded("docs");
  if (u.bytes + bytes > limits.maxBytesPerArtifact) throw quotaExceeded("bytes");
  if (userBytes + bytes > ctx.config.data.maxBytesPerUser) throw quotaExceeded("user_bytes");

  return { text, afterCommit: (result) => seedBoard(ctx, result, measured) };
}

/** Why a starting board was not written. */
export type SeedSkipped = "forbidden" | "not_empty" | "quota" | "gone" | "rate_limited" | "error";

const SKIP_MESSAGES: Record<SeedSkipped, string> = {
  forbidden:
    "The version is published, but its starting board was not written: you can no longer change this board's data",
  not_empty:
    "The version is published, but its starting board was not written: someone added blocks in the meantime. Read them with list_artifact_data",
  quota:
    "The version is published, but its starting board was not written: the board's shared data is full",
  gone: "The version is published, but its starting board was not written: the board is gone",
  error:
    "The version is published, but its starting board could not be written. Read the board with list_artifact_data and add what is missing with write_artifact_data",
  rate_limited:
    "The version is published, but its starting board was not written: too many changes to this board's data in the last hour. Add the blocks later with write_artifact_data",
};

function notSeeded(result: PublishResult, why: SeedSkipped): PublishResult {
  const warning: PublishWarning = {
    code: "board_not_seeded",
    file: "board.json",
    message: SKIP_MESSAGES[why],
  };
  return { ...result, warnings: [...result.warnings, warning] };
}

/**
 * Write a starting board into the artifact's shared data, after its version committed. The
 * data_write decision is made again on the artifact as it now is, and its role stamps every
 * document. One statement, so it counts once toward D1's per-invocation query limit: it inserts
 * every document or none (the board must still be live, still have no blocks or arrows, and stay
 * within the artifact's quotas, all judged on one snapshot). Each document's rev is one past the
 * artifact's change counter at that snapshot plus its index, and the insert trigger advances the
 * counter once per row, so the next write's rev is above every seeded one. `d` is bound as the
 * JSON text measureDoc measured, so the stored bytes are exactly the ones counted.
 */
export async function seedBoard(
  ctx: Ctx,
  result: PublishResult,
  measured: readonly Measured[],
): Promise<PublishResult> {
  let artifact: Awaited<ReturnType<typeof requireArtifact>>;
  try {
    artifact = await requireArtifact(ctx, result.id, "data_write");
  } catch {
    return notSeeded(result, "forbidden");
  }
  const d1 = ctx.env.DB;
  const config = ctx.config;
  try {
    const writer = await writerOf(ctx, artifact.artifact, artifact.role);
    try {
      await limitWrites(d1, config, result.id, writer.email);
    } catch (e) {
      if (e instanceof ApiError && e.code === "rate_limited") {
        return notSeeded(result, "rate_limited");
      }
      throw e;
    }
    const docs = JSON.stringify(
      measured.map((m) => ({ c: m.seed.collection, id: m.seed.id, d: m.json, n: m.size })),
    );
    const bytes = measured.reduce((n, m) => n + m.size, 0);
    const now = nowIso();
    const { results } = await d1
      .prepare(
        `WITH base AS MATERIALIZED (
           SELECT coalesce((SELECT seq FROM artifact_data_usage WHERE artifact_id = ?1), 0) AS s,
                  coalesce((SELECT docs FROM artifact_data_usage WHERE artifact_id = ?1), 0) AS d,
                  coalesce((SELECT bytes FROM artifact_data_usage WHERE artifact_id = ?1), 0) AS b)
         INSERT INTO artifact_docs (${DOC_INSERT_COLUMNS})
         SELECT ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.id'),
                json_extract(j.value, '$.d'), json_extract(j.value, '$.n'), base.s + 1 + j.key,
                ?3, ?4, ?5, ?6, ?7, ?3, ?4, ?5, ?6, ?7
           FROM json_each(?2) j, base
          WHERE ${ARTIFACT_LIVE_SQL}
            AND base.d + json_array_length(?2) <= ?8
            AND base.b + ?9 <= ?10
            AND NOT EXISTS (SELECT 1 FROM artifact_docs
                             WHERE artifact_id = ?1 AND collection IN ('blocks', 'arrows'))
         ON CONFLICT DO NOTHING
         RETURNING collection`,
      )
      .bind(
        result.id,
        docs,
        writer.email,
        writer.role,
        writer.via,
        writer.label ?? null,
        now,
        config.data.board.maxDocsPerArtifact,
        bytes,
        config.data.board.maxBytesPerArtifact,
      )
      .all<{ collection: string }>();
    if (results.length === 0) return notSeeded(result, await whyNotSeeded(ctx, result.id));
    // Open views of the board re-read its data (live views); only the signal travels.
    notifyViewers(ctx, result.id, "data");
    return {
      ...result,
      board: {
        blocks: results.filter((r) => r.collection === "blocks").length,
        arrows: results.filter((r) => r.collection === "arrows").length,
      },
    };
  } catch (e) {
    // The version is committed whatever happens here; the seed is best effort past its checks.
    console.error("board seed failed:", e instanceof Error ? e.name : "unknown");
    return notSeeded(result, "error");
  }
}

/** Why the seed statement wrote nothing (it raced another write, a deletion or the quota). */
async function whyNotSeeded(ctx: Ctx, artifactId: string): Promise<SeedSkipped> {
  const r = await ctx.env.DB.prepare(`SELECT ${ARTIFACT_LIVE_SQL} AS live`)
    .bind(artifactId)
    .first<{ live: number }>();
  if (!r?.live) return "gone";
  if (await boardHasDocs(ctx.env.DB, artifactId)) return "not_empty";
  return "quota";
}
