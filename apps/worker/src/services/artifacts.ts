// Artifact operations shared by MCP tools, REST endpoints and the app. Every function authorizes
// through policy.ts before touching data.
import {
  ARTIFACT_ID_RE,
  type ArtifactDetail,
  type ArtifactList,
  type ArtifactSummary,
  type AssetInput,
  type Author,
  type Capabilities,
  type EffectiveRole,
  type PublishResult,
  ROOM_OPEN_ALL,
  ROOM_TOPIC_RE,
  type Role,
  type VersionInfo,
  type Visibility,
} from "@plinth/shared";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { appUrl, contentOrigin, thumbnailsActive } from "../config.ts";
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
import { hashPassword } from "../lib/crypto.ts";
import { ApiError, forbidden, notFound, unauthorized } from "../lib/errors.ts";
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
  seesOwnerMetadata,
} from "../policy.ts";
import { notifyRoom } from "../rooms/notify.ts";
import { requireTypeDef, resolveSource } from "./artifactTypes.ts";
import { claimArtifactAttempts } from "./attempts.ts";
import {
  matchingSpellings,
  ownerCategories,
  patchArtifact,
  requireCategoryRight,
  resolveCategory,
} from "./categories.ts";
import type { Ctx } from "./context.ts";
import { wipeArtifactData } from "./data.ts";
import {
  commitVersion,
  conflictError,
  enforcePublishRate,
  newArtifactTarget,
  openVersionStager,
  type StagedVersion,
  updateTarget,
  type VersionStager,
  type VersionTarget,
} from "./stage.ts";
import {
  assetBytes,
  deletePrefix,
  fileKey,
  parseManifest,
  readText,
  sourceTooLarge,
  tooManyAssets,
} from "./storage.ts";
import { getUserById } from "./users.ts";

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
    case "account_required":
      return unauthorized("Sign in to do this");
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

// ---------- shaping ----------

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
    type: a.type,
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
    thumbnail_url:
      thumbnailsActive(ctx.config, ctx.env) && !a.takenDownAt
        ? appUrl(ctx.config, `/api/v1/artifacts/${a.id}/thumbnail?version=${a.currentVersion}`)
        : null,
    // The read gate for owner-only metadata: every summary path goes through here.
    category: seesOwnerMetadata(role) ? (a.category ?? null) : null,
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

// ---------- shared data capabilities (docs/spec.md "Shared data and viewer identity") ----------

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
  const { data, viewer, shared, room, roomOpen } = v as Record<string, unknown>;
  if (typeof data !== "boolean" || typeof viewer !== "boolean") return null;
  // Rows stored before rooms, and declarations without `room`, have no room fields.
  const hasRoom = room === true;
  // `viewer` alone declares nothing (shared parseCapabilities).
  if (!data && !hasRoom) return null;
  const names = Array.isArray(shared) ? shared.filter((n) => typeof n === "string") : [];
  const topics =
    hasRoom && Array.isArray(roomOpen)
      ? roomOpen.filter(
          (t): t is string =>
            typeof t === "string" && (t === ROOM_OPEN_ALL || ROOM_TOPIC_RE.test(t)),
        )
      : [];
  return { data, viewer, shared: names, room: hasRoom, roomOpen: topics };
}

export async function getVersionRow(
  ctx: Ctx,
  artifactId: string,
  n: number,
): Promise<VersionRow | null> {
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
  /** Defaults to html. */
  type?: string;
  html?: string;
  content?: string;
  assets?: AssetInput[];
  visibility: Visibility;
  password?: string;
  emails?: string[];
  /** The owner's category for it (docs/spec.md "Categories"). */
  category?: string;
}

/** The stored category, echoed only when the call set one (the caller is then the owner). */
function withCategory(result: PublishResult, target: VersionTarget): PublishResult {
  return target.category !== undefined ? { ...result, category: target.category } : result;
}

/**
 * Stage a version's inline source and assets: content is hashed and put (or reused when the
 * current version has the same bytes), `{path, sha256}` reuses the current version's file.
 * Cheap checks run before any rate hit or R2 operation.
 */
function precheckAssets(ctx: Ctx, assets: AssetInput[] | undefined): void {
  const count = assets?.length ?? 0;
  if (count > ctx.config.maxAssetsPerVersion) {
    throw tooManyAssets(ctx.config.maxAssetsPerVersion, count);
  }
  for (const a of assets ?? []) {
    if (a.content === undefined && a.sha256 === undefined) {
      throw new ApiError("invalid_input", `Asset ${a.path} needs content or sha256`, {
        path: a.path,
        next: "Send content, or sha256 alone to reuse the current version's file (get_artifact lists each asset's sha256)",
      });
    }
  }
}

