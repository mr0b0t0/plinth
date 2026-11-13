// OAuth 2.1 authorization server for /mcp, on D1. Public clients only (PKCE S256, no secrets),
// dynamic client registration (RFC 7591), consent through the SPA, rotating refresh tokens and
// revocation (RFC 7009). Codes and tokens are random and stored only as SHA-256 hashes.
import {
  type ClientType,
  type OAuthConsentResult,
  type OAuthRequestInfo,
  SCOPES,
  type Scope,
  TTL,
} from "@plinth/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { TOKEN_PREFIX } from "../auth/principal.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentConnections, oauthClients, oauthGrants, oauthRequests } from "../db/schema.ts";
import {
  base64url,
  hashToken,
  newId,
  newToken,
  randomString,
  timingSafeEqual,
} from "../lib/crypto.ts";
import { notFound } from "../lib/errors.ts";
import { isoIn, nowIso } from "../lib/time.ts";

/** How long a pending authorization request waits for the person to consent. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2000;
export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_STATE_LENGTH = 1000;
export const REGISTRATIONS_PER_IP_PER_HOUR = 20;

const GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An OAuth protocol error, rendered as `{ error, error_description }` (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  toBody() {
    return { error: this.error, error_description: this.description };
  }
}

export const mcpResource = (config: Config) => `${config.appOrigin}/mcp`;

/** RFC 8414 authorization server metadata. The issuer is the app origin. */
export function authorizationServerMetadata(config: Config) {
  const o = config.appOrigin;
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [...GRANT_TYPES],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    // RFC 9207: the redirect back to the client carries `iss`, so it can detect mix-up attacks.
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Redirect URIs must be https, or http on a loopback host (native apps, RFC 8252). No fragments, no
 * credentials. Matching at /authorize is exact string comparison.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  if (raw.length > MAX_REDIRECT_URI_LENGTH || raw.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

// ---------- Registration (RFC 7591) ----------

export async function registerClient(db: Db, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OAuthError("invalid_client_metadata", "Body must be a JSON object");
  }
  const m = raw as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `redirect_uris must be a list of 1 to ${MAX_REDIRECT_URIS} URIs`,
    );
  }
  for (const u of uris) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "Each redirect URI must be https, or http on localhost, 127.0.0.1 or [::1], without a fragment",
      );
    }
  }
  if (m.grant_types !== undefined) {
    const g = m.grant_types;
    if (
      !Array.isArray(g) ||
      !g.every((x) => (GRANT_TYPES as readonly unknown[]).includes(x)) ||
      !g.includes("authorization_code")
    ) {
      throw new OAuthError(
        "invalid_client_metadata",
        "grant_types must include authorization_code and may add refresh_token",
      );
    }
  }
  if (m.response_types !== undefined) {
    const r = m.response_types;
    if (!Array.isArray(r) || !r.every((x) => x === "code")) {
      throw new OAuthError("invalid_client_metadata", 'response_types must be ["code"]');
    }
  }
  let clientName: string | null = null;
  if (m.client_name !== undefined) {
    if (typeof m.client_name !== "string") {
      throw new OAuthError("invalid_client_metadata", "client_name must be a string");
    }
    clientName = m.client_name.trim().slice(0, MAX_CLIENT_NAME_LENGTH) || null;
  }
  // Plinth only has public clients (PKCE, no secret). A different requested method is replaced,
  // as RFC 7591 §3.2.1 allows; the response tells the client what it got.
  const id = randomString(32);
  const createdAt = nowIso();
  const redirectUris = [...new Set(uris as string[])];
  await db
    .insert(oauthClients)
    .values({
      id,
      clientName,
      redirectUris: JSON.stringify(redirectUris),
      tokenEndpointAuthMethod: "none",
      clientSecretHash: null,
      createdAt,
    })
    .run();
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: [...GRANT_TYPES],
    response_types: ["code"],
    scope: SCOPES.join(" "),
  };
}

async function getClient(db: Db, clientId: string | null | undefined) {
  if (!clientId || clientId.length > 200) return null;
  const row = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
  if (!row) return null;
  let redirectUris: string[] = [];
  try {
    redirectUris = JSON.parse(row.redirectUris) as string[];
  } catch {
    redirectUris = [];
  }
  return { ...row, redirectUris };
}

