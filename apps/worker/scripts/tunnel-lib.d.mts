// Types for tunnel-lib.mjs (imported by the Vitest suite).
export type Isolation = "origin" | "opaque";
export type TunnelOptions = {
  name: string;
  appHost: string;
  contentHost: string;
  port: number;
  emailProvider: "sendgrid" | "resend" | "console";
  emailFrom: string;
  singleUser: boolean;
  adminEmail: string | null;
  isolation: Isolation;
  cloudflare: boolean;
};
export type InstancePaths = {
  dir: string;
  state: string;
  wranglerConfig: string;
  devVars: string;
  cloudflaredConfig: string;
  credentials: string;
  meta: string;
};
export declare const DEFAULT_PORT: number;
export declare class TunnelUsageError extends Error {}
export declare function validateTunnelOptions(
  raw: Record<string, string | true | undefined>,
  deps: { getDomain(host: string): string | null },
): TunnelOptions;
export declare function instancePaths(home: string, name: string): InstancePaths;
export type Layout = { main: string; assetsDir: string; migrationsDir: string };
export type LocalOptions = { name: string; port: number; adminEmail: string };
export declare function resolveLayout(layout: string | Layout): Layout;
export declare function buildWorkerConfig(
  o: TunnelOptions,
  layout: string | Layout,
  base?: Record<string, unknown>,
): Record<string, unknown>;
export declare function validateLocalOptions(
  raw: Record<string, string | true | undefined>,
): LocalOptions;
export declare function localHosts(port: number): { appHost: string; contentHost: string };
export declare function buildLocalWorkerConfig(
  o: LocalOptions,
  layout: string | Layout,
  base?: Record<string, unknown>,
): Record<string, unknown>;
export declare function renderCloudflaredConfig(a: {
  tunnelId: string;
  credentialsFile: string;
  appHost: string;
  contentHost: string;
  port: number;
}): string;
export declare function dnsRecordNames(appHost: string, contentHost: string): string[];
export declare function credentialsJson(a: {
  accountId: string;
  tunnelId: string;
  secret: string;
}): string;
export declare function startCommands(
  paths: InstancePaths,
  port: number,
  tunnel: boolean,
  opts?: { local?: boolean; listen?: string },
): { wrangler: string[]; cloudflared: string[] | null };
export declare function validateListen(value: unknown): string;
