// "Your name": the signed-in person's display name (PATCH /api/v1/me). It labels their comments and
// versions, and pages that show who is viewing see it beside their email. The rules are the
// Worker's (displayName.ts): no "@", no control or invisible characters, at most 100 characters;
// an empty name clears it.
import { API, displayNameProblem, LIMITS, type Me, normalizeDisplayName } from "@plinth/shared";
import { type FormEvent, useId, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Dialog, Input, useToast } from "../ui/index.ts";

export const PROFILE_NAME_HELP =
  "Shown with your comments and versions, and on pages that show who is viewing. It is not checked: people see your email address too.";

export function ProfileNameDialog({
  current,
  onClose,
  onSaved,
}: {
  /** The name stored now, or null. */
  current: string | null;
  onClose: () => void;
  /** After a save: the account as the server returned it. */
  onSaved: (me: Me) => void;
}) {
  const toast = useToast();
  const formId = useId();
  const [typed, setTyped] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (name: string) => {
    setBusy(true);
    try {
      const me = await api<Me>(API.me, { method: "PATCH", body: { name } });
      toast.success(me.name ? "Name saved" : "Name cleared", me.name ?? "");
      onSaved(me);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiRequestError ? err.message : "Could not reach Plinth. Try again.");
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = normalizeDisplayName(typed);
    const problem = displayNameProblem(name);
    if (problem) {
      setError(`${problem}.`);
      return;
    }
    void save(name);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Your name"
      footer={
        <>
          <Button variant="ghost" onClick={() => void save("")} disabled={busy || current === null}>
            Clear
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate aria-busy={busy || undefined}>
        <Input
          label="Name"
          value={typed}
          maxLength={LIMITS.maxDisplayNameLength}
          hint={PROFILE_NAME_HELP}
          error={error ?? undefined}
          autoComplete="name"
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
      </form>
    </Dialog>
  );
}
