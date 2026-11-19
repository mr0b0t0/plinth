// Page: /login/review?next=. Password sign-in for the one review account an operator may configure
// (REVIEW_LOGIN_EMAIL and REVIEW_LOGIN_PASSWORD_HASH), for a directory's reviewers, who cannot
// receive a sign-in email. The Worker answers this path with a 404 unless it is configured, and the
// regular sign-in page links here only then. After signing in it continues to `next`, so an OAuth
// consent request carries on as after any other sign-in.
import { SignInIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES } from "@plinth/shared";
import { type FormEvent, useState } from "react";
import "../components/account/account.css";
import { useDocumentTitle } from "../components/account/hooks.tsx";
import { loginHref, safeNext } from "../components/account/nav.ts";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, Input, Stack } from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.code === "rate_limited" || e.code === "invalid_input") return e.message;
    if (e.status === 404) return "This sign-in is not available on this instance.";
    if (e.status >= 500) return "Something went wrong on our side. Try again in a moment.";
    return e.message || "Could not sign in.";
  }
  return "Could not reach Plinth. Check your connection and try again.";
}

export default function ReviewLogin() {
  useDocumentTitle("Review account sign-in");
  const { refresh } = useSession();
  const { search } = useLocation();
  const next = safeNext(search.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Enter the review account's email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(API.loginReview, { method: "POST", body: { email: email.trim(), password } });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setBusy(false);
      setPassword("");
      setError(errorText(err));
    }
  };

  const regular = loginHref(next === APP_ROUTES.dashboard ? undefined : next);

  return (
    <PublicShell centered>
      <div className="pl-acct-auth">
        <Stack gap={6}>
          <Stack gap={3}>
            <h1 className="type-title">Review account sign-in</h1>
            <p className="type-lead">
              For the review account this instance's operator set up. Everyone else signs in with an
              emailed link.
            </p>
          </Stack>
          <form className="pl-acct-form" onSubmit={onSubmit} noValidate>
            <Input
              label="Email"
              type="email"
              name="username"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
            />
            <Input
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              error={error ?? undefined}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              icon={SignInIcon}
              loading={busy}
            >
              Sign in
            </Button>
          </form>
          <p className="type-small text-muted">
            Not the review account? <Link to={regular}>Sign in with an emailed link</Link>.
          </p>
        </Stack>
      </div>
    </PublicShell>
  );
}
