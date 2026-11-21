// Page: /a/:slug/stats. Owner only: who opened the artifact, when, how often and which version, over
// 7, 30, 90 or 365 UTC days (kept in ?days=). Tiles, daily opens and viewers, the people who opened
// it, opens per version and the anonymous visitor count. Everyone else gets the same answers as
// Settings: "not found", or "only the owner" for collaborators.
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ArtifactStats as ArtifactStatsData,
  type ArtifactStatsPerson,
  type ArtifactSummary,
  type OpenRole,
  route,
  STATS_RANGES,
  type StatsRange,
} from "@plinth/shared";
import { useEffect, useState } from "react";
import "../components/account/account.css";
import { useDocumentTitle, useSignInRedirect, useSignOut } from "../components/account/hooks.tsx";
import { Note } from "../components/account/Note.tsx";
import { formatCount } from "../components/admin/StatGrid.tsx";
import { TrendChart } from "../components/admin/TrendChart.tsx";
import "../components/admin/admin.css";
import { AppShell } from "../components/layout/AppShell.tsx";
import "../components/stats/stats.css";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  SegmentedControl,
  SkeletonText,
} from "../components/ui/index.ts";
import { formatDate, formatDay } from "../components/viewer/format.ts";
import { ApiRequestError, api, getArtifactStats } from "../lib/api.ts";
import { Link, navigate, useLocation } from "../lib/router.tsx";

type State =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "forbidden"; artifact: ArtifactSummary }
  | { status: "taken_down"; artifact: ArtifactSummary }
  | { status: "error"; message: string }
  | { status: "ready"; artifact: ArtifactSummary; stats: ArtifactStatsData };

const RANGE_OPTIONS = STATS_RANGES.map((d) => ({ value: String(d), label: `${d} days` }));

/** The window from `?days=`, 30 when it is missing or not one of the choices. */
export function rangeFrom(search: URLSearchParams): StatsRange {
  const n = Number(search.get("days"));
  return (STATS_RANGES as readonly number[]).includes(n) ? (n as StatsRange) : 30;
}

const isTakenDown = (e: unknown) => {
  const details = e instanceof ApiRequestError ? e.details : undefined;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "taken_down"
  );
};

export default function ArtifactStats({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const { pending, redirect } = useSignInRedirect();
  const signOut = useSignOut();
  const { pathname, search } = useLocation();
  const days = rangeFrom(search);
  const [state, setState] = useState<State>({ status: "loading" });
  const [reload, setReload] = useState(0);

  useDocumentTitle(state.status === "ready" ? `Stats · ${state.artifact.title}` : "Artifact stats");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    const load = async () => {
      const artifact = await api<ArtifactSummary>(route(API.artifact, { ref: slug }), {
        signal: ctrl.signal,
      });
      if (artifact.role !== "owner") {
        setState({ status: "forbidden", artifact });
        return;
      }
      try {
        const stats = await getArtifactStats(artifact.id, days, ctrl.signal);
        setState({ status: "ready", artifact, stats });
      } catch (e) {
        if (!ctrl.signal.aborted && isTakenDown(e)) {
          setState({ status: "taken_down", artifact });
          return;
        }
        throw e;
      }
    };
    // Keep what is shown while another window loads; only the first load shows the skeleton.
    load().catch((e: unknown) => {
      if (ctrl.signal.aborted) return;
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        setState({ status: "not_found" });
      } else {
        setState({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      }
    });
    return () => ctrl.abort();
  }, [pending, slug, days, reload]);

  if (redirect) return redirect;

  const artifactHref = (s: string) => route(APP_ROUTES.artifact, { slug: s });
  const known = state.status === "ready" ? state.artifact : null;
  const setDays = (d: string) => navigate(`${pathname}?days=${d}`, { replace: true });

  return (
    <AppShell
      onSignOut={signOut}
      crumbs={known ? [{ label: "Artifacts", to: APP_ROUTES.dashboard }] : undefined}
      title={known ? <Link to={artifactHref(known.slug)}>{known.title}</Link> : undefined}
      trail="Stats"
      actions={
        known ? (
          <ButtonLink to={artifactHref(known.slug)} icon={ArrowSquareOutIcon}>
            Open
          </ButtonLink>
        ) : undefined
      }
    >
      {pending || state.status === "loading" ? (
        <div aria-busy="true" className="pl-stats">
          <span className="visually-hidden">Loading stats</span>
          <SkeletonText lines={6} />
        </div>
      ) : state.status === "not_found" ? (
        <EmptyState
          size="lg"
          headingLevel={1}
          title="Artifact not found"
          description="There is no artifact at this address whose stats you can see. It may have been deleted, or the link is mistyped."
          action={
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          }
        />
      ) : state.status === "forbidden" ? (
        <EmptyState
          size="lg"
          headingLevel={1}
          title="Only the owner can see who opened it"
          description={`You can open “${state.artifact.title}”, but who opened it is for its owner to see.`}
          action={
            <ButtonLink to={artifactHref(state.artifact.slug)} variant="primary">
              Open the artifact
            </ButtonLink>
          }
        />
      ) : state.status === "taken_down" ? (
        <EmptyState
          size="lg"
          headingLevel={1}
          title="This artifact was taken down"
          description="It was taken down after a report, so who opened it is not shown."
          action={
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          }
        />
      ) : state.status === "error" ? (
        <EmptyState
          art={null}
          headingLevel={1}
          title="Could not load the stats"
          description={state.message}
          action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        />
      ) : (
        <StatsView
          stats={state.stats}
          days={days}
          onDays={setDays}
          // The stats on screen are for another window until the new range arrives.
          updating={state.stats.days !== days}
        />
      )}
    </AppShell>
  );
}

