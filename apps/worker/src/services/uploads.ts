// Out-of-band uploads (docs/spec.md): start_upload mints a single-use, 30-minute ticket for one
// publish or one update with a stated base; POST /uploads/:id/bundle streams one tar through the
// bounded reader (bundle.ts) into the stager and commits in one guarded D1 batch that also turns
// the ticket from open to used. Nothing else consumes a ticket, so it commits at most once.
//
// The token is a capability for that one commit only: resolveBearer never accepts its prefix, so
// it cannot read anything, call /mcp or reach another route. It is stored as its SHA-256, sent only
// in a header, and dies with its connection (or with ADMIN_TOKEN and single-user mode).
import {
  ARTIFACT_ID_RE,
  type ArtifactEditing,
  type ArtifactType,
  type BundleResult,
  copyFilesSchema,
  LIMITS,
  type PublishResult,
  RATE_LIMITS,
  SCOPES,
  type Scope,
  type StartUploadInput,
  type StartUploadResult,
  TTL,
  typeDef,
  UPLOAD_TOKEN_PREFIX,
  type UploadStatus,
} from "@plinth/shared";
import { cliPublishReleased, isReleaseAtLeast, PLINTH_VERSION } from "../app/version.ts";
import { parseScopes } from "../auth/principal.ts";
import {
  appUrl,
  type Bindings,
  type Config,
  instanceLimits,
  maxBundleBytes,
  uploadTicketsPerHour,
} from "../config.ts";
import type { Db } from "../db/client.ts";
import { base64url, hashToken, newId, randomString, timingSafeEqual } from "../lib/crypto.ts";
import { ApiError, forbidden, notFound, unauthorized } from "../lib/errors.ts";
import { hit, peek } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { type Principal, seesOwnerMetadata } from "../policy.ts";
import { sweepSoon } from "./attempts.ts";
import { readBundle } from "./bundle.ts";
import { requireCategoryRight, resolveCategory } from "./categories.ts";
import { categoryShareResult, filingShareResult } from "./categoryShares.ts";
import type { Ctx } from "./context.ts";
import { type CopyPlan, copyRecords, resolveCopies, stageCopies } from "./copies.ts";
import {
  commitStaged,
  DB_NOW,
  enforcePublishRate,
  newArtifactTarget,
  openStager,
  type Stager,
  storageError,
  storageUsed,
  updateTarget,
  uploadTooSlow,
  type VersionTarget,
} from "./stage.ts";

/** The version-writing functions an upload uses (services/stage.ts). Tests pass their own. */
export interface StageDeps {
  newArtifactTarget: typeof newArtifactTarget;
  updateTarget: typeof updateTarget;
  enforcePublishRate: typeof enforcePublishRate;
  openStager: typeof openStager;
  commitStaged: typeof commitStaged;
}

export const stageDeps: StageDeps = {
  newArtifactTarget,
  updateTarget,
  enforcePublishRate,
  openStager,
  commitStaged,
};

