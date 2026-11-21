// The review of a shared category's waiting artifacts (docs/spec.md "Category sharing and personal
// categories"): every artifact filed under a shared category, by an agent or by the owner, waits
// here until the owner shares it or keeps it private. Each row's choice applies at once. A share
// names the version and the category_rev the owner was shown, so a change made meanwhile is
// skipped, never shared unseen.
import {
  API,
  type CategoryReviewResult,
  type CategoryShareArtifact,
  type CategoryShareDetail,
  route,
} from "@plinth/shared";
import { useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Dialog, Spinner, useToast } from "../ui/index.ts";
import { formatRelativeShort } from "./format.ts";
import { Note } from "./Note.tsx";
import { skippedText } from "./ShareCategoryDialog.tsx";

type Decision = "shared" | "private";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; share: CategoryShareDetail; pending: CategoryShareArtifact[] };

/** The review item for one decision on a row, with the version and category_rev it was shown at. */
export function decisionItem(row: CategoryShareArtifact, decision: Decision) {
  return {
    id: row.id,
    version: row.current_version,
    category_rev: row.category_rev,
    decision,
  };
}

export function CategoryReviewDialog({
  shareId,
  onClose,
  onDone,
}: {
  shareId: string;
  onClose: () => void;
  /** After the last waiting artifact is decided. */
  onDone: () => void;
}) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  /** The row whose decision is being sent. */
  const [busy, setBusy] = useState<{ id: string; decision: Decision } | null>(null);
  /** Something was decided, so the dashboard reloads on close. */
  const [decidedAny, setDecidedAny] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  // Focus starts on the dialog's content, not on its close button.
  const startRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch
  useEffect(() => {
    const ctrl = new AbortController();
    api<CategoryShareDetail>(route(API.categoryShare, { id: shareId }), { signal: ctrl.signal })
      .then((share) => {
        const pending = share.artifacts.filter((a) => a.state === "pending" && !a.taken_down);
        setLoad({ status: "ready", share, pending });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      });
    return () => ctrl.abort();
  }, [shareId, reload]);

  const pending = load.status === "ready" ? load.pending : [];
  const category = load.status === "ready" ? load.share.category : "";

  const decide = async (row: CategoryShareArtifact, decision: Decision) => {
    if (busy) return;
    const items = [decisionItem(row, decision)];
    setBusy({ id: row.id, decision });
    setError(null);
    setNote(null);
    try {
      const res = await api<CategoryReviewResult>(route(API.categoryShareReview, { id: shareId }), {
        method: "POST",
        body: { items },
      });
      setDecidedAny(true);
      const skipped = skippedText(res, items);
      if (skipped) {
        setNote(skipped);
        setReload((n) => n + 1);
        return;
      }
      toast.success(decision === "shared" ? "Shared" : "Kept private", row.title);
      const rest = pending.filter((r) => r.id !== row.id);
      if (rest.length === 0) {
        onDone();
        return;
      }
      setLoad((l) => (l.status === "ready" ? { ...l, pending: rest } : l));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={decidedAny ? onDone : onClose}
      title={category ? `Review “${category}”` : "Review"}
      initialFocus={startRef}
    >
      <div ref={startRef} tabIndex={-1} className="pl-review">
        {load.status === "loading" ? (
          <Spinner size={16} label="Loading the artifacts waiting for review" />
        ) : load.status === "error" ? (
          <p className="pl-field__error" role="alert">
            {load.message}
          </p>
        ) : pending.length === 0 ? (
          <p className="pl-acct-group__empty">Nothing to review.</p>
        ) : (
          <ul className="pl-review__list">
            {pending.map((r) => (
              <li key={r.id} className="pl-review__row">
                <span className="pl-review__what">
                  <span className="pl-review__title" id={`${ids}-${r.id}`}>
                    {r.title}
                  </span>
                  <span className="pl-review__meta text-muted">
                    v{r.current_version} · {r.last_author ?? "someone"} ·{" "}
                    {formatRelativeShort(r.updated_at, now)}
                  </span>
                </span>
                <span className="pl-review__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-describedby={`${ids}-${r.id}`}
                    disabled={busy !== null && busy.id !== r.id}
                    loading={busy?.id === r.id && busy.decision === "private"}
                    onClick={() => void decide(r, "private")}
                  >
                    Keep private
                  </Button>
                  <Button
                    size="sm"
                    aria-describedby={`${ids}-${r.id}`}
                    disabled={busy !== null && busy.id !== r.id}
                    loading={busy?.id === r.id && busy.decision === "shared"}
                    onClick={() => void decide(r, "shared")}
                  >
                    Share
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {note && <Note tone="warning">{note}</Note>}
        {error && (
          <p className="pl-field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
