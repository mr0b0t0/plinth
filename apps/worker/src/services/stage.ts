// Staging and committing one version (docs/spec.md, reuse by hash and commit-last). The inline
// publish, update and restore paths and the bundle upload path all write a version through these:
// objects go to R2 first under a unique per-attempt prefix `artifacts/<id>/v<n>.<nonce>/`, then
// one guarded D1 batch inserts the version row (and, for a publish, the artifact row), advances
// current_version and consumes the upload ticket, or does none of it.
//
// Contract only: the signatures are pinned for the parallel workstreams; the bodies land with the
// server-core work and are not called from any code path yet.
import type { ArtifactType, PublishResult } from "@plinth/shared";
import type { ArtifactRow } from "../db/schema.ts";
import type { Ctx } from "./context.ts";
import type { ManifestEntry } from "./storage.ts";

/** What a staged version will become. */
export type VersionTarget =
  /** A new artifact: `artifactId` is fresh and has no row yet (commitStaged inserts it). */
  | { mode: "publish"; artifactId: string; type: ArtifactType; title?: string }
  | { mode: "update"; artifact: ArtifactRow; baseVersion?: number; note?: string };

/** The publish scope check and the artifact-count pre-check, then a target with a fresh id. */
export async function newArtifactTarget(
  _ctx: Ctx,
  _input: { type: ArtifactType; title?: string },
): Promise<VersionTarget> {
  throw new Error("not implemented");
}

/** requireArtifact(edit) plus an early base check (a stale base is a conflict, before any rate hit). */
export async function updateTarget(
  _ctx: Ctx,
  _ref: string,
  _input: { baseVersion?: number; note?: string },
): Promise<VersionTarget> {
  throw new Error("not implemented");
}

/** The per-user publish rate (MAX_PUBLISHES_PER_HOUR). */
export async function enforcePublishRate(_ctx: Ctx): Promise<void> {
  throw new Error("not implemented");
}

/** A version's files after staging: every object it needs is in R2, nothing is committed. */
export interface StagedVersion {
  /** `artifacts/<id>/v<n>.<nonce>/` */
  prefix: string;
  entries: ManifestEntry[];
  /** What a viewer loads: every file, reused ones included. */
  logicalBytes: number;
  /** Bytes put to R2 by this attempt. */
  writtenBytes: number;
  written: number;
  reused: number;
}

export interface Stager {
  /** `artifacts/<id>/v<n>.<nonce>/` */
  readonly prefix: string;
  /** Validate, hash, then reuse or put one file; awaits back-pressure from the in-flight budget. */
  add(path: string, bytes: Uint8Array): Promise<void>;
  /** An inline `{path, sha256}`: reuse that file from the current version. */
  addRef(path: string, sha256: string): void;
  /**
   * Settle every put, apply the prefix strip, write the source under its own prefix, and check
   * the count, size, references and paths.
   */
  finish(opts?: { stripPrefix?: string }): Promise<StagedVersion>;
  /** Settle every put, then delete this attempt's prefix. */
  abort(): Promise<void>;
}

export async function openStager(_ctx: Ctx, _target: VersionTarget): Promise<Stager> {
  throw new Error("not implemented");
}

/**
 * One guarded D1 batch: the artifact row (publish), the version row, the current_version advance
 * and, with `ticketId`, the upload ticket's `open -> used`. Aborts the stager on failure.
 */
export async function commitStaged(
  _ctx: Ctx,
  _target: VersionTarget,
  _staged: StagedVersion,
  _opts?: { ticketId?: string },
): Promise<PublishResult> {
  throw new Error("not implemented");
}