/** A ticket row (upload_tickets, migration 0007). */
export interface TicketRow {
  id: string;
  token_hash: string;
  user_id: string;
  credential: "connection" | "admin";
  connection_id: string | null;
  admin_token_hash: string | null;
  scopes: string;
  mode: "publish" | "update";
  artifact_id: string | null;
  artifact_type: string;
  title: string | null;
  note: string | null;
  /** The category start_upload was given (migrations/0009_categories.sql); NULL = none given. */
  category: string | null;
  /** The copy_files start_upload was given, as JSON (migrations/0022); NULL = none. */
  copy_files: string | null;
  /** start_upload's `editing` (migrations/0023_artifact_editing.sql); NULL = none given. */
  editing: ArtifactEditing | null;
  base_version: number | null;
  state: "open" | "used" | "dead";
  /** Why a dead ticket ended: a version conflict, or a takedown of its artifact. */
  dead_reason: "conflict" | "taken_down" | null;
  attempts: number;
  receiving_claim: string | null;
  receiving_until: string | null;
  result_artifact_id: string | null;
  result_version: number | null;
  /** Publish mode: the id its commit creates, reserved at mint (target.id). */
  reserved_artifact_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** 20 lowercase letters and digits, like every row id (newId). */
export const UPLOAD_ID_RE = /^[a-z0-9]{20}$/;
/** plinth_up_ + 43 base64url characters (32 random bytes). */
export const UPLOAD_TOKEN_RE = new RegExp(`^${UPLOAD_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

const isoAt = (ms: number) => new Date(ms).toISOString();

function hasWriteScope(p: Principal): boolean {
  return p.kind === "agent" && p.scopes.has("artifacts:write");
}

// ---------- minting ----------

/**
 * start_upload (MCP) and POST /uploads (REST, bearer only). Checks run in the order of the spec:
 * scope, cross-field rules, the target (edit rights and a current base, or the artifact-count
 * pre-check), then the mint rate, so a refused request costs no rate hit.
 */
export async function startUpload(
  ctx: Ctx,
  input: StartUploadInput,
  deps: StageDeps = stageDeps,
): Promise<StartUploadResult> {
  const p = ctx.principal;
  if (p.kind !== "agent") {
    throw unauthorized(
      "start_upload takes a bearer token (OAuth access token, personal access token or ADMIN_TOKEN)",
    );
  }
  if (!hasWriteScope(p)) throw forbidden("This token lacks the artifacts:write scope");

  let target: VersionTarget;
  if (input.id !== undefined) {
    if (input.title !== undefined || input.type !== undefined) {
      throw new ApiError(
        "invalid_input",
        "title and type are for a new artifact; omit them with id",
        {
          field: input.title !== undefined ? "title" : "type",
          next: "Leave out title and type when you update an artifact",
        },
      );
    }
    if (input.base_version === undefined) {
      throw new ApiError("invalid_input", "base_version is required with id", {
        field: "base_version",
        next: "Pass the version you read with get_artifact as base_version (list_versions gives the current number without the page's files)",
      });
    }
    target = await deps.updateTarget(ctx, input.id, {
      baseVersion: input.base_version,
      note: input.note,
    });
    // The category is the owner's: refused for an editor before the mint rate hit.
    if (input.category !== undefined && target.mode === "update") {
      await requireCategoryRight(ctx, target.artifact);
      target.category = await resolveCategory(
        ctx,
        target.artifact.ownerId,
        input.category,
        target.artifact.id,
      );
    }
  } else {
    if (input.base_version !== undefined || input.note !== undefined) {
      throw new ApiError(
        "invalid_input",
        "base_version and note are for an update; pass id with them",
        {
          field: input.base_version !== undefined ? "base_version" : "note",
          next: "Pass id (and the base_version you read) to update an artifact, or leave both out to publish a new one",
        },
      );
    }
    target = await deps.newArtifactTarget(ctx, {
      type: input.type ?? "html",
      title: input.title,
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
  }

  // A type that takes no bundle (a whiteboard: board.json alone, its starting board checked and
  // written by the inline publish) is refused before the mint rate hit.
  const typeId = target.mode === "update" ? target.artifact.type : target.type;
  const def = typeDef(typeId);
  if (def?.upload === false) {
    throw new ApiError("invalid_input", `A ${def.id} is not uploaded as a bundle`, {
      type: def.id,
      field: "type",
      next: "Send board JSON inline in publish_artifact or update_artifact",
    });
  }
  const limit = uploadTicketsPerHour(ctx.config);
  const rate = await hit(ctx.env.DB, `upload:${p.userId}`, limit, 3600);
  if (!rate.allowed) {
    throw new ApiError("rate_limited", `Upload limit reached (${limit} per hour)`, {
      retry_after: rate.retryAfter,
      next: "Wait for the limit to reset, then call start_upload again",
    });
  }
  // Copies are authorized after the mint rate hit and before the ticket exists, so a ticket that
  // cannot copy is never minted; the bundle authorizes them again as the ticket's principal.
  if (input.copy_files !== undefined && def) await resolveCopies(ctx, input.copy_files, def);

  let credential: "connection" | "admin";
  let adminTokenHash: string | null = null;
  if (p.connectionId) {
    credential = "connection";
  } else if (ctx.config.singleUserMode && ctx.config.adminToken) {
    credential = "admin";
    adminTokenHash = await hashToken(ctx.config.adminToken);
  } else {
    throw unauthorized("start_upload needs an agent connection or the single-user ADMIN_TOKEN");
  }

  const id = newId();
  const token = `${UPLOAD_TOKEN_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const now = Date.now();
  const expiresAt = isoAt(now + TTL.uploadTicketMs);
  const update = target.mode === "update" ? target : null;
  const fresh = target.mode === "publish" ? target : null;
  const type: ArtifactType = update ? update.artifact.type : (fresh as { type: ArtifactType }).type;
  // A publish reserves its artifact id now, so a client whose bundle response is lost can ask
  // get_artifact(id) whether it was published.
  const targetId = update ? update.artifact.id : (fresh as { artifactId: string }).artifactId;
  await ctx.env.DB.prepare(
    `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id, admin_token_hash,
       scopes, mode, artifact_id, artifact_type, title, note, base_version, state, attempts,
       created_at, expires_at, reserved_artifact_id, category, copy_files, editing)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', 0, ?14, ?15, ?16, ?17, ?18, ?19)`,
  )
    .bind(
      id,
      await hashToken(token),
      p.userId,
      credential,
      p.connectionId,
      adminTokenHash,
      [...p.scopes].join(" "),
      target.mode,
      update ? update.artifact.id : null,
      type,
      target.mode === "publish" ? (input.title?.trim() ?? null) : null,
      update ? (input.note?.trim() ?? null) : null,
      update ? (input.base_version ?? null) : null,
      isoAt(now),
      expiresAt,
      fresh ? fresh.artifactId : null,
      target.category ?? null,
      input.copy_files !== undefined ? JSON.stringify(input.copy_files) : null,
      input.editing ?? null,
    )
    .run();
  // No cron under `wrangler dev`: clear abandoned attempts and old tickets here too (capped,
  // throttled).
  sweepSoon(ctx.env, ctx.waitUntil);

  const uploadUrl = appUrl(ctx.config, `/api/v1/uploads/${id}/bundle`);
  const npx = npxCommand(PLINTH_VERSION, token, uploadUrl);
  // A category on the ticket is the owner's (requireCategoryRight passed for an update): say the
  // state the commit will start in when that category is shared (pending; filing never shares).
  const share =
    target.category !== undefined
      ? await filingShareResult(
          ctx,
          update ? update.artifact.ownerId : p.userId,
          target.category,
          update ? update.artifact : null,
        )
      : undefined;
  return {
    ...(share ? { category_share: share } : {}),
    upload_id: id,
    upload_token: token,
    expires_at: expiresAt,
    upload_url: uploadUrl,
    target: update
      ? {
          mode: "update",
          id: update.artifact.id,
          slug: update.artifact.slug,
          type,
          base_version: input.base_version as number,
          visibility: update.artifact.visibility,
        }
      : { mode: "publish", id: targetId, type },
    limits: instanceLimits(ctx.config),
    content_isolation: ctx.config.contentIsolation,
    commands: { curl: curlCommand(token, uploadUrl), ...(npx ? { npx } : {}) },
    next: uploadNext({
      sourcePath: sourceNames(type),
      id: targetId,
      baseVersion: update ? (input.base_version as number) : null,
      visibility: update?.artifact.visibility ?? null,
      opaque: ctx.config.contentIsolation === "opaque",
      npx: npx !== null,
    }),
  };
}

/** The archive part of commands.curl (and of the hints that point at it). */
export const TAR_PIPE = "COPYFILE_DISABLE=1 tar --exclude='*.map' -cf - . | gzip -c";

/**
 * The bundle request as one shell line (bash or zsh). The token reaches curl through a process
 * substitution read by `-H @file`, so it is never in curl's argv; printf is a shell builtin.
 * The tar goes through gzip rather than `tar -z`: bsdtar (macOS) pads `tar -czf -` with NUL
 * bytes past the gzip member when it writes to a pipe (the server tolerates that too).
 * COPYFILE_DISABLE stops macOS adding `._*` AppleDouble entries, and source maps stay out, as
 * the CLI leaves them out.
 */
export function curlCommand(token: string, uploadUrl: string): string {
  return (
    `cd <folder> && ${TAR_PIPE} | curl -sS --fail-with-body --max-time 600 -A plinth-agent/1 ` +
    `-H @<(printf 'Authorization: Bearer %s' '${token}') ` +
    `-H 'Content-Type: application/gzip' --data-binary @- '${uploadUrl}'`
  );
}

export { isReleaseAtLeast };

/** The CLI form, offered only on release builds that ship `plinth upload` (macOS and Linux). */
export function npxCommand(version: string, token: string, uploadUrl: string): string | null {
  if (!cliPublishReleased(version)) return null;
  return `PLINTH_UPLOAD_TOKEN='${token}' npx -y @mr0b0t0/plinth@${version} upload <folder> --to '${uploadUrl}'`;
}

/** The source file(s) a type's build folder has at its top: "slides.md or deck.json" for a deck. */
function sourceNames(type: string): string {
  const def = typeDef(type);
  if (!def) return "index.html";
  return def.altSource ? `${def.sourcePath} or ${def.altSource.path}` : def.sourcePath;
}

export function uploadNext(o: {
  sourcePath: string;
  /** The artifact: the update's target, or the id the publish will create. */
  id: string;
  /** The update's base version; null for a publish. */
  baseVersion: number | null;
  visibility: string | null;
  opaque: boolean;
  npx: boolean;
}): string {
  const parts = [
    `Replace <folder> with the build folder (the one with ${o.sourcePath} at its top), then run ` +
      "commands.curl in bash or zsh with a shell timeout of at least 10 minutes" +
      (o.npx ? " (or commands.npx where Node is available)" : "") +
      ". It prints JSON: give the user its url.",
    "If it lists warnings, fix them and publish again with a new start_upload; not_scanned and live_draft need no action.",
    lostResponseNext(o.id, o.baseVersion),
    "The token works once, for 30 minutes; never put it in a URL, a file or a message.",
  ];
  if (o.visibility) {
    parts.push(`This replaces the live page at its current visibility (${o.visibility}).`);
  }
  if (o.opaque) {
    parts.push(
      "This instance runs opaque isolation: module scripts, crossorigin links and web fonts fail. " +
        "Build a classic bundle (Vite: build.modulePreload false and an iife/legacy output).",
    );
  }
  return parts.join(" ");
}

/**
 * What to do when the bundle request ends without its JSON answer (a curl error, a timeout). Once
 * the whole body was read, the request may have committed; before that it never did. The upload's
 * own status is the check that tells this upload's commit apart from a collaborator's version.
 */
export function lostResponseNext(id: string, baseVersion: number | null): string {
  const again =
    "call start_upload again" +
    (baseVersion === null ? "" : ` with the same base_version ${baseVersion}`);
  return (
    "If the command ends without JSON (a curl error or a timeout), do not run it again blindly. " +
    "Ask the upload first: GET the upload_url without /bundle, with the same Authorization header " +
    "(state used: this upload published that version, give the user its url; dead: someone else " +
    "published first and this change was not saved, so read the artifact again; receiving: still " +
    "running, ask again in a few seconds; taken_down: the artifact was taken down and nothing was " +
    `published, tell the user; open, expired or exhausted: nothing was published, ${again}). ` +
    `If the upload cannot be read, call get_artifact with id ${id}: ` +
    (baseVersion === null
      ? `if it exists, this upload created it; if it is not_found, nothing was published, so ${again}. `
      : `if it is still version ${baseVersion}, nothing was published, so ${again}; version ` +
        `${baseVersion + 1} may be a collaborator's, so compare its files with what you sent before ` +
        `you call it yours; past ${baseVersion + 1}, others published too, so check with ` +
        "list_versions and compare before you claim any of it. ") +
    "This upload can never commit twice: sending it again after it committed answers upload_used with the url."
  );
}

// ---------- redeeming ----------

/** What the bundle request needs from the Worker; built by the route, never from cookies. */
export interface BundleEnv {
  env: Bindings;
  config: Config;
  db: Db;
  ip: string | null;
  waitUntil: (p: Promise<unknown>) => void;
}

export interface BundleRequest {
  uploadId: string;
  /** The Authorization header as sent. */
  authorization: string | undefined;
  /** The Content-Length header as sent. */
  contentLength: string | undefined;
  body: ReadableStream<Uint8Array> | null;
  /**
   * The request's signal (compatibility flag enable_request_signal): it aborts when the client
   * disconnects, and the attempt's cleanup is then handed to waitUntil, which outlives the
   * request; an `await` in the handler may be cancelled with it.
   */
  signal?: AbortSignal;
}

/** The upload-token check: format first (no database), so strangers learn nothing. */
export function bundleToken(authorization: string | undefined): string {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const token = m?.[1];
  if (!token?.startsWith(UPLOAD_TOKEN_PREFIX)) {
    throw unauthorized("This endpoint takes the upload token from start_upload");
  }
  return token;
}

/**
 * POST /uploads/:id/bundle. Takes a receiving lease (concurrency only), rebuilds the minting
 * principal from a live credential with current rights, then streams and commits. The ticket is
 * consumed only inside commitStaged's batch.
 */
export async function redeemBundle(
  w: BundleEnv,
  req: BundleRequest,
  deps: StageDeps = stageDeps,
): Promise<{ status: 200 | 201; body: BundleResult }> {
  const token = bundleToken(req.authorization);
  const maxBundle = maxBundleBytes(w.config);
  if (req.contentLength !== undefined) {
    const declared = Number(req.contentLength);
    if (Number.isFinite(declared) && declared > maxBundle) {
      throw new ApiError(
        "payload_too_large",
        `The bundle is over ${Math.round((maxBundle / 1024 / 1024) * 10) / 10} MB`,
        {
          limit_bytes: maxBundle,
          size_bytes: declared,
          next: "Leave out source maps (*.map) and files the page does not load, and gzip the tar (the commands.curl from start_upload does both)",
        },
      );
    }
  }
  await refuseGuessers(w);
  if (!UPLOAD_ID_RE.test(req.uploadId) || !UPLOAD_TOKEN_RE.test(token)) throw await uploadMiss(w);
  const tokenHash = await hashToken(token);
  const claim = randomString(24);
  const ticket = await takeLease(w, req.uploadId, tokenHash, claim);
  sweepSoon(w.env, w.waitUntil);
  // The bundle must arrive within the receiving lease: past it another request may take the
  // lease, and the staging sweep's threshold assumes no attempt commits after its ticket's lifetime.
  // The commit batch also requires the lease (CommitOptions.receivingClaim).
  const deadline = Date.parse(ticket.receiving_until ?? "") || Date.now() + TTL.uploadReceivingMs;

  let stager: Stager | null = null;
  let committing = false;
  // Cleanup runs once: on a failure, or as soon as the client disconnects (the body read may
  // only fail later, or the invocation may be cancelled first). It goes through waitUntil so it
  // finishes even when the request does not. Once the commit has begun, commitStaged owns it.
  let abortedStager: Stager | null = null;
  let released: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    const tasks: Promise<unknown>[] = [];
    if (stager && !committing && abortedStager !== stager) {
      abortedStager = stager;
      tasks.push(stager.abort().catch(() => undefined));
    }
    released ??= releaseLease(w, ticket.id, claim);
    tasks.push(released);
    const done = Promise.all(tasks).then(() => undefined);
    w.waitUntil(done);
    return done;
  };
  const onDisconnect = () => {
    if (!committing) void cleanup();
  };
  req.signal?.addEventListener("abort", onDisconnect, { once: true });
  const inTime = () => {
    if (Date.now() > deadline) throw tooSlow();
  };
  let stopClock = () => {};
  try {
    const ctx = await ticketCtx(w, ticket);
    if (!req.body) {
      throw new ApiError("invalid_input", "Send the tar as the request body", {
        next: `cd <folder> && ${TAR_PIPE} | curl ... --data-binary @- (the commands.curl from start_upload)`,
      });
    }
    const def = typeDef(ticket.artifact_type);
    if (!def)
      throw new ApiError(
        "feature_disabled",
        "This artifact's type is not supported by this instance",
      );
    const limit = 2 * w.config.maxPublishesPerHour;
    const rate = await hit(w.env.DB, `bundle:${ticket.user_id}`, limit, 3600);
    if (!rate.allowed) {
      throw new ApiError("rate_limited", `Bundle limit reached (${limit} per hour)`, {
        retry_after: rate.retryAfter,
        next: "Wait for the limit to reset, then send the bundle again (the ticket keeps its remaining attempts)",
      });
    }
    const target = await ticketTarget(ctx, ticket, deps);
    await deps.enforcePublishRate(ctx);
    // The ticket's copies, authorized again as the ticket's principal, after the rate hits and
    // before the stager opens.
    const copies = await ticketCopies(ctx, ticket, def);
    // An account already at its quota stages nothing; below it, the stager refuses puts past the
    // room left, so an abandoned attempt cannot leave more than that behind.
    const ownerId = target.mode === "update" ? target.artifact.ownerId : ticket.user_id;
    const storageLimit = w.config.maxStorageBytesPerUser;
    const used = await storageUsed(ctx, ownerId);
    if (used >= storageLimit) throw storageError(storageLimit, used, 0);
    stager = await deps.openStager(ctx, target, { storageRoom: { limit: storageLimit, used } });
    if (req.signal?.aborted) throw new ApiError("invalid_input", "The client went away");
    const staging = stager;
    // A sender that goes quiet is cut off at the deadline, not only checked between files.
    const timed = withDeadline(req.body, deadline);
    stopClock = timed.stop;
    const reader = readBundle(timed.stream, {
      maxRawBytes: maxBundle,
      maxInflatedBytes: maxBundle,
      maxTotalBytes: w.config.maxVersionBytes,
      maxFileBytes: LIMITS.maxBundleFileBytes,
      maxEntries: w.config.maxAssetsPerVersion + 1,
      maxMetaBytes: LIMITS.maxTarMetaBytes,
      sourcePath: def.sourcePath,
      ...(def.altSource ? { altSourcePath: def.altSource.path } : {}),
      reserve: (size) => staging.reserve(size),
    });
    for await (const entry of reader) {
      inTime();
      await stager.add(entry.path, entry.bytes);
    }
    stopClock();
    // Beside the bundle's files, at their own paths (a prefix strip never moves them).
    await stageCopies(stager, copies);
    inTime();
    const staged = await stager.finish(
      reader.summary.strippedPrefix ? { stripPrefix: reader.summary.strippedPrefix } : undefined,
    );
    // Rights are checked again once every file is written, right before the commit: a connection
    // revoked or an editor removed while the bundle streamed or finish settled its puts stops it
    // (the batch also re-checks the connection). What is left is the commit's own reads, the same
    // window as any publish.
    const fresh = await ticketCtx(w, ticket);
    await ticketTarget(fresh, ticket, deps, target);
    inTime();
    // A disconnect while finish settled its last puts already started the cleanup: never commit
    // after it. Synchronous from here into commitStaged, which takes the stager's point of no
    // abort before its first await; from then on commitStaged owns cleanup.
    if (abortedStager !== null || req.signal?.aborted) {
      throw new ApiError("invalid_input", "The client went away");
    }
    committing = true;
    const result: PublishResult = await deps.commitStaged(ctx, target, staged, {
      ticketId: ticket.id,
      receivingClaim: claim,
    });
    // The owner's own upload only: an editor's update ticket carries nothing about the owner's
    // category sharing.
    const share = await categoryShareResult(
      w.env.DB,
      w.config,
      result.id,
      seesOwnerMetadata(
        fresh.principal,
        target.mode === "publish" ? "owner" : (target.role ?? null),
      ),
    );
    const copied = copyRecords(copies);
    return {
      status: ticket.mode === "publish" ? 201 : 200,
      body: {
        ...result,
        ...(copied ? { copied_from: copied } : {}),
        ...(share ? { category_share: share } : {}),
        // Only the uploader that minted the ticket reads this, and only an owner can set it.
        ...(target.category !== undefined ? { category: target.category } : {}),
        bundle: {
          entries: reader.summary.entries,
          skipped: reader.summary.skipped,
          stripped_prefix: reader.summary.strippedPrefix,
        },
      },
    };
  } catch (e) {
    await cleanup();
    throw await afterFailure(w, ticket, tokenHash, e);
  } finally {
    stopClock();
    req.signal?.removeEventListener("abort", onDisconnect);
  }
}

/** A ticket's copy_files, authorized as `ctx` (the ticket's principal now), or null. */
async function ticketCopies(
  ctx: Ctx,
  t: TicketRow,
  def: NonNullable<ReturnType<typeof typeDef>>,
): Promise<CopyPlan | null> {
  if (t.copy_files === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(t.copy_files);
  } catch {
    raw = null;
  }
  const parsed = copyFilesSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("internal", "The upload's copy_files cannot be read");
  return resolveCopies(ctx, parsed.data, def);
}

const tooSlow = uploadTooSlow;

/** How often a waiting body read looks at the clock (the deadline is re-read, never cached). */
const DEADLINE_CHECK_MS = 1000;

/**
 * The body, cut off with upload_too_slow once `deadline` passes while a read waits: a sender that
 * declares a file and then goes quiet holds the request and its buffers only until then.
 */
function withDeadline(
  body: ReadableStream<Uint8Array>,
  deadline: number,
): { stream: ReadableStream<Uint8Array>; stop: () => void } {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const expired = (): Promise<never> =>
    new Promise<never>((_, fail) => {
      const check = () => {
        if (stopped) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          fail(tooSlow());
          return;
        }
        timer = setTimeout(check, Math.min(left, DEADLINE_CHECK_MS));
      };
      timer = setTimeout(check, Math.min(Math.max(deadline - Date.now(), 0), DEADLINE_CHECK_MS));
    });
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await Promise.race([reader.read(), expired()]);
        } catch (e) {
          reader.cancel(e).catch(() => undefined);
          throw e;
        } finally {
          clearTimeout(timer);
        }
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel(reason) {
        stop();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stop };
}

