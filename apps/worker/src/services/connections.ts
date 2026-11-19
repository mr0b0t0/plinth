// Agent connections: personal access tokens and OAuth connections. Only people manage them
// (policy.canManageConnections); a person only ever sees and changes their own. A personal access
// token may be limited to one artifact (docs/spec.md "Publishing from CI"); what the list says
// about that artifact goes through the policy module, never an owner or grant test here.
import {
  type ClientType,
  type ConnectionInfo,
  type CreatedToken,
  DEFAULT_SCOPES,
  type Scope,
} from "@plinth/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { TOKEN_PREFIX } from "../auth/principal.ts";
import { agentConnections, artifacts, type ConnectionRow, oauthGrants } from "../db/schema.ts";
import { hashToken, newId, newToken } from "../lib/crypto.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import type { Principal } from "../policy.ts";
import { decideFor, requireArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { unpinConnectionQueries, unpinIfRevoked } from "./dataSources.ts";

/** A service context whose principal is a signed-in person (api/connections.ts checks it). */
export type PersonCtx = Ctx & { principal: Extract<Principal, { kind: "user" }> };

/** The scopes a token limited to one artifact gets when none are given. */
export const BOUND_DEFAULT_SCOPES: readonly Scope[] = ["artifacts:read", "artifacts:write"];

export function toConnectionInfo(
  row: ConnectionRow,
  artifact: ConnectionInfo["artifact"],
): ConnectionInfo {
  return {
    id: row.id,
    label: row.label,
    client_type: row.clientType,
    kind: row.kind,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
    artifact: row.artifactId === null ? null : artifact,
  };
}

/**
 * The artifacts these connections are bound to, as the signed-in person may see them now: slug
 * and title only where decide allows `view`, so a deleted, taken-down or no-longer-shared
 * artifact reads { id, slug: null, title: null }. One artifacts read for all of them.
 */
async function boundArtifactInfo(
  ctx: PersonCtx,
  rows: ConnectionRow[],
): Promise<Map<string, NonNullable<ConnectionInfo["artifact"]>>> {
  const ids = [...new Set(rows.map((r) => r.artifactId).filter((x): x is string => x !== null))];
  const out = new Map<string, NonNullable<ConnectionInfo["artifact"]>>();
  if (ids.length === 0) return out;
  // Deleted rows included: factsOf marks them deleted, and decide answers not_found.
  const found = await ctx.db.select().from(artifacts).where(inArray(artifacts.id, ids)).all();
  const byId = new Map(found.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    const d = a ? await decideFor(ctx, a, "view") : null;
    out.set(
      id,
      a && d?.allow ? { id, slug: a.slug, title: a.title } : { id, slug: null, title: null },
    );
  }
  return out;
}

async function withArtifacts(ctx: PersonCtx, rows: ConnectionRow[]): Promise<ConnectionInfo[]> {
  const info = await boundArtifactInfo(ctx, rows);
  return rows.map((r) =>
    toConnectionInfo(r, r.artifactId === null ? null : (info.get(r.artifactId) ?? null)),
  );
}

async function oneInfo(ctx: PersonCtx, row: ConnectionRow): Promise<ConnectionInfo> {
  const [info] = await withArtifacts(ctx, [row]);
  if (!info) throw new ApiError("internal", "Connection missing");
  return info;
}

export async function listConnections(ctx: PersonCtx): Promise<ConnectionInfo[]> {
  const rows = await ctx.db
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.userId, ctx.principal.userId))
    .orderBy(desc(agentConnections.createdAt))
    .all();
  return withArtifacts(ctx, rows);
}

/**
 * The scopes of a token limited to one artifact: artifacts:read always, artifacts:write when
 * asked (both by default), never mentions.
 */
function boundScopes(scopes: Scope[] | undefined): Scope[] {
  if (scopes === undefined) return [...BOUND_DEFAULT_SCOPES];
  const set = new Set(scopes);
  if (!set.has("artifacts:read") || set.has("mentions")) {
    throw new ApiError(
      "invalid_input",
      "A token limited to one artifact holds artifacts:read, and may add artifacts:write",
      {
        field: "scopes",
        next: "A token limited to one artifact reads it and may publish new versions; give artifacts:read and optionally artifacts:write",
      },
    );
  }
  return BOUND_DEFAULT_SCOPES.filter((s) => set.has(s));
}

/**
 * Create a personal access token. The token is returned once; only its SHA-256 is stored. With
 * `artifact`, the token is limited to that artifact, which the person must own or edit (the
 * policy's `edit`: strangers get 404, viewers and commenters 403).
 */
export async function createPersonalToken(
  ctx: PersonCtx,
  input: { label: string; client_type: ClientType; scopes?: Scope[]; artifact?: string },
): Promise<CreatedToken> {
  let artifactId: string | null = null;
  let scopes: Scope[];
  if (input.artifact !== undefined) {
    scopes = boundScopes(input.scopes);
    const { artifact } = await requireArtifact(ctx, input.artifact, "edit");
    artifactId = artifact.id;
  } else {
    scopes = [...new Set(input.scopes ?? DEFAULT_SCOPES)];
  }
  const token = newToken(TOKEN_PREFIX.pat);
  const row: ConnectionRow = {
    id: newId(),
    userId: ctx.principal.userId,
    label: input.label,
    clientType: input.client_type,
    kind: "token",
    tokenHash: await hashToken(token),
    scopes: scopes.join(" "),
    oauthClientId: null,
    createdAt: nowIso(),
    lastUsedAt: null,
    revokedAt: null,
    artifactId,
  };
  await ctx.db.insert(agentConnections).values(row).run();
  return { connection: await oneInfo(ctx, row), token };
}

/** The caller's own connection, or a 404 (never reveal another user's connection exists). */
async function ownConnection(ctx: PersonCtx, id: string): Promise<ConnectionRow> {
  const row = await ctx.db
    .select()
    .from(agentConnections)
    .where(and(eq(agentConnections.id, id), eq(agentConnections.userId, ctx.principal.userId)))
    .get();
  if (!row) throw notFound("Connection");
  return row;
}

export async function renameConnection(
  ctx: PersonCtx,
  id: string,
  label: string,
): Promise<ConnectionInfo> {
  const row = await ownConnection(ctx, id);
  await ctx.db.update(agentConnections).set({ label }).where(eq(agentConnections.id, row.id)).run();
  return oneInfo(ctx, { ...row, label });
}

/** Revoke a connection and every OAuth grant behind it. Idempotent. */
export async function revokeConnection(ctx: PersonCtx, id: string): Promise<ConnectionInfo> {
  const row = await ownConnection(ctx, id);
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .update(agentConnections)
      .set({ revokedAt: now })
      .where(and(eq(agentConnections.id, row.id), isNull(agentConnections.revokedAt))),
    ctx.db
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(oauthGrants.connectionId, row.id), isNull(oauthGrants.revokedAt))),
    // Data sources pinned to it wait for the owner again (services/dataSources.ts).
    ...(await unpinConnectionQueries(ctx.db, row.id, now)),
  ]);
  // A source pinned after the read above and before the batch committed.
  await unpinIfRevoked(ctx.db, row.id, now);
  return oneInfo(ctx, { ...row, revokedAt: row.revokedAt ?? now });
}
