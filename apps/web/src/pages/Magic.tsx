// Page: /login/magic?token=. The link from the sign-in email. Opening it never signs anyone in:
// email scanners prefetch links, so the token is only spent when the person presses "Sign in".
import { SignInIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES } from "@plinth/shared";
import { useState } from "react";
import "../components/account/account.css";
import { useDocumentTitle } from "../components/account/hooks.tsx";
import { safeNext } from "../components/account/nav.ts";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, ButtonLink, Stack } from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { navigate, useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

export default function Magic() {
  useDocumentTitle("Finish signing in");
  const { search } = useLocation();
  const { me, refresh } = useSession();
  const token = search.get("token") ?? "";
  const next = safeNext(search.get("next"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignIn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(API.loginVerifyLink, { method: "POST", body: { token } });
      await refresh();
      navigate(next, { replace: true });
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiRequestError && e.code === "rate_limited") setError(e.message);
      else if (e instanceof ApiRequestError && e.status < 500) {
        setError("This link has expired or was already used. Request a new one to sign in.");
      } else setError("Could not reach Plinth. Check your connection and try again.");
    }
  };

  const missing = token.length < 10;

  return (
    <PublicShell centered>
      <div className="pl-acct-auth">
        <Stack gap={6}>
          {missing ? (
            <>
              <Stack gap={3}>
                <h1 className="type-title">This link is incomplete</h1>
                <p className="type-lead">
                  Part of the sign-in link is missing. Copy the whole link from the email, or
                  request a new one.
                </p>
              </Stack>
              <ButtonLink to={APP_ROUTES.login} variant="primary" size="lg" block>
                Request a new link
              </ButtonLink>
            </>
          ) : (
            <>
              <Stack gap={3}>
                <h1 className="type-title">Finish signing in</h1>
                <p className="type-lead">
                  Press the button to sign in on this device. The link works once.
                </p>
                {me && (
                  <p className="type-small text-muted">
                    You are signed in as {me.email}. Signing in again switches to the account this
                    link was sent to.
                  </p>
                )}
              </Stack>
              <Button
                variant="primary"
                size="lg"
                block
                icon={SignInIcon}
                loading={busy}
                onClick={onSignIn}
              >
                Sign in
              </Button>
              {error && (
                <div className="pl-acct-error" role="alert">
                  <p>{error}</p>
                  <ButtonLink to={APP_ROUTES.login} variant="secondary">
                    Request a new link
                  </ButtonLink>
                </div>
              )}
            </>
          )}
        </Stack>
      </div>
    </PublicShell>
  );
}
