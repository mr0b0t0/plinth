// The share dialog's Data sources section (the owner only, docs/spec.md "Live data from the owner's
// agents"): each source an agent set, with its recipe in full, as text in a <pre>, never HTML. A
// source an agent set or changed waits here until the owner confirms it; the confirmation sends the
// config_hash that was shown, so a change made in between is refused and the list reloads. Removing
// never needs a confirmation. Plinth never runs a recipe: the owner's own agents do.
import { CheckIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { DataSourceInfo } from "@plinth/shared";
import { useEffect, useState } from "react";
import {
  ApiRequestError,
  confirmDataSource,
  getDataSources,
  removeDataSource,
} from "../../lib/api.ts";
import { fullTimestamp, relativeTime } from "../history/format.ts";
import { Button, useToast } from "../ui/index.ts";

export interface SourcesState {
  status: "idle" | "loading" | "ok" | "error";
  sources: DataSourceInfo[] | null;
  reload: () => void;
}

/** The artifact's data sources, read while `active` (the owner's open dialog). */
export function useDataSources(active: boolean, ref: string): SourcesState {
  const [status, setStatus] = useState<SourcesState["status"]>("idle");
  const [sources, setSources] = useState<DataSourceInfo[] | null>(null);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the reload trigger
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    setStatus("loading");
    getDataSources(ref, ctrl.signal)
      .then((r) => {
        setSources(r.sources);
        setStatus("ok");
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("error");
      });
    return () => ctrl.abort();
  }, [active, ref, nonce]);
  return { status, sources, reload: () => setNonce((n) => n + 1) };
}

const CLIENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", other: "other" };

/** Whose agents a source belongs to, in words. */
export function targetText(s: DataSourceInfo): string {
  const t = s.target;
  if (!t) return "";
  if (t.connection_id) return `Pinned to the connection ${t.connection_label ?? "that is gone"}`;
  const name = CLIENT_NAMES[t.client_type] ?? t.client_type;
  return t.client_type === "other" ? "Any of your other connections" : `Any ${name} connection`;
}

function SourceItem({
  source,
  slug,
  onChanged,
}: {
  source: DataSourceInfo;
  slug: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"confirm" | "remove" | null>(null);
  const awaiting = source.status === "awaiting_confirmation";
  const confirm = async () => {
    if (!source.config_hash) return;
    setBusy("confirm");
    try {
      await confirmDataSource(slug, source.id, source.config_hash);
      toast.success("Data source confirmed");
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "conflict") {
        toast.error("This source changed", "It was changed since you opened it: read it again.");
      } else {
        toast.error("Could not confirm the source", err instanceof Error ? err.message : "");
      }
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const remove = async () => {
    setBusy("remove");
    try {
      await removeDataSource(slug, source.id);
      toast.success("Data source removed");
    } catch (err) {
      toast.error("Could not remove the source", err instanceof Error ? err.message : "");
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  return (
    <li className="pl-share-sources__item">
      <div className="pl-share-files__meta">
        <span className="pl-share-files__name">
          {source.label}{" "}
          <span className="pl-share-sources__connector">from {source.connector}</span>
        </span>
        <span className="pl-share-files__detail">
          {awaiting ? "Waiting for you to confirm" : "Confirmed"} · collection {source.collection}
          {source.target ? ` · ${targetText(source)}` : ""}
          {source.last_fetched_at ? (
            <>
              {" · last fetched "}
              <time dateTime={source.last_fetched_at} title={fullTimestamp(source.last_fetched_at)}>
                {relativeTime(source.last_fetched_at)}
              </time>
            </>
          ) : (
            " · nothing fetched yet"
          )}
        </span>
      </div>
      {source.pin_lost_at && awaiting && (
        <p className="pl-field__error" role="alert">
          <WarningCircleIcon aria-hidden="true" />
          <span>
            The connection this source was pinned to was revoked. Confirm to let any connection of
            its type take it, or remove the source.
          </span>
        </p>
      )}
      {awaiting && (
        <p className="pl-share-views__help">
          An agent set this source. Read the recipe before you confirm: confirming says you agree to
          this fetch for this page. Plinth never runs it; your own agents do, with their own
          connections.
        </p>
      )}
      {source.recipe !== undefined && (
        <figure className="pl-share-sources__figure">
          <figcaption className="pl-share-files__detail">Recipe</figcaption>
          <pre className="pl-share-sources__recipe">{source.recipe}</pre>
        </figure>
      )}
      <div className="pl-share-sources__actions">
        {awaiting && source.config_hash && (
          <Button
            variant="primary"
            size="sm"
            icon={CheckIcon}
            onClick={confirm}
            loading={busy === "confirm"}
            disabled={busy !== null}
            aria-label={`Confirm ${source.label}`}
          >
            Confirm
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={TrashIcon}
          onClick={remove}
          loading={busy === "remove"}
          disabled={busy !== null}
          aria-label={`Remove ${source.label}`}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

/** The section, only when the artifact has data sources. Nothing while loading. */
export function DataSourcesSection({
  state,
  slug,
  expected,
  onChanged,
}: {
  state: SourcesState;
  slug: string;
  /** The gate said the artifact has sources: only then is a failed load worth saying. */
  expected: boolean;
  onChanged: () => void;
}) {
  if (state.status === "error") {
    if (!expected) return null;
    return (
      <p className="pl-field__error" role="alert">
        <WarningCircleIcon aria-hidden="true" />
        <span>Could not load the data sources. Close and reopen this dialog to try again.</span>
      </p>
    );
  }
  const list = state.sources;
  if (!list || list.length === 0) return null;
  const changed = () => {
    state.reload();
    onChanged();
  };
  return (
    <section className="pl-share-data" aria-label="Data sources">
      <p className="pl-share-data__usage" role="status">
        Data sources: where this page's figures come from
      </p>
      <ul className="pl-share-files">
        {list.map((s) => (
          <SourceItem key={s.id} source={s} slug={slug} onChanged={changed} />
        ))}
      </ul>
    </section>
  );
}
