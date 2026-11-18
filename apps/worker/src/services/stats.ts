// Admin stats and an owner's open counts (docs/spec.md "Admin stats and view counts").
//
// instanceStats: instance-wide aggregates for the admins in ADMIN_EMAIL. No statement selects an
// artifact's id, slug or title, an owner or an email, so the answer names no page and no person.
// artifactViews: one artifact's open counts, for its owner (policy action "views").
import {
  type AdminStats,
  type ArtifactViews,
  CLIENT_TYPES,
  type ClientType,
  type StatsDay,
  VISIBILITIES,
  type Visibility,
} from "@plinth/shared";
import { requireArtifact } from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { requireAdmin } from "./reports.ts";
import { utcDay } from "./views.ts";

const DAY_MS = 86_400_000;

/** The `n` UTC days ending today, oldest first. */
function dayRange(nowMs: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => utcDay(nowMs - (n - 1 - i) * DAY_MS));
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

type Row = Record<string, unknown>;

export async function instanceStats(ctx: Ctx, days: 7 | 30 | 90): Promise<AdminStats> {
  requireAdmin(ctx);
  const now = Date.now();
  const range = dayRange(now, days);
  const start = range[0] as string;
  const startIso = `${start}T00:00:00.000Z`;
  const db = ctx.env.DB;
  const q = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds);

  const [
    users,
    byVisibility,
    versions,
    data,
    connections,
    openReports,
    allViews,
    viewDays,
    viewedInWindow,
    newUsers,
    newArtifacts,
    publishes,
  ] = await db.batch<Row>([
    q("SELECT count(*) AS n, coalesce(sum(created_at >= ?1), 0) AS fresh FROM users", startIso),
    q(
      `SELECT visibility, count(*) AS n, coalesce(sum(taken_down_at IS NOT NULL), 0) AS down
         FROM artifacts WHERE deleted_at IS NULL GROUP BY visibility`,
    ),
    q(
      `SELECT count(*) AS n, coalesce(sum(v.created_by_connection IS NOT NULL), 0) AS agent,
              coalesce(sum(coalesce(v.stored_bytes, v.size_bytes)), 0) AS bytes
         FROM versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.deleted_at IS NULL`,
    ),
    q(
      `SELECT coalesce(sum(u.docs), 0) AS docs, coalesce(sum(u.bytes), 0) AS bytes,
              coalesce(sum(u.docs > 0), 0) AS pages
         FROM artifact_data_usage u JOIN artifacts a ON a.id = u.artifact_id
        WHERE a.deleted_at IS NULL`,
    ),
    q(
      `SELECT client_type, count(*) AS n, coalesce(sum(last_used_at >= ?1), 0) AS used
         FROM agent_connections WHERE revoked_at IS NULL GROUP BY client_type`,
      startIso,
    ),
    q("SELECT count(*) AS n FROM reports WHERE state = 'open'"),
    q(
      `SELECT (SELECT coalesce(sum(views), 0) FROM artifact_view_days)
            + (SELECT coalesce(sum(views), 0) FROM artifact_view_totals) AS n`,
    ),
    q(
      `SELECT day, sum(views) AS views, count(*) AS artifacts FROM artifact_view_days
        WHERE day >= ?1 GROUP BY day`,
      start,
    ),
    q("SELECT count(DISTINCT artifact_id) AS n FROM artifact_view_days WHERE day >= ?1", start),
    q(
      `SELECT substr(created_at, 1, 10) AS d, count(*) AS n FROM users
        WHERE created_at >= ?1 GROUP BY d`,
      startIso,
    ),
    // Activity series: artifacts and versions created in the window, including any deleted since.
    q(
      `SELECT substr(created_at, 1, 10) AS d, count(*) AS n FROM artifacts
        WHERE created_at >= ?1 GROUP BY d`,
      startIso,
    ),
    q(
      `SELECT substr(created_at, 1, 10) AS d, count(*) AS n,
              coalesce(sum(created_by_connection IS NOT NULL), 0) AS agent
         FROM versions WHERE created_at >= ?1 GROUP BY d`,
      startIso,
    ),
  ]);

  const rows = (r: D1Result<Row> | undefined): Row[] => r?.results ?? [];
  const first = (r: D1Result<Row> | undefined): Row => rows(r)[0] ?? {};
  const byDay = (r: D1Result<Row> | undefined, key: string, col: string) => {
    const m = new Map<string, number>();
    for (const row of rows(r)) m.set(String(row[key]), num(row[col]));
    return m;
  };

  const artifactsByVisibility = Object.fromEntries(VISIBILITIES.map((v) => [v, 0])) as Record<
    Visibility,
    number
  >;
  let liveArtifacts = 0;
  let takenDown = 0;
  for (const row of rows(byVisibility)) {
    const v = row.visibility as Visibility;
    if (v in artifactsByVisibility) artifactsByVisibility[v] = num(row.n);
    liveArtifacts += num(row.n);
    takenDown += num(row.down);
  }

  const connectionsByClient = Object.fromEntries(CLIENT_TYPES.map((t) => [t, 0])) as Record<
    ClientType,
    number
  >;
  let liveConnections = 0;
  let connectionsUsed = 0;
  for (const row of rows(connections)) {
    const t = row.client_type as ClientType;
    if (t in connectionsByClient) connectionsByClient[t] = num(row.n);
    liveConnections += num(row.n);
    connectionsUsed += num(row.used);
  }

  const usersPerDay = byDay(newUsers, "d", "n");
  const artifactsPerDay = byDay(newArtifacts, "d", "n");
  const publishesPerDay = byDay(publishes, "d", "n");
  const agentPublishesPerDay = byDay(publishes, "d", "agent");
  const viewsPerDay = byDay(viewDays, "day", "views");
  const viewedPerDay = byDay(viewDays, "day", "artifacts");
  const series: StatsDay[] = range.map((day) => ({
    day,
    users: usersPerDay.get(day) ?? 0,
    artifacts: artifactsPerDay.get(day) ?? 0,
    publishes: publishesPerDay.get(day) ?? 0,
    agent_publishes: agentPublishesPerDay.get(day) ?? 0,
    views: viewsPerDay.get(day) ?? 0,
    artifacts_viewed: viewedPerDay.get(day) ?? 0,
  }));
  const sum = (k: keyof StatsDay) => series.reduce((acc, d) => acc + num(d[k]), 0);

  const u = first(users);
  const v = first(versions);
  const d = first(data);
  return {
    generated_at: new Date(now).toISOString(),
    days,
    view_counts: ctx.config.viewCounts,
    totals: {
      users: num(u.n),
      artifacts: liveArtifacts,
      artifacts_by_visibility: artifactsByVisibility,
      artifacts_taken_down: takenDown,
      versions: num(v.n),
      agent_versions: num(v.agent),
      storage_bytes: num(v.bytes),
      data_docs: num(d.docs),
      data_bytes: num(d.bytes),
      data_artifacts: num(d.pages),
      connections: liveConnections,
      connections_by_client: connectionsByClient,
      views: num(first(allViews).n),
      open_reports: num(first(openReports).n),
    },
    window: {
      new_users: num(u.fresh),
      new_artifacts: sum("artifacts"),
      publishes: sum("publishes"),
      agent_publishes: sum("agent_publishes"),
      connections_used: connectionsUsed,
      views: sum("views"),
      artifacts_viewed: num(first(viewedInWindow).n),
    },
    series,
  };
}

