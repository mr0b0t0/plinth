// Sign-in for people: one email with a magic link and a six-digit code. Both are single use, expire
// after TTL.loginCodeMs, and are stored only as keyed hashes. Requesting a code never reveals
// whether an account exists: the account is created on the first successful verification.
import { RATE_LIMITS, TTL } from "@plinth/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { loginCodes, type UserRow } from "../db/schema.ts";
import type { EmailAdapter } from "../email/index.ts";
import { loginEmail } from "../email/templates.ts";
import {
  hashToken,
  hmacHex,
  newId,
  newSixDigitCode,
  randomString,
  timingSafeEqual,
} from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { isoIn, nowIso } from "../lib/time.ts";
import { getOrCreateUser } from "../services/users.ts";

/** Wrong guesses allowed against one code before it is burned. */
export const MAX_CODE_ATTEMPTS = 5;
const HOUR = 3600;

export interface LoginDeps {
  config: Config;
  db: Db;
  /** Raw D1 binding, for rate-limit counters. */
  d1: D1Database;
  mailer: EmailAdapter;
  ip: string | null;
}

const INVALID = "That code is wrong or has expired. Request a new one if needed.";

/** Keyed hash of a six-digit code. The pepper keeps a database dump from being brute-forced offline. */
export function hashLoginCode(config: Config, email: string, code: string): Promise<string> {
  return hmacHex(config.sessionSecret, `login-code:${email}:${code}`);
}

/** May this address sign in at all? In single-user mode only the admin email can. */
export function maySignIn(config: Config, email: string): boolean {
  return !config.singleUserMode || config.adminEmails.includes(email);
}

/**
 * Send a sign-in email. Answers the same way whether or not the address has an account; in
 * single-user mode other addresses get the same answer but no email.
 */
export async function requestLogin(deps: LoginDeps, email: string): Promise<void> {
  const { config, db, d1 } = deps;
  // Cloudflare always sets the client IP in production; without it (local tests) only the
  // per-email limit applies.
  if (deps.ip) {
    await enforce(
      d1,
      `login:ip:${deps.ip}`,
      RATE_LIMITS.loginPerIpPerHour,
      HOUR,
      "Too many sign-in requests from this network. Try again later.",
    );
  }
  await enforce(
    d1,
    `login:email:${email}`,
    RATE_LIMITS.loginPerEmailPerHour,
    HOUR,
    "Too many sign-in emails for this address. Try again later.",
  );
  if (!maySignIn(config, email)) return;

  const code = newSixDigitCode();
  const linkToken = randomString(43);
  const now = nowIso();
  // One live code per address: a new email supersedes the previous one.
  await db
    .update(loginCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(loginCodes.email, email),
        eq(loginCodes.purpose, "login"),
        isNull(loginCodes.consumedAt),
      ),
    )
    .run();
  await db
    .insert(loginCodes)
    .values({
      id: newId(),
      email,
      purpose: "login",
      artifactId: null,
      codeHash: await hashLoginCode(config, email, code),
      linkTokenHash: await hashToken(linkToken),
      attempts: 0,
      expiresAt: isoIn(TTL.loginCodeMs),
      consumedAt: null,
      createdAt: now,
    })
    .run();

  // The SPA page POSTs the token; a GET of this URL never signs anyone in, so mail scanners that
  // prefetch links cannot burn or use it.
  const link = `${config.appOrigin}/login/magic?token=${encodeURIComponent(linkToken)}`;
  try {
    await deps.mailer.send(
      loginEmail({ to: email, link, code, minutes: Math.round(TTL.loginCodeMs / 60_000) }),
    );
  } catch (e) {
    // Name the provider and status only; never the message (it holds the code).
    console.error(`sign-in email failed: ${e instanceof Error ? e.message : "unknown error"}`);
    throw new ApiError("internal", "Could not send the sign-in email. Try again later.");
  }
}

/** Check a six-digit code. On success the code is consumed and the user exists and is verified. */
export async function verifyLoginCode(
  deps: LoginDeps,
  email: string,
  code: string,
): Promise<UserRow> {
  const { config, db, d1 } = deps;
  await enforce(
    d1,
    `login:verify:${email}`,
    RATE_LIMITS.codeAttemptsPerEmailPerHour,
    HOUR,
    "Too many attempts. Request a new code later.",
  );
  if (!maySignIn(config, email)) throw new ApiError("invalid_input", INVALID);

  const row = await db
    .select()
    .from(loginCodes)
    .where(
      and(
        eq(loginCodes.email, email),
        eq(loginCodes.purpose, "login"),
        isNull(loginCodes.consumedAt),
        gt(loginCodes.expiresAt, nowIso()),
      ),
    )
    .orderBy(desc(loginCodes.createdAt))
    .get();
  if (!row) throw new ApiError("invalid_input", INVALID);

  // Count the attempt before comparing, atomically, so parallel guesses cannot exceed the cap.
  const counted = await d1
    .prepare(
      "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND consumed_at IS NULL RETURNING attempts",
    )
    .bind(row.id, MAX_CODE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!counted) {
    await burn(db, row.id);
    throw new ApiError("invalid_input", INVALID);
  }

  const expected = await hashLoginCode(config, email, code);
  if (!timingSafeEqual(expected, row.codeHash)) {
    if (counted.attempts >= MAX_CODE_ATTEMPTS) await burn(db, row.id);
    throw new ApiError("invalid_input", INVALID);
  }
  if (!(await consume(d1, row.id))) throw new ApiError("invalid_input", INVALID);
  return getOrCreateUser(db, config, email, { verified: true });
}

/** Check a magic-link token (POSTed by the SPA). Single use. */
export async function verifyMagicLink(deps: LoginDeps, token: string): Promise<UserRow> {
  const { config, db, d1 } = deps;
  if (deps.ip) {
    await enforce(
      d1,
      `login:link:ip:${deps.ip}`,
      RATE_LIMITS.loginPerIpPerHour,
      HOUR,
      "Too many attempts. Try again later.",
    );
  }
  const invalid = new ApiError(
    "invalid_input",
    "This sign-in link is invalid, already used or expired. Request a new one.",
  );
  const row = await db
    .select()
    .from(loginCodes)
    .where(
      and(
        eq(loginCodes.linkTokenHash, await hashToken(token)),
        eq(loginCodes.purpose, "login"),
        isNull(loginCodes.consumedAt),
        gt(loginCodes.expiresAt, nowIso()),
      ),
    )
    .get();
  if (!row || !maySignIn(config, row.email)) throw invalid;
  if (!(await consume(d1, row.id))) throw invalid;
  return getOrCreateUser(db, config, row.email, { verified: true });
}

/** Mark a code used. Exactly one concurrent caller gets true. */
async function consume(d1: D1Database, id: string): Promise<boolean> {
  const r = await d1
    .prepare(
      "UPDATE login_codes SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL RETURNING id",
    )
    .bind(id, nowIso())
    .first<{ id: string }>();
  return !!r;
}

async function burn(db: Db, id: string): Promise<void> {
  await db
    .update(loginCodes)
    .set({ consumedAt: nowIso() })
    .where(and(eq(loginCodes.id, id), isNull(loginCodes.consumedAt)))
    .run();
}
