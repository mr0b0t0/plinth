// Runtime configuration, parsed from env vars once per isolate. Every host, limit and provider is
// configurable (AGENTS.md: anything a self-hoster may change is an env var).
import { DEFAULTS } from "@plinth/shared";
import { getDomain } from "tldts";

/** Secrets are set with `wrangler secret put` (or .dev.vars locally); not in wrangler.jsonc. */
export interface Secrets {
  SESSION_SECRET?: string;
  TOKEN_SIGNING_KEY?: string;
  ADMIN_TOKEN?: string;
  SENDGRID_API_KEY?: string;
  RESEND_API_KEY?: string;
}

export type Bindings = Env & Secrets;

export type Environment = "development" | "staging" | "production";
export type EmailProvider = "sendgrid" | "resend" | "console";

export interface Config {
  environment: Environment;
  /** host[:port], e.g. plinth.aconite.io or app.localhost:8787 */
  appHost: string;
  contentHost: string;
  scheme: "http" | "https";
  appOrigin: string;
  emailProvider: EmailProvider;
  emailFrom: string;
  maxArtifactsPerUser: number;
  maxPublishesPerHour: number;
  cdnAllowlist: string[];
  singleUserMode: boolean;
  /** Admin's email in single-user mode; also gets the admin takedown page on any instance. */
  adminEmails: string[];
  allowPublicVisibility: boolean;
  publicMinAccountAgeHours: number;
  /** Serve content at APP_HOST/__content/<id>/ (staging on workers.dev only). */
  contentPathFallback: boolean;
  /** Keep console emails in D1 so local tests can read them. Development only. */
  devOutbox: boolean;
  /**
   * Ignore the client IP for per-IP rate limits (per-email limits still apply). Development only:
   * the local e2e suite signs in hundreds of times from one address.
   */
  devIgnoreClientIp: boolean;
  /**
   * POST /__dev/seed creates users, tokens and sessions for the e2e suite without touching the
   * database file from outside the Worker. Development only, and only with DEV_SEED=true.
   */
  devSeed: boolean;
  sessionSecret: string;
  tokenSigningKey: string;
  adminToken: string | null;
  sendgridApiKey: string | null;
  resendApiKey: string | null;
}

export class ConfigError extends Error {}

