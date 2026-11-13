// Agent connections: personal access tokens and OAuth connections. Only people manage them
// (policy.canManageConnections); a person only ever sees and changes their own.
import {
  type ClientType,
  type ConnectionInfo,
  type CreatedToken,
  DEFAULT_SCOPES,
  type Scope,
} from "@plinth/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TOKEN_PREFIX } from "../auth/principal.ts";
import type { Db } from "../db/client.ts";
import { agentConnections, type ConnectionRow, oauthGrants } from "../db/schema.ts";
import { hashToken, newId, newToken } from "../lib/crypto.ts";
import { notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";

export function toConnectionInfo(row: ConnectionRow): ConnectionInfo {
  return {
    id: row.id,
    label: row.label,
    client_type: row.clientType,
    kind: row.kind,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
  };
}

export async function listConnections(db: Db, userId: string): Promise<ConnectionInfo[]> {
  const rows = await db
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.userId, userId))
    .orderBy(desc(agentConnections.createdAt))
    .all();
  return rows.map(toConnectionInfo);
}

/** Create a personal access token. The token is returned once; only its SHA-256 is stored. */
export async function createPersonalToken(
  db: Db,
  userId: string,
  input: { label: string; client_type: ClientType; scopes?: Scope[] },
): Promise<CreatedToken> {
  const token = newToken(TOKEN_PREFIX.pat);
  const scopes = [...new Set(input.scopes ?? DEFAULT_SCOPES)];
  const row: ConnectionRow = {
    id: newId(),
    userId,
    label: input.label,
    clientType: input.client_type,
    kind: "token",
    tokenHash: await hashToken(token),
    scopes: scopes.join(" "),
    oauthClientId: null,
    createdAt: nowIso(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await db.insert(agentConnections).values(row).run();
  return { connection: toConnectionInfo(row), token };
}

/** The caller's own connection, or a 404 (never reveal another user's connection exists). */
async function ownConnection(db: Db, userId: string, id: string): Promise<ConnectionRow> {
  const row = await db
    .select()
    .from(agentConnections)
    .where(and(eq(agentConnections.id, id), eq(agentConnections.userId, userId)))
    .get();
  if (!row) throw notFound("Connection");
  return row;
}

export async function renameConnection(
  db: Db,
  userId: string,
  id: string,
  label: string,
): Promise<ConnectionInfo> {
  const row = await ownConnection(db, userId, id);
  await db.update(agentConnections).set({ label }).where(eq(agentConnections.id, row.id)).run();
  return toConnectionInfo({ ...row, label });
}

/** Revoke a connection and every OAuth grant behind it. Idempotent. */
export async function revokeConnection(
  db: Db,
  userId: string,
  id: string,
): Promise<ConnectionInfo> {
  const row = await ownConnection(db, userId, id);
  const now = nowIso();
  await db.batch([
    db
      .update(agentConnections)
      .set({ revokedAt: now })
      .where(and(eq(agentConnections.id, row.id), isNull(agentConnections.revokedAt))),
    db
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(oauthGrants.connectionId, row.id), isNull(oauthGrants.revokedAt))),
  ]);
  return toConnectionInfo({ ...row, revokedAt: row.revokedAt ?? now });
}