const MISS_WINDOW_S = 3600;
const missKey = (ip: string) => `upload-miss:ip:${ip}`;

/**
 * Refuses an address that has named too many dead tickets this hour, before any ticket lookup:
 * the bundle and status routes run before authentication, so the per-user limits cannot apply.
 */
async function refuseGuessers(w: Pick<BundleEnv, "env" | "ip">): Promise<void> {
  if (!w.ip) return;
  if (
    (await peek(w.env.DB, missKey(w.ip), MISS_WINDOW_S)) >= RATE_LIMITS.uploadMissesPerIpPerHour
  ) {
    throw new ApiError("rate_limited", "Too many requests for unknown uploads, try again later");
  }
}

/** A request that named no live ticket: count it against its address, then answer not found. */
async function uploadMiss(w: Pick<BundleEnv, "env" | "ip">): Promise<ApiError> {
  if (w.ip) await hit(w.env.DB, missKey(w.ip), RATE_LIMITS.uploadMissesPerIpPerHour, MISS_WINDOW_S);
  return notFound("Upload");
}

/**
 * Whether the credential that minted the ticket is still live: its connection unrevoked, or (for
 * an ADMIN_TOKEN ticket) the same token in single-user mode for the admin user. The same test as
 * ticketCtx, which the bundle route runs before staging; the status route answers 404 otherwise,
 * so the token dies with its connection there too.
 */
