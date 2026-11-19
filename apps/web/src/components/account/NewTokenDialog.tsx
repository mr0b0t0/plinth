// "New token": label, client type, scopes and, optionally, the one artifact it is limited to; then
// the token, shown once. The token lives only in this component's state and is dropped when the
// dialog closes. A token limited to one artifact reads it and may publish new versions of it,
// nothing else (the Worker enforces that; this dialog only offers the scopes it allows).
import {
  API,
  type ArtifactList,
  type ArtifactSummary,
  CI_DOCS_URL,
  CLIENT_TYPES,
  type ClientType,
  type ConnectionInfo,
  type CreatedToken,
  ciShellCommand,
  ciWorkflowSnippet,
  LIMITS,
  SCOPES,
  type Scope,
} from "@plinth/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Checkbox, Dialog, Input, Select, Stack } from "../ui/index.ts";
import { CopyBlock, CopyField } from "./CopyField.tsx";
import { CLIENT_TYPE_LABEL, mentionReach, mentionReachText, SCOPE_META } from "./format.ts";
import { Note } from "./Note.tsx";

/** The artifact a new token is limited to. */
export interface TokenArtifact {
  id: string;
  slug: string;
  title: string;
}

export interface NewTokenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once the token exists (to refresh the list). */
  onCreated: (created: CreatedToken) => void;
  /** Limit the token to this artifact (the Settings page's "Publish from CI"). */
  artifact?: TokenArtifact;
  /** The person's connections, so the name hint can say which handle a comment uses. */
  connections?: readonly ConnectionInfo[];
}

/** The scopes a token limited to one artifact may hold: read always, write optional. */
const BOUND_SCOPES: readonly Scope[] = ["artifacts:read", "artifacts:write"];

/** "CI: <title>", cut to the label limit. */
export function ciLabel(title: string): string {
  return [...`CI: ${title}`].slice(0, LIMITS.maxLabelLength).join("");
}

export function NewTokenDialog({
  open,
  onClose,
  onCreated,
  artifact,
  connections,
}: NewTokenDialogProps) {
  // Remount the body each time it opens, so nothing from a previous token survives.
  return open ? (
    <TokenDialogBody
      onClose={onClose}
      onCreated={onCreated}
      artifact={artifact}
      connections={connections}
    />
  ) : null;
}

type Editable =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; items: TokenArtifact[] };

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
            .filter((a: ArtifactSummary) => a.role === "owner" || a.role === "editor")
            .map((a) => ({ id: a.id, slug: a.slug, title: a.title })),
        }),
      )
      .catch(() => setState({ status: "error" }));
  }, [wanted]);
  return state;
}

function TokenDialogBody({
  onClose,
  onCreated,
  artifact,
  connections = [],
}: Omit<NewTokenDialogProps, "open">) {
  const fixed = artifact !== undefined;
  const [limited, setLimited] = useState(fixed);
  const editable = useEditableArtifacts(limited && !fixed);
  const [label, setLabel] = useState(fixed ? ciLabel(artifact.title) : "");
  const [clientType, setClientType] = useState<ClientType>("other");
  const [limitTo, setLimitTo] = useState<string>(artifact?.id ?? "");
  const [limitError, setLimitError] = useState<string | null>(null);
  const bound = limited;
  const [scopes, setScopes] = useState<Scope[]>(fixed ? [...BOUND_SCOPES] : [...SCOPES]);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const offered = bound ? BOUND_SCOPES : SCOPES;
  const chosen = bound
    ? (["artifacts:read", ...scopes.filter((s) => s === "artifacts:write")] as Scope[])
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
    if (bound && !limitTo) {
      setLimitError("Choose the artifact, or untick “Limit to one artifact”.");
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
          client_type: clientType,
          scopes: chosen,
          ...(bound ? { artifact: limitTo } : {}),
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
    // The app runs on its own origin, which is the instance the token belongs to.
    const appOrigin = window.location.origin;
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
            agent's settings, a CI secret or a password manager. If you lose it, revoke it and
            create a new one.
          </Note>
          {createdFor ? (
            <>
              <p className="type-small text-muted">
                Store it as the secret <code>PLINTH_TOKEN</code> (GitHub: Settings › Secrets and
                variables › Actions), then add this step after your build:
              </p>
              <CopyBlock
                label="GitHub Actions step"
                value={ciWorkflowSnippet({ id: createdFor, appOrigin })}
                copyLabel="Copy workflow step"
                copiedMessage="Workflow step copied"
              />
              <CopyBlock
                label="GitLab CI, cron or a shell (PLINTH_TOKEN set)"
                value={ciShellCommand({ id: createdFor, appOrigin })}
                copyLabel="Copy command"
                copiedMessage="Command copied"
              />
              <p className="type-small text-muted">
                It can only read this artifact and publish new versions of it.{" "}
                <a href={CI_DOCS_URL} target="_blank" rel="noreferrer">
                  Publishing from CI
                </a>
              </p>
            </>
          ) : (
            <p className="type-small text-muted">
              Agents send it as <code>Authorization: Bearer …</code> to the MCP server URL.
            </p>
          )}
        </Stack>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      title={fixed ? "New token for CI" : "New token"}
      description={
        fixed
          ? `A token that can only read “${artifact.title}” and publish new versions of it, for a CI pipeline or a script.`
          : "A personal access token lets an agent without OAuth, or a script, act as you."
      }
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
          hint={
            label.trim() && !bound
              ? `Shown on this page and in the version history of what it publishes. ${mentionReachText(
                  mentionReach(label, connections, { client_type: clientType, scopes: chosen }),
                )}`
              : "Shown on this page and in the version history of what it publishes."
          }
          value={label}
          maxLength={LIMITS.maxLabelLength}
          error={labelError ?? undefined}
          onChange={(e) => {
            setLabel(e.target.value);
            if (labelError) setLabelError(null);
          }}
          autoComplete="off"
        />
        {!fixed && (
          <Checkbox
            label="Limit to one artifact"
            hint="For CI: the token can only read that artifact and publish new versions of it."
            checked={limited}
            onChange={(e) => {
              setLimited(e.target.checked);
              setLimitError(null);
              setScopeError(null);
            }}
          />
        )}
        {!fixed && limited && (
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
            hint="Artifacts you own or edit."
          />
        )}
        <Select
          label="Client"
          value={clientType}
          onChange={(e) => setClientType(e.target.value as ClientType)}
          options={CLIENT_TYPES.map((t) => ({ value: t, label: CLIENT_TYPE_LABEL[t] }))}
          hint={
            bound
              ? "A token limited to one artifact does not answer mentions."
              : clientType === "other"
                ? "Collaborators can reach it only by its name, as the hint under Name shows."
                : `Collaborators can reach it with @${clientType} in comments, and by its name.`
          }
        />
        <fieldset
          className="pl-acct-scopes"
          aria-describedby={scopeError ? "scope-error" : undefined}
        >
          <legend className="pl-acct-scopes__legend">Permissions</legend>
          {offered.map((s) => (
            <Checkbox
              key={s}
              label={SCOPE_META[s].label}
              hint={
                bound && s === "artifacts:read"
                  ? "Always on: it reads the artifact before it publishes."
                  : bound && s === "artifacts:write"
                    ? "Publish new versions of this artifact."
                    : SCOPE_META[s].description
              }
              checked={chosen.includes(s)}
              disabled={bound && s === "artifacts:read"}
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
