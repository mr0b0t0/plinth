// Per-request context for the app host: config, database, the calling principal, CSRF.
import { COOKIES, CSRF_HEADER } from "@plinth/shared";
import type { Context, MiddlewareHandler } from "hono";
import { resolveBearer, resolveSession, resolveViewerSession } from "../auth/principal.ts";
import { type Bindings, type Config, getConfig } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import { parseCookies, secureFlag, serializeCookie } from "../lib/cookies.ts";
import { randomString, timingSafeEqual, verifyToken } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import type { Principal } from "../policy.ts";
import type { Ctx } from "../services/context.ts";

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    config: Config;
    db: Db;
    principal: Principal;
    /** How the principal authenticated. "bearer" requests skip CSRF (no ambient credentials). */
    authVia: "bearer" | "cookie" | "none";
    cookies: Map<string, string>;
    passwordPasses: Map<string, number>;
    viewerEmail: string | null;
  };
}

export type AppContext = Context<AppEnv>;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Config and database on every app-host request. */
export const base: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("config", getConfig(c.env as unknown as Record<string, unknown>));
  c.set("db", getDb(c.env.DB));
  c.set("cookies", parseCookies(c.req.header("cookie")));
  await next();
};

export interface PasswordPassPayload {
  k: "pw";
  a: string;
  e: number;
  exp: number;
  [key: string]: unknown;
}

/** Resolve the principal and enforce CSRF for cookie-authenticated (or anonymous) writes. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.get("config");
  const db = c.get("db");
  const cookies = c.get("cookies");
  const authz = c.req.header("authorization");
  let principal: Principal = { kind: "anonymous" };
  let via: AppEnv["Variables"]["authVia"] = "none";
  /** A confirmed allowlist email (viewer cookie), kept even when a user session also exists. */
  let viewerEmail: string | null = null;

  if (authz) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    const p = m?.[1]
      ? await resolveBearer(db, config, m[1], (p) => c.executionCtx.waitUntil(p))
      : null;
    if (!p) throw new ApiError("unauthorized", "Invalid, expired or revoked bearer token");
    principal = p;
    via = "bearer";
  } else {
    const session = cookies.get(COOKIES.session);
    const viewer = cookies.get(COOKIES.viewer);
    const user = session ? await resolveSession(db, session) : null;
    const viewerP = viewer ? await resolveViewerSession(db, viewer) : null;
    if (viewerP?.kind === "viewer") viewerEmail = viewerP.email;
    const p = user ?? viewerP;
    if (p) {
      // Admin rights follow the current ADMIN_EMAIL, not a flag stored at sign-in.
      principal = p.kind === "user" ? { ...p, isAdmin: config.adminEmails.includes(p.email) } : p;
      via = "cookie";
    }
  }

  if (via !== "bearer" && UNSAFE.has(c.req.method)) checkCsrf(c, config);

  const passes = new Map<string, number>();
  for (const [name, value] of cookies) {
    if (!name.startsWith(COOKIES.passwordPassPrefix)) continue;
    const p = await verifyToken<PasswordPassPayload>(config.tokenSigningKey, value, "pw");
    if (p && name === `${COOKIES.passwordPassPrefix}${p.a}`) passes.set(p.a, p.e);
  }

  c.set("principal", principal);
  c.set("authVia", via);
  c.set("passwordPasses", passes);
  c.set("viewerEmail", viewerEmail);
  await next();
};

/**
 * Double-submit CSRF check plus an Origin check. Applies to every state-changing request that does
 * not carry a bearer token, including anonymous ones (login, viewer password), so no cross-site
 * form or fetch can act with the browser's cookies.
 */
function checkCsrf(c: AppContext, config: Config): void {
  const origin = c.req.header("origin");
  if (origin && origin !== config.appOrigin)
    throw new ApiError("csrf", "Cross-origin request refused");
  const cookie = c.get("cookies").get(COOKIES.csrf);
  const header = c.req.header(CSRF_HEADER);
  if (!cookie || !header || !timingSafeEqual(cookie, header)) {
    throw new ApiError("csrf", "Missing or invalid CSRF token. Reload the page and try again.");
  }
}

/** Set the CSRF cookie if the browser does not have one yet. Readable by the app's own JS. */
export function ensureCsrfCookie(c: AppContext, headers: Headers): void {
  if (c.get("cookies").get(COOKIES.csrf)) return;
  const config = c.get("config");
  headers.append(
    "Set-Cookie",
    serializeCookie(COOKIES.csrf, randomString(32), {
      httpOnly: false,
      secure: secureFlag(config.scheme, config.appHost),
      sameSite: "Strict",
      maxAge: 60 * 60 * 24 * 365,
    }),
  );
}

/** The client IP for rate limits, or null (no header, or DEV_IGNORE_CLIENT_IP in development). */
export function clientIp(c: Context<AppEnv>): string | null {
  if (c.get("config").devIgnoreClientIp) return null;
  return c.req.header("cf-connecting-ip") ?? null;
}

export function serviceCtx(c: AppContext): Ctx {
  return {
    env: c.env,
    config: c.get("config"),
    db: c.get("db"),
    principal: c.get("principal"),
    passwordPasses: c.get("passwordPasses"),
    viewerEmail: c.get("viewerEmail") ?? null,
    ip: clientIp(c),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
}

/** Parse a JSON body with a schema; invalid input becomes a 400 with the issues. */
export async function parseBody<T>(
  c: AppContext,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("invalid_input", "Body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_input", "Invalid input", { issues: r.error.issues });
  return r.data;
}

export function parseInput<T>(
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  raw: unknown,
): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_input", "Invalid input", { issues: r.error.issues });
  return r.data;
}
