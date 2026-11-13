// Page: /connections. The agents (OAuth connections and personal access tokens) that can act for
// the signed-in person: create tokens, rename, revoke; plus how to connect a new one.
import { PlusIcon } from "@phosphor-icons/react";
import { API, type ConnectionInfo, type Paged } from "@plinth/shared";
import { useEffect, useState } from "react";
import "../components/account/account.css";
import { ConnectionItem } from "../components/account/ConnectionItem.tsx";
import { mcpUrl } from "../components/account/format.ts";
import { HowToConnect } from "../components/account/HowToConnect.tsx";
import { useDocumentTitle, useSignInRedirect, useSignOut } from "../components/account/hooks.tsx";
import { NewTokenDialog } from "../components/account/NewTokenDialog.tsx";
import { AppShell } from "../components/layout/AppShell.tsx";
import { Button, EmptyState, PageHeader, Skeleton } from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useSession } from "../lib/session.ts";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ConnectionInfo[] };

export default function Connections() {
  useDocumentTitle("Connections");
  const { pending, redirect } = useSignInRedirect();
  const { config } = useSession();
  const signOut = useSignOut();
  const [state, setState] = useState<State>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    api<Paged<ConnectionInfo>>(API.connections, { signal: ctrl.signal })
      .then((res) => {
        setState({ status: "ready", items: res.items });
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      });
    return () => ctrl.abort();
  }, [pending, reload]);

  if (redirect) return redirect;

  const items = state.status === "ready" ? state.items : [];
  const active = items.filter((c) => !c.revoked_at);
  const revoked = items.filter((c) => c.revoked_at);
  const update = (next: ConnectionInfo) =>
    setState((s) =>
      s.status === "ready"
        ? { status: "ready", items: s.items.map((c) => (c.id === next.id ? next : c)) }
        : s,
    );

  return (
    <AppShell onSignOut={signOut}>
      <PageHeader
        title="Connections"
        description="Agents that can publish and answer comments as you. Each one has its own access and can be revoked on its own."
        actions={
          <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>
            New token
          </Button>
        }
      />

      <div className="pl-acct-stack">
        <section className="pl-acct-section" aria-labelledby="conn-active">
          <h2 id="conn-active" className="pl-acct-group__title">
            Connected agents
            {state.status === "ready" && (
              <span className="pl-acct-group__count">{active.length}</span>
            )}
          </h2>
          {pending || state.status === "loading" ? (
            <div aria-busy="true">
              <span className="visually-hidden">Loading connections</span>
              <ul className="pl-acct-list">
                {[0, 1].map((i) => (
                  <li key={i} className="pl-acct-conn" aria-hidden="true">
                    <div className="pl-acct-conn__main">
                      <Skeleton width="12rem" height="1.25rem" />
                      <Skeleton width="18rem" height="0.875rem" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : state.status === "error" ? (
            <EmptyState
              art={null}
              headingLevel={3}
              title="Could not load your connections"
              description={state.message}
              action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}
            />
          ) : active.length === 0 ? (
            <p className="pl-acct-group__empty">
              No agent is connected yet. Connect Claude with the steps below, or create a token for
              Codex and other clients.
            </p>
          ) : (
            <ul className="pl-acct-list">
              {active.map((c) => (
                <ConnectionItem key={c.id} connection={c} now={now} onChanged={update} />
              ))}
            </ul>
          )}
        </section>

        {revoked.length > 0 && (
          <section className="pl-acct-section" aria-labelledby="conn-revoked">
            <h2 id="conn-revoked" className="pl-acct-group__title">
              Revoked <span className="pl-acct-group__count">{revoked.length}</span>
            </h2>
            <ul className="pl-acct-list">
              {revoked.map((c) => (
                <ConnectionItem key={c.id} connection={c} now={now} onChanged={update} />
              ))}
            </ul>
          </section>
        )}

        <HowToConnect endpoint={mcpUrl(config?.app_origin)} />
      </div>

      <NewTokenDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setState((s) =>
            s.status === "ready" ? { status: "ready", items: [created.connection, ...s.items] } : s,
          );
        }}
      />
    </AppShell>
  );
}
