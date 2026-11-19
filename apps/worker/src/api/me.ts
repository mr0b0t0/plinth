import {
  type AppConfig,
  type BoundMe,
  type Me,
  type MeConnection,
  normalizeDisplayName,
  REPO_URL,
  TTL,
  updateProfileInput,
} from "@plinth/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dictationActive, instanceLimits } from "../config.ts";
import { artifacts, users } from "../db/schema.ts";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { boundArtifactOf } from "../policy.ts";
import { decideFor, findArtifact } from "../services/artifacts.ts";
import { artifactLimitFor, getUserById } from "../services/users.ts";
import {
  type AppContext,
  type AppEnv,
  ensureCsrfCookie,
  parseBody,
  serviceCtx,
} from "./context.ts";

export const meApi = new Hono<AppEnv>();

meApi.get("/config", (c) => {
  const config = c.get("config");
  const body: AppConfig = {
    app_origin: config.appOrigin,
    content_host: config.contentHost,
    content_protocol: `${config.scheme}:`,
    single_user_mode: config.singleUserMode,
    public_visibility_enabled: config.allowPublicVisibility,
    content_path_fallback: config.contentPathFallback,
    content_isolation: config.contentIsolation,
    environment: config.environment,
    operator: config.operator,
    email_provider: config.emailProvider,
    max_artifacts_per_user: config.maxArtifactsPerUser,
    source_url: config.showSourceLink ? REPO_URL : null,
    limits: instanceLimits(config),
    cdn_allowlist: [...config.cdnAllowlist],
    upload_ticket_ttl_s: TTL.uploadTicketMs / 1000,
    dictation: dictationActive(config),
    category_sharing: config.allowCategorySharing,
    live_views: config.allowLiveViews,
  };
  const res = c.json(body);
  ensureCsrfCookie(c, res.headers);
  return res;
});

/**
 * Update the signed-in person's display name (displayName.ts rules: stored normalised, "" clears
 * it). People only (not agents).
 */
meApi.patch("/me", async (c) => {
  const p = c.get("principal");
  if (p.kind === "agent") throw new ApiError("forbidden", "Agents cannot change the profile");
  if (p.kind !== "user") throw unauthorized();
  const { name } = await parseBody(c, updateProfileInput);
  await c
    .get("db")
    .update(users)
    .set({ name: normalizeDisplayName(name) || null })
    .where(eq(users.id, p.userId))
    .run();
  return meResponse(c);
});

meApi.get("/me", (c) => meResponse(c));

async function meResponse(c: AppContext) {
  const p = c.get("principal");
  if (p.kind !== "user" && p.kind !== "agent") throw unauthorized();
  const user = await getUserById(c.get("db"), p.userId);
  if (!user) throw unauthorized();
  if (boundArtifactOf(p) !== null) {
    // A token limited to one artifact reads that artifact and nothing else: not its person's
    // email, name, artifact count, limit or admin flag (docs/security.md).
    const connection = await meConnection(c);
    if (!connection) throw unauthorized();
    const bound: BoundMe = { id: user.id, connection };
    return c.json(bound);
  }
  const count = await c
    .get("db")
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .where(and(eq(artifacts.ownerId, user.id), isNull(artifacts.deletedAt)))
    .get();
  const me: Me = {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.createdAt,
    artifact_limit: artifactLimitFor(c.get("config"), user),
    artifact_count: count?.n ?? 0,
    // Admin follows the current ADMIN_EMAIL, like every policy check.
    is_admin: c.get("config").adminEmails.includes(user.email),
    connection: await meConnection(c),
  };
  return c.json(me);
}

/**
 * The bearer connection making the call, and the artifact it is limited to while the policy lets
 * its person view it (a deleted, taken-down or no-longer-shared one reads `artifact: null`).
 */
async function meConnection(c: AppContext): Promise<MeConnection | null> {
  const p = c.get("principal");
  if (p.kind !== "agent") return null;
  const bound = boundArtifactOf(p);
  let artifact: MeConnection["artifact"] = null;
  if (bound !== null) {
    const ctx = serviceCtx(c);
    const a = await findArtifact(ctx, bound);
    const d = a ? await decideFor(ctx, a, "view") : null;
    if (a && d?.allow) artifact = { id: a.id, slug: a.slug, title: a.title };
  }
  return { id: p.connectionId, label: p.connectionLabel, bound: bound !== null, artifact };
}