async function credentialLive(
  w: Pick<BundleEnv, "env" | "config">,
  t: TicketRow,
): Promise<boolean> {
  if (t.credential === "connection") {
    const row = await w.env.DB.prepare(
      "SELECT 1 AS one FROM agent_connections WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
    )
      .bind(t.connection_id, t.user_id)
      .first();
    return row !== null;
  }
  const c = w.config;
  if (!c.singleUserMode || !c.adminToken || !t.admin_token_hash) return false;
  if (!timingSafeEqual(await hashToken(c.adminToken), t.admin_token_hash)) return false;
  const user = await w.env.DB.prepare("SELECT email FROM users WHERE id = ?1")
    .bind(t.user_id)
    .first<{ email: string }>();
  return !!user && user.email === c.adminEmails[0];
}

/**
 * The receiving lease: one statement that counts the attempt and takes the lease only while the
 * ticket is open, unexpired, has attempts left, is not already receiving, and no other ticket of
 * the same user is receiving. On failure the ticket is re-read to say why.
 */
async function takeLease(
  w: BundleEnv,
  id: string,
  tokenHash: string,
  claim: string,
): Promise<TicketRow> {
  const now = Date.now();
  const nowS = isoAt(now);
  const row = await w.env.DB.prepare(
    `UPDATE upload_tickets SET attempts = attempts + 1, receiving_claim = ?3, receiving_until = ?4
      WHERE id = ?1 AND token_hash = ?2 AND state = 'open' AND expires_at > ?5 AND attempts < ?6
        AND (receiving_until IS NULL OR receiving_until < ?5)
        AND NOT EXISTS (SELECT 1 FROM upload_tickets o
                         WHERE o.user_id = upload_tickets.user_id AND o.id <> ?1
                           AND o.state = 'open' AND o.receiving_until > ?5)
      RETURNING *`,
  )
    .bind(id, tokenHash, claim, isoAt(now + TTL.uploadReceivingMs), nowS, LIMITS.maxTicketAttempts)
    .first<TicketRow>();
  if (row) return row;
  const cur = await readTicket(w, id, tokenHash);
  if (!cur) throw await uploadMiss(w);
  throw await stateError(w, cur);
}

