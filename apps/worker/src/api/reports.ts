// Abuse reports and the admin takedown queue (workstream: content and hosted flags).
//
//   POST /artifacts/:ref/report  {reason, reporter_email?}  -> 201 {id, state: "open"}
//   GET  /admin/reports?state=open|actioned|dismissed       -> {items: ReportInfo[]} (admins only)
//   POST /admin/reports/:id      {state: "actioned"|"dismissed"} -> ReportInfo (admins only)
//
// Non-admins get 404 from the admin endpoints.
import { reportDecisionInput, reportInput, reportStateSchema } from "@plinth/shared";
import { Hono } from "hono";
import { createReport, decideReport, listReports, requireAdmin } from "../services/reports.ts";
import { type AppEnv, parseBody, parseInput, serviceCtx } from "./context.ts";

export const reportsApi = new Hono<AppEnv>();

reportsApi.post("/artifacts/:ref/report", async (c) => {
  const input = await parseBody(c, reportInput);
  return c.json(await createReport(serviceCtx(c), c.req.param("ref"), input), 201);
});

reportsApi.get("/admin/reports", async (c) => {
  const ctx = serviceCtx(c);
  requireAdmin(ctx);
  const raw = c.req.query("state");
  const state = raw ? parseInput(reportStateSchema, raw) : undefined;
  return c.json({ items: await listReports(ctx, state) });
});

reportsApi.post("/admin/reports/:id", async (c) => {
  const ctx = serviceCtx(c);
  requireAdmin(ctx);
  const { state } = await parseBody(c, reportDecisionInput);
  return c.json(await decideReport(ctx, c.req.param("id"), state));
});
