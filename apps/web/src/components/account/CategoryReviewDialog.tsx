// The review of a shared category's waiting artifacts (docs/spec.md "Category sharing and personal
// categories"): every artifact filed under a shared category, by an agent or by the owner, waits
// here until the owner shares it or keeps it private. A share names the version and the
// category_rev the owner was shown, so a change made meanwhile is skipped, never shared unseen.
import {
  API,
  type CategoryReviewResult,
  type CategoryShareArtifact,
  type CategoryShareDetail,
  route,
} from "@plinth/shared";
import { useEffect, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Dialog, SegmentedControl, Spinner, useToast } from "../ui/index.ts";
import { formatRelativeShort } from "./format.ts";
import { Note } from "./Note.tsx";
import { skippedText } from "./ShareCategoryDialog.tsx";

type Decision = "shared" | "private";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; share: CategoryShareDetail; pending: CategoryShareArtifact[] };

/** The review items for the rows the owner decided on. */
export function decisionsToItems(
  rows: readonly CategoryShareArtifact[],
  decided: ReadonlyMap<string, Decision>,
) {
  return rows.flatMap((r) => {
    const d = decided.get(r.id);
    return d
      ? [{ id: r.id, version: r.current_version, category_rev: r.category_rev, decision: d }]
      : [];
  });
}

export function CategoryReviewDialog({
  shareId,
  onClose,
  onDone,
}: {
  shareId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch
  useEffect(() => {
    const ctrl = new AbortController();
    api<CategoryShareDetail>(route(API.categoryShare, { id: shareId }), { signal: ctrl.signal })
      .then((share) => {
        const pending = share.artifacts.filter((a) => a.state === "pending" && !a.taken_down);
        setLoad({ status: "ready", share, pending });
        setDecided(new Map());
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
  const title = load.status === "ready" ? load.share.title : "";

  const send = async (map: Map<string, Decision>) => {
    const items = decisionsToItems(pending, map);
    if (items.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await api<CategoryReviewResult>(route(API.categoryShareReview, { id: shareId }), {
        method: "POST",
        body: { items },
      });
      const skipped = skippedText(res, items);
      if (skipped) {
        setNote(skipped);
        setReload((n) => n + 1);
        return;
      }
      toast.success(
        res.shared > 0 ? "Shared" : "Kept private",
        `${res.shared} shared, ${res.private} kept private`,
      );
      onDone();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={title ? `Review for “${title}”` : "Review"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => void send(decided)}
            disabled={decided.size === 0}
            loading={busy}
          >
            Save
          </Button>
        </>
      }
    >
      {load.status === "loading" ? (
        <Spinner size={16} label="Loading the artifacts waiting for review" />
      ) : load.status === "error" ? (
        <p className="pl-field__error" role="alert">
          {load.message}
        </p>
      ) : pending.length === 0 ? (
        <p className="pl-acct-group__empty">Nothing is waiting for your review.</p>
      ) : (
        <ul className="pl-review__list">
          {pending.map((r) => (
            <li key={r.id} className="pl-review__row">
              <span className="pl-review__what">
                <span className="pl-review__title">{r.title}</span>
                <span className="pl-review__meta text-muted">
                  v{r.current_version} · filed by {r.last_author ?? "someone"} ·{" "}
                  {formatRelativeShort(r.updated_at, now)}
                </span>
              </span>
              <SegmentedControl<"shared" | "private" | "undecided">
                label={`Decision for ${r.title}`}
                options={[
                  { value: "shared", label: "Share" },
                  { value: "private", label: "Keep private" },
                ]}
                value={decided.get(r.id) ?? "undecided"}
                onChange={(v) => {
                  if (v === "undecided") return;
                  const next = new Map(decided);
                  next.set(r.id, v);
                  setDecided(next);
                }}
              />
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
    </Dialog>
  );
}
