// Resolve who is calling: a bearer token (agent), an app session (person), a viewer cookie
// (confirmed allowlist email), or nobody. Policy decisions happen in policy.ts, not here.
import { SCOPES, type Scope } from "@plinth/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentConnections, oauthGrants, sessions, users } from "../db/schema.ts";
import { hashToken, timingSafeEqual } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";
import type { Principal } from "../policy.ts";
import { getOrCreateUser } from "../services/users.ts";

export const TOKEN_PREFIX = {
  pat: "plinth_pat_",
  access: "plinth_at_",
  refresh: "plinth_rt_",
} as const;

export function parseScopes(s: string): Set<Scope> {
  return new Set(
    s.split(/\s+/).filter((x): x is Scope => (SCOPES as readonly string[]).includes(x)),
  );
}

const LAST_USED_RESOLUTION_MS = 60_000;

function shouldTouch(lastUsedAt: string | null): boolean {
  return !lastUsedAt || Date.now() - Date.parse(lastUsedAt) > LAST_USED_RESOLUTION_MS;
}

/** Resolve an Authorization: Bearer token. Returns null for unknown, expired or revoked tokens. */
export async function resolveBearer(
  db: Db,
  config: Config,
  token: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Principal | null> {
  if (config.singleUserMode && config.adminToken && timingSafeEqual(token, config.adminToken)) {
    const email = config.adminEmails[0];
    if (!email) return null;
    const user = await getOrCreateUser(db, config, email, { verified: true });
    return {
      kind: "agent",
      userId: user.id,
      email: user.email,
      connectionId: null,
      connectionLabel: "Admin token",
      clientType: "other",
      scopes: new Set(SCOPES),
    };
  }

  if (token.startsWith(TOKEN_PREFIX.pat)) {
    const hash = await hashToken(token);
    const row = await db
      .select({ conn: agentConnections, user: users })
      .from(agentConnections)
      .innerJoin(users, eq(users.id, agentConnections.userId))
      .where(
        and(
          eq(agentConnections.tokenHash, hash),
          eq(agentConnections.kind, "token"),
          isNull(agentConnections.revokedAt),
        ),
      )
      .get();
    if (!row) return null;
    if (shouldTouch(row.conn.lastUsedAt)) {
      waitUntil(
        db
          .update(agentConnections)
          .set({ lastUsedAt: nowIso() })
          .where(eq(agentConnections.id, row.conn.id))
          .run(),
      );
    }
    return {
      kind: "agent",
      userId: row.user.id,
      email: row.user.email,
      connectionId: row.conn.id,
      connectionLabel: row.conn.label,
      clientType: row.conn.clientType,
      scopes: parseScopes(row.conn.scopes),
    };
  }

  if (token.startsWith(TOKEN_PREFIX.access)) {
    const hash = await hashToken(token);
    const now = nowIso();
    const row = await db
      .select({ grant: oauthGrants, conn: agentConnections, user: users })
      .from(oauthGrants)
      .innerJoin(agentConnections, eq(agentConnections.id, oauthGrants.connectionId))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .where(
        and(
          eq(oauthGrants.accessTokenHash, hash),
          isNull(oauthGrants.revokedAt),
          isNull(agentConnections.revokedAt),
          gt(oauthGrants.accessExpiresAt, now),
        ),
      )
      .get();
    if (!row) return null;
    if (shouldTouch(row.conn.lastUsedAt)) {
      waitUntil(
        db
          .update(agentConnections)
          .set({ lastUsedAt: now })
          .where(eq(agentConnections.id, row.conn.id))
          .run(),
      );
    }
    const granted = parseScopes(row.grant.scope);
    const connScopes = parseScopes(row.conn.scopes);
    return {
      kind: "agent",
      userId: row.user.id,
      email: row.user.email,
      connectionId: row.conn.id,
      connectionLabel: row.conn.label,
      clientType: row.conn.clientType,
      scopes: new Set([...granted].filter((s) => connScopes.has(s))),
    };
  }

  return null;
}

/** Resolve the app session cookie value to a person. */
export async function resolveSession(db: Db, cookieValue: string): Promise<Principal | null> {
  const id = await hashToken(cookieValue);
  const row = await db
    .select({ s: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), eq(sessions.kind, "user"), gt(sessions.expiresAt, nowIso())))
    .get();
  if (!row) return null;
  return { kind: "user", userId: row.user.id, email: row.user.email, isAdmin: row.user.isAdmin };
}

/** Resolve the app-host viewer cookie (confirmed allowlist email, no account). */
export async function resolveViewerSession(db: Db, cookieValue: string): Promise<Principal | null> {
  const id = await hashToken(cookieValue);
  const row = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.kind, "viewer"), gt(sessions.expiresAt, nowIso())))
    .get();
  if (!row?.viewerEmail) return null;
  return { kind: "viewer", email: row.viewerEmail };
}