function bool(v: unknown): boolean {
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown): string[] {
  return str(v)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Registrable domain (eTLD+1) of a host, ignoring the port. Falls back to the hostname. */
export function registrableDomain(host: string): string {
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const CDN_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseConfig(env: Record<string, unknown>): Config {
  const environment = str(env.ENVIRONMENT) || "production";
  if (!["development", "staging", "production"].includes(environment)) {
    throw new ConfigError(`ENVIRONMENT must be development, staging or production`);
  }
  const appHost = str(env.APP_HOST).toLowerCase();
  const contentHost = str(env.CONTENT_HOST).toLowerCase();
  if (!HOST_RE.test(appHost)) throw new ConfigError("APP_HOST is missing or not a host name");
  if (!HOST_RE.test(contentHost))
    throw new ConfigError("CONTENT_HOST is missing or not a host name");
  if (appHost === contentHost) throw new ConfigError("APP_HOST and CONTENT_HOST must differ");
  if (contentHost.endsWith(`.${appHost}`) || appHost.endsWith(`.${contentHost}`)) {
    throw new ConfigError("APP_HOST and CONTENT_HOST must not be subdomains of each other");
  }
  const scheme = str(env.PUBLIC_SCHEME) === "http" ? "http" : "https";
  const emailProvider = (str(env.EMAIL_PROVIDER) || "console") as EmailProvider;
  if (!["sendgrid", "resend", "console"].includes(emailProvider)) {
    throw new ConfigError("EMAIL_PROVIDER must be sendgrid, resend or console");
  }
  const cdn = list(env.CDN_ALLOWLIST);
  const cdnAllowlist = cdn.length > 0 ? cdn : [...DEFAULTS.cdnAllowlist];
  for (const h of cdnAllowlist) {
    if (!CDN_HOST_RE.test(h)) throw new ConfigError(`CDN_ALLOWLIST entry is not a host name: ${h}`);
  }

  const config: Config = {
    environment: environment as Environment,
    appHost,
    contentHost,
    scheme,
    appOrigin: `${scheme}://${appHost}`,
    emailProvider,
    emailFrom: str(env.EMAIL_FROM) || `Plinth <noreply@${appHost.replace(/:\d+$/, "")}>`,
    maxArtifactsPerUser: int(env.MAX_ARTIFACTS_PER_USER, DEFAULTS.maxArtifactsPerUser),
    maxPublishesPerHour: int(env.MAX_PUBLISHES_PER_HOUR, DEFAULTS.maxPublishesPerHour),
    cdnAllowlist,
    singleUserMode: bool(env.SINGLE_USER_MODE),
    adminEmails: list(env.ADMIN_EMAIL),
    allowPublicVisibility: bool(env.ALLOW_PUBLIC_VISIBILITY),
    publicMinAccountAgeHours: int(
      env.PUBLIC_MIN_ACCOUNT_AGE_HOURS,
      DEFAULTS.publicMinAccountAgeHours,
    ),
    contentPathFallback: bool(env.STAGING_CONTENT_FALLBACK),
    devOutbox: bool(env.DEV_OUTBOX) && environment === "development",
    devIgnoreClientIp: bool(env.DEV_IGNORE_CLIENT_IP) && environment === "development",
    devSeed: bool(env.DEV_SEED) && environment === "development",
    sessionSecret: str(env.SESSION_SECRET),
    tokenSigningKey: str(env.TOKEN_SIGNING_KEY),
    adminToken: str(env.ADMIN_TOKEN) || null,
    sendgridApiKey: str(env.SENDGRID_API_KEY) || null,
    resendApiKey: str(env.RESEND_API_KEY) || null,
  };
  validate(config);
  return config;
}

function validate(c: Config): void {
  if (c.sessionSecret.length < 32)
    throw new ConfigError("SESSION_SECRET must be at least 32 characters");
  if (c.tokenSigningKey.length < 32) {
    throw new ConfigError("TOKEN_SIGNING_KEY must be at least 32 characters");
  }
  if (c.singleUserMode) {
    if (!c.adminToken || c.adminToken.length < 32) {
      throw new ConfigError("SINGLE_USER_MODE needs ADMIN_TOKEN of at least 32 characters");
    }
    if (c.adminEmails.length !== 1)
      throw new ConfigError("SINGLE_USER_MODE needs exactly one ADMIN_EMAIL");
  }
  if (c.emailProvider === "sendgrid" && !c.sendgridApiKey)
    throw new ConfigError("SENDGRID_API_KEY is not set");
  if (c.emailProvider === "resend" && !c.resendApiKey)
    throw new ConfigError("RESEND_API_KEY is not set");
  if (c.contentPathFallback && c.environment === "production") {
    throw new ConfigError("STAGING_CONTENT_FALLBACK is refused in production");
  }
  if (c.environment === "production") {
    // Refuse to run if user HTML would be same-site with the app.
    if (registrableDomain(c.appHost) === registrableDomain(c.contentHost)) {
      throw new ConfigError(
        "APP_HOST and CONTENT_HOST share a registrable domain; the content host must be a separate domain",
      );
    }
    if (c.scheme !== "https") throw new ConfigError("PUBLIC_SCHEME must be https in production");
    if (c.emailProvider === "console" && !c.singleUserMode) {
      throw new ConfigError(
        "EMAIL_PROVIDER=console is refused in production (it logs sign-in links)",
      );
    }
  }
}

let cached: { key: unknown; config: Config } | null = null;

/** Parse once per isolate; env objects are stable within an isolate. */
export function getConfig(env: Record<string, unknown>): Config {
  if (cached && cached.key === env) return cached.config;
  const config = parseConfig(env);
  cached = { key: env, config };
  return config;
}

export function contentOrigin(c: Config, artifactId: string): string {
  if (c.contentPathFallback) return `${c.appOrigin}/__content/${artifactId}`;
  return `${c.scheme}://${artifactId}.${c.contentHost}`;
}

export function appUrl(c: Config, path: string): string {
  return `${c.appOrigin}${path}`;
}
