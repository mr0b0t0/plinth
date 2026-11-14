// Artifact operations shared by MCP tools, REST endpoints and the app. Every function authorizes
// through policy.ts before touching data.
import {
  ARTIFACT_ID_RE,
  type ArtifactDetail,
  type ArtifactSummary,
  type AssetInput,
  type Author,
  type Capabilities,
  type EffectiveRole,
  type PublishResult,
  parseCapabilities,
  type Role,
  type VersionInfo,
  type Visibility,
} from "@plinth/shared";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { appUrl, contentOrigin } from "../config.ts";
import {
  type ArtifactRow,
  accessGrants,
  agentConnections,
  artifacts,
  type UserRow,
  users,
  type VersionRow,
  versions,
} from "../db/schema.ts";
import { hashPassword, newArtifactId, newId, randomString } from "../lib/crypto.ts";
import { ApiError, forbidden, isUniqueViolation, notFound, unauthorized } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  canMakePublic,
  type Decision,
  decide,
  principalEmail,
  principalUserId,
} from "../policy.ts";
import type { Ctx } from "./context.ts";
import {
  checkTotal,
  deletePrefix,
  type FileEntry,
  manifestOf,
  parseManifest,
  prepareFiles,
  readFiles,
  readText,
  versionPrefix,
  writeFiles,
} from "./storage.ts";
import { artifactLimitFor, getUserById } from "./users.ts";

// ---------- loading and authorization ----------

export async function findArtifact(ctx: Ctx, ref: string): Promise<ArtifactRow | null> {
  const where = ARTIFACT_ID_RE.test(ref)
    ? eq(artifacts.id, ref)
    : eq(artifacts.slug, ref.toLowerCase());
  const row = await ctx.db
    .select()
    .from(artifacts)
    .where(and(where, isNull(artifacts.deletedAt)))
    .get();
  return row ?? null;
}

export function factsOf(a: ArtifactRow): ArtifactFacts {
  return {
    ownerId: a.ownerId,
    visibility: a.visibility,
    hasPassword: !!a.passwordHash,
    deleted: !!a.deletedAt,
    takenDown: !!a.takenDownAt,
  };
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3 };

/**
 * The strongest grant for the principal's email and, for browsers, a confirmed viewer email, with
 * the email that holds it (the principal's own on a tie). Agents never use the viewer email.
 */
export async function grantFor(
  ctx: Ctx,
  artifactId: string,
): Promise<{ role: Role; email: string } | null> {
  const emails = new Set<string>();
  const own = principalEmail(ctx.principal);
  if (own) emails.add(own);
  if (ctx.viewerEmail && ctx.principal.kind !== "agent") emails.add(ctx.viewerEmail);
  if (emails.size === 0) return null;
  const rows = await ctx.db
    .select({ role: accessGrants.role, email: accessGrants.email })
    .from(accessGrants)
    .where(and(eq(accessGrants.artifactId, artifactId), inArray(accessGrants.email, [...emails])))
    .all();
  let best: { role: Role; email: string } | null = null;
  for (const r of rows) {
    if (
      !best ||
      ROLE_RANK[r.role] > ROLE_RANK[best.role] ||
      (ROLE_RANK[r.role] === ROLE_RANK[best.role] && r.email === own)
    )
      best = { role: r.role, email: r.email };
  }
  return best;
}

/** The strongest grant role for the principal (see grantFor). */
export async function grantRoleFor(ctx: Ctx, artifactId: string): Promise<Role | null> {
  return (await grantFor(ctx, artifactId))?.role ?? null;
}

export async function accessFactsFor(ctx: Ctx, a: ArtifactRow): Promise<AccessFacts> {
  return {
    grantRole: await grantRoleFor(ctx, a.id),
    passwordPassed: ctx.passwordPasses.get(a.id) === a.accessEpoch,
    publicEnabled: ctx.config.allowPublicVisibility,
    // Admins may look at an artifact only when someone reported it (to decide on the report).
    isAdmin: ctx.principal.kind === "user" && ctx.principal.isAdmin && (await hasReport(ctx, a.id)),
  };
}

