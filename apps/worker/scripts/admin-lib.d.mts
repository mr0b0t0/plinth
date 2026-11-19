// Types for admin-lib.mjs (imported by the Vitest suite).
export declare const USAGE: string;
export declare class UsageError extends Error {}
export declare class SweepRefused extends Error {}
export declare const MIN_SWEEP_MINUTES: number;
export declare const TOMBSTONE_SQL: string;
export declare function filesBucket(
  r2Buckets: { binding?: unknown; bucket_name?: unknown }[] | undefined,
  explicit: string | null | undefined,
): string;
export declare function parseResultSets(stdout: string): Record<string, unknown>[][] | null;
export declare function validateEmail(raw: unknown): string;
export declare function validateLimit(raw: unknown): number | null;
export declare function setLimitSql(email: string, limit: number | null): string;
export declare function parseArgs(argv: string[]):
  | { help: true }
  | {
      help: false;
      command: "set-limit";
      email: string;
      limit: number | null;
      target: "local" | "remote";
      sql: string;
      wranglerArgs: string[];
    }
  | {
      help: false;
      command: "erase-user" | "erase-artifact";
      subject: string;
      target: "local" | "remote";
      dryRun: boolean;
      bucket: string | null;
      env: string | null;
      config: string | null;
      keysArgs: string[];
      eraseArgs: string[];
      deleteObjectArgs(bucket: string, key: string): string[];
    }
  | {
      help: false;
      command: "sweep-orphans";
      target: "local" | "remote";
      dryRun: boolean;
      artifact: string | null;
      bucket: string | null;
      env: string | null;
      config: string | null;
      minAgeMs: number;
      prefixesArgs: string[];
    }
  | {
      help: false;
      command: "bump-epochs";
      target: "local" | "remote";
      sql: string;
      wranglerArgs: string[];
    };
export declare function bumpCategorySharedEpochsSql(): string;
export declare function validateArtifactRef(raw: unknown): string;
export declare function userKeysSql(email: string): string;
export declare function artifactKeysSql(ref: string): string;
export declare function eraseUserSql(email: string): string;
export declare function eraseArtifactSql(ref: string): string;
export interface EraseStep {
  table: string;
  /** Tells a second step on the same table apart (the erase golden test names added steps). */
  name?: string;
  sql: (subject: string) => string;
}
export declare const ERASE_USER_STEPS: readonly EraseStep[];
export declare const ERASE_USER_KEPT: Readonly<Record<string, string>>;
export declare const ERASE_ARTIFACT_STEPS: readonly EraseStep[];
export declare function resultSets(stdout: string): Record<string, unknown>[][];
export declare function keysFromRows(
  rows: { prefix: string | null; manifest: string | null }[],
): string[];
export declare function versionPrefixesSql(ref: string | null): string;
export declare function artifactRootOf(prefix: string): string | null;
export declare function rootsFromRows(rows: { artifact_id?: unknown }[]): string[];
interface BucketLike {
  list(opts: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date | string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<unknown>;
}
export declare function listObjects(
  bucket: BucketLike,
  prefix: string,
): Promise<{ key: string; uploaded: Date | string }[]>;
export declare function orphanPrefixes(
  objects: { key: string; uploaded: Date | string }[],
  referenced: Set<string>,
  opts: { now: number; minAgeMs: number },
): { prefix: string; keys: string[]; newest: number }[];
export declare function sweepOrphans(
  bucket: BucketLike,
  opts: {
    root: string;
    now: number;
    minAgeMs: number;
    dryRun: boolean;
    loadRows: () => Promise<{ prefix?: unknown }[]>;
  },
): Promise<{ prefix: string; files: number }[]>;
export declare function deleteRoots(bucket: BucketLike, roots: string[]): Promise<number>;
export declare function changesFromOutput(stdout: string): number | null;
