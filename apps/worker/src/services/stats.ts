// Artifact stats and admin stats (docs/spec.md "Artifact stats").
//
// instanceStats: instance-wide aggregates for the admins in ADMIN_EMAIL. No statement selects an
// artifact's id, slug or title, an owner or an email, so the answer names no page and no person.
// artifactStats: who opened one artifact, for its owner (policy action "views").
// artifactStatsSummary: opens across the caller's own artifacts.
import {
  type AdminStats,
  type ArtifactStats,
  type ArtifactStatsDay,
  type ArtifactStatsPerson,
  type ArtifactStatsSummary,
  type ArtifactStatsSummaryItem,
  type ArtifactStatsVersion,
  type ArtifactType,
  CLIENT_TYPES,
  type ClientType,
  LIMITS,
  type OpenRole,
  pageDisplayName,
  type StatsDay,
  type StatsRange,
  VISIBILITIES,
  type Visibility,
} from "@plinth/shared";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { mayReadStatsSummary, principalUserId } from "../policy.ts";
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
    connectionsUsedInWindow,
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
      `SELECT client_type, count(*) AS n FROM agent_connections WHERE revoked_at IS NULL
        GROUP BY client_type`,
    ),
    // Used in the window, including connections revoked since: their publishes are in the window.
    q("SELECT count(*) AS n FROM agent_connections WHERE last_used_at >= ?1", startIso),
    q("SELECT count(*) AS n FROM reports WHERE state = 'open'"),
    q(
      `SELECT (SELECT count(*) FROM artifact_opens)
            + (SELECT coalesce(sum(views), 0) FROM artifact_view_totals) AS n`,
    ),
    // Opens per UTC day and how many artifacts were opened that day (opened_at index).
    q(
      `SELECT substr(opened_at, 1, 10) AS day, count(*) AS views,
              count(DISTINCT artifact_id) AS artifacts
         FROM artifact_opens WHERE opened_at >= ?1 GROUP BY day`,
      startIso,
    ),
    q(
      "SELECT count(DISTINCT artifact_id) AS n FROM artifact_opens WHERE opened_at >= ?1",
      startIso,
    ),
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
  for (const row of rows(connections)) {
    const t = row.client_type as ClientType;
    if (t in connectionsByClient) connectionsByClient[t] = num(row.n);
    liveConnections += num(row.n);
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
      connections_used: num(first(connectionsUsedInWindow).n),
      views: sum("views"),
      artifacts_viewed: num(first(viewedInWindow).n),
    },
    series,
  };
}

// ---------- the owner's artifact stats ----------

/**
 * Who an open counts as, for distinct counts: the person (by email, so an account and the same
 * email confirmed by code are one person) or the anonymous visitor. NULL for an unknown open, which
 * counts as an open but never as a viewer. Needs `o` (artifact_opens) and `u` (LEFT JOIN users).
 */
const PERSON_KEY = `CASE
    WHEN o.viewer_kind = 'user' AND u.email IS NOT NULL THEN 'p:' || lower(u.email)
    WHEN o.viewer_kind = 'email' THEN 'p:' || lower(o.email)
  END`;
const VIEWER_KEY = `CASE
    WHEN o.viewer_kind = 'user' AND u.email IS NOT NULL THEN 'p:' || lower(u.email)
    WHEN o.viewer_kind = 'email' THEN 'p:' || lower(o.email)
    WHEN o.viewer_kind = 'anonymous' AND o.visitor IS NOT NULL THEN 'v:' || o.visitor
  END`;

/** One artifact's opens since ?2, with the keys above (?1 artifact id, ?2 window start). */
const WINDOW_CTE = `WITH w AS (
  SELECT o.id, o.opened_at, o.version, o.role, o.viewer_kind, o.visitor, u.name AS name,
         coalesce(u.email, o.email) AS email, ${PERSON_KEY} AS pk, ${VIEWER_KEY} AS vk
    FROM artifact_opens o LEFT JOIN users u ON u.id = o.user_id
   WHERE o.artifact_id = ?1 AND o.opened_at >= ?2
)`;

/** The UTC midnight that starts an `n`-day window ending today, as an ISO timestamp. */
function windowStart(nowMs: number, n: number): string {
  return `${dayRange(nowMs, n)[0]}T00:00:00.000Z`;
}

