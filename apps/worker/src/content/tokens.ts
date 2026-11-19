// Viewer tokens. After the access check on APP_HOST, the app issues a one-time "enter" token bound
// to one artifact id and its access epoch. The content subdomain exchanges it for a host-only
// cookie ("content" token) bound to the same artifact and epoch. A token for artifact A is rejected
// on artifact B; any visibility, password or grant change bumps the epoch and ends old cookies.
//
// For identified viewers (owner and grant holders) both tokens may carry `x`, a sealed identity
// claim {m: email, r: role, a?: 1} bound to the artifact id (`a` when the gate's principal was
// signed in to an account, not a viewer confirmed by code) (shared data and live rooms, docs/spec.md
// "Shared data and viewer identity" and "Live rooms"). It is sealed because the enter token
// travels in a URL, and URLs get logged.
//
// A counted open (`w`, docs/spec.md "Artifact stats") also carries `o`, the sealed opener: who is
// opening (an account's user id, a confirmed email, or nobody) and with which role, for the
// owner's stats only. It is sealed for the same reason, never copied into the cookie, and opened
// only by the enter exchange. View cookies carry `i`, a random visitor id, while counting is on.
import { CONTENT_RESERVED_PREFIX, type EffectiveRole, type OpenRole, TTL } from "@plinth/shared";
import { type Config, contentOrigin } from "../config.ts";
import { openJson, randomString, sealJson, signToken, verifyToken } from "../lib/crypto.ts";

/** HKDF info for the identity claim's AES key; changing it invalidates every sealed claim. */
export const IDENTITY_CLAIM_INFO = "plinth identity claim v1";

/** HKDF info for the opener's AES key (artifact stats); separate from the identity claim's. */
export const OPENER_CLAIM_INFO = "plinth opener claim v1";

/**
 * Who is opening, as the gate saw it, for artifact_opens. `user`: signed in (`u`, the user id).
 * `email`: an allowlisted email confirmed by code, no account (`m`). `anonymous`: anyone else.
 */
export type Opener =
  | { kind: "user"; userId: string; role: OpenRole }
  | { kind: "email"; email: string; role: OpenRole }
  | { kind: "anonymous"; role: OpenRole };

/** The identity claim before sealing. */
export interface ViewerIdentity {
  email: string;
  role: EffectiveRole;
  /** Signed in to an account (sealed as `a: 1`); only then may a doc editor edit on the page. */
  account?: boolean;
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
  /**
   * An in-chat preview (mcp/preview.ts): the cookie it becomes lets an MCP host's frame show the
   * page (no frame-ancestors) and is read-only. Never with `x` or `c`; always with `v`.
   */
  p?: 1;
  /** The one version a preview may show. */
  v?: number;
  /**
   * Count this entry as an open (docs/spec.md "Artifact stats"). Set only by the gate,
   * for a live-page view by someone other than the owner, an agent or an admin without a role.
   * Never with `c` or `p`. It changes nothing about the response; the cookie it becomes carries
   * `w` once the open is counted.
   */
  w?: 1;
  /** The sealed opener (Opener), with `w` only. */
  o?: string;
  [key: string]: unknown;
}

/** What a content pass is for: a normal view, a thumbnail capture, or an in-chat preview. */
export type PassKind = "view" | "capture" | "preview";

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
  /** a preview pass (copied from the enter token): any framer, read-only, no identity */
  p?: 1;
  /** the one version a preview pass opens (copied from the enter token) */
  v?: number;
  /**
   * This browser's open of the artifact was counted, at this pass or an earlier one at the same
   * epoch (services/views.ts): later enters with it do not count again. View passes only.
   */
  w?: 1;
  /**
   * This browser's anonymous visitor id for the artifact (VISITOR_ID_RE), carried forward by
   * every view enter while counting is on. View passes only; read even after the pass expired.
   */
  i?: string;
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
  opts: { capture?: boolean; previewVersion?: number; countView?: boolean; opener?: Opener } = {},
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
  if (opts.previewVersion !== undefined) {
    if (identity || opts.capture) throw new Error("A preview is never identified or a capture");
    if (!isVersion(opts.previewVersion)) throw new Error("A preview names one version");
    payload.p = 1;
    payload.v = opts.previewVersion;
  }
  if (opts.countView) {
    if (opts.capture || opts.previewVersion !== undefined)
      throw new Error("A capture or preview never counts as a view");
    payload.w = 1;
    if (opts.opener) payload.o = await sealOpener(config, artifact.id, opts.opener);
  } else if (opts.opener) {
    throw new Error("Only a counted open carries an opener");
  }
  if (identity) {
    payload.x = await sealJson(config.tokenSigningKey, IDENTITY_CLAIM_INFO, artifact.id, {
      m: identity.email,
      r: identity.role,
      ...(identity.account ? { a: 1 } : {}),
    });
  }
  const token = await signToken(config.tokenSigningKey, payload);
  const params = new URLSearchParams({ t: token, next: safeNext(next) });
  return `${contentOrigin(config, artifact.id)}${CONTENT_RESERVED_PREFIX}enter?${params}`;
}