/** Space-separated scope string to a validated list. Empty means every scope. */
export function parseRequestedScope(scope: string | null): Scope[] {
  const asked = (scope ?? "").split(" ").filter(Boolean);
  // Refresh tokens are always issued; tolerate clients that ask for them by scope.
  const wanted = asked.filter((s) => s !== "offline_access");
  if (wanted.length === 0) return [...SCOPES];
  const out: Scope[] = [];
  for (const s of wanted) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new OAuthError("invalid_scope", `Unknown scope: ${s.slice(0, 50)}`);
    }
    if (!out.includes(s as Scope)) out.push(s as Scope);
  }
  return out;
}

// ---------- Authorization endpoint ----------

export type AuthorizeOutcome =
  /** Client or redirect URI could not be validated: show an error page, never redirect. */
  { kind: "error_page"; message: string } | { kind: "redirect"; location: string };

/** Build the client redirect with RFC 6749 parameters plus RFC 9207 `iss`. */
export function clientRedirect(
  config: Config,
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set("iss", config.appOrigin);
  return u.toString();
}

export async function startAuthorization(
  db: Db,
  config: Config,
  q: URLSearchParams,
): Promise<AuthorizeOutcome> {
  for (const k of ["client_id", "redirect_uri", "response_type", "code_challenge", "state"]) {
    if (q.getAll(k).length > 1) {
      return { kind: "error_page", message: `The ${k} parameter appears more than once.` };
    }
  }
  const client = await getClient(db, q.get("client_id"));
  if (!client) {
    return {
      kind: "error_page",
      message: "This application is not registered with Plinth. Reconnect it and try again.",
    };
  }
  const redirectUri = q.get("redirect_uri");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return {
      kind: "error_page",
      message: "The redirect address does not match what this application registered.",
    };
  }
  const state = q.get("state");
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "redirect",
    location: clientRedirect(config, redirectUri, {
      error,
      error_description: description,
      state: state && state.length <= MAX_STATE_LENGTH ? state : null,
    }),
  });

  if (state && state.length > MAX_STATE_LENGTH) return fail("invalid_request", "state is too long");
  if (q.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported");
  }
  const challenge = q.get("code_challenge");
  if (!challenge || !PKCE_RE.test(challenge)) {
    return fail("invalid_request", "PKCE code_challenge is required");
  }
  if (q.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  let scopes: Scope[];
  try {
    scopes = parseRequestedScope(q.get("scope"));
  } catch (e) {
    if (e instanceof OAuthError) return fail(e.error, e.description);
    throw e;
  }
  const resource = q.get("resource");
  if (resource !== null && resource !== mcpResource(config)) {
    return fail("invalid_target", `resource must be ${mcpResource(config)}`);
  }

  const now = nowIso();
  // Housekeeping: pending requests are short-lived.
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, now)).run();
  const id = randomString(32);
  await db
    .insert(oauthRequests)
    .values({
      id,
      clientId: client.id,
      redirectUri,
      codeChallenge: challenge,
      scope: scopes.join(" "),
      state,
      resource,
      expiresAt: isoIn(REQUEST_TTL_MS),
      createdAt: now,
    })
    .run();
  return {
    kind: "redirect",
    location: `${config.appOrigin}/oauth/consent?request=${encodeURIComponent(id)}`,
  };
}

// ---------- Consent (session + CSRF, through /api/v1) ----------

async function pendingRequest(db: Db, id: string) {
  const row = await db.select().from(oauthRequests).where(eq(oauthRequests.id, id)).get();
  if (!row || row.expiresAt <= nowIso()) throw notFound("Authorization request");
  return row;
}

export async function describeRequest(db: Db, id: string): Promise<OAuthRequestInfo> {
  const row = await pendingRequest(db, id);
  const client = await getClient(db, row.clientId);
  if (!client) throw notFound("Authorization request");
  return {
    id: row.id,
    client_id: row.clientId,
    client_name: client.clientName,
    redirect_host: new URL(row.redirectUri).host,
    redirect_uri: row.redirectUri,
    scopes: row.scope.split(" ").filter(Boolean),
    expires_at: row.expiresAt,
  };
}

