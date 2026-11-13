import type { AppConfig, Me } from "@plinth/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { artifacts } from "../db/schema.ts";
import { unauthorized } from "../lib/errors.ts";
import { artifactLimitFor, getUserById } from "../services/users.ts";
import { type AppEnv, ensureCsrfCookie } from "./context.ts";

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

meApi.get("/me", async (c) => {
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
    is_admin: user.isAdmin,
  };
  return c.json(me);
});