/** The ticket, with D1's clock at the read (`db_now`, the format of receiving_until). */
async function readTicket(
  w: Pick<BundleEnv, "env">,
  id: string,
  tokenHash: string,
): Promise<(TicketRow & { db_now: string }) | null> {
  return w.env.DB.prepare(
    `SELECT *, ${DB_NOW} AS db_now FROM upload_tickets WHERE id = ?1 AND token_hash = ?2`,
  )
    .bind(id, tokenHash)
    .first<TicketRow & { db_now: string }>();
}

/** Why a ticket cannot take a bundle now (it exists and the token matches). */
async function stateError(w: BundleEnv, t: TicketRow): Promise<ApiError> {
  if (t.state === "used") {
    const a = t.result_artifact_id
      ? await w.env.DB.prepare("SELECT slug FROM artifacts WHERE id = ?1")
          .bind(t.result_artifact_id)
          .first<{ slug: string }>()
      : null;
    return new ApiError("conflict", "This upload was already used", {
      reason: "upload_used",
      id: t.result_artifact_id,
      version: t.result_version,
      url: a ? appUrl(w.config, `/a/${a.slug}`) : null,
      next: "The bundle is published; give the user this url. For another change, call start_upload again",
    });
  }
  if (t.state === "dead" && t.dead_reason === "taken_down") return takenDownError();
  if (t.state === "dead") {
    return new ApiError("conflict", "This upload can no longer be used", {
      reason: "upload_dead",
      next: "Read the artifact again (get_artifact), then call start_upload with the new base_version",
    });
  }
  if (t.expires_at <= nowIso()) {
    return new ApiError("invalid_input", "This upload expired", {
      reason: "upload_expired",
      next: "Call start_upload again",
    });
  }
  if (t.attempts >= LIMITS.maxTicketAttempts) {
    return new ApiError(
      "invalid_input",
      `This upload was tried ${LIMITS.maxTicketAttempts} times`,
      {
        reason: "upload_exhausted",
        next: "Call start_upload again",
      },
    );
  }
  // The lease that blocks this one: this ticket's own, or another ticket of the same user's.
  const other = await w.env.DB.prepare(
    `SELECT max(receiving_until) AS until FROM upload_tickets
      WHERE user_id = ?1 AND state = 'open' AND receiving_until > ?2`,
  )
    .bind(t.user_id, nowIso())
    .first<{ until: string | null }>();
  const until = other?.until ?? null;
  return new ApiError("conflict", "Another upload of yours is in progress; wait for it", {
    reason: "upload_running",
    receiving_until: until,
    retry_after: until ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000)) : null,
    next:
      "Wait for the other bundle request to finish, then send this one again" +
      (until ? ` (its lease ends at ${until} at the latest)` : ""),
  });
}

