import { pageDisplayName } from "@plinth/shared";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type UserRow, users } from "../db/schema.ts";
import { newId } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  return (await db.select().from(users).where(eq(users.id, id)).get()) ?? null;
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  return (await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()) ?? null;
}

/** Find or create the user for an email. `verified` marks the email as confirmed (sign-in). */
export async function getOrCreateUser(
  db: Db,
  config: Config,
  email: string,
  opts: { verified?: boolean } = {},
): Promise<UserRow> {
  const normalized = email.toLowerCase();
  const now = nowIso();
  await db
    .insert(users)
    .values({
      id: newId(),
      email: normalized,
      name: null,
      artifactLimit: null,
      emailVerifiedAt: opts.verified ? now : null,
      isAdmin: config.adminEmails.includes(normalized),
      createdAt: now,
    })
    .onConflictDoNothing({ target: users.email })
    .run();
  let user = await getUserByEmail(db, normalized);
  if (!user) throw new Error("user insert failed");
  if (opts.verified && !user.emailVerifiedAt) {
    await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id)).run();
    user = { ...user, emailVerifiedAt: now };
  }
  const shouldBeAdmin = config.adminEmails.includes(normalized);
  if (user.isAdmin !== shouldBeAdmin) {
    await db.update(users).set({ isAdmin: shouldBeAdmin }).where(eq(users.id, user.id)).run();
    user = { ...user, isAdmin: shouldBeAdmin };
  }
  return user;
}

/** D1 binds at most 100 parameters per statement. */
const NAMES_PER_QUERY = 90;

/**
 * Display names for these emails, as pages, rooms and agents see them (pageDisplayName), read live
 * so a rename or erase-user shows at once: one indexed query per 90 emails. An email with no
 * account, or an account with no name, maps to null. Never logged.
 */
export async function namesByEmail(
  d1: D1Database,
  emails: Iterable<string>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const e of emails) out.set(e, null);
  const all = [...out.keys()];
  for (let i = 0; i < all.length; i += NAMES_PER_QUERY) {
    const chunk = all.slice(i, i + NAMES_PER_QUERY);
    const { results } = await d1
      .prepare(
        `SELECT email, name FROM users WHERE name IS NOT NULL AND email IN (${chunk
          .map((_, j) => `?${j + 1}`)
          .join(", ")})`,
      )
      .bind(...chunk)
      .all<{ email: string; name: string | null }>();
    for (const r of results) out.set(r.email, pageDisplayName(r.name));
  }
  return out;
}

export function artifactLimitFor(config: Config, user: Pick<UserRow, "artifactLimit">): number {
  return user.artifactLimit ?? config.maxArtifactsPerUser;
}
