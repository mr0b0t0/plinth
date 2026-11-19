// Page: /stats. The signed-in person's own artifacts with their opens over 7 and 30 days, viewers
// over 30 days and the last open, sortable by any column. Each row links to that artifact's stats.
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import {
  APP_ROUTES,
  type ArtifactStatsSummary,
  type ArtifactStatsSummaryItem,
  route,
} from "@plinth/shared";
import { useEffect, useMemo, useState } from "react";
import "../components/account/account.css";
import { useDocumentTitle, useSignInRedirect, useSignOut } from "../components/account/hooks.tsx";
import { Note } from "../components/account/Note.tsx";
import { formatCount } from "../components/admin/StatGrid.tsx";
import "../components/admin/admin.css";
import { AppShell } from "../components/layout/AppShell.tsx";
import "../components/stats/stats.css";
import { Button, ButtonLink, EmptyState, SkeletonText } from "../components/ui/index.ts";
import { formatDate } from "../components/viewer/format.ts";
import { ApiRequestError, getStatsSummary } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: ArtifactStatsSummary };

export type SortKey = "title" | "opens_7d" | "opens_30d" | "viewers_30d" | "last_opened_at";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "title", label: "Artifact", numeric: false },
  { key: "opens_7d", label: "Opens, 7 days", numeric: true },
  { key: "opens_30d", label: "Opens, 30 days", numeric: true },
  { key: "viewers_30d", label: "Viewers, 30 days", numeric: true },
  { key: "last_opened_at", label: "Last opened", numeric: false },
];

/** Sort a copy of the rows. Never-opened rows go last whichever way "Last opened" sorts. */
export function sortItems(
  items: ArtifactStatsSummaryItem[],
  sort: Sort,
): ArtifactStatsSummaryItem[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (sort.key === "title") {
      return sign * a.title.localeCompare(b.title, "en", { sensitivity: "base" });
    }
    if (sort.key === "last_opened_at") {
      const x = a.last_opened_at;
      const y = b.last_opened_at;
      if (x === y) return a.title.localeCompare(b.title, "en", { sensitivity: "base" });
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * (x < y ? -1 : 1);
    }
    const diff = a[sort.key] - b[sort.key];
    return diff !== 0 ? sign * diff : a.title.localeCompare(b.title, "en", { sensitivity: "base" });
  });
}

export default function Stats() {
  const { pending, redirect } = useSignInRedirect();
  const signOut = useSignOut();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [sort, setSort] = useState<Sort>({ key: "last_opened_at", dir: "desc" });

  useDocumentTitle("Stats");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    getStatsSummary(ctrl.signal)
      .then((summary) => setState({ status: "ready", summary }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      });
    return () => ctrl.abort();
  }, [pending, reload]);

  const rows = useMemo(
    () => (state.status === "ready" ? sortItems(state.summary.items, sort) : []),
    [state, sort],
  );

  if (redirect) return redirect;

  const choose = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "title" ? "asc" : "desc" },
    );

  return (
    <AppShell onSignOut={signOut} title="Stats">
      {pending || state.status === "loading" ? (
        <div aria-busy="true" className="pl-stats">
          <span className="visually-hidden">Loading stats</span>
          <SkeletonText lines={6} />
        </div>
      ) : state.status === "error" ? (
        <EmptyState
          art={null}
          headingLevel={2}
          title="Could not load the stats"
          description={state.message}
          action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        />
      ) : state.summary.items.length === 0 ? (
        <EmptyState
          headingLevel={2}
          title="No artifacts yet"
          description="Once you publish an artifact and share it, you will see here who opened it."
          action={
            <ButtonLink to={APP_ROUTES.dashboard} variant="primary">
              Go to dashboard
            </ButtonLink>
          }
        />
      ) : (
        <>
          <div className="pl-ostats__toolbar">
            <p className="pl-ostats__lead">
              How often your artifacts were opened by other people. Open one to see who.
            </p>
          </div>
          {!state.summary.enabled && (
            <Note className="pl-ostats__note">
              This instance does not record opens (VIEW_COUNTS is off), so nothing new is added
              here.
            </Note>
          )}
          <div className="pl-table-wrap">
            <table className="pl-table">
              <caption className="visually-hidden">
                Your artifacts and how often they were opened
              </caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key;
                    const Caret = sort.dir === "asc" ? CaretUpIcon : CaretDownIcon;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        className={c.numeric ? "pl-table__num" : undefined}
                        aria-sort={
                          active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                        }
                      >
                        <button
                          type="button"
                          className="pl-table__sort"
                          onClick={() => choose(c.key)}
                        >
                          {c.label}
                          {active && <Caret size={12} aria-hidden="true" />}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <th scope="row" className="pl-table__main">
                      <Link to={route(APP_ROUTES.artifactStats, { slug: a.slug })}>{a.title}</Link>
                    </th>
                    <td className="pl-table__num">{formatCount(a.opens_7d)}</td>
                    <td className="pl-table__num">{formatCount(a.opens_30d)}</td>
                    <td className="pl-table__num">{formatCount(a.viewers_30d)}</td>
                    <td>
                      {a.last_opened_at ? (
                        <time dateTime={a.last_opened_at}>{formatDate(a.last_opened_at)}</time>
                      ) : (
                        <span className="text-muted">Never</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pl-stats__footnote">
            Counts opens by people other than you, once per browser every 12 hours. Viewers are the
            people who opened it plus anonymous visitors, one per browser. Opens are kept with who
            made them for {formatCount(state.summary.retention_days)} days.
          </p>
        </>
      )}
    </AppShell>
  );
}
