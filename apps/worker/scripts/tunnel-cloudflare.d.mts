// Types for tunnel-cloudflare.mjs (imported by the Vitest suite).
export declare const REQUIRED_PERMISSIONS: string;
export declare class CloudflareError extends Error {}
export declare function provision(a: {
  token: string;
  fetch: typeof fetch;
  tunnelName: string;
  appHost: string;
  contentHost: string;
  appZone: string;
  contentZone: string;
  /** Whether the instance already holds the tunnel credentials file. */
  hasCredentials: boolean;
  /** Base64 of 32 random bytes, used as the new tunnel's secret. */
  newSecret: () => string;
}): Promise<{
  accountId: string;
  tunnelId: string;
  /** Credentials file contents when a tunnel was created now, else null. */
  credentials: string | null;
  records: { name: string; action: "created" | "kept" }[];
}>;
