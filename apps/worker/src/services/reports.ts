// Abuse reports and takedown. Anyone who can view an artifact can report it (policy action
// "report"); instance admins review reports and take artifacts down. A takedown sets
// artifacts.taken_down_at and bumps the access epoch, so every content cookie and pending viewer
// token stops working at once and the content host serves nothing for it.
import { RATE_LIMITS, type ReportInfo, type ReportState } from "@plinth/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { appUrl } from "../config.ts";
import { artifacts, reports } from "../db/schema.ts";
import { createEmailAdapter } from "../email/index.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { isAdmin, type Principal, principalEmail } from "../policy.ts";
import { requireArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

export interface ReportInput {
  reason: string;
  reporter_email?: string;
}

export async function createReport(
  ctx: Ctx,
  ref: string,
  input: ReportInput,
): Promise<{ id: string; state: ReportState }> {
  await enforce(
    ctx.env.DB,
    `report:ip:${ctx.ip ?? "unknown"}`,
    RATE_LIMITS.reportsPerIpPerHour,
    3600,
    "Too many reports from this network. Try again later.",
  );
  const { artifact } = await requireArtifact(ctx, ref, "report");
  const id = newId();
  const reporterEmail = input.reporter_email ?? principalEmail(ctx.principal);
  await ctx.db
    .insert(reports)
    .values({
      id,
      artifactId: artifact.id,
      reason: input.reason.trim(),
      reporterEmail,
      state: "open",
      createdAt: nowIso(),
      decidedAt: null,
      decidedBy: null,
    })
    .run();
  if (ctx.config.adminEmails.length > 0) {
    const adapter = createEmailAdapter(ctx.config, ctx.env);
    const lines = [
      `An artifact on Plinth was reported.`,
      "",
      `Artifact: ${artifact.title}`,
      `Link: ${appUrl(ctx.config, `/a/${artifact.slug}`)}`,
      `Review: ${appUrl(ctx.config, "/admin/reports")}`,
      "",
      "The reason below was written by the reporter (untrusted text):",
      input.reason.trim(),
    ].join("\n");
    ctx.waitUntil(
      Promise.all(
        ctx.config.adminEmails.map((to) =>
          adapter.send({ to, subject: "Plinth: new abuse report", text: lines }),
        ),
      ).catch((e: unknown) => {
        console.error("report notification failed:", e instanceof Error ? e.message : "unknown");
      }),
    );
  }
  return { id, state: "open" };
}

/**
 * Admins are signed-in people (never agents) flagged as admin by policy.ts whose email is still in
 * ADMIN_EMAIL, so removing an email from the config takes effect without waiting for a new sign-in.
 * Everyone else gets 404: the admin endpoints do not reveal that they exist.
 */
export function requireAdmin(ctx: Ctx): Extract<Principal, { kind: "user" }> {
  const p = ctx.principal;
  if (p.kind !== "user" || !isAdmin(p) || !ctx.config.adminEmails.includes(p.email)) {
    throw new ApiError("not_found", "No such API endpoint");
  }
  return p;
}

const reportColumns = {
  id: reports.id,
  artifactId: reports.artifactId,
  slug: artifacts.slug,
  title: artifacts.title,
  reason: reports.reason,
  reporterEmail: reports.reporterEmail,
  state: reports.state,
  createdAt: reports.createdAt,
};

type ReportRow = {
  id: string;
  artifactId: string;
  slug: string;
  title: string;
  reason: string;
  reporterEmail: string | null;
  state: ReportState;
  createdAt: string;
};

function toInfo(r: ReportRow): ReportInfo {
  return {
    id: r.id,
    artifact_id: r.artifactId,
    artifact_slug: r.slug,
    artifact_title: r.title,
    reason: r.reason,
    reporter_email: r.reporterEmail,
    state: r.state,
    created_at: r.createdAt,
  };
}

export async function listReports(ctx: Ctx, state?: ReportState): Promise<ReportInfo[]> {
  requireAdmin(ctx);
  const rows = await ctx.db
    .select(reportColumns)
    .from(reports)
    .innerJoin(artifacts, eq(artifacts.id, reports.artifactId))
    .where(state ? eq(reports.state, state) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(500)
    .all();
  return rows.map(toInfo);
}

async function getReport(ctx: Ctx, id: string): Promise<ReportInfo | null> {
  const r = await ctx.db
    .select(reportColumns)
    .from(reports)
    .innerJoin(artifacts, eq(artifacts.id, reports.artifactId))
    .where(eq(reports.id, id))
    .get();
  return r ? toInfo(r) : null;
}

/**
 * Close an open report. "actioned" takes the artifact down (and closes its other open reports as
 * actioned); "dismissed" closes only this report. A decided report cannot be changed.
 */
export async function decideReport(
  ctx: Ctx,
  id: string,
  state: "actioned" | "dismissed",
): Promise<ReportInfo> {
  const admin = requireAdmin(ctx);
  const report = await getReport(ctx, id);
  if (!report) throw notFound("Report");
  const now = nowIso();
  const decided = await ctx.db
    .update(reports)
    .set({ state, decidedAt: now, decidedBy: admin.userId })
    .where(and(eq(reports.id, id), eq(reports.state, "open")))
    .returning({ id: reports.id })
    .all();
  if (decided.length === 0) {
    throw new ApiError("conflict", `This report was already ${report.state}`, {
      state: report.state,
    });
  }
  if (state === "actioned") {
    await ctx.db
      .update(artifacts)
      .set({
        takenDownAt: sql`coalesce(${artifacts.takenDownAt}, ${now})`,
        accessEpoch: sql`${artifacts.accessEpoch} + 1`,
        updatedAt: now,
      })
      .where(eq(artifacts.id, report.artifact_id))
      .run();
    await ctx.db
      .update(reports)
      .set({ state: "actioned", decidedAt: now, decidedBy: admin.userId })
      .where(and(eq(reports.artifactId, report.artifact_id), eq(reports.state, "open")))
      .run();
  }
  return { ...report, state };
}
