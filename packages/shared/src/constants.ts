// Constants shared by the Worker and the web app. Anything a self-hoster may change is an env var
// (see apps/worker/src/config.ts); these are the fixed rules and the defaults.

export const PRODUCT_NAME = "Plinth";

export const VISIBILITIES = ["public", "unlisted", "password", "allowlist"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const ROLES = ["viewer", "commenter", "editor"] as const;
export type Role = (typeof ROLES)[number];

/** Effective role of a principal on one artifact. `owner` is never stored in access_grants. */
export type EffectiveRole = Role | "owner";

export const CLIENT_TYPES = ["claude", "codex", "other"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const MENTION_STATES = ["pending", "claimed", "done", "failed"] as const;
export type MentionState = (typeof MENTION_STATES)[number];

export const COMMENT_STATUSES = ["open", "resolved"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const REPORT_STATES = ["open", "actioned", "dismissed"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/** Token scopes. A personal access token or OAuth grant carries a space-separated subset. */
export const SCOPES = ["artifacts:read", "artifacts:write", "mentions"] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: readonly Scope[] = SCOPES;

/** Agent names that `@name` in a comment maps to a client type. */
export const MENTION_AGENT_NAMES: Record<string, ClientType> = {
  claude: "claude",
  codex: "codex",
};

const MB = 1024 * 1024;

export const LIMITS = {
  /** Bytes of HTML per version. */
  maxHtmlBytes: 5 * MB,
  /** Bytes of HTML plus assets per version. */
  maxVersionBytes: 25 * MB,
  maxAssetsPerVersion: 200,
  maxAssetPathLength: 200,
  maxTitleLength: 200,
  maxNoteLength: 500,
  maxCommentLength: 10_000,
  maxLabelLength: 80,
  maxAllowlistEmails: 200,
  minPasswordLength: 6,
  maxPasswordLength: 200,
  maxReportReasonLength: 2_000,
} as const;

export const TTL = {
  /** Magic link and six-digit code. */
  loginCodeMs: 15 * 60 * 1000,
  /** Code a viewer types to confirm an allowlisted email. */
  viewerCodeMs: 15 * 60 * 1000,
  /** One-time viewer token, exchanged on the content host for a cookie. */
  viewerTokenMs: 60 * 1000,
  /** Host-only viewer cookie on one artifact's content subdomain. */
  contentCookieS: 12 * 60 * 60,
  /** App session cookie. */
  sessionS: 30 * 24 * 60 * 60,
  /** App-host cookie proving a viewer confirmed an allowlisted email. */
  viewerSessionS: 7 * 24 * 60 * 60,
  /** App-host cookie proving a viewer entered an artifact's password. */
  passwordPassS: 12 * 60 * 60,
  oauthCodeMs: 10 * 60 * 1000,
  /** A claimed mention task nobody completed becomes claimable again after this. */
  mentionClaimMs: 30 * 60 * 1000,
  oauthAccessTokenS: 60 * 60,
  oauthRefreshTokenS: 90 * 24 * 60 * 60,
} as const;

export const RATE_LIMITS = {
  loginPerEmailPerHour: 5,
  loginPerIpPerHour: 20,
  codeAttemptsPerEmailPerHour: 10,
  passwordAttemptsPerArtifactPerIpPerHour: 10,
  /** Across all addresses, so guessing cannot be spread over many IPs. */
  passwordAttemptsPerArtifactPerHour: 100,
  viewerCodesPerEmailPerHour: 5,
  commentsPerUserPerHour: 60,
  reportsPerIpPerHour: 10,
  /** GET /a/<slug>/source without signing in: generous, like other link-viewer reads. */
  sourceReadsPerIpPerHour: 600,
} as const;

export const DEFAULTS = {
  maxArtifactsPerUser: 100,
  maxPublishesPerHour: 60,
  /** Stored bytes per account across all versions of live artifacts (1 GiB). */
  maxStorageBytesPerUser: 1024 * 1024 * 1024,
  publicMinAccountAgeHours: 72,
  cdnAllowlist: [
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdn.tailwindcss.com",
    "code.jquery.com",
    "cdn.plot.ly",
  ],
} as const;

/**
 * Browsers accept a `__Host-` cookie only when it is Secure, has Path=/ and no Domain, and no other
 * host (a sibling subdomain included) can set or overwrite one. Every app cookie uses it.
 */
export const HOST_COOKIE_PREFIX = "__Host-";

/**
 * App cookie names as set over https (and on localhost, where Secure cookies work over http). A
 * plain-http instance on another name cannot set Secure cookies; there the Worker drops the
 * `__Host-` prefix (apps/worker/src/lib/cookies.ts appCookieName).
 */
export const COOKIES = {
  /** App session (people). Host-only on APP_HOST. */
  session: "__Host-plinth_session",
  /** Double-submit CSRF token. Host-only on APP_HOST, readable by the app's own JS. */
  csrf: "__Host-plinth_csrf",
  /** Confirmed allowlist email for a viewer without an account. Host-only on APP_HOST. */
  viewer: "__Host-plinth_viewer",
  /** Password pass for one artifact, name suffixed with the artifact id. Host-only on APP_HOST. */
  passwordPassPrefix: "__Host-plinth_pw_",
  /**
   * Viewer cookie on one artifact's content subdomain. Host-only on that subdomain. No `__Host-`
   * prefix: in the staging path fallback it is scoped to the artifact's path on the app host.
   */
  content: "plinth_content",
} as const;

export const CSRF_HEADER = "x-plinth-csrf";

/** Paths on a content host under this prefix are served by Plinth, never by the artifact. */
export const CONTENT_RESERVED_PREFIX = "/__plinth/";

/** Query parameter that turns on review mode (comment anchoring bridge) on a content host. */
export const REVIEW_MODE_PARAM = "plinth-review";

/** postMessage protocol between the app and the bridge script injected in review mode. */
export const BRIDGE_MESSAGE_SOURCE = "plinth-bridge";

/**
 * CONTENT_ISOLATION. `origin`: each artifact is its own origin. `opaque`: artifact documents get an
 * opaque origin (CSP sandbox without allow-same-origin on every content response).
 */
export const CONTENT_ISOLATION_MODES = ["origin", "opaque"] as const;
export type ContentIsolation = (typeof CONTENT_ISOLATION_MODES)[number];

/**
 * The sandbox every artifact iframe uses. The frame's origin is the artifact's own content
 * subdomain, so allow-same-origin gives it that origin, never the app's (see DECISIONS.md).
 * Never add allow-top-navigation or allow-top-navigation-by-user-activation.
 */
export const ARTIFACT_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * The iframe sandbox under opaque isolation: the same flags without allow-same-origin, matching
 * the CSP sandbox every content response carries in that mode, so both layers agree.
 */
export const ARTIFACT_IFRAME_SANDBOX_OPAQUE =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** The iframe sandbox for an artifact frame on this instance. */
export function artifactIframeSandbox(isolation: ContentIsolation | undefined): string {
  return isolation === "opaque" ? ARTIFACT_IFRAME_SANDBOX_OPAQUE : ARTIFACT_IFRAME_SANDBOX;
}