async function stageInline(
  stager: VersionStager,
  text: string,
  assets: AssetInput[] | undefined,
): Promise<StagedVersion> {
  await stager.addSource(text);
  if (assets === undefined) stager.carryCurrent();
  for (const a of assets ?? []) {
    if (a.content === undefined) {
      stager.addRefTyped(a.path, a.sha256 as string, a.content_type);
    } else {
      await stager.addFile(a.path, assetBytes(a.path, a.content, a.encoding), {
        contentType: a.content_type,
        ...(a.sha256 !== undefined ? { expectedSha256: a.sha256 } : {}),
      });
    }
  }
  return stager.finish();
}

/** Stage with `run`, then commit; on any failure the attempt's objects are deleted. */
async function writeVersion(
  ctx: Ctx,
  target: VersionTarget,
  run: (stager: VersionStager) => Promise<StagedVersion>,
  opts: Parameters<typeof commitVersion>[3] = {},
): Promise<PublishResult> {
  const stager = await openVersionStager(ctx, target);
  let staged: StagedVersion;
  try {
    staged = await run(stager);
  } catch (e) {
    await stager.abort().catch(() => undefined);
    throw e;
  }
  return commitVersion(ctx, target, staged, opts);
}

function checkSourceSize(def: { sourceLabel: string; maxSourceBytes: number }, text: string) {
  const size = new TextEncoder().encode(text).byteLength;
  if (size > def.maxSourceBytes) throw sourceTooLarge(def.sourceLabel, def.maxSourceBytes, size);
}

export async function publishArtifact(ctx: Ctx, input: PublishInput): Promise<PublishResult> {
  const { def, text } = resolveSource(input, null);
  const target = await newArtifactTarget(ctx, {
    type: def.id,
    title: input.title,
    ...(input.category !== undefined ? { category: input.category } : {}),
  });
  const p = ctx.principal;
  const userId = p.kind === "user" || p.kind === "agent" ? p.userId : null;
  if (!userId) throw unauthorized();
  if (input.visibility === "public") await checkPublicAllowed(ctx, userId);
  if (input.visibility === "password" && !input.password) {
    throw new ApiError("invalid_input", "A password is required for password visibility");
  }
  checkSourceSize(def, text);
  precheckAssets(ctx, input.assets);
  await enforcePublishRate(ctx);
  const passwordHash =
    input.visibility === "password" && input.password ? await hashPassword(input.password) : null;
  const result = await writeVersion(ctx, target, (s) => stageInline(s, text, input.assets ?? []), {
    visibility: input.visibility,
    passwordHash,
  });
  if (input.emails?.length) await replaceViewerGrants(ctx, result.id, input.emails);
  return withCategory(result, target);
}

export interface UpdateInput {
  id: string;
  /** The field matching the artifact's type (html for a page, content for a doc). */
  html?: string;
  content?: string;
  assets?: AssetInput[];
  note?: string;
  base_version?: number;
  /** Owner only; omitted keeps the current category. */
  category?: string;
}

export async function updateArtifact(ctx: Ctx, input: UpdateInput): Promise<PublishResult> {
  // Edit rights and a stale base_version are checked before the rate limit and any R2 operation.
  const target = await updateTarget(ctx, input.id, {
    baseVersion: input.base_version,
    note: input.note,
  });
  if (target.mode !== "update") throw new ApiError("internal", "Not an update");
  // The type is fixed at publish: the input must carry the artifact's own source field.
  const { def, text } = resolveSource(input, requireTypeDef(target.artifact.type).id);
  checkSourceSize(def, text);
  precheckAssets(ctx, input.assets);
  // The category is the owner's: an editor's call that carries one is refused here, before the
  // rate limit and any R2 operation, never silently dropped.
  if (input.category !== undefined) {
    await requireCategoryRight(ctx, target.artifact);
    target.category = await resolveCategory(
      ctx,
      target.artifact.ownerId,
      input.category,
      target.artifact.id,
    );
  }
  await enforcePublishRate(ctx);
  // No assets given: the current version's assets are carried forward as references.
  const result = await writeVersion(ctx, target, (s) => stageInline(s, text, input.assets));
  return withCategory(result, target);
}

export async function getArtifact(
  ctx: Ctx,
  ref: string,
  version?: number,
): Promise<ArtifactDetail> {
  const { artifact, role } = await requireArtifact(ctx, ref, "view");
  const def = requireTypeDef(artifact.type);
  const v = await requireVersion(ctx, artifact, version ?? artifact.currentVersion);
  const text = await readText(ctx.env.FILES, `${v.r2Prefix}${def.sourcePath}`);
  if (text === null) throw new ApiError("internal", `Stored ${def.sourceLabel} is missing`);
  const base = {
    ...(await summaryFor(ctx, artifact, role)),
    version: v.number,
    source_path: def.sourcePath,
    assets: parseManifest(v.manifest)
      .filter((m) => !def.reservedPaths.includes(m.path))
      .map((m) => ({
        path: m.path,
        size_bytes: m.size_bytes,
        content_type: m.content_type,
        sha256: m.sha256 ?? null,
      })),
  };
  // html for a page, content for every typed artifact; never both.
  return def.id === "html"
    ? { ...base, type: "html", html: text }
    : { ...base, type: def.id, content: text };
}

