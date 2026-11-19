// Runtime configuration, parsed from env vars once per isolate. Every host, limit and provider is
// configurable (AGENTS.md: anything a self-hoster may change is an env var).
import {
  CONTENT_ISOLATION_MODES,
  type ContentIsolation,
  DEFAULTS,
  type InstanceLimits,
  LIMITS,
  LIVE_BOUNDS,
  LIVE_DEFAULTS,
  ROOM_BOUNDS,
  ROOM_DEFAULTS,
} from "@plinth/shared";
import { getDomain } from "tldts";
import { PASSWORD_HASH_RE } from "./lib/crypto.ts";
import type { ArtifactRoom } from "./rooms/ArtifactRoom.ts";

/** Secrets are set with `wrangler secret put` (or .dev.vars locally); not in wrangler.jsonc. */
export interface Secrets {
  SESSION_SECRET?: string;
  TOKEN_SIGNING_KEY?: string;
  ADMIN_TOKEN?: string;
  SENDGRID_API_KEY?: string;
  RESEND_API_KEY?: string;
  /** The review account's password, hashed (apps/worker/scripts/review-login-hash.mjs). */
  REVIEW_LOGIN_PASSWORD_HASH?: string;
}

/**
 * Bindings a deploy may lack. BROWSER is Cloudflare Browser Rendering (`"browser": { "binding":
 * "BROWSER" }`), used for thumbnails, which an operator adds by hand; local, tunnel and Docker
 * instances run without it. ROOMS is the live-room Durable Object namespace (class ArtifactRoom),
 * which every config Plinth generates carries; an older config without it simply has rooms off.
 */
export interface OptionalBindings {
  BROWSER?: Fetcher;
  ROOMS?: DurableObjectNamespace<ArtifactRoom>;
}

/** Vars an operator may set that the shipped wrangler.jsonc leaves out (their defaults apply). */
export interface OptionalVars {
  VIEW_COUNTS?: string;
  REVIEW_LOGIN_EMAIL?: string;
}

export type Bindings = Omit<Env, "ROOMS"> & Secrets & OptionalBindings & OptionalVars;

export type Environment = "development" | "staging" | "production";
export type EmailProvider = "sendgrid" | "resend" | "console";
/**
 * How artifact documents are isolated (CONTENT_ISOLATION). `origin`: each artifact is its own
 * origin (its subdomain), with its own storage. `opaque`: every content response also carries a
 * CSP `sandbox` without allow-same-origin, so artifact documents get an opaque origin (no cookies,
 * no storage, no service workers). Opaque is the compensating control for a content host that
 * shares a registrable domain with the app (see docs/security.md).
 */
