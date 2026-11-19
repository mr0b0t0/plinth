// "New token": label, client type, scopes and, optionally, the one artifact it is limited to; then
// the token, shown once. The token lives only in this component's state and is dropped when the
// dialog closes. A token limited to one artifact reads it and may publish new versions of it,
// nothing else (the Worker enforces that; this dialog only offers the scopes it allows).
import {
  API,
  type ArtifactList,
  CI_DOCS_URL,
  CLIENT_TYPES,
  type ClientType,
  type CreatedToken,
  ciWorkflowSnippet,
  LIMITS,
  SCOPES,
  type Scope,
} from "@plinth/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Checkbox, Dialog, Input, Select, Stack } from "../ui/index.ts";
import { CopyBlock, CopyField } from "./CopyField.tsx";
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

type Editable =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; items: { id: string; title: string }[] };

/**
 * Artifacts the person owns or edits, for "Limit to one artifact": loaded once, when the person
 * first asks for the limit.
 */
function useEditableArtifacts(load: boolean): Editable {
  const [state, setState] = useState<Editable>({ status: "idle" });
  const wanted = load && state.status === "idle";
  useEffect(() => {
    if (!wanted) return;
    setState({ status: "loading" });
    api<ArtifactList>(API.artifacts)
      .then((list) =>
        setState({
          status: "ready",
          items: list.items
            .filter((a) => a.role === "owner" || a.role === "editor")
            .map((a) => ({ id: a.id, title: a.title })),
        }),
      )
      .catch(() => setState({ status: "error" }));
  }, [wanted]);
  return state;
}

function TokenDialogBody({ onClose, onCreated }: Omit<NewTokenDialogProps, "open">) {
  const [label, setLabel] = useState("");
  const [clientType, setClientType] = useState<ClientType>("other");
  const [scopes, setScopes] = useState<Scope[]>([...SCOPES]);
  // Limited to one artifact: it always reads it, and publishes new versions when `canPublish`.
  const [limited, setLimited] = useState(false);
  const editable = useEditableArtifacts(limited);
  const [limitTo, setLimitTo] = useState("");
  const [canPublish, setCanPublish] = useState(true);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const chosen: Scope[] = limited
    ? canPublish
      ? ["artifacts:read", "artifacts:write"]
      : ["artifacts:read"]
    : scopes;

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
    if (chosen.length === 0) {
      setScopeError("Choose at least one permission.");
      bad = true;
    }
    if (limited && !limitTo) {
      setLimitError("Choose an artifact.");
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
        body: {
          label: name,
          // A limited token answers no mentions, so its client type only labels it.
          client_type: limited ? "other" : clientType,
          scopes: chosen,
          ...(limited ? { artifact: limitTo } : {}),
        },
      });
      setToken(created.token);
      setCreatedFor(created.connection.artifact?.id ?? null);
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
          {createdFor ? (
            <>
              <Note tone="warning">
                Shown only once. Save it as the CI secret <code>PLINTH_TOKEN</code>.
              </Note>
              <CopyBlock
                label={
                  <>
                    GitHub Actions step <span aria-hidden="true">·</span>{" "}
                    <a href={CI_DOCS_URL} target="_blank" rel="noreferrer">
                      CI guide
                    </a>
                  </>
                }
                // The app runs on its own origin, which is the instance the token belongs to.
                value={ciWorkflowSnippet({ id: createdFor, appOrigin: window.location.origin })}
                copyLabel="Copy workflow step"
                copiedMessage="Workflow step copied"
                wrap={false}
              />
            </>
          ) : (
            <>
              <Note tone="warning">
                You won't see this token again. Copy it now and keep it somewhere safe, like your
                agent's settings, a CI secret or a password manager. If you lose it, revoke it and
                create a new one.
              </Note>
              <p className="type-small text-muted">
                Agents send it as <code>Authorization: Bearer …</code> to the MCP server URL.
              </p>
            </>
          )}
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
        <Checkbox
          label="Limit to one artifact"
          checked={limited}
          onChange={(e) => {
            setLimited(e.target.checked);
            setLimitError(null);
            setScopeError(null);
          }}
        />
        {limited ? (
          <Select
            label="Artifact"
            value={limitTo}
            onChange={(e) => {
              setLimitTo(e.target.value);
              setLimitError(null);
            }}
            disabled={editable.status !== "ready"}
            error={
              limitError ??
              (editable.status === "error"
                ? "Could not load your artifacts. Close the dialog and try again."
                : undefined)
            }
            options={[
              {
                value: "",
                label: editable.status === "ready" ? "Choose an artifact" : "Loading artifacts…",
              },
              ...(editable.status === "ready"
                ? editable.items.map((a) => ({ value: a.id, label: a.title }))
                : []),
            ]}
          />
        ) : (
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
        )}
        <fieldset
          className="pl-acct-scopes"
          aria-describedby={scopeError ? "scope-error" : undefined}
        >
          <legend className="pl-acct-scopes__legend">Permissions</legend>
          {limited ? (
            <Checkbox
              label="Publish new versions"
              checked={canPublish}
              onChange={(e) => setCanPublish(e.target.checked)}
            />
          ) : (
            SCOPES.map((s) => (
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
            ))
          )}
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