function StatsView({
  stats,
  days,
  onDays,
  updating,
}: {
  stats: ArtifactStatsData;
  days: StatsRange;
  onDays: (d: string) => void;
  updating: boolean;
}) {
  const t = stats.totals;
  const period = `last ${stats.days} days`;
  const series = stats.series.map((d) => d.day);
  return (
    <>
      <div className="pl-ostats__toolbar">
        <p className="pl-ostats__lead">Who opened this artifact, when and which version.</p>
        <SegmentedControl
          label="Period"
          options={RANGE_OPTIONS}
          value={String(days)}
          onChange={onDays}
          size="sm"
        />
      </div>
      <p className="visually-hidden pl-ostats__live" role="status">
        {updating ? "Updating stats" : ""}
      </p>
      <div
        className={updating ? "pl-ostats__body pl-ostats__body--updating" : "pl-ostats__body"}
        aria-busy={updating || undefined}
      >
        {!stats.enabled && (
          <Note className="pl-ostats__note">
            This instance does not record opens (VIEW_COUNTS is off), so nothing new is added here.
          </Note>
        )}
        {t.all_time_opens === 0 ? (
          <EmptyState
            headingLevel={2}
            title="No opens yet"
            description="When someone other than you opens this artifact, you will see who it was and when."
          />
        ) : (
          <>
            <h2 className="visually-hidden">Totals</h2>
            <dl className="pl-stat-grid">
              <Tile
                label={`Opens, ${period}`}
                value={formatCount(t.opens)}
                caption={`${formatCount(t.anonymous_opens)} anonymous`}
              />
              <Tile
                label={`Viewers, ${period}`}
                value={formatCount(t.viewers)}
                caption="People and anonymous visitors"
              />
              <Tile label="People" value={formatCount(t.people)} caption="Signed in or by email" />
              <Tile
                label="Anonymous visitors"
                value={formatCount(t.anonymous_visitors)}
                caption="Approximate: one per browser"
              />
              <Tile
                label="Opens in all"
                value={formatCount(t.all_time_opens)}
                caption={t.since ? `Since ${formatDay(t.since)}` : undefined}
              />
            </dl>
            <h2 className="pl-stats__section-title">Per day, {period}</h2>
            <div className="pl-stats__charts">
              <TrendChart
                title="Opens per day"
                unit={["open", "opens"]}
                days={series}
                series={[{ label: "Opens", values: stats.series.map((d) => d.opens) }]}
              />
              <TrendChart
                title="Viewers per day"
                unit={["viewer", "viewers"]}
                days={series}
                series={[{ label: "Viewers", values: stats.series.map((d) => d.viewers) }]}
              />
            </div>
            <h2 className="pl-stats__section-title">People, {period}</h2>
            <PeopleTable stats={stats} />
            <h2 className="pl-stats__section-title">Versions, {period}</h2>
            <VersionsTable stats={stats} />
          </>
        )}
        <p className="pl-stats__footnote">
          Counts opens by people other than you: once per browser every 12 hours, and again after
          you change who can open the page. Names and emails are shown for people signed in to
          Plinth and for viewers who confirmed their email; anyone else counts as an anonymous
          visitor, one per browser, so that figure is approximate. Days are UTC. Each open is kept
          with who made it for {formatCount(stats.retention_days)} days, and after that only
          counted.
        </p>
      </div>
    </>
  );
}

