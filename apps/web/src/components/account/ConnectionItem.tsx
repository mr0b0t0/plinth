// One agent connection: label, client, kind, permissions, dates; rename and revoke. A token
// limited to one artifact shows a key instead of initials, and names the artifact before what it
// may do there.
import { KeyIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type ConnectionInfo, LIMITS, route } from "@plinth/shared";
import { type FormEvent, useState } from "react";
import { agentInitials } from "../../lib/agents.ts";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { Badge, Button, ConfirmDialog, Dialog, Input, useToast } from "../ui/index.ts";
import {
  CLIENT_TYPE_LABEL,
  formatDate,
  formatDateTime,
  formatRelative,
  scopeLabel,
} from "./format.ts";

/**
 * What a token limited to one artifact may do there, in one label: it always reads it, so that is
 * said only when it is all it may do.
 */
function boundScopes(scopes: string[]): { scope: string; label: string }[] {
  return scopes.includes("artifacts:write")
    ? [{ scope: "artifacts:write", label: "Publish new versions" }]
    : [{ scope: "artifacts:read", label: "Read only" }];
}

export interface ConnectionItemProps {
  connection: ConnectionInfo;
  now: number;
  onChanged: (next: ConnectionInfo) => void;
}

export function ConnectionItem({ connection: c, now, onChanged }: ConnectionItemProps) {
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const revoked = c.revoked_at !== null;
  const KindIcon = c.kind === "oauth" ? PlugsConnectedIcon : KeyIcon;

  const revoke = async () => {
    setBusy(true);
    try {
      const next = await api<ConnectionInfo>(route(API.connection, { id: c.id }), {
        method: "DELETE",
      });
      onChanged(next);
      setRevoking(false);
      toast.success("Connection revoked", `${c.label} can no longer act for you.`);
    } catch (e) {
      toast.error("Could not revoke", e instanceof ApiRequestError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="pl-acct-conn" data-revoked={revoked || undefined}>
      <span className="pl-acct-conn__mark" aria-hidden="true">
        {c.artifact ? <KeyIcon size={12} /> : agentInitials(c.label)}
      </span>
      <div className="pl-acct-conn__main">
        <div className="pl-acct-conn__head">
          <h3 className="pl-acct-conn__label">{c.label}</h3>
          {/* A token limited to one artifact has the key for a mark and answers no mentions, so
              neither badge says anything there. */}
          {!c.artifact && (
            <>
              <Badge icon={KindIcon} tone="neutral">
                {c.kind === "oauth" ? "OAuth" : "Token"}
              </Badge>
              <Badge tone="neutral" srPrefix="Client:">
                {CLIENT_TYPE_LABEL[c.client_type]}
              </Badge>
            </>
          )}
          {revoked && <Badge tone="danger">Revoked</Badge>}
        </div>
        <p className="pl-acct-conn__scopes">
          {c.artifact && (
            <span className="pl-acct-conn__scope">
              <span className="visually-hidden">Only </span>
              {c.artifact.slug !== null && c.artifact.title !== null ? (
                <Link to={route(APP_ROUTES.artifact, { slug: c.artifact.slug })}>
                  {c.artifact.title}
                </Link>
              ) : (
                "An artifact you can no longer open"
              )}
            </span>
          )}
          <span className="visually-hidden">Permissions: </span>
          {(c.artifact
            ? boundScopes(c.scopes)
            : c.scopes.map((s) => ({ scope: s, label: scopeLabel(s) }))
          ).map(({ scope, label }) => (
            <span key={scope} className="pl-acct-conn__scope" title={scope}>
              {label}
            </span>
          ))}
        </p>
        <p className="pl-acct-conn__meta">
          <span title={formatDateTime(c.created_at)}>Created {formatDate(c.created_at)}</span>
          <span aria-hidden="true">·</span>
          {c.last_used_at ? (
            <span title={formatDateTime(c.last_used_at)}>
              Last used {formatRelative(c.last_used_at, now)}
            </span>
          ) : (
            <span>Never used</span>
          )}
          {c.revoked_at && (
            <>
              <span aria-hidden="true">·</span>
              <span title={formatDateTime(c.revoked_at)}>Revoked {formatDate(c.revoked_at)}</span>
            </>
          )}
        </p>
      </div>
      {!revoked && (
        <div className="pl-acct-conn__actions">
          <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
            Rename<span className="visually-hidden"> {c.label}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRevoking(true)}>
            Revoke<span className="visually-hidden"> {c.label}</span>
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        onConfirm={revoke}
        loading={busy}
        danger
        title={`Revoke “${c.label}”?`}
        description="The agent stops working with Plinth at once. What it already published stays. This cannot be undone; to reconnect, create a new token or connect again."
        confirmLabel="Revoke connection"
      />
      {renaming && (
        <RenameDialog
          connection={c}
          onClose={() => setRenaming(false)}
          onRenamed={(next) => {
            onChanged(next);
            setRenaming(false);
            toast.success("Connection renamed");
          }}
        />
      )}
    </li>
  );
}

function RenameDialog({
  connection,
  onClose,
  onRenamed,
}: {
  connection: ConnectionInfo;
  onClose: () => void;
  onRenamed: (c: ConnectionInfo) => void;
}) {
  const [label, setLabel] = useState(connection.label);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    try {
      onRenamed(
        await api<ConnectionInfo>(route(API.connection, { id: connection.id }), {
          method: "PATCH",
          body: { label: name },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach Plinth. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename connection"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="rename-connection-form" loading={busy}>
            Save name
          </Button>
        </>
      }
    >
      <form id="rename-connection-form" onSubmit={submit} noValidate>
        <Input
          label="Name"
          value={label}
          maxLength={LIMITS.maxLabelLength}
          error={error ?? undefined}
          hint="Collaborators can mention it with @ and this name in comments."
          onChange={(e) => {
            setLabel(e.target.value);
            setError(null);
          }}
          autoComplete="off"
        />
      </form>
    </Dialog>
  );
}
