// Artifact stats and admin stats (docs/spec.md "Artifact stats").
//
//   GET /admin/stats?days=7|30|90             -> AdminStats (admins only; everyone else gets 404)
//   GET /artifacts/:ref/stats?days=7|30|90|365 -> ArtifactStats (the owner only, policy action "views")
//   GET /stats/artifacts                       -> ArtifactStatsSummary (the caller's own artifacts)
import {
  API,
  adminStatsQuerySchema,
  artifactStatsQuerySchema,
  type StatsRange,
} from "@plinth/shared";
import { Hono } from "hono";
import { requireAdmin } from "../services/reports.ts";
import { artifactStats, artifactStatsSummary, instanceStats } from "../services/stats.ts";
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

statsApi.get(API.artifactStats, async (c) => {
  const { days } = parseInput(artifactStatsQuerySchema, { days: c.req.query("days") });
  const stats = await artifactStats(serviceCtx(c), c.req.param("ref"), Number(days) as StatsRange);
  c.header("Cache-Control", "no-store");
  return c.json(stats);
});

statsApi.get(API.statsArtifacts, async (c) => {
  const summary = await artifactStatsSummary(serviceCtx(c));
  c.header("Cache-Control", "no-store");
  return c.json(summary);
});