/** Days in the owner's open-count view (the Share dialog's sparkline). */
const OWNER_DAYS = 30;

/**
 * One artifact's open counts, for its owner. Authorization comes first, so a stranger learns
 * nothing. Reads the last 30 daily rows, one sum over the older daily rows (at most 61 on an
 * instance whose cron folds them) and the folded total: one primary-key range each.
 */
export async function artifactViews(ctx: Ctx, ref: string): Promise<ArtifactViews> {
  const { artifact } = await requireArtifact(ctx, ref, "views");
  const now = Date.now();
  const range = dayRange(now, OWNER_DAYS);
  const start = range[0] as string;
  const db = ctx.env.DB;
  const [recent, older, folded] = await db.batch<Row>([
    db
      .prepare("SELECT day, views FROM artifact_view_days WHERE artifact_id = ?1 AND day >= ?2")
      .bind(artifact.id, start),
    db
      .prepare(
        `SELECT coalesce(sum(views), 0) AS n FROM artifact_view_days
          WHERE artifact_id = ?1 AND day < ?2`,
      )
      .bind(artifact.id, start),
    db.prepare("SELECT views FROM artifact_view_totals WHERE artifact_id = ?1").bind(artifact.id),
  ]);
  const perDay = new Map<string, number>();
  for (const row of recent?.results ?? []) perDay.set(String(row.day), num(row.views));
  const series = range.map((day) => ({ day, views: perDay.get(day) ?? 0 }));
  const last30 = series.reduce((acc, d) => acc + d.views, 0);
  const last7 = series.slice(-7).reduce((acc, d) => acc + d.views, 0);
  return {
    enabled: ctx.config.viewCounts,
    total: last30 + num(older?.results[0]?.n) + num(folded?.results[0]?.views),
    last_7: last7,
    last_30: last30,
    days: series,
  };
}