/** Give the lease back, only if this request still holds it. */
async function releaseLease(w: BundleEnv, id: string, claim: string): Promise<void> {
  await w.env.DB.prepare(
    `UPDATE upload_tickets SET receiving_until = NULL, receiving_claim = NULL
      WHERE id = ?1 AND receiving_claim = ?2`,
  )
    .bind(id, claim)
    .run()
    .catch(() => undefined);
}

/** A ticket whose artifact was taken down: nothing was published, and nothing more can be. */
function takenDownError(): ApiError {
  return new ApiError("forbidden", "This artifact was taken down", {
    reason: "taken_down",
    next: "Nothing was published, and this artifact takes no new versions: tell the user. Do not resend it or start a new upload for it",
  });
}

/**
 * The error a failed bundle request returns. A version conflict (no reason, or reason
 * "conflict") and a takedown end the ticket, with that reason kept in dead_reason (guarded on
 * state 'open', so it can never overwrite 'used'); a ticket another request used in the meantime
 * is reported as upload_used. Every other failure, attempt_expired included, keeps its own reason
 * and next and leaves the ticket open for its remaining attempts.
 */
async function afterFailure(
  w: BundleEnv,
  ticket: TicketRow,
  tokenHash: string,
  e: unknown,
): Promise<unknown> {
  if (!(e instanceof ApiError)) return e;
  const details = (e.details ?? {}) as Record<string, unknown>;
  const reason = typeof details.reason === "string" ? details.reason : null;
  const versionConflict = e.code === "conflict" && (reason === null || reason === "conflict");
  const takenDown = reason === "taken_down";
  if (versionConflict || takenDown) {
    await w.env.DB.prepare(
      "UPDATE upload_tickets SET state = 'dead', dead_reason = ?2 WHERE id = ?1 AND state = 'open'",
    )
      .bind(ticket.id, takenDown ? "taken_down" : "conflict")
      .run();
  }
  if (e.code === "conflict" || takenDown || reason?.startsWith("upload_")) {
    const cur = await readTicket(w, ticket.id, tokenHash);
    if (cur?.state === "used") return stateError(w, cur);
  }
  if (takenDown) return takenDownError();
  if (versionConflict) {
    const current = typeof details.current_version === "number" ? details.current_version : null;
    return new ApiError("conflict", e.message, {
      ...details,
      reason: "conflict",
      next:
        current !== null
          ? `v${current} is current; check what changed (get_artifact), then start_upload again with base_version ${current}`
          : "Check what changed (get_artifact), then start_upload again with the new base_version",
    });
  }
  return e;
}

