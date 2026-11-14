// App sessions for people. The cookie holds a random token; the database holds only its SHA-256,
// so a database leak does not hand out live sessions. The cookie is host-only on APP_HOST (no
// Domain attribute, `__Host-` prefix), HttpOnly, Secure and SameSite=Lax.
import { TTL } from "@plinth/shared";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { sessions } from "../db/schema.ts";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import { hashToken, randomString } from "../lib/crypto.ts";
import { isoIn, nowIso } from "../lib/time.ts";

/** Create a session row for a user and return the cookie value (shown to the browser only). */
export async function createUserSession(db: Db, userId: string): Promise<string> {
  const value = randomString(43);
  await db
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "user",
      userId,
      viewerEmail: null,
      expiresAt: isoIn(TTL.sessionS * 1000),
      createdAt: nowIso(),
    })
    .run();
  return value;
}

/** Delete the session behind a cookie value, if any. */
export async function deleteSession(db: Db, value: string): Promise<void> {
  await db
    .delete(sessions)
    .where(eq(sessions.id, await hashToken(value)))
    .run();
}

export function sessionCookie(config: Config, value: string): string {
  return serializeCookie(appCookieName(config, "session"), value, {
    httpOnly: true,
    secure: secureFlag(config.scheme, config.appHost),
    sameSite: "Lax",
    maxAge: TTL.sessionS,
  });
}

export function clearSessionCookie(config: Config): string {
  return serializeCookie(appCookieName(config, "session"), "", {
    httpOnly: true,
    secure: secureFlag(config.scheme, config.appHost),
    sameSite: "Lax",
    maxAge: 0,
  });
}
