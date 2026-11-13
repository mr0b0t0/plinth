// Allowlist viewers without an account. A viewer confirms an email with a six-digit code sent to it;
// that creates an app-host viewer session (cookie plinth_viewer) naming the email. The session
// carries no artifact: policy.ts checks the email's grant on every artifact, so one confirmation
// opens every artifact the email is listed on, and an email that is not listed opens nothing.
import { RATE_LIMITS, TTL } from "@plinth/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { type ArtifactRow, accessGrants, loginCodes, sessions } from "../db/schema.ts";
import { createEmailAdapter } from "../email/index.ts";
import {
  hashToken,
  hmacHex,
  newId,
  newSixDigitCode,
  newToken,
  timingSafeEqual,
} from "../lib/crypto.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { isoIn, nowIso } from "../lib/time.ts";
import { findArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

/** Wrong guesses allowed on one code before it stops working. */
export const MAX_VIEWER_CODE_ATTEMPTS = 5;
/** Prefix of the viewer session cookie value (the database keeps only its hash). */
export const VIEWER_SESSION_PREFIX = "plinth_vs_";

const HOUR = 3600;

function ipKey(ctx: Ctx): string {
  return ctx.ip ?? "unknown";
}

/** Codes are hashed with SESSION_SECRET as a pepper and bound to the artifact and email. */
function codeHash(ctx: Ctx, artifactId: string, email: string, code: string): Promise<string> {
  return hmacHex(ctx.config.sessionSecret, `viewer-code\n${artifactId}\n${email}\n${code}`);
}

/** The artifact a viewer may confirm an email for: live, published, and set to allowlist. */
async function allowlistArtifact(ctx: Ctx, ref: string): Promise<ArtifactRow> {
  const a = await findArtifact(ctx, ref);
  if (!a || a.takenDownAt || a.currentVersion < 1 || a.visibility !== "allowlist") throw notFound();
  return a;
}

/** Does this email hold any grant (viewer, commenter or editor) on the artifact? */
export async function isListed(ctx: Ctx, artifactId: string, email: string): Promise<boolean> {
  const g = await ctx.db
    .select({ role: accessGrants.role })
    .from(accessGrants)
    .where(and(eq(accessGrants.artifactId, artifactId), eq(accessGrants.email, email)))
    .get();
  return !!g;
}

/**
 * Send a code if the email is on the artifact's allowlist. The caller always gets the same answer,
 * listed or not, and the rate limits count both cases alike, so the allowlist cannot be probed.
 * The code is stored and mailed after the response (waitUntil) so timing does not tell either.
 */
export async function requestViewerCode(ctx: Ctx, ref: string, email: string): Promise<void> {
  const a = await allowlistArtifact(ctx, ref);
  const tooMany = "Too many codes requested. Try again later.";
  await enforce(
    ctx.env.DB,
    `viewer-code:ip:${ipKey(ctx)}`,
    RATE_LIMITS.loginPerIpPerHour,
    HOUR,
    tooMany,
  );
  await enforce(
    ctx.env.DB,
    `viewer-code:email:${email}`,
    RATE_LIMITS.viewerCodesPerEmailPerHour,
    HOUR,
    tooMany,
  );
  if (!(await isListed(ctx, a.id, email))) return;
  ctx.waitUntil(
    sendViewerCode(ctx, a, email).catch((e: unknown) => {
      console.error("viewer code email failed:", e instanceof Error ? e.message : "unknown");
    }),
  );
}

async function sendViewerCode(ctx: Ctx, a: ArtifactRow, email: string): Promise<void> {
  const now = nowIso();
  // Only the newest code works.
  await ctx.db
    .update(loginCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(loginCodes.email, email),
        eq(loginCodes.purpose, "viewer"),
        eq(loginCodes.artifactId, a.id),
        isNull(loginCodes.consumedAt),
      ),
    )
    .run();
  const code = newSixDigitCode();
  await ctx.db
    .insert(loginCodes)
    .values({
      id: newId(),
      email,
      purpose: "viewer",
      artifactId: a.id,
      codeHash: await codeHash(ctx, a.id, email, code),
      linkTokenHash: null,
      attempts: 0,
      expiresAt: isoIn(TTL.viewerCodeMs),
      consumedAt: null,
      createdAt: now,
    })
    .run();
  const minutes = Math.round(TTL.viewerCodeMs / 60000);
  await createEmailAdapter(ctx.config, ctx.env).send({
    to: email,
    subject: "Your Plinth viewing code",
    text: [
      `Someone asked to open "${a.title}" on Plinth with this email address.`,
      "",
      `Your code is ${code}. It works once and expires in ${minutes} minutes.`,
      "",
      "If this was not you, ignore this email.",
    ].join("\n"),
  });
}

/**
 * Check a code and, on success, create a viewer session. Returns the cookie value (shown once;
 * only its hash is stored). Every failure looks the same: wrong code, expired code, used code,
 * too many attempts, or an email that is not (or no longer) listed.
 */
export async function verifyViewerCode(
  ctx: Ctx,
  ref: string,
  email: string,
  code: string,
): Promise<string> {
  const a = await allowlistArtifact(ctx, ref);
  const tooMany = "Too many attempts. Try again later.";
  await enforce(
    ctx.env.DB,
    `viewer-verify:ip:${ipKey(ctx)}`,
    RATE_LIMITS.loginPerIpPerHour,
    HOUR,
    tooMany,
  );
  await enforce(
    ctx.env.DB,
    `viewer-verify:email:${email}`,
    RATE_LIMITS.codeAttemptsPerEmailPerHour,
    HOUR,
    tooMany,
  );
  const invalid = new ApiError(
    "forbidden",
    "That code is wrong or has expired. Ask for a new one.",
    {
      reason: "invalid_code",
    },
  );

  const row = await ctx.db
    .select()
    .from(loginCodes)
    .where(
      and(
        eq(loginCodes.email, email),
        eq(loginCodes.purpose, "viewer"),
        eq(loginCodes.artifactId, a.id),
        isNull(loginCodes.consumedAt),
        gt(loginCodes.expiresAt, nowIso()),
      ),
    )
    .orderBy(desc(loginCodes.createdAt))
    .get();
  if (!row) throw invalid;

  // Count the attempt first, atomically, so parallel guesses cannot exceed the cap.
  const counted = await ctx.env.DB.prepare(
    "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND consumed_at IS NULL RETURNING attempts",
  )
    .bind(row.id, MAX_VIEWER_CODE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!counted) throw invalid;
  if (!timingSafeEqual(await codeHash(ctx, a.id, email, code), row.codeHash)) throw invalid;

  // Single use: exactly one request consumes the code.
  const consumed = await ctx.env.DB.prepare(
    "UPDATE login_codes SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
  )
    .bind(row.id, nowIso())
    .run();
  if ((consumed.meta.changes ?? 0) === 0) throw invalid;

  // The owner may have removed the email since the code was sent.
  if (!(await isListed(ctx, a.id, email))) throw invalid;

  const value = newToken(VIEWER_SESSION_PREFIX);
  await ctx.db
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      userId: null,
      viewerEmail: email,
      expiresAt: isoIn(TTL.viewerSessionS * 1000),
      createdAt: nowIso(),
    })
    .run();
  return value;
}
