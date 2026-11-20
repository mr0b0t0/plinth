// Page: /oauth/consent?request=<id>. An MCP client asked to act for the signed-in person. Shows
// who is asking (the name is the client's own claim), where the browser will return (the part a
// person can check), and what it may do, with one Allow button. The connection is named after the
// client ("Claude Code", or "Claude Code 2" when that name is taken); "Change name" edits the name
// and client type before allowing.
// The answer is POSTed with fetch and the browser then goes to `redirect_to` with location.href:
// the app CSP's form-action 'self' would block a form redirect to another origin.
import { ArrowRightIcon, CheckIcon, WarningIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  CLIENT_TYPES,
  type ClientType,
  type ConnectionInfo,
  LIMITS,
  type OAuthConsentResult,
  type OAuthRequestInfo,
  type Paged,
  route,
} from "@plinth/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import "../components/account/account.css";
import {
  CLIENT_TYPE_LABEL,
  defaultConnectionLabel,
  guessClientType,
  mentionReach,
  mentionReachText,
  SCOPE_META,
} from "../components/account/format.ts";
import { useDocumentTitle, useSignInRedirect } from "../components/account/hooks.tsx";
import { Note } from "../components/account/Note.tsx";
import { LogoMark } from "../components/Logo.tsx";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import {
  Button,
  ButtonLink,
  EmptyState,
  ICON_SIZE,
  Input,
  Select,
  Skeleton,
  Stack,
} from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; req: OAuthRequestInfo };

const isLoopback = (host: string) =>
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);