export async function decideConsent(
  db: Db,
  config: Config,
  userId: string,
  input: { request_id: string; label: string; client_type: ClientType; approve: boolean },
): Promise<OAuthConsentResult> {
  // Take the request exactly once: a second decision on the same request finds nothing.
  const req = await db
    .delete(oauthRequests)
    .where(eq(oauthRequests.id, input.request_id))
    .returning()
    .get();
  if (!req || req.expiresAt <= nowIso()) throw notFound("Authorization request");

  if (!input.approve) {
    return {
      redirect_to: clientRedirect(config, req.redirectUri, {
        error: "access_denied",
        error_description: "The user declined the request",
        state: req.state,
      }),
    };
  }

  const code = randomString(43);
  const now = nowIso();
  const connectionId = newId();
  await db.batch([
    db.insert(agentConnections).values({
      id: connectionId,
      userId,
      label: input.label,
      clientType: input.client_type,
      kind: "oauth",
      tokenHash: null,
      scopes: req.scope,
      oauthClientId: req.clientId,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    }),
    db.insert(oauthGrants).values({
      id: newId(),
      clientId: req.clientId,
      userId,
      connectionId,
      codeHash: await hashToken(code),
      codeChallenge: req.codeChallenge,
      redirectUri: req.redirectUri,
      scope: req.scope,
      resource: req.resource,
      codeExpiresAt: isoIn(TTL.oauthCodeMs),
      codeUsedAt: null,
      accessTokenHash: null,
      accessExpiresAt: null,
      refreshTokenHash: null,
      refreshExpiresAt: null,
      createdAt: now,
      revokedAt: null,
    }),
  ]);
  return { redirect_to: clientRedirect(config, req.redirectUri, { code, state: req.state }) };
}

// ---------- Token endpoint ----------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function newTokens() {
  return {
    access: newToken(TOKEN_PREFIX.access),
    refresh: newToken(TOKEN_PREFIX.refresh),
    accessExpiresAt: isoIn(TTL.oauthAccessTokenS * 1000),
    refreshExpiresAt: isoIn(TTL.oauthRefreshTokenS * 1000),
  };
}

const invalidGrant = (why: string) => new OAuthError("invalid_grant", why);

async function revokeGrant(db: Db, grantId: string, connectionId: string) {
  const now = nowIso();
  await db.batch([
    db
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt))),
    db
      .update(agentConnections)
      .set({ revokedAt: now })
      .where(and(eq(agentConnections.id, connectionId), isNull(agentConnections.revokedAt))),
  ]);
}

export async function tokenRequest(
  db: Db,
  d1: D1Database,
  config: Config,
  p: URLSearchParams,
): Promise<TokenResponse> {
  for (const k of new Set(p.keys())) {
    if (p.getAll(k).length > 1) {
      throw new OAuthError("invalid_request", `Parameter ${k.slice(0, 40)} appears more than once`);
    }
  }
  const client = await getClient(db, p.get("client_id"));
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id", 401);
  const resource = p.get("resource");
  if (resource !== null && resource !== mcpResource(config)) {
    throw new OAuthError("invalid_target", `resource must be ${mcpResource(config)}`);
  }
  switch (p.get("grant_type")) {
    case "authorization_code":
      return exchangeCode(db, d1, client.id, p);
    case "refresh_token":
      return refresh(db, d1, client.id, p);
    case null:
      throw new OAuthError("invalid_request", "grant_type is required");
    default:
      throw new OAuthError(
        "unsupported_grant_type",
        "Supported grant types: authorization_code, refresh_token",
      );
  }
}

async function exchangeCode(
  db: Db,
  d1: D1Database,
  clientId: string,
  p: URLSearchParams,
): Promise<TokenResponse> {
  const code = p.get("code");
  const verifier = p.get("code_verifier");
  const redirectUri = p.get("redirect_uri");
  if (!code || !verifier || !redirectUri) {
    throw new OAuthError("invalid_request", "code, code_verifier and redirect_uri are required");
  }
  const grant = await db
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.codeHash, await hashToken(code)))
    .get();
  if (!grant) throw invalidGrant("Unknown authorization code");

  // Consume the code first, atomically: any second presentation, by anyone, is a replay. OAuth 2.1
  // says a replayed code should revoke what it issued, since one of the two parties stole it.
  const now = nowIso();
  const consumed = await d1
    .prepare(
      "UPDATE oauth_grants SET code_used_at = ?2 WHERE id = ?1 AND code_used_at IS NULL RETURNING id",
    )
    .bind(grant.id, now)
    .first<{ id: string }>();
  if (!consumed) {
    await revokeGrant(db, grant.id, grant.connectionId);
    throw invalidGrant("Authorization code was already used; the grant has been revoked");
  }
  if (grant.revokedAt) throw invalidGrant("Grant revoked");
  if (grant.clientId !== clientId) throw invalidGrant("Code was issued to another client");
  if (!grant.codeExpiresAt || grant.codeExpiresAt <= now) {
    throw invalidGrant("Authorization code expired");
  }
  if (grant.redirectUri !== redirectUri) throw invalidGrant("redirect_uri does not match");
  if (!PKCE_RE.test(verifier) || !grant.codeChallenge) {
    throw invalidGrant("PKCE verification failed");
  }
  if (!timingSafeEqual(await pkceS256(verifier), grant.codeChallenge)) {
    throw invalidGrant("PKCE verification failed");
  }
  const conn = await db
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.id, grant.connectionId))
    .get();
  if (!conn || conn.revokedAt) throw invalidGrant("Connection revoked");

  const t = newTokens();
  await db
    .update(oauthGrants)
    .set({
      accessTokenHash: await hashToken(t.access),
      accessExpiresAt: t.accessExpiresAt,
      refreshTokenHash: await hashToken(t.refresh),
      refreshExpiresAt: t.refreshExpiresAt,
    })
    .where(eq(oauthGrants.id, grant.id))
    .run();
  return {
    access_token: t.access,
    token_type: "Bearer",
    expires_in: TTL.oauthAccessTokenS,
    refresh_token: t.refresh,
    scope: grant.scope,
  };
}