function Tile({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="pl-stat">
      <dt className="pl-stat__label">{label}</dt>
      <dd className="pl-stat__value type-num">{value}</dd>
      {caption && <dd className="pl-stat__caption type-num">{caption}</dd>}
    </div>
  );
}

const ROLE_LABEL: Record<OpenRole, string> = {
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
  public: "Public link",
  link: "Link",
  password: "Password",
};

/** Whether this person last saw a version older than the current one. */
export const sawOlderVersion = (p: ArtifactStatsPerson, current: number) =>
  p.last_version_seen !== null && p.last_version_seen < current;

function PeopleTable({ stats }: { stats: ArtifactStatsData }) {
  if (stats.people.length === 0) {
    return (
      <p className="pl-ostats__none">
        {stats.totals.opens > 0
          ? "Nobody signed in or confirmed by email opened it in this period."
          : "Nobody opened it in this period."}
      </p>
    );
  }
  return (
    <>
      <div className="pl-table-wrap">
        <table className="pl-table">
          <caption className="visually-hidden">People who opened this artifact</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Role</th>
              <th scope="col">First opened</th>
              <th scope="col">Last opened</th>
              <th scope="col" className="pl-table__num">
                Opens
              </th>
              <th scope="col">Last version seen</th>
            </tr>
          </thead>
          <tbody>
            {stats.people.map((p) => (
              <tr key={p.email}>
                <th scope="row" className="pl-table__main">
                  {p.name ?? p.email}
                  {p.name && <span className="pl-table__sub">{p.email}</span>}
                </th>
                <td>{p.role ? ROLE_LABEL[p.role] : "—"}</td>
                <td>
                  <time dateTime={p.first_opened_at}>{formatDate(p.first_opened_at)}</time>
                </td>
                <td>
                  <time dateTime={p.last_opened_at}>{formatDate(p.last_opened_at)}</time>
                </td>
                <td className="pl-table__num">{formatCount(p.opens)}</td>
                <td>
                  {p.last_version_seen === null ? (
                    "Not recorded"
                  ) : (
                    <span className="pl-table__version type-num">
                      v{p.last_version_seen}
                      {sawOlderVersion(p, stats.current_version) && (
                        <Badge tone="warning">Not the latest version</Badge>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {stats.people_total > stats.people.length && (
        <p className="pl-ostats__more">
          Showing the {formatCount(stats.people.length)} who opened it most recently, of{" "}
          {formatCount(stats.people_total)} people.
        </p>
      )}
    </>
  );
}

function VersionsTable({ stats }: { stats: ArtifactStatsData }) {
  if (stats.versions.length === 0) {
    return <p className="pl-ostats__none">No version was recorded for opens in this period.</p>;
  }
  return (
    <div className="pl-table-wrap">
      <table className="pl-table">
        <caption className="visually-hidden">Opens per version</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col" className="pl-table__num">
              Opens
            </th>
            <th scope="col" className="pl-table__num">
              Viewers
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.versions.map((v) => (
            <tr key={v.version}>
              <th scope="row">
                <span className="pl-table__version type-num">
                  v{v.version}
                  {v.version === stats.current_version && <Badge>Current</Badge>}
                </span>
              </th>
              <td className="pl-table__num">{formatCount(v.opens)}</td>
              <td className="pl-table__num">{formatCount(v.viewers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