async function hasReport(ctx: Ctx, artifactId: string): Promise<boolean> {
  const r = await ctx.env.DB.prepare("SELECT 1 AS x FROM reports WHERE artifact_id = ?1 LIMIT 1")
    .bind(artifactId)
    .first<{ x: number }>();
  return !!r;
}

export async function decideFor(
  ctx: Ctx,
  a: ArtifactRow,
  action: ArtifactAction,
): Promise<Decision> {
  return decide(ctx.principal, action, factsOf(a), await accessFactsFor(ctx, a));
}

/** Turn a denial into the error the API returns. Hides existence from people who cannot view. */
export function denialError(
  ctx: Ctx,
  d: Extract<Decision, { allow: false }>,
  action: ArtifactAction,
): ApiError {
  switch (d.reason) {
    case "not_found":
      return notFound();
    case "scope":
      return new ApiError("forbidden", `This token lacks the scope for ${action}`);
    case "taken_down":
      return new ApiError("forbidden", "This artifact was taken down", { reason: "taken_down" });
    case "password_required":
      return new ApiError("forbidden", "This artifact needs a password", { reason: d.reason });
    case "email_required":
      return new ApiError("forbidden", "This artifact is shared with specific people", {
        reason: d.reason,
      });
    case "login_required":
      return ctx.principal.kind === "anonymous" ? unauthorized() : forbidden();
    case "forbidden":
      // Someone with a role gets "forbidden"; a stranger should not learn the artifact exists.
      return d.role ? forbidden() : notFound();
  }
}

/** Load an artifact by id or slug and require an action. Returns the row and the caller's role. */
export async function requireArtifact(
  ctx: Ctx,
  ref: string,
  action: ArtifactAction,
): Promise<{ artifact: ArtifactRow; role: EffectiveRole | null }> {
  const a = await findArtifact(ctx, ref);
  if (!a) throw notFound();
  const d = await decideFor(ctx, a, action);
  if (!d.allow) {
    // A viewer-level denial for a non-view action: check whether they could at least view, so
    // collaborators get "forbidden" and strangers get "not found".
    if (action !== "view" && d.reason === "forbidden" && d.role === null) {
      const v = await decideFor(ctx, a, "view");
      if (v.allow) throw forbidden();
    }
    throw denialError(ctx, d, action);
  }
  return { artifact: a, role: d.role };
}

function requireActor(ctx: Ctx): { userId: string; connectionId: string | null } {
  const p = ctx.principal;
  if (p.kind === "user") return { userId: p.userId, connectionId: null };
  if (p.kind === "agent") return { userId: p.userId, connectionId: p.connectionId };
  throw unauthorized();
}

// ---------- shaping ----------

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const suffix = randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  return base ? `${base}-${suffix}` : suffix;
}

export function toSummary(
  ctx: Ctx,
  a: ArtifactRow,
  owner: Pick<UserRow, "id" | "email" | "name">,
  versionCount: number,
  role: EffectiveRole | null,
): ArtifactSummary {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    visibility: a.visibility,
    current_version: a.currentVersion,
    version_count: versionCount,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    url: appUrl(ctx.config, `/a/${a.slug}`),
    content_url: `${contentOrigin(ctx.config, a.id)}/`,
    // Link viewers (no role) do not learn the owner's address or id.
    owner: role
      ? { id: owner.id, email: owner.email, name: owner.name }
      : { id: null, email: null, name: owner.name },
    // Callers only build summaries for artifacts the principal may view; viewers get "viewer".
    role: role ?? "viewer",
    taken_down: !!a.takenDownAt,
  };
}

async function versionCount(ctx: Ctx, artifactId: string): Promise<number> {
  const r = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(versions)
    .where(eq(versions.artifactId, artifactId))
    .get();
  return r?.n ?? 0;
}

async function ownerOf(ctx: Ctx, a: ArtifactRow): Promise<UserRow> {
  const u = await getUserById(ctx.db, a.ownerId);
  if (!u) throw new ApiError("internal", "Artifact owner missing");
  return u;
}