/** `since`: the earliest day an all-time count covers, from the log and the folded total. */
function sinceOf(total: number, ...days: unknown[]): string | null {
  if (total <= 0) return null;
  const known = days
    .filter((d): d is string => typeof d === "string" && d.length >= 10)
    .map((d) => d.slice(0, 10));
  return known.sort()[0] ?? null;
}

/**
 * One artifact's stats over the last `days` UTC days, for its owner only (policy action `views`):
 * authorization comes first, so a stranger learns nothing. Every statement reads one artifact's
 * rows through (artifact_id, opened_at), in one batch.
 */
export async function artifactStats(
  ctx: Ctx,
  ref: string,
  days: StatsRange,
): Promise<ArtifactStats> {
  const { artifact } = await requireArtifact(ctx, ref, "views");
  const now = Date.now();
  const range = dayRange(now, days);
  const start = windowStart(now, days);
  const db = ctx.env.DB;
  const q = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(artifact.id, ...binds);
  const [perDay, totals, logged, folded, people, perVersion] = await db.batch<Row>([
    q(
      `${WINDOW_CTE} SELECT substr(opened_at, 1, 10) AS day, count(*) AS opens,
         count(DISTINCT vk) AS viewers FROM w GROUP BY day`,
      start,
    ),
    q(
      `${WINDOW_CTE} SELECT count(*) AS opens, count(DISTINCT vk) AS viewers,
         count(DISTINCT pk) AS people,
         count(DISTINCT CASE WHEN viewer_kind = 'anonymous' THEN visitor END) AS anon_visitors,
         coalesce(sum(viewer_kind = 'anonymous'), 0) AS anon_opens FROM w`,
      start,
    ),
    q("SELECT count(*) AS n, min(opened_at) AS first FROM artifact_opens WHERE artifact_id = ?1"),
    q("SELECT views, first_day FROM artifact_view_totals WHERE artifact_id = ?1"),
    q(
      `${WINDOW_CTE}, r AS (
         SELECT *, row_number() OVER (PARTITION BY pk ORDER BY opened_at DESC, id DESC) AS rn,
                count(*) OVER (PARTITION BY pk) AS opens,
                min(opened_at) OVER (PARTITION BY pk) AS first_opened_at,
                max(name) OVER (PARTITION BY pk) AS person_name
           FROM w WHERE pk IS NOT NULL
       )
       SELECT email, person_name, viewer_kind, role, version, opened_at, first_opened_at, opens,
              count(*) OVER () AS total
         FROM r WHERE rn = 1 ORDER BY opened_at DESC, id DESC LIMIT ?3`,
      start,
      LIMITS.maxStatsPeople,
    ),
    q(
      `${WINDOW_CTE} SELECT version, count(*) AS opens, count(DISTINCT vk) AS viewers FROM w
        WHERE version IS NOT NULL GROUP BY version ORDER BY version DESC`,
      start,
    ),
  ]);
  const rows = (r: D1Result<Row> | undefined): Row[] => r?.results ?? [];
  const first = (r: D1Result<Row> | undefined): Row => rows(r)[0] ?? {};

  const byDay = new Map<string, Row>();
  for (const row of rows(perDay)) byDay.set(String(row.day), row);
  const series: ArtifactStatsDay[] = range.map((day) => ({
    day,
    opens: num(byDay.get(day)?.opens),
    viewers: num(byDay.get(day)?.viewers),
  }));

  const t = first(totals);
  const log = first(logged);
  const fold = first(folded);
  const allTime = num(log.n) + num(fold.views);
  const peopleRows = rows(people);
  return {
    enabled: ctx.config.viewCounts,
    days,
    retention_days: ctx.config.viewLogRetentionDays,
    current_version: artifact.currentVersion,
    totals: {
      opens: num(t.opens),
      viewers: num(t.viewers),
      people: num(t.people),
      anonymous_visitors: num(t.anon_visitors),
      anonymous_opens: num(t.anon_opens),
      all_time_opens: allTime,
      since: sinceOf(allTime, fold.first_day, log.first),
    },
    series,
    people: peopleRows.map(
      (r): ArtifactStatsPerson => ({
        name: pageDisplayName(typeof r.person_name === "string" ? r.person_name : null),
        email: String(r.email),
        kind: r.viewer_kind === "user" ? "user" : "email",
        role: typeof r.role === "string" ? (r.role as OpenRole) : null,
        first_opened_at: String(r.first_opened_at),
        last_opened_at: String(r.opened_at),
        opens: num(r.opens),
        last_version_seen: r.version === null || r.version === undefined ? null : num(r.version),
      }),
    ),
    people_total: num(peopleRows[0]?.total),
    versions: rows(perVersion).map(
      (r): ArtifactStatsVersion => ({
        version: num(r.version),
        opens: num(r.opens),
        viewers: num(r.viewers),
      }),
    ),
  };
}