async function sealOpener(config: Config, artifactId: string, o: Opener): Promise<string> {
  const id = o.kind === "user" ? { u: o.userId } : o.kind === "email" ? { m: o.email } : {};
  return sealJson(config.tokenSigningKey, OPENER_CLAIM_INFO, artifactId, {
    k: o.kind,
    r: o.role,
    ...id,
  });
}

const OPEN_ROLES: ReadonlySet<string> = new Set<OpenRole>([
  "editor",
  "commenter",
  "viewer",
  "public",
  "link",
  "password",
]);

/** The opener sealed into an enter token for this artifact, or null when absent or malformed. */
export async function openOpener(
  config: Config,
  artifactId: string,
  sealed: unknown,
): Promise<Opener | null> {
  if (typeof sealed !== "string") return null;
  const v = await openJson(config.tokenSigningKey, OPENER_CLAIM_INFO, artifactId, sealed);
  if (!v || typeof v !== "object") return null;
  const { k, r, u, m } = v as Record<string, unknown>;
  if (typeof r !== "string" || !OPEN_ROLES.has(r)) return null;
  const role = r as OpenRole;
  if (k === "user" && typeof u === "string" && u) return { kind: "user", userId: u, role };
  if (k === "email" && typeof m === "string" && m) return { kind: "email", email: m, role };
  if (k === "anonymous") return { kind: "anonymous", role };
  return null;
}

/** An anonymous visitor id: 22 base62 characters (about 131 bits), random per browser. */
export const VISITOR_ID_RE = /^[A-Za-z0-9]{22}$/;

export function newVisitorId(): string {
  return randomString(22);
}

export function verifyEnterToken(config: Config, token: string) {
  return verifyToken<EnterPayload>(config.tokenSigningKey, token, "enter");
}

export async function signContentCookie(
  config: Config,
  artifactId: string,
  epoch: number,
  x?: string,
  kind: PassKind = "view",
  previewVersion?: number,
  counted = false,
  visitor?: string,
): Promise<string> {
  if (kind !== "view" && x !== undefined)
    throw new Error(`A ${kind} pass never carries an identity`);
  if (kind !== "view" && counted) throw new Error(`A ${kind} pass never counts as an open`);
  if (kind !== "view" && visitor !== undefined)
    throw new Error(`A ${kind} pass never carries a visitor id`);
  if (visitor !== undefined && !VISITOR_ID_RE.test(visitor)) throw new Error("Bad visitor id");
  if ((kind === "preview") !== (previewVersion !== undefined && isVersion(previewVersion)))
    throw new Error("A preview pass, and only a preview pass, names one version");
  const payload: ContentPayload = {
    k: "content",
    a: artifactId,
    e: epoch,
    exp: Date.now() + passMaxAgeS(kind) * 1000,
  };
  if (x !== undefined) payload.x = x;
  if (kind === "capture") payload.c = 1;
  if (kind === "preview") {
    payload.p = 1;
    payload.v = previewVersion;
  }
  if (counted) payload.w = 1;
  if (visitor !== undefined) payload.i = visitor;
  return signToken(config.tokenSigningKey, payload);
}

/** A version number as tokens carry it. */
export function isVersion(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** The content cookie's lifetime for each kind of pass. */
export function passMaxAgeS(kind: PassKind): number {
  if (kind === "capture") return CAPTURE_COOKIE_S;
  if (kind === "preview") return TTL.previewCookieS;
  return TTL.contentCookieS;
}

export function verifyContentCookie(config: Config, value: string) {
  return verifyToken<ContentPayload>(config.tokenSigningKey, value, "content");
}

/**
 * The visitor id in one content cookie value for this artifact, at any access epoch, from a view
 * pass that expired at most TTL.visitorIdS ago (the cookie outlives its pass for this). Null when
 * the value is not one. It grants nothing: access always comes from verifyContentCookie.
 */
export async function visitorIdIn(
  config: Config,
  artifactId: string,
  value: string,
): Promise<string | null> {
  const p = await verifyToken<ContentPayload>(
    config.tokenSigningKey,
    value,
    "content",
    Date.now() - TTL.visitorIdS * 1000,
  );
  if (!p || p.a !== artifactId || p.c !== undefined || p.p !== undefined) return null;
  return typeof p.i === "string" && VISITOR_ID_RE.test(p.i) ? p.i : null;
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