export async function summaryFor(
  ctx: Ctx,
  a: ArtifactRow,
  role: EffectiveRole | null,
): Promise<ArtifactSummary> {
  return toSummary(ctx, a, await ownerOf(ctx, a), await versionCount(ctx, a.id), role);
}

// ---------- versions ----------

interface NewVersionOptions {
  note?: string | null;
  /** Reject unless the current version equals this. */
  baseVersion?: number;
  restoredFrom?: number | null;
}

// ---------- shared data capabilities (docs/spec.md "Shared data and viewer identity") ----------

const utf8Decoder = new TextDecoder();

/** The capabilities index.html declares, as stored in versions.capabilities (JSON or null). */
function capabilitiesJson(files: FileEntry[]): string | null {
  const index = files.find((f) => f.path === "index.html");
  if (!index) return null;
  const caps = parseCapabilities(utf8Decoder.decode(index.bytes));
  return caps ? JSON.stringify(caps) : null;
}

/** A version row's declared capabilities. Null when none, or when the stored value is malformed. */
export function versionCapabilities(
  row: Pick<VersionRow, "capabilities"> | null | undefined,
): Capabilities | null {
  if (!row?.capabilities) return null;
  let v: unknown;
  try {
    v = JSON.parse(row.capabilities);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { data, viewer, shared } = v as Record<string, unknown>;
  if (typeof data !== "boolean" || typeof viewer !== "boolean") return null;
  const names = Array.isArray(shared) ? shared.filter((n) => typeof n === "string") : [];
  return { data, viewer, shared: names };
}

/**
 * Write a new immutable version. The version row is inserted first (UNIQUE(artifact_id, number)
 * picks one winner), then files go to R2 under a fresh prefix, then current_version moves forward.
 * A writer that loses the race on a stated base_version gets a conflict; one without a base retries.
 */
export async function createVersion(
  ctx: Ctx,
  artifact: ArtifactRow,
  files: FileEntry[],
  opts: NewVersionOptions = {},
): Promise<number> {
  const actor = requireActor(ctx);
  const size = checkTotal(files);
  const manifest = JSON.stringify(manifestOf(files));
  const capabilities = capabilitiesJson(files);
  await enforceStorage(ctx, artifact.ownerId, size);
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifact.id)).get();
    if (!fresh || fresh.deletedAt) throw notFound();
    let n: number;
    if (opts.baseVersion !== undefined) {
      if (opts.baseVersion !== fresh.currentVersion) {
        throw new ApiError(
          "conflict",
          `Version ${opts.baseVersion} is not current; current is ${fresh.currentVersion}`,
          {
            current_version: fresh.currentVersion,
          },
        );
      }
      n = opts.baseVersion + 1;
    } else {
      const max = await ctx.db
        .select({ n: sql<number>`coalesce(max(${versions.number}), 0)` })
        .from(versions)
        .where(eq(versions.artifactId, artifact.id))
        .get();
      n = (max?.n ?? 0) + 1;
    }
    const id = newId();
    const prefix = versionPrefix(artifact.id, n);
    try {
      await ctx.db
        .insert(versions)
        .values({
          id,
          artifactId: artifact.id,
          number: n,
          r2Prefix: prefix,
          sizeBytes: size,
          manifest,
          createdByUser: actor.userId,
          createdByConnection: actor.connectionId,
          note: opts.note?.trim() || null,
          restoredFrom: opts.restoredFrom ?? null,
          createdAt: nowIso(),
          capabilities,
        })
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (opts.baseVersion !== undefined) {
        throw new ApiError("conflict", `Version ${opts.baseVersion} is not current`, {
          current_version: opts.baseVersion + 1,
        });
      }
      continue;
    }
    try {
      await writeFiles(ctx.env.FILES, prefix, files);
    } catch (e) {
      await ctx.db.delete(versions).where(eq(versions.id, id)).run();
      throw e;
    }
    // Advance current_version. If that keeps failing, remove the new version again so it never
    // lingers as an orphan that blocks every later update with a false conflict.
    let advanced = false;
    let lastError: unknown;
    for (let i = 0; i < 3 && !advanced; i++) {
      try {
        await ctx.db
          .update(artifacts)
          .set({ currentVersion: sql`max(${artifacts.currentVersion}, ${n})`, updatedAt: nowIso() })
          .where(eq(artifacts.id, artifact.id))
          .run();
        advanced = true;
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    if (!advanced) {
      // Delete the files before the row: once the row is gone another writer may take this
      // number (and prefix), and a late delete would remove its files.
      await deletePrefix(ctx.env.FILES, prefix).catch(() => undefined);
      await ctx.db.delete(versions).where(eq(versions.id, id)).run();
      throw lastError;
    }
    return n;
  }
  throw new ApiError("conflict", "Too many concurrent updates, try again");
}