/**
 * Opens across the caller's own live artifacts (not deleted, not taken down): 7 and 30 days, all
 * time and the last open. People and agents (`artifacts:read`); every statement is limited to
 * artifacts the caller owns.
 */
export async function artifactStatsSummary(ctx: Ctx): Promise<ArtifactStatsSummary> {
  const uid = principalUserId(ctx.principal);
  if (!uid) throw unauthorized();
  if (ctx.principal.kind === "agent" && !ctx.principal.scopes.has("artifacts:read")) {
    throw new ApiError("forbidden", "This token lacks the artifacts:read scope");
  }
  // A token limited to one artifact never lists the person's other artifacts (policy).
  if (!mayReadStatsSummary(ctx.principal)) {
    throw new ApiError("forbidden", "This token is limited to one artifact and cannot list stats", {
      reason: "token_bound",
      next: "Use a token without that limit",
    });
  }
  const now = Date.now();
  const start30 = windowStart(now, 30);
  const start7 = windowStart(now, 7);
  const db = ctx.env.DB;
  const MINE = `mine AS (SELECT id FROM artifacts
     WHERE owner_id = ?1 AND deleted_at IS NULL AND taken_down_at IS NULL)`;
  const [list, recent, logged, folded] = await db.batch<Row>([
    db
      .prepare(
        `SELECT id, slug, title, type, visibility, current_version FROM artifacts
          WHERE owner_id = ?1 AND deleted_at IS NULL AND taken_down_at IS NULL
            AND current_version >= 1`,
      )
      .bind(uid),
    db
      .prepare(
        `WITH ${MINE}, w AS (
           SELECT o.artifact_id, o.opened_at, ${VIEWER_KEY} AS vk
             FROM artifact_opens o JOIN mine ON mine.id = o.artifact_id
             LEFT JOIN users u ON u.id = o.user_id
            WHERE o.opened_at >= ?2
         )
         SELECT artifact_id, coalesce(sum(opened_at >= ?3), 0) AS opens_7d, count(*) AS opens_30d,
                count(DISTINCT CASE WHEN opened_at >= ?3 THEN vk END) AS viewers_7d,
                count(DISTINCT vk) AS viewers_30d
           FROM w GROUP BY artifact_id`,
      )
      .bind(uid, start30, start7),
    db
      .prepare(
        `WITH ${MINE} SELECT o.artifact_id, count(*) AS n, max(o.opened_at) AS last
           FROM artifact_opens o JOIN mine ON mine.id = o.artifact_id GROUP BY o.artifact_id`,
      )
      .bind(uid),
    db
      .prepare(
        `WITH ${MINE} SELECT t.artifact_id, t.views
           FROM artifact_view_totals t JOIN mine ON mine.id = t.artifact_id`,
      )
      .bind(uid),
  ]);
  const index = (r: D1Result<Row> | undefined) => {
    const m = new Map<string, Row>();
    for (const row of r?.results ?? []) m.set(String(row.artifact_id), row);
    return m;
  };
  const windows = index(recent);
  const logs = index(logged);
  const folds = index(folded);
  const items: ArtifactStatsSummaryItem[] = (list?.results ?? []).map((a) => {
    const id = String(a.id);
    const w = windows.get(id) ?? {};
    const l = logs.get(id) ?? {};
    return {
      id,
      slug: String(a.slug),
      title: String(a.title),
      type: a.type as ArtifactType,
      visibility: a.visibility as Visibility,
      current_version: num(a.current_version),
      opens_7d: num(w.opens_7d),
      opens_30d: num(w.opens_30d),
      viewers_7d: num(w.viewers_7d),
      viewers_30d: num(w.viewers_30d),
      all_time_opens: num(l.n) + num(folds.get(id)?.views),
      last_opened_at: typeof l.last === "string" ? l.last : null,
    };
  });
  // Most recently opened first; never-opened ones after, by title.
  items.sort(
    (a, b) =>
      (b.last_opened_at ?? "").localeCompare(a.last_opened_at ?? "") ||
      a.title.localeCompare(b.title),
  );
  return {
    enabled: ctx.config.viewCounts,
    retention_days: ctx.config.viewLogRetentionDays,
    generated_at: new Date(now).toISOString(),
    items,
  };
}
