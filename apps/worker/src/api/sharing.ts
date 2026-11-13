// Sharing settings: allowlist and collaborator roles. Owner only (policy action "manage").
import { grantsReplaceInput, type SharingSettings } from "@plinth/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type ArtifactRow, accessGrants } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { canMakePublic } from "../policy.ts";
import { bumpAccessEpoch, requireArtifact } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { getUserById } from "../services/users.ts";
import { type AppEnv, parseBody, serviceCtx } from "./context.ts";

export const sharingApi = new Hono<AppEnv>();

async function settings(ctx: Ctx, a: ArtifactRow): Promise<SharingSettings> {
  const grants = await ctx.db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.artifactId, a.id))
    .orderBy(asc(accessGrants.email))
    .all();
  const owner = await getUserById(ctx.db, a.ownerId);
  return {
    visibility: a.visibility,
    has_password: !!a.passwordHash,
    grants: grants.map((g) => ({ email: g.email, role: g.role, created_at: g.createdAt })),
    public_allowed:
      !!owner &&
      canMakePublic({
        enabled: ctx.config.allowPublicVisibility,
        emailVerifiedAt: owner.emailVerifiedAt,
        createdAt: owner.createdAt,
        minAccountAgeHours: ctx.config.publicMinAccountAgeHours,
      }),
  };
}

sharingApi.get("/artifacts/:ref/sharing", async (c) => {
  const ctx = serviceCtx(c);
  const { artifact } = await requireArtifact(ctx, c.req.param("ref"), "manage");
  return c.json(await settings(ctx, artifact));
});

/** Replace every grant (viewer, commenter, editor). The owner's own email is ignored. */
sharingApi.put("/artifacts/:ref/sharing", async (c) => {
  const ctx = serviceCtx(c);
  const { grants } = await parseBody(c, grantsReplaceInput);
  const { artifact } = await requireArtifact(ctx, c.req.param("ref"), "manage");
  const owner = await getUserById(ctx.db, artifact.ownerId);
  const byEmail = new Map<string, (typeof grants)[number]["role"]>();
  for (const g of grants) {
    if (g.email === owner?.email) continue;
    if (byEmail.has(g.email)) throw new ApiError("invalid_input", `Duplicate email: ${g.email}`);
    byEmail.set(g.email, g.role);
  }
  const now = nowIso();
  const stmts = [
    ctx.db.delete(accessGrants).where(eq(accessGrants.artifactId, artifact.id)),
    ...[...byEmail].map(([email, role]) =>
      ctx.db.insert(accessGrants).values({ artifactId: artifact.id, email, role, createdAt: now }),
    ),
  ];
  // biome-ignore lint/suspicious/noExplicitAny: drizzle batch takes a non-empty tuple of queries
  await ctx.db.batch(stmts as any);
  await bumpAccessEpoch(ctx, artifact.id);
  const fresh = (await requireArtifact(ctx, artifact.id, "manage")).artifact;
  return c.json(await settings(ctx, fresh));
});
