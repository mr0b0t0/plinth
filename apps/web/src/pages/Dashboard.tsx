// Page: /dashboard. The signed-in person's artifacts and the ones shared with them, with search
// (kept in ?q=) and the artifact quota.
import { PlugIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type ArtifactSummary, type Paged } from "@plinth/shared";
import { useEffect, useState } from "react";
import "../components/account/account.css";
import { ArtifactRow, ArtifactRowSkeleton } from "../components/account/ArtifactRow.tsx";
import { CopyField } from "../components/account/CopyField.tsx";
import { mcpUrl, quotaText } from "../components/account/format.ts";
import {
  useDebouncedValue,
  useDocumentTitle,
  useSignInRedirect,
  useSignOut,
} from "../components/account/hooks.tsx";
import { AppShell } from "../components/layout/AppShell.tsx";
import {
  Button,
  ButtonLink,
  EmptyState,
  Input,
  PageHeader,
  Spinner,
} from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ArtifactSummary[]; query: string };

export default function Dashboard() {
  useDocumentTitle("Dashboard");
  const { pending, redirect } = useSignInRedirect();
  const { me, config, refresh } = useSession();
  const signOut = useSignOut();
  const { search } = useLocation();
  const [query, setQuery] = useState(() => search.get("q") ?? "");
  const settled = useDebouncedValue(query.trim(), 250);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // The quota count may have changed since the session loaded (publishes, deletes).
  useEffect(() => {
    if (!pending) refresh().catch(() => undefined);
  }, [pending, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    setBusy(true);
    const path = settled ? `${API.artifacts}?query=${encodeURIComponent(settled)}` : API.artifacts;
    api<Paged<ArtifactSummary>>(path, { signal: ctrl.signal })
      .then((res) => {
        setList({ status: "ready", items: res.items, query: settled });
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setList({
          status: "error",
          message:
            e instanceof ApiRequestError
              ? e.message
              : "Could not reach Plinth. Check your connection and try again.",
        });
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    // Keep the search in the address bar (replace, so typing does not fill the history).
    const want = settled
      ? `${APP_ROUTES.dashboard}?q=${encodeURIComponent(settled)}`
      : APP_ROUTES.dashboard;
    if (window.location.pathname + window.location.search !== want) {
      window.history.replaceState(null, "", want);
    }
    return () => ctrl.abort();
  }, [settled, pending, reload]);

  if (redirect) return redirect;

  const items = list.status === "ready" ? list.items : [];
  const own = items.filter((a) => a.role === "owner");
  const shared = items.filter((a) => a.role !== "owner");
  const searching = list.status === "ready" && list.query !== "";
  const nothingYet = list.status === "ready" && !searching && items.length === 0;

  return (
    <AppShell onSignOut={signOut}>
      <PageHeader
        title="Artifacts"
        meta={
          me ? (
            <span className="pl-acct-quota">{quotaText(me.artifact_count, me.artifact_limit)}</span>
          ) : null
        }
        actions={
          nothingYet ? undefined : (
            <ButtonLink to={APP_ROUTES.connections} icon={PlugIcon}>
              Connect an agent
            </ButtonLink>
          )
        }
      />

      {!nothingYet && (
        <search className="pl-acct-search">
          <Input
            label="Search artifacts"
            hideLabel
            type="search"
            placeholder="Search by title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="pl-acct-search__status" role="status">
            {busy && list.status === "ready" ? (
              <Spinner size={16} label="Searching" />
            ) : searching ? (
              `${items.length} ${items.length === 1 ? "match" : "matches"}`
            ) : null}
          </span>
        </search>
      )}

      {pending || list.status === "loading" ? (
        <div aria-busy="true">
          <span className="visually-hidden">Loading artifacts</span>
          <ul className="pl-acct-list">
            <ArtifactRowSkeleton />
            <ArtifactRowSkeleton />
            <ArtifactRowSkeleton />
          </ul>
        </div>
      ) : list.status === "error" ? (
        <EmptyState
          art={null}
          title="Could not load your artifacts"
          description={list.message}
          action={
            <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : nothingYet ? (
        <EmptyState
          size="lg"
          title="Nothing on display yet"
          description={
            <div className="pl-acct-empty">
              <p>
                Connect an agent, then ask it to publish something. Whatever it publishes stands
                here, and you decide who can see it.
              </p>
              <CopyField
                label="MCP server URL"
                value={mcpUrl(config?.app_origin)}
                copyLabel="Copy MCP server URL"
                copiedMessage="MCP server URL copied"
              />
            </div>
          }
          action={
            <ButtonLink to={APP_ROUTES.connections} variant="primary" icon={PlugIcon}>
              Connect an agent
            </ButtonLink>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          art={null}
          title={`Nothing matches “${list.query}”`}
          description="Try another word from the title."
          action={<Button onClick={() => setQuery("")}>Clear search</Button>}
        />
      ) : (
        <div className="pl-acct-groups" aria-busy={busy || undefined}>
          <section aria-labelledby="dash-own">
            <h2 id="dash-own" className="pl-acct-group__title">
              Yours <span className="pl-acct-group__count">{own.length}</span>
            </h2>
            {own.length > 0 ? (
              <ul className="pl-acct-list">
                {own.map((a) => (
                  <ArtifactRow key={a.id} artifact={a} now={now} />
                ))}
              </ul>
            ) : (
              <p className="pl-acct-group__empty">
                {searching
                  ? "None of your artifacts match."
                  : "You have not published anything yet."}
              </p>
            )}
          </section>
          {shared.length > 0 && (
            <section aria-labelledby="dash-shared">
              <h2 id="dash-shared" className="pl-acct-group__title">
                Shared with you <span className="pl-acct-group__count">{shared.length}</span>
              </h2>
              <ul className="pl-acct-list">
                {shared.map((a) => (
                  <ArtifactRow key={a.id} artifact={a} now={now} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