/**
 * The caller's artifacts and those shared with them (optionally by title, and by category among the
 * caller's own; at most `limit`, 500 by default), plus the caller's own category names.
 * `categories` never depends on the filters and never holds another owner's names, so a
 * collaborator cannot probe them.
 */
export async function listArtifacts(
  ctx: Ctx,
  filter: { query?: string; category?: string; limit?: number } = {},
): Promise<ArtifactList> {
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
  const categories = await ownerCategories(ctx, uid);
  // limit 0: the names only, the cheap read agents make before they publish.
  if (filter.limit === 0) return { items: [], categories };
  let inCategory: ReturnType<typeof and> | undefined;
  // An empty filter is no filter.
  if (filter.category?.trim()) {
    const spellings = await matchingSpellings(ctx, uid, filter.category);
    if (spellings.length === 0) return { items: [], categories };
    inCategory = and(eq(artifacts.ownerId, uid), inArray(artifacts.category, spellings));
  }
  const q = filter.query?.trim().toLowerCase();
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
        inCategory,
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(filter.limit ?? 500)
    .all();
  if (rows.length === 0) return { items: [], categories };
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
  const items = rows.map((r) =>
    toSummary(
      ctx,
      r.a,
      r.owner,
      countBy.get(r.a.id) ?? 0,
      r.a.ownerId === uid ? "owner" : (grantBy.get(r.a.id) ?? "viewer"),
    ),
  );
  return { items, categories };
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
  // Like get and update: a type this instance does not know is refused, not copied blind.
  const def = requireTypeDef(artifact.type);
  if (baseVersion !== undefined && baseVersion !== artifact.currentVersion) {
    throw conflictError(baseVersion, artifact.currentVersion);
  }
  const old = await requireVersion(ctx, artifact, version);
  await enforcePublishRate(ctx);
  const target: VersionTarget = {
    mode: "update",
    artifact,
    ...(baseVersion !== undefined ? { baseVersion } : {}),
    note: `Restored from v${version}`,
  };
  const manifest = parseManifest(old.manifest);
  return writeVersion(
    ctx,
    target,
    async (stager) => {
      // One get of the old source and one put under the new prefix; every asset is a reference.
      stager.scan = false;
      stager.capabilitiesOverride = old.capabilities ?? null;
      const entry = manifest.find((m) => m.path === def.sourcePath) ?? {
        path: def.sourcePath,
        size_bytes: 0,
        content_type: def.contentType,
      };
      const obj = await ctx.env.FILES.get(fileKey(artifact.id, old, entry));
      if (!obj) throw new ApiError("internal", `Stored ${def.sourceLabel} is missing`);
      await stager.addSource(new Uint8Array(await obj.arrayBuffer()));
      for (const m of manifest) if (!def.reservedPaths.includes(m.path)) stager.carry(old, m);
      return stager.finish();
    },
    { restoredFrom: version },
  );
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
  // Live room sockets opened with an older pass close (rooms/notify.ts; the alarm backs it up).
  notifyRoom(ctx, artifactId, "revoke");
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

/** Rename an artifact (owner only). A title-only patchArtifact. */
export async function renameArtifact(
  ctx: Ctx,
  ref: string,
  title: string,
): Promise<ArtifactSummary> {
  return patchArtifact(ctx, ref, { title });
}

/**
 * Soft-delete the row (frees quota, ends all access), wipe its shared data in the same batch, and
 * remove the files from R2.
 */
export async function deleteArtifact(ctx: Ctx, ref: string): Promise<void> {
  const { artifact } = await requireArtifact(ctx, ref, "delete");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE artifacts SET deleted_at = ?1, access_epoch = access_epoch + 1 WHERE id = ?2",
    ).bind(nowIso(), artifact.id),
    ...wipeArtifactData(ctx.env.DB, artifact.id),
    // Its attempt rows become tombstones: their objects are under the root deleted next, and the
    // sweep deletes what a still-running attempt puts after that.
    claimArtifactAttempts(ctx.env.DB, artifact.id, Date.now()),
  ]);
  ctx.waitUntil(deletePrefix(ctx.env.FILES, `artifacts/${artifact.id}/`));
  notifyRoom(ctx, artifact.id, "gone");
}

export { forbidden };
