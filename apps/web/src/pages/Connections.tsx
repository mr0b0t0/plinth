// Page: /connections (?connect=1 opens the Connect panel). The agents (OAuth connections and
// personal access tokens) that can act for the signed-in person: connect a new one, rename,
// revoke. While the Connect panel is open the list refreshes itself, so a newly approved agent
// shows up with a first prompt to try. Tokens sit under Advanced, for scripts and CI.
import { PlugIcon, PlusIcon } from "@phosphor-icons/react";
import { API, type ConnectionInfo, type Paged } from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
import "../components/account/account.css";
import { ConnectionItem } from "../components/account/ConnectionItem.tsx";
import { ConnectPanel } from "../components/account/ConnectPanel.tsx";
import { mcpUrl } from "../components/account/format.ts";
import { useDocumentTitle, useSignInRedirect, useSignOut } from "../components/account/hooks.tsx";
import { NewTokenDialog } from "../components/account/NewTokenDialog.tsx";
import { useConnectionPoll } from "../components/account/useConnectionPoll.ts";
import { AppShell } from "../components/layout/AppShell.tsx";
import { focusElement } from "../components/ui/focus.ts";
import { Button, EmptyState, Skeleton } from "../components/ui/index.ts";
import { publishAgents } from "../lib/agents.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: ConnectionInfo[] };

export default function Connections() {
  useDocumentTitle("Connections");
  const { pending, redirect } = useSignInRedirect();
  const { config, me } = useSession();
  const signOut = useSignOut();
  const [state, setState] = useState<State>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const { search } = useLocation();
  // null until the list loads: then open when nothing is connected yet.
  const [panelOpen, setPanelOpen] = useState<boolean | null>(
    search.get("connect") !== null ? true : null,
  );
  const [connected, setConnected] = useState<ConnectionInfo | null>(null);
  const [focusPanel, setFocusPanel] = useState(0);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  // Connections that existed when the panel opened; anything else is new.
  const known = useRef<Set<string> | null>(null);

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

  const ready = state.status === "ready";
  // Keep the sidebar's agent list in step with this page.
  useEffect(() => {
    if (me && state.status === "ready") publishAgents(me.id, state.items);
  }, [me, state]);
  useEffect(() => {
    if (panelOpen !== null || state.status !== "ready") return;
    setPanelOpen(!state.items.some((c) => !c.revoked_at));
  }, [panelOpen, state]);

  useEffect(() => {
    if (!panelOpen) {
      known.current = null;
      return;
    }
    if (state.status === "ready" && known.current === null) {
      known.current = new Set(state.items.map((c) => c.id));
    }
  }, [panelOpen, state]);

  useEffect(() => {
    if (!focusPanel) return;
    const h = panelHeading.current;
    h?.scrollIntoView?.({ block: "start" });
    focusElement(h);
  }, [focusPanel]);

  useConnectionPoll(!!panelOpen && ready && !connected, (fresh) => {
    setState({ status: "ready", items: fresh });
    setNow(Date.now());
    const seen = known.current;
    if (!seen) return;
    const added = fresh.find((c) => c.kind === "oauth" && !c.revoked_at && !seen.has(c.id));
    if (added) setConnected(added);
  });

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
  const openPanel = () => {
    setPanelOpen(true);
    setFocusPanel((n) => n + 1);
  };
  const connectAnother = () => {
    known.current = new Set(items.map((c) => c.id));
    setConnected(null);
  };

  return (
    <AppShell
      onSignOut={signOut}
      title="Connections"
      actions={
        <Button variant="primary" icon={PlugIcon} onClick={openPanel}>
          Connect an agent
        </Button>
      }
    >
      <p className="pl-acct-lead">
        Agents that can publish and answer comments as you. Each one has its own access and can be
        revoked on its own.
      </p>

      <div className="pl-acct-stack">
        {panelOpen && (
          <ConnectPanel
            endpoint={mcpUrl(config?.app_origin)}
            connected={connected}
            onConnectAnother={connectAnother}
            onHide={() => {
              setPanelOpen(false);
              setConnected(null);
            }}
            headingRef={panelHeading}
          />
        )}

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
                      <Skeleton width="10rem" height="0.75rem" />
                      <Skeleton width="16rem" height="0.625rem" />
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
              No agent is connected yet. Pick yours under “Connect an agent” and follow the steps.
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

        <details className="pl-acct-advanced">
          <summary>Advanced: personal access tokens for scripts and CI</summary>
          <div className="pl-acct-advanced__body">
            <p className="text-muted">
              For scripts, CI and clients that cannot sign in with OAuth. A token is shown once and
              is sent as <code>Authorization: Bearer …</code>. The agents above do not need one.
            </p>
            <Button icon={PlusIcon} onClick={() => setCreating(true)}>
              New token
            </Button>
          </div>
        </details>
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
