// A stand-in for services/stage.ts in the upload tests, until the server-core work lands the real
// stager. It keeps the parts of the contract the upload code relies on and nothing more:
// - targets go through the real requireArtifact (policy.ts), with the early base check;
// - the stager puts each file to R2 under a unique attempt prefix and abort() deletes that prefix;
// - commitStaged consumes the ticket with the same guarded statement the real batch carries
//   (open -> used, only while open and unexpired), aborts on failure, and records each commit.
// Hooks let a test pause a stream mid-way or fail a step.
import { env } from "cloudflare:workers";
import type { ArtifactType, PublishResult } from "@plinth/shared";
import { appUrl, contentOrigin } from "../../../src/config.ts";
import { newArtifactId, randomString } from "../../../src/lib/crypto.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { nowIso } from "../../../src/lib/time.ts";
import { requireArtifact } from "../../../src/services/artifacts.ts";
import type { Ctx } from "../../../src/services/context.ts";
import type { StagedVersion, Stager, VersionTarget } from "../../../src/services/stage.ts";
import { deletePrefix } from "../../../src/services/storage.ts";
import type { StageDeps } from "../../../src/services/uploads.ts";

export interface FakeLog {
  /** Every Ctx a stage function was called with. */
  ctxs: Ctx[];
  targets: VersionTarget[];
  /** Paths added, per stager prefix. */
  added: Map<string, string[]>;
  aborted: string[];
  finished: { prefix: string; stripPrefix?: string }[];
  commits: { ticketId?: string; artifactId: string; version: number; prefix: string }[];
  publishRateCalls: number;
}

export interface FakeOptions {
  /** Called before each add; a test may await something here to hold the stream. */
  beforeAdd?: (path: string, prefix: string) => Promise<void> | void;
  /** Called before commitStaged runs its batch. */
  beforeCommit?: (prefix: string) => Promise<void> | void;
  /** Make commitStaged report a version conflict instead of upload_used when the ticket is gone. */
  conflictWhenUsed?: boolean;
}

export function fakeStage(opts: FakeOptions = {}): { deps: StageDeps; log: FakeLog } {
  const log: FakeLog = {
    ctxs: [],
    targets: [],
    added: new Map(),
    aborted: [],
    finished: [],
    commits: [],
    publishRateCalls: 0,
  };
  const bucket = env.FILES;

  const deps: StageDeps = {
    async newArtifactTarget(ctx, input) {
      log.ctxs.push(ctx);
      const p = ctx.principal;
      if (p.kind !== "agent" && p.kind !== "user") throw new ApiError("unauthorized", "Sign in");
      if (p.kind === "agent" && !p.scopes.has("artifacts:write")) {
        throw new ApiError("forbidden", "This token lacks the artifacts:write scope");
      }
      const t: VersionTarget = {
        mode: "publish",
        artifactId: newArtifactId(),
        type: input.type,
        title: input.title,
      };
      log.targets.push(t);
      return t;
    },
    async updateTarget(ctx, ref, input) {
      log.ctxs.push(ctx);
      const { artifact } = await requireArtifact(ctx, ref, "edit");
      if (input.baseVersion !== undefined && input.baseVersion !== artifact.currentVersion) {
        throw new ApiError(
          "conflict",
          `Version ${input.baseVersion} is not current; current is ${artifact.currentVersion}`,
          { current_version: artifact.currentVersion },
        );
      }
      const t: VersionTarget = {
        mode: "update",
        artifact,
        baseVersion: input.baseVersion,
        note: input.note,
      };
      log.targets.push(t);
      return t;
    },
    async enforcePublishRate(ctx) {
      log.ctxs.push(ctx);
      log.publishRateCalls++;
    },
    async openStager(ctx, target) {
      log.ctxs.push(ctx);
      const id = target.mode === "publish" ? target.artifactId : target.artifact.id;
      const n = target.mode === "publish" ? 1 : target.artifact.currentVersion + 1;
      const prefix = `artifacts/${id}/v${n}.${randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789")}/`;
      const paths: string[] = [];
      log.added.set(prefix, paths);
      let bytes = 0;
      const stager: Stager = {
        prefix,
        async reserve() {},
        async add(path, data) {
          await opts.beforeAdd?.(path, prefix);
          paths.push(path);
          bytes += data.byteLength;
          // Big test bundles only count; small ones really reach R2.
          if (data.byteLength <= 64 * 1024) await bucket.put(prefix + path, data);
        },
        addRef() {
          throw new Error("addRef is not used by bundles");
        },
        async finish(o) {
          log.finished.push({ prefix, stripPrefix: o?.stripPrefix });
          const strip = o?.stripPrefix ?? "";
          return {
            prefix,
            entries: paths.map((p) => ({
              path: p.slice(strip.length),
              size_bytes: 0,
              content_type: "application/octet-stream",
            })),
            logicalBytes: bytes,
            writtenBytes: bytes,
            written: paths.length,
            reused: 0,
          } satisfies StagedVersion;
        },
        async abort() {
          log.aborted.push(prefix);
          await deletePrefix(bucket, prefix);
        },
      };
      return stager;
    },
    async commitStaged(ctx, target, staged, o) {
      log.ctxs.push(ctx);
      await opts.beforeCommit?.(staged.prefix);
      const id = target.mode === "publish" ? target.artifactId : target.artifact.id;
      const n = target.mode === "publish" ? 1 : target.artifact.currentVersion + 1;
      if (o?.ticketId) {
        const r = await env.DB.prepare(
          `UPDATE upload_tickets SET state = 'used', result_artifact_id = ?2, result_version = ?3,
             used_at = ?4, receiving_until = NULL
            WHERE id = ?1 AND state = 'open' AND expires_at > ?4`,
        )
          .bind(o.ticketId, id, n, nowIso())
          .run();
        if ((r.meta.changes ?? 0) !== 1) {
          log.aborted.push(staged.prefix);
          await deletePrefix(bucket, staged.prefix);
          if (opts.conflictWhenUsed) {
            throw new ApiError("conflict", `Version ${n - 1} is not current`, {
              current_version: n,
            });
          }
          throw new ApiError("conflict", "This upload was already used", { reason: "upload_used" });
        }
      }
      log.commits.push({
        ticketId: o?.ticketId,
        artifactId: id,
        version: n,
        prefix: staged.prefix,
      });
      const slug = target.mode === "publish" ? `${id}-slug` : target.artifact.slug;
      const type: ArtifactType = target.mode === "publish" ? target.type : target.artifact.type;
      const result: PublishResult = {
        id,
        slug,
        type,
        version: n,
        url: appUrl(ctx.config, `/a/${slug}`),
        content_url: `${contentOrigin(ctx.config, id)}/`,
        visibility: target.mode === "publish" ? "allowlist" : target.artifact.visibility,
        warnings: [],
        stored: {
          files: staged.entries.length,
          written: staged.written,
          reused: staged.reused,
          bytes: staged.logicalBytes,
          bytes_written: staged.writtenBytes,
        },
      };
      return result;
    },
  };
  return { deps, log };
}

/** Keys R2 holds under a prefix. */
export async function keysUnder(prefix: string): Promise<string[]> {
  const page = await env.FILES.list({ prefix });
  return page.objects.map((o) => o.key);
}
