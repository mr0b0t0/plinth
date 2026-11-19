// Password sign-in for exactly one account, the review account (REVIEW_LOGIN_EMAIL and
// REVIEW_LOGIN_PASSWORD_HASH), for a directory's reviewers, who cannot receive a sign-in email.
// Off unless both are set: the API route and the /login/review page are then 404s.
//
// The account is an ordinary user: config validation refuses an ADMIN_EMAIL address and single-user
// mode, and this check refuses an admin address again. Guessing is bounded per address and across
// all addresses (a lockout for the rest of the hour after RATE_LIMITS.reviewLoginFailuresPerHour
// wrong passwords). Every attempt is logged with its outcome, never with the password or email.
import { RATE_LIMITS } from "@plinth/shared";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { UserRow } from "../db/schema.ts";
import { timingSafeEqual, verifyPassword } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { enforce, hit, peek } from "../lib/ratelimit.ts";
import { getOrCreateUser } from "../services/users.ts";
import { maySignIn } from "./login.ts";

const HOUR = 3600;
const FAILURES_KEY = "login:review:failures";
const INVALID = "That email and password do not match.";
const LOCKED =
  "This sign-in is locked after too many wrong passwords. Try again in an hour, or ask the instance's operator.";

export interface ReviewLoginDeps {
  config: Config;
  db: Db;
  /** Raw D1 binding, for rate-limit counters. */
  d1: D1Database;
  ip: string | null;
}

/** The review sign-in is configured on this instance. */
export function reviewLoginEnabled(config: Config): boolean {
  return config.reviewLogin !== null;
}

function log(outcome: string): void {
  // Outcome only: the email is the configured one and the password never leaves this function.
  console.log(`review login: ${outcome}`);
}

/**
 * Check the review account's email and password. On success the account exists (created on first
 * use, unverified: a password proves nothing about the mailbox) and is returned. Throws not_found
 * when the review sign-in is off, rate_limited when it is locked or the address is over its limit,
 * and the same invalid_input for a wrong email or a wrong password.
 */
export async function verifyReviewLogin(
  deps: ReviewLoginDeps,
  email: string,
  password: string,
): Promise<UserRow> {
  const { config, db, d1 } = deps;
  const review = config.reviewLogin;
  if (!review) throw new ApiError("not_found", "No such API endpoint");

  if (deps.ip) {
    await enforce(
      d1,
      `login:review:ip:${deps.ip}`,
      RATE_LIMITS.reviewLoginAttemptsPerIpPerHour,
      HOUR,
      "Too many sign-in attempts from this network. Try again later.",
    );
  }
  // Locked: refuse before spending any work on the password.
  if ((await peek(d1, FAILURES_KEY, HOUR)) >= RATE_LIMITS.reviewLoginFailuresPerHour) {
    log("refused (locked)");
    throw new ApiError("rate_limited", LOCKED);
  }

  const address = email.trim().toLowerCase();
  // Always derive the hash, so a wrong email costs the same time as a wrong password.
  const passwordOk = await verifyPassword(password, review.passwordHash);
  const emailOk = timingSafeEqual(address, review.email);
  const allowed =
    emailOk && passwordOk && !config.adminEmails.includes(address) && maySignIn(config, address);
  if (!allowed) {
    const r = await hit(d1, FAILURES_KEY, RATE_LIMITS.reviewLoginFailuresPerHour, HOUR);
    log(r.allowed ? "refused (wrong email or password)" : "refused (wrong password; now locked)");
    throw new ApiError("invalid_input", INVALID);
  }
  const user = await getOrCreateUser(db, config, address);
  log(`signed in user ${user.id}`);
  return user;
}
