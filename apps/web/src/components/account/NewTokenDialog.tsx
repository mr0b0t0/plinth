// "New token": label, client type, scopes and, optionally, the one artifact it is limited to; then
// the token, shown once. The token lives only in this component's state and is dropped when the
// dialog closes. A token limited to one artifact reads it and may publish new versions of it,
// nothing else (the Worker enforces that; this dialog only offers the scopes it allows).
import {
  API,
  type ArtifactList,
  type ArtifactType,
  CI_DOCS_URL,
  CI_NO_ARTIFACT_URL,
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

/** GET /artifacts answers at most this many, most recent first, and has no next page. */
const LIST_MAX = 500;

/** An artifact the token can be limited to. */
interface Pickable {
  id: string;
  slug: string;
  title: string;
  type: ArtifactType;
}

type Editable =
  | { status: "idle" | "loading" | "error" }
  | {
      status: "ready";
      items: Pickable[];
      /** The answer for this search ("" for none). */
      query: string;
    };

/**
 * Artifacts the person owns or edits, for "Limit to one artifact": loaded when the person first
 * asks for the limit, again for each search (`query`, settled), and on `retry` after an error.
 * `full`: the unfiltered list came back at its maximum, so older artifacts are found by searching.
 */
function useEditableArtifacts(load: boolean, query: string) {
  const [state, setState] = useState<Editable>({ status: "idle" });
  const [full, setFull] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the fetch (Try again)
  useEffect(() => {
    if (!load) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    const path = query ? `${API.artifacts}?query=${encodeURIComponent(query)}` : API.artifacts;
    api<ArtifactList>(path, { signal: ctrl.signal })
      .then((list) => {
        // Once full, it stays full: a search's shorter answer does not hide the search box.
        if (!query && list.items.length >= LIST_MAX) setFull(true);
        setState({
          status: "ready",
          items: list.items
            .filter((a) => a.role === "owner" || a.role === "editor")
            .map((a) => ({ id: a.id, slug: a.slug, title: a.title, type: a.type })),
          query,
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [load, query, attempt]);
  return { state, full, retry: () => setAttempt((n) => n + 1) };
}

/** Each artifact's option text: its title, and its slug when another one has the same title. */
function optionLabels(items: Pickable[]): Map<string, string> {
  const key = (t: string) => t.trim().toLowerCase();
  const seen = new Map<string, number>();
  for (const a of items) seen.set(key(a.title), (seen.get(key(a.title)) ?? 0) + 1);
  return new Map(
    items.map((a) => [
      a.id,
      (seen.get(key(a.title)) ?? 0) > 1 ? `${a.title} (${a.slug})` : a.title || a.slug,
    ]),
  );
}

/** `value` once it has stopped changing for `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function TokenDialogBody({ onClose, onCreated }: Omit<NewTokenDialogProps, "open">) {
  const [label, setLabel] = useState("");
  const [clientType, setClientType] = useState<ClientType>("other");
  const [scopes, setScopes] = useState<Scope[]>([...SCOPES]);
  // Limited to one artifact: it always reads it, and publishes new versions when `canPublish`.
  const [limited, setLimited] = useState(false);
  const [search, setSearch] = useState("");
  const settledSearch = useSettled(search.trim(), 300);
  const { state: editable, full, retry } = useEditableArtifacts(limited, settledSearch);
  const [picked, setPicked] = useState<Pickable | null>(null);
  const limitTo = picked?.id ?? "";
  const [canPublish, setCanPublish] = useState(true);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [createdFor, setCreatedFor] = useState<{ id: string; type?: ArtifactType } | null>(null);
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
      const bound = created.connection.artifact;
      setCreatedFor(
        bound ? { id: bound.id, type: picked?.id === bound.id ? picked.type : undefined } : null,
      );
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
                value={ciWorkflowSnippet({
                  id: createdFor.id,
                  type: createdFor.type,
                  appOrigin: window.location.origin,
                })}
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
      description={
        limited
          ? "A token for scripts and CI that reads one artifact and can publish its next versions, nothing else."
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
          <ArtifactPicker
            editable={editable}
            full={full}
            retry={retry}
            search={search}
            onSearch={setSearch}
            picked={picked}
            onPick={(a) => {
              setPicked(a);
              setLimitError(null);
            }}
            error={limitError}
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

interface ArtifactPickerProps {
  editable: Editable;
  full: boolean;
  retry: () => void;
  search: string;
  onSearch: (q: string) => void;
  picked: Pickable | null;
  onPick: (a: Pickable | null) => void;
  error: string | null;
}

/**
 * The artifact a limited token is for: one select of what the person owns or edits; a search box
 * above it only when the list is full (older artifacts are found by title or slug); a pointer to
 * the guide when there is nothing to choose; Try again after a failed load.
 */
function ArtifactPicker({
  editable,
  full,
  retry,
  search,
  onSearch,
  picked,
  onPick,
  error,
}: ArtifactPickerProps) {
  if (editable.status === "error") {
    return (
      <div className="pl-acct-picker">
        <p className="pl-field__error" role="alert">
          Could not load your artifacts.
        </p>
        <Button size="sm" variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }
  const ready = editable.status === "ready" ? editable : null;
  if (ready && !full && !ready.query && ready.items.length === 0) {
    return (
      <div className="pl-acct-picker">
        <Note>
          You own or edit no artifact yet. Publish its first version, then make the token:{" "}
          <a href={CI_NO_ARTIFACT_URL} target="_blank" rel="noreferrer">
            how
          </a>
          .
        </Note>
        {error && <p className="pl-field__error">{error}</p>}
      </div>
    );
  }
  // The chosen artifact stays in the list while a search shows others.
  const items = ready
    ? picked && !ready.items.some((a) => a.id === picked.id)
      ? [picked, ...ready.items]
      : ready.items
    : [];
  const labels = optionLabels(items);
  const placeholder = !ready
    ? "Loading artifacts…"
    : ready.items.length === 0
      ? "No artifact matches"
      : "Choose an artifact";
  return (
    <>
      {full ? (
        <Input
          label="Find an artifact"
          hint={`Only your ${LIST_MAX} most recent are listed. Search by title or slug for an older one.`}
          value={search}
          maxLength={200}
          onChange={(e) => onSearch(e.target.value)}
          autoComplete="off"
        />
      ) : null}
      <Select
        label="Artifact"
        value={picked?.id ?? ""}
        onChange={(e) => onPick(items.find((a) => a.id === e.target.value) ?? null)}
        disabled={!ready}
        error={error ?? undefined}
        options={[
          { value: "", label: placeholder },
          ...items.map((a) => ({ value: a.id, label: labels.get(a.id) ?? a.title })),
        ]}
      />
    </>
  );
}
