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
    };
export declare function changesFromOutput(stdout: string): number | null;
