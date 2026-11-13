// Viewer tokens. After the access check on APP_HOST, the app issues a one-time "enter" token bound
// to one artifact id and its access epoch. The content subdomain exchanges it for a host-only
// cookie ("content" token) bound to the same artifact and epoch. A token for artifact A is rejected
// on artifact B; any visibility, password or grant change bumps the epoch and ends old cookies.
import { CONTENT_RESERVED_PREFIX, TTL } from "@plinth/shared";
import { type Config, contentOrigin } from "../config.ts";
import { randomString, signToken, verifyToken } from "../lib/crypto.ts";

export interface EnterPayload {
  k: "enter";
  /** artifact id */
  a: string;
  /** access epoch at issue time */
  e: number;
  /** single-use nonce */
  n: string;
  exp: number;
  [key: string]: unknown;
}

export interface ContentPayload {
  k: "content";
  a: string;
  e: number;
  exp: number;
  [key: string]: unknown;
}

/** Only same-origin absolute paths, never "//host" or a scheme. */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

export async function issueEnterUrl(
  config: Config,
  artifact: { id: string; accessEpoch: number },
  next = "/",
): Promise<string> {
  const token = await signToken(config.tokenSigningKey, {
    k: "enter",
    a: artifact.id,
    e: artifact.accessEpoch,
    n: randomString(24),
    exp: Date.now() + TTL.viewerTokenMs,
  } satisfies EnterPayload);
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
): Promise<string> {
  return signToken(config.tokenSigningKey, {
    k: "content",
    a: artifactId,
    e: epoch,
    exp: Date.now() + TTL.contentCookieS * 1000,
  } satisfies ContentPayload);
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