export default function Consent() {
  useDocumentTitle("Connect an agent");
  const { pending, redirect } = useSignInRedirect();
  const { me } = useSession();
  const { search } = useLocation();
  const requestId = search.get("request") ?? "";
  const [state, setState] = useState<State>({ status: "loading" });
  const [label, setLabel] = useState("");
  const [defaultLabel, setDefaultLabel] = useState("Agent");
  const [clientType, setClientType] = useState<ClientType>("other");
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [editing, setEditing] = useState(false);
  const editId = useId();
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (pending) return;
    if (!requestId) {
      setState({ status: "missing" });
      return;
    }
    const ctrl = new AbortController();
    // The existing connections only make the default name distinct and say which handle a name
    // becomes; without them the page is still usable.
    const live = api<Paged<ConnectionInfo>>(API.connections, { signal: ctrl.signal })
      .then((res) => res.items.filter((c) => !c.revoked_at))
      .catch(() => [] as ConnectionInfo[]);
    Promise.all([
      api<OAuthRequestInfo>(route(API.oauthRequest, { id: requestId }), { signal: ctrl.signal }),
      live,
    ])
      .then(([req, existing]) => {
        setConnections(existing);
        const taken = existing.map((c) => c.label);
        const name = defaultConnectionLabel(req.client_name, taken, LIMITS.maxLabelLength);
        setDefaultLabel(name);
        setLabel(name);
        setClientType(guessClientType(req.client_name));
        setState({ status: "ready", req });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiRequestError && e.status === 404) setState({ status: "missing" });
        else {
          setState({
            status: "error",
            message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
          });
        }
      });
    return () => ctrl.abort();
  }, [pending, requestId]);

  if (redirect) return redirect;

  const decide = async (approve: boolean) => {
    if (state.status !== "ready" || submitting) return;
    const name = label.trim() || defaultLabel;
    setSubmitting(approve ? "allow" : "deny");
    setSubmitError(null);
    try {
      const res = await api<OAuthConsentResult>(API.oauthConsent, {
        method: "POST",
        body: {
          request_id: state.req.id,
          label: name,
          client_type: clientType,
          approve,
        },
      });
      window.location.href = res.redirect_to;
    } catch (e) {
      setSubmitting(null);
      if (e instanceof ApiRequestError && e.status === 404) setState({ status: "missing" });
      else setSubmitError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth.");
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void decide(true);
  };

  return (
    <PublicShell width="narrow">
      <div className="pl-acct-consent">
        {pending || state.status === "loading" ? (
          <div aria-busy="true" className="pl-acct-consent__loading">
            <span className="visually-hidden">Loading the request</span>
            <Skeleton width="70%" height="2.25rem" />
            <Skeleton height="5rem" />
            <Skeleton height="8rem" />
          </div>
        ) : state.status === "missing" ? (
          <EmptyState
            headingLevel={1}
            title="This request has expired"
            description="The connection request is unknown, was already answered, or waited too long. Start connecting again from your agent."
            action={
              <ButtonLink to={APP_ROUTES.connections} variant="primary">
                Go to connections
              </ButtonLink>
            }
          />
        ) : state.status === "error" ? (
          <EmptyState
            art={null}
            headingLevel={1}
            title="Could not load the request"
            description={state.message}
            action={<Button onClick={() => window.location.reload()}>Try again</Button>}
          />
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <Stack gap={6}>
              <div className="pl-acct-consent__head">
                <div className="pl-acct-consent__marks" aria-hidden="true">
                  <span className="pl-acct-consent__agent">
                    {(state.req.client_name ?? "?").trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <ArrowRightIcon size={ICON_SIZE.md} />
                  <LogoMark size={40} />
                </div>
                <h1 className="type-title">
                  Connect{" "}
                  <span className="pl-acct-consent__client">
                    {state.req.client_name ?? "an unnamed application"}
                  </span>{" "}
                  to Plinth?
                </h1>
                <p className="text-muted">
                  It will act as <strong className="pl-acct-consent__me">{me?.email}</strong>. The
                  name above is chosen by the application itself; check where you will be sent back.
                </p>
              </div>

              <div className="pl-acct-consent__dest">
                <span className="pl-acct-consent__dest-label">After you answer, you return to</span>
                <span className="pl-acct-consent__host">{state.req.redirect_host}</span>
                {isLoopback(state.req.redirect_host) && (
                  <span className="type-small text-muted">
                    This is your own computer, as used by desktop and command-line agents.
                  </span>
                )}
              </div>

              <div>
                <h2 className="type-subhead">It will be able to</h2>
                <ul className="pl-acct-consent__scopes">
                  {state.req.scopes.map((s) => {
                    const meta = (
                      SCOPE_META as Record<
                        string,
                        { label: string; description: string } | undefined
                      >
                    )[s];
                    return (
                      <li key={s}>
                        <CheckIcon size={ICON_SIZE.sm} aria-hidden="true" />
                        <span>
                          <span className="pl-acct-consent__scope-label">{meta?.label ?? s}</span>
                          {meta && (
                            <span className="pl-acct-consent__scope-desc">{meta.description}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="pl-acct-consent__name">
                <p>
                  <span className="pl-acct-consent__dest-label">Saved as</span>{" "}
                  <strong className="pl-acct-consent__label">{label.trim() || defaultLabel}</strong>
                  <span className="text-muted">
                    {" "}
                    ·{" "}
                    {clientType === "other"
                      ? "Other client"
                      : `${CLIENT_TYPE_LABEL[clientType]} client`}
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={editing}
                  aria-controls={editId}
                  onClick={() => setEditing((v) => !v)}
                >
                  Change name
                </Button>
              </div>
              {editing && (
                <div id={editId} className="pl-acct-form">
                  <Input
                    label="Name this connection"
                    hint={[
                      "Shown on your Connections page and next to what it publishes.",
                      mentionReachText(
                        mentionReach(label.trim() || defaultLabel, connections, {
                          client_type: clientType,
                          // The grant holds exactly what the client asked for.
                          scopes: state.req.scopes,
                        }),
                      ),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    value={label}
                    maxLength={LIMITS.maxLabelLength}
                    placeholder={defaultLabel}
                    onChange={(e) => setLabel(e.target.value)}
                    autoComplete="off"
                  />
                  <Select
                    label="Client"
                    value={clientType}
                    onChange={(e) => setClientType(e.target.value as ClientType)}
                    options={CLIENT_TYPES.map((t) => ({ value: t, label: CLIENT_TYPE_LABEL[t] }))}
                    hint="Mentions of @claude or @codex in comments go to connections of that kind."
                  />
                </div>
              )}

              <Note tone="warning">
                Only allow agents you started yourself. You can revoke this connection at any time
                on the Connections page.
              </Note>

              {submitError && (
                <p className="pl-field__error" role="alert">
                  <WarningIcon size={ICON_SIZE.sm} aria-hidden="true" />
                  <span>{submitError}</span>
                </p>
              )}

              <div className="pl-acct-consent__actions">
                <Button
                  variant="secondary"
                  size="lg"
                  loading={submitting === "deny"}
                  disabled={submitting === "allow"}
                  onClick={() => void decide(false)}
                >
                  Deny
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={submitting === "allow"}
                  disabled={submitting === "deny"}
                >
                  Allow
                </Button>
              </div>
            </Stack>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
