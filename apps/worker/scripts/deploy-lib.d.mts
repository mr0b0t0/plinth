// Types for deploy-lib.mjs (imported by the Vitest suite).
export { CloudflareError } from "./tunnel-cloudflare.mjs";

export type DeploySettings = {
  version: 1;
  name: string;
  workerName: string;
  dbName: string;
  bucket: string;
  appHost: string;
  contentHost: string;
  emailProvider: "sendgrid" | "resend" | "console";
  emailFrom: string | null;
  adminEmail: string | null;
  singleUser: boolean;
  isolation: "origin" | "opaque";
  operator: {
    name: string | null;
    email: string | null;
    address: string | null;
    registration: string | null;
  };
  vars: Record<string, string>;
};
type Deps = { getDomain(host: string): string | null; getZone(host: string): string | null };
type Raw = Record<string, string | true | undefined>;

export declare const WILDCARD_CONTENT: string;
export declare const DEPLOY_PERMISSIONS: string;
export declare const OWNED_VARS: string[];
export declare class DeployUsageError extends Error {}
export declare function hostPairProblem(
  appHost: string,
  contentHost: string,
  isolation: string,
  registrable: (host: string) => string,
): string | null;
type Runtime = {
  compatibility_date?: string;
  compatibility_flags?: string[];
  triggers?: { crons?: string[] };
};
export declare const REQUIRED_FLAGS: string[];
export declare const SWEEP_CRON: string;
export declare function refreshRuntime<T extends Runtime>(
  existing: T,
  repo: Runtime,
): T & { compatibility_flags: string[]; triggers?: { crons: string[] } };
export declare function runtimeBase(repoCfg: Record<string, unknown>): Record<string, unknown>;
export declare function runtimeConfigProblem(cfg: unknown): string | null;
export declare function instanceName(raw: Raw): string;
export declare function deployPaths(
  home: string,
  name: string,
): { dir: string; wranglerConfig: string; settings: string };
export declare function resourceNames(name: string): {
  workerName: string;
  dbName: string;
  bucket: string;
};
export declare function mergeDeploySettings(
  raw: Raw,
  saved: Partial<DeploySettings> | null,
  deps: Deps,
): DeploySettings;
export declare function zonesOf(
  s: DeploySettings,
  deps: Deps,
): { appZone: string; contentZone: string };
export declare function buildDeployConfig(
  s: DeploySettings,
  layout: { main: string; assetsDir: string; migrationsDir: string },
  base: Record<string, unknown>,
  ids: { databaseId: string; contentZone: string },
): Record<string, unknown> & { vars: Record<string, string> };
export declare function pickAccount(
  whoami: { accounts?: { id: string; name: string }[] } | null,
  envAccountId?: string,
): { id: string; name: string };
export declare function wildcardRecord(
  contentHost: string,
  contentZone: string,
): { type: "A"; name: string; label: string; content: string; proxied: true };
export declare function checkZones(a: {
  token: string;
  fetch: typeof fetch;
  accountId: string;
  accountName?: string;
  appZone: string;
  contentZone: string;
  contentHost: string;
  /** Create the wildcard record when it is missing (an API token with DNS Edit). */
  create: boolean;
}): Promise<{
  zones: Record<string, string>;
  wildcard: "created" | "exists" | "missing" | "unknown";
}>;
export declare function deployNotes(s: DeploySettings, deps: Deps): string[];