/** Per-account storage cap: every version of every live artifact the owner has. */
async function enforceStorage(ctx: Ctx, ownerId: string, adding: number): Promise<void> {
  const limit = ctx.config.maxStorageBytesPerUser;
  const row = await ctx.env.DB.prepare(
    `SELECT coalesce(sum(v.size_bytes), 0) AS used FROM versions v
       JOIN artifacts a ON a.id = v.artifact_id
      WHERE a.owner_id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(ownerId)
    .first<{ used: number }>();
  const used = row?.used ?? 0;
  if (used + adding > limit) {
    throw new ApiError(
      "quota_exceeded",
      `Storage limit reached (${Math.round(limit / 1024 / 1024)} MB). Delete artifacts to free space.`,
      { limit_bytes: limit, used_bytes: used },
    );
  }
}

async function getVersionRow(ctx: Ctx, artifactId: string, n: number): Promise<VersionRow | null> {
  return (
    (await ctx.db
      .select()
      .from(versions)
      .where(and(eq(versions.artifactId, artifactId), eq(versions.number, n)))
      .get()) ?? null
  );
}

/** A version that exists and is published (number <= current_version). */
export async function requireVersion(ctx: Ctx, a: ArtifactRow, n: number): Promise<VersionRow> {
  if (n < 1 || n > a.currentVersion) throw notFound("Version");
  const v = await getVersionRow(ctx, a.id, n);
  if (!v) throw notFound("Version");
  return v;
}

// ---------- operations ----------

async function enforcePublishRate(ctx: Ctx, userId: string): Promise<void> {
  await enforce(
    ctx.env.DB,
    `publish:${userId}`,
    ctx.config.maxPublishesPerHour,
    3600,
    `Publish limit reached (${ctx.config.maxPublishesPerHour} per hour)`,
  );
}

async function checkPublicAllowed(ctx: Ctx, userId: string): Promise<void> {
  const user = await getUserById(ctx.db, userId);
  if (!user) throw unauthorized();
  if (!ctx.config.allowPublicVisibility) {
    throw new ApiError("feature_disabled", "Public visibility is not enabled on this instance");
  }
  const ok = canMakePublic({
    enabled: ctx.config.allowPublicVisibility,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    minAccountAgeHours: ctx.config.publicMinAccountAgeHours,
  });
  if (!ok) {
    throw new ApiError(
      "forbidden",
      `Public visibility unlocks after email verification and ${ctx.config.publicMinAccountAgeHours} hours of account age`,
    );
  }
}

export interface PublishInput {
  title: string;
  html: string;
  assets?: AssetInput[];
  visibility: Visibility;
  password?: string;
  emails?: string[];
}

export async function publishArtifact(ctx: Ctx, input: PublishInput): Promise<PublishResult> {
  const actor = requireActor(ctx);
  if (ctx.principal.kind === "agent" && !ctx.principal.scopes.has("artifacts:write")) {
    throw new ApiError("forbidden", "This token lacks the artifacts:write scope");
  }
  const user = await getUserById(ctx.db, actor.userId);
  if (!user) throw unauthorized();
  if (input.visibility === "public") await checkPublicAllowed(ctx, user.id);
  if (input.visibility === "password" && !input.password) {
    throw new ApiError("invalid_input", "A password is required for password visibility");
  }

  const files = prepareFiles(input.html, input.assets);

  const limit = artifactLimitFor(ctx.config, user);
  const count = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .where(and(eq(artifacts.ownerId, user.id), isNull(artifacts.deletedAt)))
    .get();
  if ((count?.n ?? 0) >= limit) {
    throw new ApiError(
      "quota_exceeded",
      `Artifact limit reached (${limit}). Delete one or ask for a higher limit.`,
      {
        limit,
      },
    );
  }
  await enforcePublishRate(ctx, user.id);

  const now = nowIso();
  const row: ArtifactRow = {
    id: newArtifactId(),
    ownerId: user.id,
    slug: slugify(input.title),
    title: input.title.trim(),
    currentVersion: 0,
    visibility: input.visibility,
    passwordHash:
      input.visibility === "password" && input.password ? await hashPassword(input.password) : null,
    accessEpoch: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    takenDownAt: null,
  };
  // Insert only while the owner is under the limit, so parallel publishes cannot overshoot it.
  const inserted = await ctx.env.DB.prepare(
    `INSERT INTO artifacts (id, owner_id, slug, title, current_version, visibility, password_hash,
       access_epoch, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, 0, ?5, ?6, 1, ?7, ?7
      WHERE (SELECT count(*) FROM artifacts WHERE owner_id = ?2 AND deleted_at IS NULL) < ?8`,
  )
    .bind(row.id, row.ownerId, row.slug, row.title, row.visibility, row.passwordHash, now, limit)
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    throw new ApiError("quota_exceeded", `Artifact limit reached (${limit}).`, { limit });
  }
  try {
    await createVersion(ctx, row, files, { baseVersion: 0 });
  } catch (e) {
    await ctx.db.delete(artifacts).where(eq(artifacts.id, row.id)).run();
    throw e;
  }
  if (input.emails?.length) await replaceViewerGrants(ctx, row.id, input.emails);

  return {
    id: row.id,
    slug: row.slug,
    version: 1,
    url: appUrl(ctx.config, `/a/${row.slug}`),
    content_url: `${contentOrigin(ctx.config, row.id)}/`,
    visibility: row.visibility,
  };
}

export interface UpdateInput {
  id: string;
  html: string;
  assets?: AssetInput[];
  note?: string;
  base_version?: number;
}

export async function updateArtifact(ctx: Ctx, input: UpdateInput): Promise<PublishResult> {
  const { artifact } = await requireArtifact(ctx, input.id, "edit");
  const actor = requireActor(ctx);
  let files = prepareFiles(input.html, input.assets);
  if (input.assets === undefined && artifact.currentVersion > 0) {
    // No assets given: carry the current version's assets forward unchanged.
    const cur = await requireVersion(ctx, artifact, artifact.currentVersion);
    const carried = parseManifest(cur.manifest).filter((m) => m.path !== "index.html");
    if (carried.length > 0)
      files = [...files, ...(await readFiles(ctx.env.FILES, cur.r2Prefix, carried))];
  }
  await enforcePublishRate(ctx, actor.userId);
  const n = await createVersion(ctx, artifact, files, {
    note: input.note,
    baseVersion: input.base_version,
  });
  return {
    id: artifact.id,
    slug: artifact.slug,
    version: n,
    url: appUrl(ctx.config, `/a/${artifact.slug}`),
    content_url: `${contentOrigin(ctx.config, artifact.id)}/`,
    visibility: artifact.visibility,
  };
}

export async function getArtifact(
  ctx: Ctx,
  ref: string,
  version?: number,
): Promise<ArtifactDetail> {
  const { artifact, role } = await requireArtifact(ctx, ref, "view");
  const v = await requireVersion(ctx, artifact, version ?? artifact.currentVersion);
  const html = await readText(ctx.env.FILES, `${v.r2Prefix}index.html`);
  if (html === null) throw new ApiError("internal", "Stored HTML is missing");
  const summary = await summaryFor(ctx, artifact, role);
  return {
    ...summary,
    version: v.number,
    html,
    assets: parseManifest(v.manifest).filter((m) => m.path !== "index.html"),
  };
}

export async function listArtifacts(ctx: Ctx, query?: string): Promise<ArtifactSummary[]> {
  const uid = principalUserId(ctx.principal);
  const email = principalEmail(ctx.principal);
  if (!uid || !email) throw unauthorized();
  if (ctx.principal.kind === "agent" && !ctx.principal.scopes.has("artifacts:read")) {
    throw new ApiError("forbidden", "This token lacks the artifacts:read scope");
  }
  const shared = ctx.db
    .select({ id: accessGrants.artifactId })
    .from(accessGrants)
    .where(eq(accessGrants.email, email));
  const q = query?.trim().toLowerCase();
  const rows = await ctx.db
    .select({ a: artifacts, owner: users })
    .from(artifacts)
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .where(
      and(
        isNull(artifacts.deletedAt),
        or(eq(artifacts.ownerId, uid), inArray(artifacts.id, shared)),
        q
          ? or(like(sql`lower(${artifacts.title})`, `%${q}%`), like(artifacts.slug, `%${q}%`))
          : undefined,
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(500)
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.a.id);
  const counts = await ctx.db
    .select({ id: versions.artifactId, n: sql<number>`count(*)` })
    .from(versions)
    .where(inArray(versions.artifactId, ids))
    .groupBy(versions.artifactId)
    .all();
  const grants = await ctx.db
    .select()
    .from(accessGrants)
    .where(and(eq(accessGrants.email, email), inArray(accessGrants.artifactId, ids)))
    .all();
  const countBy = new Map(counts.map((c) => [c.id, c.n]));
  const grantBy = new Map(grants.map((g) => [g.artifactId, g.role]));
  return rows.map((r) =>
    toSummary(
      ctx,
      r.a,
      r.owner,
      countBy.get(r.a.id) ?? 0,
      r.a.ownerId === uid ? "owner" : (grantBy.get(r.a.id) ?? "viewer"),
    ),
  );
}

export async function listVersions(ctx: Ctx, ref: string): Promise<VersionInfo[]> {
  const { artifact, role } = await requireArtifact(ctx, ref, "view");
  const rows = await ctx.db
    .select({ v: versions, user: users, conn: agentConnections })
    .from(versions)
    .leftJoin(users, eq(users.id, versions.createdByUser))
    .leftJoin(agentConnections, eq(agentConnections.id, versions.createdByConnection))
    .where(
      and(
        eq(versions.artifactId, artifact.id),
        sql`${versions.number} <= ${artifact.currentVersion}`,
      ),
    )
    .orderBy(desc(versions.number))
    .all();
  return rows.map(({ v, user, conn }) => {
    const author: Author = conn
      ? {
          kind: "connection",
          label: conn.label,
          user_id: role ? v.createdByUser : null,
          connection_id: role ? conn.id : null,
        }
      : {
          kind: "user",
          // Link viewers see a name or the address's local part, never the full email.
          label: user?.name || (role ? user?.email : user?.email?.split("@")[0]) || "Unknown",
          user_id: role ? v.createdByUser : null,
          connection_id: null,
        };
    return {
      number: v.number,
      size_bytes: v.sizeBytes,
      note: v.note,
      created_at: v.createdAt,
      author,
      restored_from: v.restoredFrom,
    };
  });
}

export async function restoreVersion(
  ctx: Ctx,
  ref: string,
  version: number,
  baseVersion?: number,
): Promise<PublishResult> {
  const { artifact } = await requireArtifact(ctx, ref, "restore");
  const actor = requireActor(ctx);
  const old = await requireVersion(ctx, artifact, version);
  const files = await readFiles(ctx.env.FILES, old.r2Prefix, parseManifest(old.manifest));
  await enforcePublishRate(ctx, actor.userId);
  const n = await createVersion(ctx, artifact, files, {
    note: `Restored from v${version}`,
    restoredFrom: version,
    baseVersion,
  });
  return {
    id: artifact.id,
    slug: artifact.slug,
    version: n,
    url: appUrl(ctx.config, `/a/${artifact.slug}`),
    content_url: `${contentOrigin(ctx.config, artifact.id)}/`,
    visibility: artifact.visibility,
  };
}

/** Replace the allowlist (viewer grants). Commenter and editor grants are kept. */
export async function replaceViewerGrants(
  ctx: Ctx,
  artifactId: string,
  emails: string[],
): Promise<void> {
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const existing = await ctx.db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.artifactId, artifactId))
    .all();
  const now = nowIso();
  const toDelete = existing
    .filter((g) => g.role === "viewer" && !wanted.has(g.email))
    .map((g) => g.email);
  if (toDelete.length) {
    await ctx.db
      .delete(accessGrants)
      .where(and(eq(accessGrants.artifactId, artifactId), inArray(accessGrants.email, toDelete)))
      .run();
  }
  const have = new Set(existing.map((g) => g.email));
  const toAdd = [...wanted].filter((e) => !have.has(e));
  if (toAdd.length) {
    await ctx.db
      .insert(accessGrants)
      .values(
        toAdd.map((email) => ({ artifactId, email, role: "viewer" as const, createdAt: now })),
      )
      .run();
  }
  await bumpAccessEpoch(ctx, artifactId);
}

/** Invalidate every content-host cookie and password pass for this artifact. */
export async function bumpAccessEpoch(ctx: Ctx, artifactId: string): Promise<void> {
  await ctx.db
    .update(artifacts)
    .set({ accessEpoch: sql`${artifacts.accessEpoch} + 1`, updatedAt: nowIso() })
    .where(eq(artifacts.id, artifactId))
    .run();
}

export interface SetVisibilityInput {
  id: string;
  visibility: Visibility;
  emails?: string[];
  password?: string;
}

export async function setVisibility(ctx: Ctx, input: SetVisibilityInput): Promise<ArtifactSummary> {
  const { artifact, role } = await requireArtifact(ctx, input.id, "manage");
  if (input.visibility === "public" && artifact.visibility !== "public") {
    await checkPublicAllowed(ctx, artifact.ownerId);
  }
  let passwordHash: string | null = null;
  if (input.visibility === "password") {
    if (input.password) passwordHash = await hashPassword(input.password);
    else if (artifact.passwordHash) passwordHash = artifact.passwordHash;
    else throw new ApiError("invalid_input", "A password is required for password visibility");
  }
  await ctx.db
    .update(artifacts)
    .set({ visibility: input.visibility, passwordHash, updatedAt: nowIso() })
    .where(eq(artifacts.id, artifact.id))
    .run();
  if (input.emails) await replaceViewerGrants(ctx, artifact.id, input.emails);
  else await bumpAccessEpoch(ctx, artifact.id);
  const fresh = await findArtifact(ctx, artifact.id);
  if (!fresh) throw notFound();
  return summaryFor(ctx, fresh, role);
}

export async function renameArtifact(
  ctx: Ctx,
  ref: string,
  title: string,
): Promise<ArtifactSummary> {
  const { artifact, role } = await requireArtifact(ctx, ref, "manage");
  await ctx.db
    .update(artifacts)
    .set({ title: title.trim(), updatedAt: nowIso() })
    .where(eq(artifacts.id, artifact.id))
    .run();
  return summaryFor(ctx, { ...artifact, title: title.trim() }, role);
}

/** Soft-delete the row (frees quota, ends all access) and remove the files from R2. */
export async function deleteArtifact(ctx: Ctx, ref: string): Promise<void> {
  const { artifact } = await requireArtifact(ctx, ref, "delete");
  await ctx.db
    .update(artifacts)
    .set({ deletedAt: nowIso(), accessEpoch: sql`${artifacts.accessEpoch} + 1` })
    .where(eq(artifacts.id, artifact.id))
    .run();
  ctx.waitUntil(deletePrefix(ctx.env.FILES, `artifacts/${artifact.id}/`));
}

export { forbidden };