/**
 * The minting principal, rebuilt from a live credential with current rights, in an explicit Ctx:
 * no cookies, no password passes, no viewer email. Every later check runs through policy.ts.
 */
async function ticketCtx(w: BundleEnv, t: TicketRow): Promise<Ctx> {
  const minted = parseScopes(t.scopes);
  let principal: Principal;
  if (t.credential === "connection") {
    const row = await w.env.DB.prepare(
      `SELECT c.id, c.label, c.client_type, c.scopes, c.artifact_id, u.email FROM agent_connections c
         JOIN users u ON u.id = c.user_id
        WHERE c.id = ?1 AND c.user_id = ?2 AND c.revoked_at IS NULL`,
    )
      .bind(t.connection_id, t.user_id)
      .first<{
        id: string;
        label: string;
        client_type: string;
        scopes: string;
        artifact_id: string | null;
        email: string;
      }>();
    if (!row) throw unauthorized("The connection that started this upload was revoked");
    const current = parseScopes(row.scopes);
    principal = {
      kind: "agent",
      userId: t.user_id,
      email: row.email,
      connectionId: row.id,
      connectionLabel: row.label,
      clientType: row.client_type as "claude" | "codex" | "other",
      scopes: new Set([...minted].filter((s) => current.has(s))),
      // From the live row, so a ticket never carries more than its token (issue #51).
      boundArtifactId: row.artifact_id,
    };
  } else {
    const c = w.config;
    const ok =
      c.singleUserMode &&
      !!c.adminToken &&
      !!t.admin_token_hash &&
      timingSafeEqual(await hashToken(c.adminToken), t.admin_token_hash);
    const user = ok
      ? await w.env.DB.prepare("SELECT email FROM users WHERE id = ?1")
          .bind(t.user_id)
          .first<{ email: string }>()
      : null;
    if (!user || user.email !== c.adminEmails[0]) {
      throw unauthorized("The ADMIN_TOKEN that started this upload is no longer valid");
    }
    principal = {
      kind: "agent",
      userId: t.user_id,
      email: user.email,
      connectionId: null,
      connectionLabel: "Admin token",
      clientType: "other",
      scopes: new Set<Scope>([...minted].filter((s) => (SCOPES as readonly string[]).includes(s))),
      boundArtifactId: null,
    };
  }
  return {
    env: w.env,
    config: w.config,
    db: w.db,
    principal,
    passwordPasses: new Map(),
    viewerEmail: null,
    ip: w.ip,
    waitUntil: w.waitUntil,
  };
}

/** The ticket's target, re-checked now: edit rights and the stated base, or a fresh artifact. */
/**
 * The ticket's target. With `staged` (the target the attempt is staging into), only re-checks the
 * rights for it with the current principal: edit rights and the base for an update, the write
 * scope for a publish.
 */
