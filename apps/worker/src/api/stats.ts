// Admin stats and an owner's open counts (docs/spec.md "Admin stats and view counts").
//
//   GET /admin/stats?days=7|30|90   -> AdminStats (admins only; everyone else gets 404)
//   GET /artifacts/:ref/views       -> ArtifactViews (the owner only, policy action "views")
import { API, adminStatsQuerySchema } from "@plinth/shared";
import { Hono } from "hono";
import { requireAdmin } from "../services/reports.ts";
import { artifactViews, instanceStats } from "../services/stats.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const statsApi = new Hono<AppEnv>();

statsApi.get(API.adminStats, async (c) => {
  const ctx = serviceCtx(c);
  // Before parsing, so a non-admin's bad query still gets the same 404 as any other.
  requireAdmin(ctx);
  const { days } = parseInput(adminStatsQuerySchema, { days: c.req.query("days") });
  c.header("Cache-Control", "no-store");
  return c.json(await instanceStats(ctx, Number(days) as 7 | 30 | 90));
});

statsApi.get(API.artifactViews, async (c) => {
  const views = await artifactViews(serviceCtx(c), c.req.param("ref"));
  c.header("Cache-Control", "no-store");
  return c.json(views);
});