export type { ContentIsolation };

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
  /** Stored bytes per account (all versions of non-deleted artifacts it owns). */
  maxStorageBytesPerUser: number;
  /**
   * MAX_VERSION_BYTES: source plus assets of one version, uncompressed (reused files count). From
   * 1 MB up to LIMITS.maxVersionBytesCeiling.
   */
  maxVersionBytes: number;
  /** MAX_ASSETS_PER_VERSION: asset files in one version, from 1 up to LIMITS.maxAssetsCeiling. */
  maxAssetsPerVersion: number;
  cdnAllowlist: string[];
  singleUserMode: boolean;
  /** Admin's email in single-user mode; also gets the admin takedown page on any instance. */
  adminEmails: string[];
  allowPublicVisibility: boolean;
  publicMinAccountAgeHours: number;
  /** Serve content at APP_HOST/__content/<id>/ (staging on workers.dev only). */
  contentPathFallback: boolean;
  /**
   * The effective isolation mode: CONTENT_ISOLATION, except that the path fallback is always
   * opaque (it serves user HTML from the app's own origin).
   */
  contentIsolation: ContentIsolation;
  /** CONTENT_ISOLATION as configured, before the path fallback forces opaque. */
  configuredContentIsolation: ContentIsolation;
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
  /**
   * ALLOW_SHARED_DATA (default on): pages may keep shared data and learn who is viewing. Only in
   * effect with origin isolation; see sharedDataActive.
   */
  allowSharedData: boolean;
  /** Shared data limits (DATA_* env vars). */
  data: SharedDataLimits;
  /**
   * SHOW_SOURCE_LINK (default on): the banner under every artifact links to Plinth's source
   * repository. Lives in the app's page around the frame, never in the artifact document.
   */
  showSourceLink: boolean;
  /**
   * THUMBNAILS (default on): screenshot each version for dashboard cards and link previews. Only
   * in effect with a BROWSER binding; see thumbnailsActive.
   */
  thumbnails: boolean;
  /**
   * VIEW_COUNTS (default on): count artifact opens per UTC day, aggregate only (docs/spec.md).
   */
  viewCounts: boolean;
  /**
   * ALLOW_ROOMS (default on): pages that declare `room` get live presence and broadcast, and doc
   * editors see each other's page edits live. Only in effect with origin isolation and a ROOMS
   * binding.
   */
  allowRooms: boolean;
  /** Room limits (ROOM_* env vars). */
  rooms: RoomLimits;
  /**
   * ALLOW_LIVE_EDITING (default on): owners and editors may edit a doc on its page. Off means the
   * source editor only.
   */
  allowLiveEditing: boolean;
  /** Live editing timings (LIVE_* env vars). */
  live: LiveEditSettings;
  /**
   * REVIEW_LOGIN_EMAIL and REVIEW_LOGIN_PASSWORD_HASH: one ordinary account that may also sign in
   * with a password at /login/review, for a directory's reviewers, who cannot receive sign-in
   * emails. null (the route is a 404) unless both are set; deleting the secret turns it off.
   */
  reviewLogin: { email: string; passwordHash: string } | null;
  /** OPERATOR_*: who runs this instance, for its legal pages. null when none is published. */
  operator: {
    name: string;
    address: string | null;
    registration: string | null;
    email: string;
    hosting: string;
  } | null;
}

export interface SharedDataLimits {
  /** DATA_MAX_DOCS_PER_ARTIFACT */
  maxDocsPerArtifact: number;
  /** DATA_MAX_BYTES_PER_ARTIFACT */
  maxBytesPerArtifact: number;
  /** DATA_MAX_BYTES_PER_USER: across all of an owner's artifacts. */
  maxBytesPerUser: number;
  /** DATA_MAX_DOC_BYTES: one document, 1024..65536. */
  maxDocBytes: number;
  /** DATA_WRITES_PER_VIEWER_PER_HOUR: per writer per artifact. */
  writesPerViewerPerHour: number;
  /** DATA_WRITES_PER_ARTIFACT_PER_HOUR: all writers of one artifact. */
  writesPerArtifactPerHour: number;
}

export interface RoomLimits {
  /** ROOM_MAX_CONNECTIONS_PER_ARTIFACT: sockets on one artifact's room. */
  maxConnectionsPerArtifact: number;
  /** ROOM_MAX_MESSAGE_BYTES: one page-room frame. */
  maxMessageBytes: number;
  /** ROOM_MESSAGES_PER_SECOND: per connection, with a burst of twice this. */
  messagesPerSecond: number;
}

export interface LiveEditSettings {
  /** LIVE_CHECKPOINT_IDLE_S: quiet seconds before an autosave; 0 means explicit saves only. */
  checkpointIdleS: number;
  /** LIVE_AUTO_CHECKPOINT_MIN_S: least seconds between autosaves, at least the idle time. */
  autoCheckpointMinS: number;
  /** LIVE_DRAFT_FLUSH_S: the room writes the draft to D1 at most this often. */
  draftFlushS: number;
  /** LIVE_DRAFT_RETENTION_DAYS: an untouched unsaved draft is deleted after this. */
  draftRetentionDays: number;
}

export class ConfigError extends Error {}

/** The smallest MAX_VERSION_BYTES an instance may set (1 MB). */
export const MIN_VERSION_BYTES = 1024 * 1024;

