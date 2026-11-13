// "New token": label, client type and scopes, then the token, shown once. The token lives only in
// this component's state and is dropped when the dialog closes.
import {
  API,
  CLIENT_TYPES,
  type ClientType,
  type CreatedToken,
  LIMITS,
  SCOPES,
  type Scope,
} from "@plinth/shared";
import { type FormEvent, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Checkbox, Dialog, Input, Select, Stack } from "../ui/index.ts";
import { CopyField } from "./CopyField.tsx";
import { CLIENT_TYPE_LABEL, SCOPE_META } from "./format.ts";
import { Note } from "./Note.tsx";

export interface NewTokenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once the token exists (to refresh the list). */
  onCreated: (created: CreatedToken) => void;
}

export function NewTokenDialog({ open, onClose, onCreated }: NewTokenDialogProps) {
  // Remount the body each time it opens, so nothing from a previous token survives.
  return open ? <TokenDialogBody onClose={onClose} onCreated={onCreated} /> : null;
}

function TokenDialogBody({ onClose, onCreated }: Omit<NewTokenDialogProps, "open">) {
  const [label, setLabel] = useState("");
  const [clientType, setClientType] = useState<ClientType>("other");
  const [scopes, setScopes] = useState<Scope[]>([...SCOPES]);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setToken(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = label.trim();
    let bad = false;
    if (!name) {
      setLabelError("Name the token, e.g. “Codex on my laptop”.");
      bad = true;
    }
    if (scopes.length === 0) {
      setScopeError("Choose at least one permission.");
      bad = true;
    }
    if (bad) {
      if (!name) labelRef.current?.focus();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const created = await api<CreatedToken>(API.connections, {
        method: "POST",
        body: { label: name, client_type: clientType, scopes },
      });
      setToken(created.token);
      onCreated(created);
      window.setTimeout(() => doneRef.current?.focus(), 0);
    } catch (err) {
      setFormError(
        err instanceof ApiRequestError ? err.message : "Could not reach Plinth. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (token) {
    return (
      <Dialog
        open
        onClose={close}
        title="Copy your new token"
        size="md"
        footer={
          <Button ref={doneRef} variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <Stack gap={4}>
          <CopyField
            label="Token"
            value={token}
            multiline
            copyLabel="Copy token"
            copiedMessage="Token copied"
          />
          <Note tone="warning">
            You won't see this token again. Copy it now and keep it somewhere safe, like your
            agent's settings or a password manager. If you lose it, revoke it and create a new one.
          </Note>
          <p className="type-small text-muted">
            Agents send it as <code>Authorization: Bearer …</code> to the MCP server URL.
          </p>
        </Stack>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      title="New token"
      description="A personal access token lets an agent without OAuth, or a script, act as you."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-token-form" loading={busy}>
            Create token
          </Button>
        </>
      }
    >
      <form id="new-token-form" className="pl-acct-form" onSubmit={submit} noValidate>
        <Input
          ref={labelRef}
          label="Name"
          hint="Shown on this page and in the version history of what it publishes."
          value={label}
          maxLength={LIMITS.maxLabelLength}
          error={labelError ?? undefined}
          onChange={(e) => {
            setLabel(e.target.value);
            if (labelError) setLabelError(null);
          }}
          autoComplete="off"
        />
        <Select
          label="Client"
          value={clientType}
          onChange={(e) => setClientType(e.target.value as ClientType)}
          options={CLIENT_TYPES.map((t) => ({ value: t, label: CLIENT_TYPE_LABEL[t] }))}
          hint={
            clientType === "other"
              ? "Collaborators can reach it by mentioning this token's name in comments."
              : `Collaborators can reach it with @${clientType} in comments.`
          }
        />
        <fieldset
          className="pl-acct-scopes"
          aria-describedby={scopeError ? "scope-error" : undefined}
        >
          <legend className="pl-acct-scopes__legend">Permissions</legend>
          {SCOPES.map((s) => (
            <Checkbox
              key={s}
              label={SCOPE_META[s].label}
              hint={SCOPE_META[s].description}
              checked={scopes.includes(s)}
              onChange={(e) => {
                setScopeError(null);
                setScopes((cur) =>
                  e.target.checked
                    ? SCOPES.filter((x) => x === s || cur.includes(x))
                    : cur.filter((x) => x !== s),
                );
              }}
            />
          ))}
          {scopeError && (
            <p id="scope-error" className="pl-field__error">
              {scopeError}
            </p>
          )}
        </fieldset>
        {formError && (
          <p className="pl-field__error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
