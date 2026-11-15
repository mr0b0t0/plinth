// Viewer tokens. After the access check on APP_HOST, the app issues a one-time "enter" token bound
// to one artifact id and its access epoch. The content subdomain exchanges it for a host-only
// cookie ("content" token) bound to the same artifact and epoch. A token for artifact A is rejected
// on artifact B; any visibility, password or grant change bumps the epoch and ends old cookies.
//
// For identified viewers (owner and grant holders) both tokens may carry `x`, a sealed identity
// claim {m: email, r: role} bound to the artifact id (shared data, docs/spec.md "Shared data and
// viewer identity"). It is sealed because the enter token travels in a URL, and URLs get logged.
import { CONTENT_RESERVED_PREFIX, type EffectiveRole, TTL } from "@plinth/shared";
import { type Config, contentOrigin } from "../config.ts";
import { randomString, sealJson, signToken, verifyToken } from "../lib/crypto.ts";

/** HKDF info for the identity claim's AES key; changing it invalidates every sealed claim. */
export const IDENTITY_CLAIM_INFO = "plinth identity claim v1";

/** The identity claim before sealing. */
export interface ViewerIdentity {
  email: string;
  role: EffectiveRole;
}

export interface EnterPayload {
  k: "enter";
  /** artifact id */
  a: string;
  /** access epoch at issue time */
  e: number;
  /** single-use nonce */
  n: string;
  exp: number;
  /** sealed identity claim (identified viewers only) */
  x?: string;
  /**
   * A thumbnail capture (services/thumbnails.ts): the cookie it becomes may load the artifact as a
   * top-level page, which only Plinth's own capture browser does. Never with `x`.
   */
  c?: 1;
  [key: string]: unknown;
}

/** How long a capture's content cookie lasts: one page load and a screenshot. */
export const CAPTURE_COOKIE_S = 120;

export interface ContentPayload {
  k: "content";
  a: string;
  e: number;
  exp: number;
  /** sealed identity claim, copied unchanged from the enter token */
  x?: string;
  /** a capture pass (copied from the enter token): top-level loads allowed */
  c?: 1;
  [key: string]: unknown;
}

const NEXT_BASE = "https://next.plinth.invalid";

/**
 * Only same-origin absolute paths, never "//host" or a scheme. Browsers strip tabs and newlines
 * from URLs and treat "\\" as "/", so "/\t/evil.example" would become "//evil.example": any control
 * character or backslash is refused, and the result is re-serialized by the URL parser so what we
 * send in a Location header is exactly what the browser will resolve.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 2048) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u0020\u007f\\]/.test(next)) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  let u: URL;
  try {
    u = new URL(next, NEXT_BASE);
  } catch {
    return "/";
  }
  if (u.origin !== NEXT_BASE) return "/";
  const out = `${u.pathname}${u.search}${u.hash}`;
  return out.startsWith("//") ? "/" : out;
}

export async function issueEnterUrl(
  config: Config,
  artifact: { id: string; accessEpoch: number },
  next = "/",
  identity?: ViewerIdentity,
  opts: { capture?: boolean } = {},
): Promise<string> {
  const payload: EnterPayload = {
    k: "enter",
    a: artifact.id,
    e: artifact.accessEpoch,
    n: randomString(24),
    exp: Date.now() + TTL.viewerTokenMs,
  };
  if (opts.capture) {
    if (identity) throw new Error("A capture never carries an identity");
    payload.c = 1;
  }
  if (identity) {
    payload.x = await sealJson(config.tokenSigningKey, IDENTITY_CLAIM_INFO, artifact.id, {
      m: identity.email,
      r: identity.role,
    });
  }
  const token = await signToken(config.tokenSigningKey, payload);
  const params = new URLSearchParams({ t: token, next: safeNext(next) });
  return `${contentOrigin(config, artifact.id)}${CONTENT_RESERVED_PREFIX}enter?${params}`;
}

export function verifyEnterToken(config: Config, token: string) {
  return verifyToken<EnterPayload>(config.tokenSigningKey, token, "enter");
}

export function signContentCookie(
  config: Config,
  artifactId: string,
  epoch: number,
  x?: string,
  capture = false,
): Promise<string> {
  const payload: ContentPayload = {
    k: "content",
    a: artifactId,
    e: epoch,
    exp: Date.now() + (capture ? CAPTURE_COOKIE_S : TTL.contentCookieS) * 1000,
  };
  if (x !== undefined) payload.x = x;
  if (capture) payload.c = 1;
  return signToken(config.tokenSigningKey, payload);
}

export function verifyContentCookie(config: Config, value: string) {
  return verifyToken<ContentPayload>(config.tokenSigningKey, value, "content");
}

/** Mark a nonce used. Returns false if it was already used (replay). */
export async function consumeNonce(
  d1: D1Database,
  nonce: string,
  expiresAtMs: number,
): Promise<boolean> {
  const nowS = Math.floor(Date.now() / 1000);
  const r = await d1
    .prepare(
      "INSERT INTO used_nonces (nonce, expires_at) VALUES (?1, ?2) ON CONFLICT (nonce) DO NOTHING",
    )
    .bind(nonce, Math.ceil(expiresAtMs / 1000))
    .run();
  if (Math.random() < 0.02)
    await d1.prepare("DELETE FROM used_nonces WHERE expires_at < ?1").bind(nowS).run();
  return (r.meta.changes ?? 0) > 0;
}