function bool(v: unknown): boolean {
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** A switch that is on unless set to a false value. */
function boolDefaultOn(v: unknown): boolean {
  return str(v) === "" ? true : bool(v);
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * An integer setting with hard bounds: unset or empty gives the default; anything else must be an
 * integer from min to max, or the Worker refuses to start.
 */
function boundedInt(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = str(env[name]);
  if (raw === "") return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return n;
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

const OPERATOR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * REVIEW_LOGIN_EMAIL and REVIEW_LOGIN_PASSWORD_HASH. Either one missing turns the review sign-in
 * off rather than failing, since removing the secret is how an operator ends a review. A hash that
 * is set but malformed is refused, so a typo never leaves a login nobody can use, or one that
 * checks fewer iterations.
 */
function parseReviewLogin(env: Record<string, unknown>): Config["reviewLogin"] {
  const email = str(env.REVIEW_LOGIN_EMAIL).toLowerCase();
  const passwordHash = str(env.REVIEW_LOGIN_PASSWORD_HASH);
  if (!email || !passwordHash) return null;
  if (!OPERATOR_EMAIL_RE.test(email)) {
    throw new ConfigError("REVIEW_LOGIN_EMAIL is not an email address");
  }
  if (!PASSWORD_HASH_RE.test(passwordHash)) {
    throw new ConfigError(
      "REVIEW_LOGIN_PASSWORD_HASH is not a hash from apps/worker/scripts/review-login-hash.mjs (pbkdf2-sha256$100000$<salt>$<hash>)",
    );
  }
  return { email, passwordHash };
}

/**
 * OPERATOR_NAME, OPERATOR_ADDRESS, OPERATOR_REGISTRATION, OPERATOR_EMAIL, OPERATOR_HOSTING: the
 * operator named in the instance's terms and privacy notice. All unset: no legal pages (a personal
 * instance). A name needs a contact email, and the reverse.
 */
function parseOperator(env: Record<string, unknown>): Config["operator"] {
  const name = str(env.OPERATOR_NAME);
  const email = str(env.OPERATOR_EMAIL).toLowerCase();
  if (!name && !email) return null;
  if (!name || !email) throw new ConfigError("Set OPERATOR_NAME and OPERATOR_EMAIL together");
  if (!OPERATOR_EMAIL_RE.test(email))
    throw new ConfigError("OPERATOR_EMAIL is not an email address");
  return {
    name,
    address: str(env.OPERATOR_ADDRESS) || null,
    registration: str(env.OPERATOR_REGISTRATION) || null,
    email,
    hosting: str(env.OPERATOR_HOSTING) || "Cloudflare",
  };
}

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
  const isolation = (str(env.CONTENT_ISOLATION).toLowerCase() || "origin") as ContentIsolation;
  if (!CONTENT_ISOLATION_MODES.includes(isolation)) {
    throw new ConfigError("CONTENT_ISOLATION must be origin or opaque");
  }
  const contentPathFallback = bool(env.STAGING_CONTENT_FALLBACK);
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
    maxStorageBytesPerUser: int(env.MAX_STORAGE_BYTES_PER_USER, DEFAULTS.maxStorageBytesPerUser),
    maxVersionBytes: boundedInt(
      env,
      "MAX_VERSION_BYTES",
      DEFAULTS.maxVersionBytes,
      MIN_VERSION_BYTES,
      LIMITS.maxVersionBytesCeiling,
    ),
    maxAssetsPerVersion: boundedInt(
      env,
      "MAX_ASSETS_PER_VERSION",
      DEFAULTS.maxAssetsPerVersion,
      1,
      LIMITS.maxAssetsCeiling,
    ),
    cdnAllowlist,
    singleUserMode: bool(env.SINGLE_USER_MODE),
    adminEmails: list(env.ADMIN_EMAIL),
    allowPublicVisibility: bool(env.ALLOW_PUBLIC_VISIBILITY),
    publicMinAccountAgeHours: int(
      env.PUBLIC_MIN_ACCOUNT_AGE_HOURS,
      DEFAULTS.publicMinAccountAgeHours,
    ),
    contentPathFallback,
    contentIsolation: contentPathFallback ? "opaque" : isolation,
    configuredContentIsolation: isolation,
    devOutbox: bool(env.DEV_OUTBOX) && environment === "development",
    devIgnoreClientIp: bool(env.DEV_IGNORE_CLIENT_IP) && environment === "development",
    devSeed: bool(env.DEV_SEED) && environment === "development",
    sessionSecret: str(env.SESSION_SECRET),
    tokenSigningKey: str(env.TOKEN_SIGNING_KEY),
    adminToken: str(env.ADMIN_TOKEN) || null,
    sendgridApiKey: str(env.SENDGRID_API_KEY) || null,
    resendApiKey: str(env.RESEND_API_KEY) || null,
    allowSharedData: boolDefaultOn(env.ALLOW_SHARED_DATA),
    data: {
      maxDocsPerArtifact: int(env.DATA_MAX_DOCS_PER_ARTIFACT, DEFAULTS.data.maxDocsPerArtifact),
      maxBytesPerArtifact: int(env.DATA_MAX_BYTES_PER_ARTIFACT, DEFAULTS.data.maxBytesPerArtifact),
      maxBytesPerUser: int(env.DATA_MAX_BYTES_PER_USER, DEFAULTS.data.maxBytesPerUser),
      maxDocBytes: int(env.DATA_MAX_DOC_BYTES, DEFAULTS.data.maxDocBytes),
      writesPerViewerPerHour: int(
        env.DATA_WRITES_PER_VIEWER_PER_HOUR,
        DEFAULTS.data.writesPerViewerPerHour,
      ),
      writesPerArtifactPerHour: int(
        env.DATA_WRITES_PER_ARTIFACT_PER_HOUR,
        DEFAULTS.data.writesPerArtifactPerHour,
      ),
    },
    showSourceLink: boolDefaultOn(env.SHOW_SOURCE_LINK),
    thumbnails: boolDefaultOn(env.THUMBNAILS),
    viewCounts: boolDefaultOn(env.VIEW_COUNTS),
    allowRooms: boolDefaultOn(env.ALLOW_ROOMS),
    rooms: parseRoomLimits(env),
    allowLiveEditing: boolDefaultOn(env.ALLOW_LIVE_EDITING),
    live: parseLiveEditSettings(env),
    reviewLogin: parseReviewLogin(env),
    operator: parseOperator(env),
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
  // ADMIN_TOKEN is optional: without it, agents connect with OAuth or a personal access token like
  // on any instance. If set, it must be long enough to be a secret.
  if (c.adminToken && c.adminToken.length < 32) {
    throw new ConfigError("ADMIN_TOKEN must be at least 32 characters");
  }
  if (c.singleUserMode) {
    if (c.adminEmails.length !== 1)
      throw new ConfigError("SINGLE_USER_MODE needs exactly one ADMIN_EMAIL");
  }
  if (c.emailProvider === "sendgrid" && !c.sendgridApiKey)
    throw new ConfigError("SENDGRID_API_KEY is not set");
  if (c.emailProvider === "resend" && !c.resendApiKey)
    throw new ConfigError("RESEND_API_KEY is not set");
  if (c.reviewLogin) {
    // The review account is an ordinary user. A shared password must never reach the admin pages,
    // and in single-user mode only the admin may sign in at all.
    if (c.adminEmails.includes(c.reviewLogin.email)) {
      throw new ConfigError(
        "REVIEW_LOGIN_EMAIL must not be an ADMIN_EMAIL address: the review account is an ordinary user",
      );
    }
    if (c.singleUserMode) {
      throw new ConfigError(
        "REVIEW_LOGIN_EMAIL cannot be used with SINGLE_USER_MODE (only the admin signs in there)",
      );
    }
  }
  if (c.sessionSecret === c.tokenSigningKey) {
    throw new ConfigError("SESSION_SECRET and TOKEN_SIGNING_KEY must be different values");
  }
  const isLocal = (h: string) =>
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$|\.localhost(:\d+)?$/.test(h);
  if (c.environment === "development" && !isLocal(c.appHost)) {
    // Development turns on helpers (dev outbox, seeding) that must never face the internet.
    throw new ConfigError("ENVIRONMENT=development is only allowed on a localhost APP_HOST");
  }
  const sharedSite = registrableDomain(c.appHost) === registrableDomain(c.contentHost);
  if (c.environment === "staging" && sharedSite && c.contentIsolation !== "opaque") {
    throw new ConfigError(
      "APP_HOST and CONTENT_HOST share a registrable domain; use a separate content domain, CONTENT_ISOLATION=opaque or STAGING_CONTENT_FALLBACK",
    );
  }
  if (c.contentPathFallback && c.environment === "production") {
    throw new ConfigError("STAGING_CONTENT_FALLBACK is refused in production");
  }
  validateSharedData(c.data);
  if (c.environment === "production") {
    // User HTML that is same-site with the app runs only with opaque isolation: artifact documents
    // then have no cookies or storage, so they cannot toss cookies onto the shared parent domain.
    // (A content host equal to, or a subdomain of, the app host is refused in parseConfig in
    // every mode.)
    if (sharedSite && c.configuredContentIsolation !== "opaque") {
      throw new ConfigError(
        "APP_HOST and CONTENT_HOST share a registrable domain. Set CONTENT_ISOLATION=opaque to run like this (artifacts then get an opaque origin and no browser storage), or keep CONTENT_ISOLATION=origin with a separate content domain or a content host on the Public Suffix List that the pinned tldts knows",
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

function parseRoomLimits(env: Record<string, unknown>): RoomLimits {
  const b = ROOM_BOUNDS;
  return {
    maxConnectionsPerArtifact: boundedInt(
      env,
      "ROOM_MAX_CONNECTIONS_PER_ARTIFACT",
      ROOM_DEFAULTS.maxConnectionsPerArtifact,
      ...b.maxConnectionsPerArtifact,
    ),
    maxMessageBytes: boundedInt(
      env,
      "ROOM_MAX_MESSAGE_BYTES",
      ROOM_DEFAULTS.maxMessageBytes,
      ...b.maxMessageBytes,
    ),
    messagesPerSecond: boundedInt(
      env,
      "ROOM_MESSAGES_PER_SECOND",
      ROOM_DEFAULTS.messagesPerSecond,
      ...b.messagesPerSecond,
    ),
  };
}

function parseLiveEditSettings(env: Record<string, unknown>): LiveEditSettings {
  const b = LIVE_BOUNDS;
  const idle = boundedInt(
    env,
    "LIVE_CHECKPOINT_IDLE_S",
    LIVE_DEFAULTS.checkpointIdleS,
    0,
    b.checkpointIdleS[1],
  );
  if (idle !== 0 && idle < b.checkpointIdleS[0]) {
    throw new ConfigError(
      `LIVE_CHECKPOINT_IDLE_S must be 0 (explicit saves only) or from ${b.checkpointIdleS[0]} to ${b.checkpointIdleS[1]}`,
    );
  }
  const autoMin = boundedInt(
    env,
    "LIVE_AUTO_CHECKPOINT_MIN_S",
    Math.max(LIVE_DEFAULTS.autoCheckpointMinS, idle),
    ...b.autoCheckpointMinS,
  );
  if (autoMin < idle) {
    throw new ConfigError("LIVE_AUTO_CHECKPOINT_MIN_S must be at least LIVE_CHECKPOINT_IDLE_S");
  }
  return {
    checkpointIdleS: idle,
    autoCheckpointMinS: autoMin,
    draftFlushS: boundedInt(env, "LIVE_DRAFT_FLUSH_S", LIVE_DEFAULTS.draftFlushS, ...b.draftFlushS),
    draftRetentionDays: boundedInt(
      env,
      "LIVE_DRAFT_RETENTION_DAYS",
      LIVE_DEFAULTS.draftRetentionDays,
      ...b.draftRetentionDays,
    ),
  };
}

function validateSharedData(d: SharedDataLimits): void {
  if (d.maxDocBytes < 1024 || d.maxDocBytes > 65536) {
    throw new ConfigError("DATA_MAX_DOC_BYTES must be between 1024 and 65536");
  }
  if (d.maxBytesPerArtifact < d.maxDocBytes) {
    throw new ConfigError("DATA_MAX_BYTES_PER_ARTIFACT must be at least DATA_MAX_DOC_BYTES");
  }
  if (d.maxBytesPerUser < d.maxBytesPerArtifact) {
    throw new ConfigError("DATA_MAX_BYTES_PER_USER must be at least DATA_MAX_BYTES_PER_ARTIFACT");
  }
  if (d.maxDocsPerArtifact < 1) {
    throw new ConfigError("DATA_MAX_DOCS_PER_ARTIFACT must be at least 1");
  }
  if (d.writesPerViewerPerHour < 1) {
    throw new ConfigError("DATA_WRITES_PER_VIEWER_PER_HOUR must be at least 1");
  }
  if (d.writesPerArtifactPerHour < 1) {
    throw new ConfigError("DATA_WRITES_PER_ARTIFACT_PER_HOUR must be at least 1");
  }
}

/**
 * Shared data and identity claims are in effect: switched on, and each artifact has its own origin.
 * Opaque isolation (the path fallback included, which config forces to opaque) has no cookies, so
 * the feature is off there; that is not a configuration error.
 */
export function sharedDataActive(c: Pick<Config, "allowSharedData" | "contentIsolation">): boolean {
  return c.allowSharedData && c.contentIsolation === "origin";
}

/**
 * Live rooms are in effect: ALLOW_ROOMS is on, the deploy has the ROOMS binding, and each artifact
 * is its own origin. Under opaque isolation (the path fallback included, which config forces to
 * opaque) a page has no cookies and its origin is "null", so rooms are off; not a config error.
 */
export function roomsActive(
  c: Pick<Config, "allowRooms" | "contentIsolation">,
  env: OptionalBindings,
): boolean {
  return c.allowRooms && env.ROOMS !== undefined && c.contentIsolation === "origin";
}

/**
 * How owners and editors may edit a doc on its page: "room" (live with other editors, through the
 * artifact's room), "solo" (on the page alone, Save makes a version), or null (the source editor
 * only: ALLOW_LIVE_EDITING off, or opaque isolation, where the app cannot trust the frame).
 */
export function liveEditMode(
  c: Pick<Config, "allowLiveEditing" | "allowRooms" | "contentIsolation">,
  env: OptionalBindings,
): "room" | "solo" | null {
  if (!c.allowLiveEditing || c.contentIsolation !== "origin") return null;
  return roomsActive(c, env) ? "room" : "solo";
}

/**
 * Whether the gate seals an identity claim into identified viewers' content passes: only with
 * origin isolation, and only while something on the page reads it (shared data or rooms).
 */
export function identityClaimsActive(
  c: Pick<Config, "allowSharedData" | "allowRooms" | "contentIsolation">,
  env: OptionalBindings,
): boolean {
  return c.contentIsolation === "origin" && (c.allowSharedData || roomsActive(c, env));
}

/**
 * Whether versions get thumbnails: THUMBNAILS is on and the operator added a Browser Rendering
 * binding (BROWSER). Without the binding, cards keep their placeholder and link previews have no
 * image.
 */
export function thumbnailsActive(c: Pick<Config, "thumbnails">, env: OptionalBindings): boolean {
  return c.thumbnails && env.BROWSER !== undefined;
}

/** Bytes on the wire one bundle may have: the version limit plus tar headers and padding. */
export function maxBundleBytes(c: Pick<Config, "maxVersionBytes">): number {
  return c.maxVersionBytes + LIMITS.bundleOverheadBytes;
}

/** Upload tickets one user may mint per hour. Bundle requests are limited to twice this. */
export function uploadTicketsPerHour(c: Pick<Config, "maxPublishesPerHour">): number {
  return c.maxPublishesPerHour;
}

/** This instance's publish limits, as GET /api/v1/config and start_upload report them. */
export function instanceLimits(
  c: Pick<Config, "maxVersionBytes" | "maxAssetsPerVersion">,
): InstanceLimits {
  return {
    max_html_bytes: LIMITS.maxHtmlBytes,
    max_doc_bytes: LIMITS.maxDocBytes,
    max_version_bytes: c.maxVersionBytes,
    max_assets_per_version: c.maxAssetsPerVersion,
    max_asset_path_length: LIMITS.maxAssetPathLength,
    max_request_bytes: LIMITS.maxInlineRequestBytes,
    max_bundle_bytes: maxBundleBytes(c),
    max_bundle_file_bytes: LIMITS.maxBundleFileBytes,
  };
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
