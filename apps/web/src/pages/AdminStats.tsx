// Page: /admin/stats. Instance admins see how the instance is used: people, artifacts, publishes,
// storage, shared data, agent connections, opens and open reports, with daily trends. Aggregates
// only: nothing here names a page or a person. Everyone else gets "not found", like the API.
import { type AdminStats as AdminStatsData, API, APP_ROUTES } from "@plinth/shared";
import { useCallback, useEffect, useState } from "react";
import { StatGrid } from "../components/admin/StatGrid.tsx";
import { TrendChart } from "../components/admin/TrendChart.tsx";
import "../components/admin/admin.css";
import { AppShell } from "../components/layout/AppShell.tsx";
import { Button, EmptyState, SegmentedControl, SkeletonText } from "../components/ui/index.ts";
import { formatDate } from "../components/viewer/format.ts";
import { ApiRequestError, api, getAdminStats } from "../lib/api.ts";
import { navigate } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";
import NotFound from "./NotFound.tsx";

type Range = "7" | "30" | "90";

const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; stats: AdminStatsData };

export default function AdminStats() {
  const { me, loading } = useSession();

  useEffect(() => {
    document.title = "Stats · Plinth";
  }, []);

  const signOut = async () => {
    try {
      await api(API.logout, { method: "POST" });
    } finally {
      window.location.assign(APP_ROUTES.home);
    }
  };

  if (loading) return null;
  if (!me?.is_admin) return <NotFound />;

  return (
    <AppShell onSignOut={signOut} title="Stats">
      <StatsBody />
    </AppShell>
  );
}

function StatsBody() {
  const [range, setRange] = useState<Range>("30");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  const load = useCallback((days: Range, signal: AbortSignal) => {
    setState({ kind: "loading" });
    getAdminStats(Number(days) as 7 | 30 | 90, signal)
      .then((stats) => setState({ kind: "ok", stats }))
      .catch((e: unknown) => {
        if (signal.aborted) return;
        if (e instanceof ApiRequestError && e.status === 404) {
          // No longer an admin (ADMIN_EMAIL changed).
          navigate(APP_ROUTES.dashboard, { replace: true });
          return;
        }
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not load the stats.",
        });
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the retry trigger
  useEffect(() => {
    const ctrl = new AbortController();
    load(range, ctrl.signal);
    return () => ctrl.abort();
  }, [load, range, nonce]);

  return (
    <>
      <p className="pl-stats__lead">
        How this instance is used, as totals and per UTC day. Nothing here names a page or a person.
      </p>
      <div className="pl-stats__toolbar">
        <SegmentedControl
          label="Period"
          options={RANGES}
          value={range}
          onChange={setRange}
          size="sm"
        />
        {state.kind === "ok" && (
          <p className="pl-stats__generated">
            As of{" "}
            <time dateTime={state.stats.generated_at}>{formatDate(state.stats.generated_at)}</time>
          </p>
        )}
      </div>
      {state.kind === "loading" && (
        <div aria-busy="true" className="pl-stats">
          <span className="visually-hidden">Loading stats…</span>
          <SkeletonText lines={6} />
        </div>
      )}
      {state.kind === "error" && (
        <EmptyState
          title="Stats could not be loaded"
          description={state.message}
          action={<Button onClick={() => setNonce((n) => n + 1)}>Try again</Button>}
        />
      )}
      {state.kind === "ok" && <StatsView stats={state.stats} />}
    </>
  );
}

function StatsView({ stats }: { stats: AdminStatsData }) {
  const days = stats.series.map((d) => d.day);
  const pick = (f: (d: AdminStatsData["series"][number]) => number) => stats.series.map(f);
  return (
    <>
      <h2 className="visually-hidden">Totals</h2>
      <StatGrid stats={stats} />
      <h2 className="pl-stats__section-title">Per day, last {stats.days} days</h2>
      <div className="pl-stats__charts">
        <TrendChart
          title="Opens per day"
          unit={["open", "opens"]}
          days={days}
          series={[{ label: "Opens", values: pick((d) => d.views) }]}
        />
        <TrendChart
          title="Publishes per day"
          unit={["publish", "publishes"]}
          days={days}
          series={[
            { label: "By agents", values: pick((d) => d.agent_publishes) },
            {
              label: "By people",
              values: pick((d) => Math.max(0, d.publishes - d.agent_publishes)),
            },
          ]}
        />
        <TrendChart
          title="New people per day"
          unit={["person", "people"]}
          days={days}
          series={[{ label: "New people", values: pick((d) => d.users) }]}
        />
        <TrendChart
          title="New artifacts per day"
          unit={["artifact", "artifacts"]}
          days={days}
          series={[{ label: "New artifacts", values: pick((d) => d.artifacts) }]}
        />
      </div>
      <p className="pl-stats__footnote">
        An open is one browser opening a page it had not opened in the last 12 hours. Owners' own
        opens, previews, history, agents and admins reviewing are not counted. Days are UTC. Plinth
        keeps one number per page per day, never who opened it. These figures never name pages or
        people; reported pages are on Reports.
      </p>
    </>
  );
}