async function ticketTarget(
  ctx: Ctx,
  t: TicketRow,
  deps: StageDeps,
  staged?: VersionTarget,
): Promise<VersionTarget> {
  if (staged?.mode === "publish") {
    if (!hasWriteScope(ctx.principal)) {
      throw forbidden("This token lacks the artifacts:write scope");
    }
    return staged;
  }
  if (t.mode === "update") {
    if (!t.artifact_id || !ARTIFACT_ID_RE.test(t.artifact_id) || t.base_version === null) {
      throw notFound();
    }
    const target = await deps.updateTarget(ctx, t.artifact_id, {
      baseVersion: t.base_version,
      note: t.note ?? undefined,
    });
    if (target.mode !== "update" || target.artifact.id !== t.artifact_id) throw notFound();
    if (t.category !== null) {
      // Re-checked with the current principal: an owner's ticket keeps the right only while
      // they own the artifact. Snapped again, so the owner's current spelling wins.
      await requireCategoryRight(ctx, target.artifact);
      target.category = await resolveCategory(
        ctx,
        target.artifact.ownerId,
        t.category,
        target.artifact.id,
      );
    }
    if (t.editing !== null) target.editing = t.editing;
    return target;
  }
  if (!hasWriteScope(ctx.principal)) throw forbidden("This token lacks the artifacts:write scope");
  return deps.newArtifactTarget(ctx, {
    type: t.artifact_type as ArtifactType,
    title: t.title ?? undefined,
    ...(t.category !== null ? { category: t.category } : {}),
    ...(t.editing !== null ? { editing: t.editing } : {}),
    ...(t.reserved_artifact_id ? { artifactId: t.reserved_artifact_id } : {}),
  });
}

// ---------- status ----------

/**
 * GET /uploads/:id with the upload token: whether the upload committed. For a client whose bundle
 * response was lost; it reads one row, counts no attempt and takes no lease.
 */
export async function uploadStatus(
  w: Pick<BundleEnv, "env" | "config" | "ip">,
  req: { uploadId: string; authorization: string | undefined },
): Promise<UploadStatus> {
  const token = bundleToken(req.authorization);
  await refuseGuessers(w);
  if (!UPLOAD_ID_RE.test(req.uploadId) || !UPLOAD_TOKEN_RE.test(token)) throw await uploadMiss(w);
  // The row and D1's clock in one read: a bundle request's commit requires its lease by the same
  // clock, so a lease reported over here can no longer commit.
  const t = await readTicket(w, req.uploadId, await hashToken(token));
  // Past the status window the ticket answers like one that never existed (its row is deleted
  // by the next cleanup anyway).
  // A revoked connection or a rotated ADMIN_TOKEN ends the token here as on the bundle route.
  if (
    !t ||
    Date.parse(t.expires_at) + TTL.uploadStatusMs < Date.parse(t.db_now) ||
    !(await credentialLive(w, t))
  ) {
    throw await uploadMiss(w);
  }
  const id =
    (t.mode === "update" ? t.artifact_id : (t.result_artifact_id ?? t.reserved_artifact_id)) ?? "";
  const now = t.db_now;
  let url: string | null = null;
  let share: UploadStatus["category_share"];
  if (t.state === "used" && t.result_artifact_id) {
    const a = await w.env.DB.prepare(
      `SELECT slug, owner_id,
              (?2 IS NOT NULL AND EXISTS (SELECT 1 FROM agent_connections
                                           WHERE id = ?2 AND artifact_id IS NOT NULL)) AS bound
         FROM artifacts WHERE id = ?1`,
    )
      .bind(t.result_artifact_id, t.connection_id)
      .first<{ slug: string; owner_id: string; bound: number }>();
    url = a ? appUrl(w.config, `/a/${a.slug}`) : null;
    // Only the owner's own ticket (not an editor's, not a token limited to one artifact) learns
    // where the artifact stands in the owner's shared category.
    share = a
      ? await categoryShareResult(
          w.env.DB,
          w.config,
          t.result_artifact_id,
          t.user_id === a.owner_id && !a.bound,
        )
      : undefined;
  }
  const receiving =
    t.receiving_until !== null && t.receiving_until > now ? t.receiving_until : null;
  // A takedown ends the upload for good: one that already failed on it keeps the reason, and an
  // update whose artifact is down now can no longer commit (the version insert requires it up).
  const takenDown =
    t.state !== "used" &&
    (t.dead_reason === "taken_down" ||
      (t.state === "open" &&
        t.mode === "update" &&
        (await w.env.DB.prepare(
          "SELECT 1 AS one FROM artifacts WHERE id = ?1 AND taken_down_at IS NOT NULL",
        )
          .bind(t.artifact_id)
          .first()) !== null));
  const state: UploadStatus["state"] = takenDown
    ? "taken_down"
    : t.state !== "open"
      ? t.state
      : receiving
        ? "receiving"
        : t.expires_at <= now
          ? "expired"
          : t.attempts >= LIMITS.maxTicketAttempts
            ? "exhausted"
            : "open";
  const next = {
    used: "It was published: give the user the url. For another change, call start_upload again",
    receiving:
      "A bundle request for this upload is still running: check again in a few seconds" +
      ` (its lease ends at ${receiving} at the latest)`,
    open: "Nothing was published with this upload yet: send the bundle again (it commits at most once)",
    dead: "Someone published in between, so this upload ended: read the artifact again (get_artifact), then start_upload with the new base_version",
    taken_down:
      "The artifact was taken down, so nothing was published with this upload and it takes no new versions: tell the user. Do not resend it or start a new upload for it",
    expired: "Nothing was published with this upload, and it expired: call start_upload again",
    exhausted: `Nothing was published with this upload, and its ${LIMITS.maxTicketAttempts} attempts are used: call start_upload again`,
  }[state];
  return {
    upload_id: t.id,
    state,
    mode: t.mode,
    id,
    version: t.state === "used" ? t.result_version : null,
    url,
    expires_at: t.expires_at,
    receiving_until: takenDown ? null : receiving,
    next,
    ...(share ? { category_share: share } : {}),
  };
}
