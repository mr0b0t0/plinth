// Page: /p/:id. A collection someone shared with you through a category (docs/spec.md "Category
// sharing and personal categories"): its title, who shared it, and the artifacts the owner chose to
// show, each opening on its own page. Someone not yet known confirms their email by a one-time code
// first, as on a private artifact; that one confirmation then opens every artifact listed here.
import { FolderSimpleIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type PortalGate, route } from "@plinth/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelativeShort } from "../components/account/format.ts";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, ICON_SIZE, Input, Spinner, Stack } from "../components/ui/index.ts";
import { gateErrorMessage } from "../components/viewer/gate.ts";
import "../components/viewer/viewer.css";
import { ApiRequestError, api } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { refreshSession } from "../lib/session.ts";
import NotFound from "./NotFound.tsx";

type State =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "gate"; gate: PortalGate };

export function PortalEmailForm({
  id,
  onGate,
}: {
  id: string;
  onGate: (gate: PortalGate) => void;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const askCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(route(API.portalEmail, { id }), {
        method: "POST",
        body: { email: email.trim() },
      });
      setStep("code");
      setCode("");
    } catch (err) {
      setError(gateErrorMessage(err, "email"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the six digits from the email.");
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const gate = await api<PortalGate>(route(API.portalCode, { id }), {
        method: "POST",
        body: { email: email.trim(), code: code.trim() },
      });
      if (gate.status !== "ok") {
        setError("That code did not work. Check it, or ask for a new one.");
        return;
      }
      await refreshSession().catch(() => {});
      onGate(gate);
    } catch (err) {
      setError(gateErrorMessage(err, "code"));
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={confirm} noValidate>
        <Stack gap={4}>
          <p className="pl-gate__sent" role="status">
            If this address has access, we sent a code to <strong>{email.trim()}</strong>. It
            expires in 15 minutes.
          </p>
          <Input
            ref={codeRef}
            label="Six-digit code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            mono
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            error={error ?? undefined}
            autoFocus
          />
          <Button type="submit" variant="primary" loading={busy} block>
            Confirm code
          </Button>
          <div className="pl-gate__links">
            <button type="button" className="pl-gate__link" onClick={() => void askCode()}>
              Send a new code
            </button>
            <button
              type="button"
              className="pl-gate__link"
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </div>
        </Stack>
      </form>
    );
  }

  return (
    <form onSubmit={askCode} noValidate>
      <Stack gap={4}>
        <Input
          ref={emailRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <Button type="submit" variant="primary" loading={busy} block>
          Send code
        </Button>
      </Stack>
    </form>
  );
}

export default function Portal({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const [state, setState] = useState<State>({ status: "loading" });
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const ctrl = new AbortController();
    api<PortalGate>(route(API.portal, { id }), { signal: ctrl.signal })
      .then((gate) => setState({ status: "gate", gate }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiRequestError && e.status === 404) setState({ status: "not_found" });
        else
          setState({
            status: "error",
            message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
          });
      });
    return () => ctrl.abort();
  }, [id]);

  const title =
    state.status === "gate" && state.gate.status === "ok" ? state.gate.portal.title : null;
  useEffect(() => {
    document.title = title ? `${title} · Plinth` : "Shared collection · Plinth";
  }, [title]);

  if (state.status === "not_found") return <NotFound />;
  if (state.status === "loading") {
    return (
      <PublicShell centered>
        <Spinner size={20} label="Loading" />
      </PublicShell>
    );
  }
  if (state.status === "error") {
    return (
      <PublicShell centered width="reading">
        <section className="pl-gate pl-gate--notice" aria-labelledby="portal-title">
          <h1 id="portal-title" className="pl-gate__title">
            Could not load this collection
          </h1>
          <p className="pl-gate__lead">{state.message}</p>
        </section>
      </PublicShell>
    );
  }

  const gate = state.gate;
  if (gate.status === "email_required") {
    return (
      <PublicShell centered>
        <section className="pl-gate" aria-labelledby="portal-title">
          <FolderSimpleIcon size={ICON_SIZE.xl} aria-hidden="true" className="pl-gate__icon" />
          <p className="pl-gate__eyebrow">Shared collection</p>
          <h1 id="portal-title" className="pl-gate__title">
            Confirm your email
          </h1>
          <p className="pl-gate__lead">
            Only the people this collection is shared with can open it. Confirm your email address
            with a one-time code. You do not need an account.
          </p>
          <PortalEmailForm id={id} onGate={(g) => setState({ status: "gate", gate: g })} />
        </section>
      </PublicShell>
    );
  }

  return (
    <PublicShell width="content">
      <section className="pl-portal" aria-labelledby="portal-title">
        <header className="pl-portal__head">
          <h1 id="portal-title" className="pl-portal__title">
            {gate.portal.title}
          </h1>
          {gate.portal.role === "owner" ? (
            <p className="text-muted">Preview</p>
          ) : (
            gate.portal.owner_name && (
              <p className="text-muted">Shared by {gate.portal.owner_name}</p>
            )
          )}
        </header>
        {gate.items.length === 0 ? (
          <p className="pl-portal__empty">Nothing here yet.</p>
        ) : (
          <ul className="pl-portal__items">
            {gate.items.map((a) => (
              <li key={a.id} className="pl-portal__item">
                <span className="pl-portal__thumb" aria-hidden="true">
                  {a.thumbnail_url && (
                    <img
                      src={a.thumbnail_url}
                      alt=""
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </span>
                <Link to={route(APP_ROUTES.artifact, { slug: a.slug })} className="pl-portal__link">
                  <span className="pl-portal__item-title">{a.title}</span>
                </Link>
                <span className="pl-portal__meta text-muted" title={formatDateTime(a.updated_at)}>
                  Updated{" "}
                  <time dateTime={a.updated_at}>{formatRelativeShort(a.updated_at, now)}</time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PublicShell>
  );
}