async function refresh(
  db: Db,
  d1: D1Database,
  clientId: string,
  p: URLSearchParams,
): Promise<TokenResponse> {
  const token = p.get("refresh_token");
  if (!token) throw new OAuthError("invalid_request", "refresh_token is required");
  const oldHash = await hashToken(token);
  const row = await db
    .select({ grant: oauthGrants, conn: agentConnections })
    .from(oauthGrants)
    .innerJoin(agentConnections, eq(agentConnections.id, oauthGrants.connectionId))
    .where(eq(oauthGrants.refreshTokenHash, oldHash))
    .get();
  if (!row) {
    // A rotated token presented again: someone holds a copy. Revoke the whole grant.
    const reused = await db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.previousRefreshTokenHash, oldHash))
      .get();
    if (reused && !reused.revokedAt) {
      await revokeGrant(db, reused.id, reused.connectionId);
      throw invalidGrant("Refresh token was already used; the grant is revoked");
    }
    throw invalidGrant("Unknown or rotated refresh token");
  }
  const { grant, conn } = row;
  const now = nowIso();
  if (grant.revokedAt || conn.revokedAt) throw invalidGrant("Grant revoked");
  if (grant.clientId !== clientId) throw invalidGrant("Refresh token was issued to another client");
  if (!grant.refreshExpiresAt || grant.refreshExpiresAt <= now) {
    throw invalidGrant("Refresh token expired");
  }
  let scope = grant.scope;
  const asked = p.get("scope");
  if (asked) {
    const granted = new Set(grant.scope.split(" "));
    const narrowed = parseRequestedScope(asked);
    if (!narrowed.every((s) => granted.has(s))) {
      throw new OAuthError("invalid_scope", "Requested scope exceeds the original grant");
    }
    scope = narrowed.join(" ");
  }

  // Rotate: the old refresh token stops working. The WHERE on the old hash makes concurrent
  // refreshes with the same token produce one winner.
  const t = newTokens();
  const r = await d1
    .prepare(
      `UPDATE oauth_grants SET access_token_hash = ?1, access_expires_at = ?2, refresh_token_hash = ?3,
         refresh_expires_at = ?4, scope = ?5, previous_refresh_token_hash = ?7
       WHERE id = ?6 AND refresh_token_hash = ?7 AND revoked_at IS NULL`,
    )
    .bind(
      await hashToken(t.access),
      t.accessExpiresAt,
      await hashToken(t.refresh),
      t.refreshExpiresAt,
      scope,
      grant.id,
      oldHash,
    )
    .run();
  if (r.meta.changes !== 1) throw invalidGrant("Unknown or rotated refresh token");
  return {
    access_token: t.access,
    token_type: "Bearer",
    expires_in: TTL.oauthAccessTokenS,
    refresh_token: t.refresh,
    scope,
  };
}

// ---------- Revocation (RFC 7009) ----------

/**
 * Revoke the grant behind an access or refresh token (and its connection). Unknown tokens, and
 * tokens of another client, succeed silently so the endpoint cannot be used to probe tokens.
 */
export async function revokeToken(db: Db, p: URLSearchParams): Promise<void> {
  const token = p.get("token");
  if (!token) throw new OAuthError("invalid_request", "token is required");
  if (!token.startsWith(TOKEN_PREFIX.access) && !token.startsWith(TOKEN_PREFIX.refresh)) return;
  const hash = await hashToken(token);
  const grant = await db
    .select()
    .from(oauthGrants)
    .where(or(eq(oauthGrants.accessTokenHash, hash), eq(oauthGrants.refreshTokenHash, hash)))
    .get();
  if (!grant) return;
  const clientId = p.get("client_id");
  if (clientId && clientId !== grant.clientId) return;
  await revokeGrant(db, grant.id, grant.connectionId);
}
