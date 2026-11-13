import { type AppConfig, type Me, updateProfileInput } from "@plinth/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { artifacts, users } from "../db/schema.ts";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { artifactLimitFor, getUserById } from "../services/users.ts";
import { type AppContext, type AppEnv, ensureCsrfCookie, parseBody } from "./context.ts";

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
    environment: config.environment,
  };
  const res = c.json(body);
  ensureCsrfCookie(c, res.headers);
  return res;
});

/** Update the signed-in person's display name. People only (not agents). */
meApi.patch("/me", async (c) => {
  const p = c.get("principal");
  if (p.kind === "agent") throw new ApiError("forbidden", "Agents cannot change the profile");
  if (p.kind !== "user") throw unauthorized();
  const { name } = await parseBody(c, updateProfileInput);
  await c
    .get("db")
    .update(users)
    .set({ name: name || null })
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
  };
  return c.json(me);
}
