// Page: /invitation-emails. Invitation emails' footer and List-Unsubscribe header point here
// (docs/spec.md "Invitation emails"). After the usual sign-in, the person turns invitation emails
// to their own address off, or back on. The URL carries no token and no address: the Worker acts
// on the signed-in person's own address only.
import { API, type InvitationEmailSettings } from "@plinth/shared";
import { type ReactNode, useEffect, useState } from "react";
import { useDocumentTitle, useSignInRedirect } from "../components/account/hooks.tsx";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, EmptyState, PageHeader, SkeletonText, Stack } from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: InvitationEmailSettings };

const errMsg = (e: unknown) =>
  e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.";

export default function InvitationEmails() {
  useDocumentTitle("Invitation emails");
  const { pending, redirect } = useSignInRedirect();
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch (Try again)
  useEffect(() => {
    if (pending) return;
    const ctrl = new AbortController();
    api<InvitationEmailSettings>(API.invitationEmails, { signal: ctrl.signal })
      .then((settings) => setState({ status: "ready", settings }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ status: "error", message: errMsg(e) });
      });
    return () => ctrl.abort();
  }, [pending, reload]);

  if (redirect) return redirect;

  const change = async (receive: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const settings = await api<InvitationEmailSettings>(API.invitationEmails, {
        method: "PUT",
        body: { receive },
      });
      setState({ status: "ready", settings });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <div aria-busy="true">
        <SkeletonText lines={2} />
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <EmptyState
        art={null}
        title="Could not load your settings"
        description={state.message}
        action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}
      />
    );
  } else {
    const { email, receive } = state.settings;
    body = (
      <Stack gap={4}>
        <p role="status">
          Invitation emails to <strong>{email}</strong> are {receive ? "on" : "off"}.
        </p>
        {error && (
          <p className="text-danger" role="alert">
            {error}
          </p>
        )}
        <div>
          {receive ? (
            <Button variant="primary" loading={busy} onClick={() => change(false)}>
              Stop these emails
            </Button>
          ) : (
            <Button loading={busy} onClick={() => change(true)}>
              Turn them back on
            </Button>
          )}
        </div>
      </Stack>
    );
  }

  return (
    <PublicShell width="reading">
      <PageHeader title="Invitation emails" />
      {body}
    </PublicShell>
  );
}
