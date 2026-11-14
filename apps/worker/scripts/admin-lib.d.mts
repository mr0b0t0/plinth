// Types for admin-lib.mjs (imported by the Vitest suite).
export declare const USAGE: string;
export declare class UsageError extends Error {}
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
      keysArgs: string[];
      eraseArgs: string[];
      deleteObjectArgs(key: string): string[];
    };
export declare function validateArtifactRef(raw: unknown): string;
export declare function userKeysSql(email: string): string;
export declare function artifactKeysSql(ref: string): string;
export declare function eraseUserSql(email: string): string;
export declare function eraseArtifactSql(ref: string): string;
export declare function resultSets(stdout: string): Record<string, unknown>[][];
export declare function keysFromRows(rows: { prefix: string; manifest: string }[]): string[];
export declare function changesFromOutput(stdout: string): number | null;
