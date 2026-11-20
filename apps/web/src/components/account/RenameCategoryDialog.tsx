// The dashboard's "Rename category" dialog: renames one of the owner's categories on every artifact
// that has it, merges it into another when the new name matches one (the same snapping the Worker
// applies), or removes it after a confirmation that names how many artifacts lose it (nothing
// undoes that). Session only on the Worker (POST /api/v1/categories/rename). With `personal`, it
// renames the person's own category for artifacts shared with them (issue #42) instead. A shared
// category cannot merge into another one (409, its message shown), and artifacts merged into a
// shared category arrive waiting for the owner's review.
import {
  API,
  type CategoryCount,
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  snapCategory,
} from "@plinth/shared";
import { type FormEvent, useId, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, ConfirmDialog, Dialog, Input, useToast } from "../ui/index.ts";

export function artifactsText(n: number): string {
  return `${n} ${n === 1 ? "artifact" : "artifacts"}`;
}

/** What a rename to `typed` does: the stored name it lands on, and the category it merges into. */
export function renamePlan(
  from: CategoryCount,
  typed: string,
  categories: readonly CategoryCount[],
): { name: string; into: CategoryCount | null } {
  const name = normalizeCategory(typed);
  const fromKey = categoryKey(from.name);
  const others = categories.filter((c) => categoryKey(c.name) !== fromKey);
  if (!name) return { name, into: null };
  const target = snapCategory(
    name,
    others.map((c) => c.name),
  );
  return { name: target, into: others.find((c) => c.name === target) ?? null };
}

export function RenameCategoryDialog({
  category,
  categories,
  personal = false,
  whose,
  onClose,
  onDone,
}: {
  /** The category being renamed, as listed. */
  category: CategoryCount;
  /** All of the owner's categories (for the datalist and the merge hint). */
  categories: readonly CategoryCount[];
  /** The person's own category for artifacts shared with them, not an owner category. */
  personal?: boolean;
  /**
   * "own" when the name is also one of the person's categories for shared artifacts (the All
   * view): the dialog then says it changes the person's own artifacts only.
   */
  whose?: "own";
  onClose: () => void;
  /** After a change: the stored name, or null when the category was removed. */
  onDone: (stored: string | null) => void;
}) {
  const toast = useToast();
  const formId = useId();
  const listId = useId();
  const [typed, setTyped] = useState(category.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  /** Remove category was pressed: the confirmation replaces the rename dialog until answered. */
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const plan = renamePlan(category, typed, categories);
  const unchanged = plan.name === category.name;
  const others = categories.filter((c) => categoryKey(c.name) !== categoryKey(category.name));

  const send = async (to: string | null) => {
    setBusy(to === null ? "remove" : "save");
    try {
      const res = await api<{ updated: number; category: string | null; pending?: number }>(
        API.categoryRename,
        {
          method: "POST",
          body: { from: category.name, to, ...(personal ? { personal: true } : {}) },
        },
      );
      if (to === null) toast.success("Category removed", category.name);
      else if (res.pending) {
        toast.success(
          "Categories merged",
          `${artifactsText(res.pending)} to review in ${res.category}`,
        );
      } else
        toast.success(plan.into ? "Categories merged" : "Category renamed", res.category ?? "");
      onDone(res.category);
    } catch (err) {
      setBusy(null);
      const message =
        err instanceof ApiRequestError ? err.message : "Could not reach Plinth. Try again.";
      if (to === null) setRemoveError(message);
      else setError(message);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (unchanged || busy) return;
    const problem = categoryProblem(normalizeCategory(typed));
    if (problem) {
      setError(`${problem}.`);
      return;
    }
    void send(normalizeCategory(typed));
  };

  const hint = plan.into
    ? `${plan.into.name} already has ${artifactsText(plan.into.count)}. ${
        category.count === 1 ? "This one" : `These ${category.count}`
      } will join it.`
    : undefined;

  if (confirming) {
    return (
      <ConfirmDialog
        open
        danger
        onClose={() => {
          if (busy) return;
          setConfirming(false);
          setRemoveError(null);
        }}
        onConfirm={() => void send(null)}
        loading={busy === "remove"}
        title={`Remove “${category.name}” from ${artifactsText(category.count)}?`}
        description={`${
          category.count === 1 ? "It will have" : "They will have"
        } no category. This cannot be undone: you would file ${
          category.count === 1 ? "it" : "them"
        } again one at a time.`}
        confirmLabel={`Remove from ${artifactsText(category.count)}`}
        cancelLabel="Back"
      >
        {removeError && (
          <p className="pl-field__error" role="alert">
            {removeError}
          </p>
        )}
      </ConfirmDialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename category"
      description={
        whose === "own"
          ? `“${category.name}” is on ${artifactsText(category.count)} of yours. Artifacts shared with you keep it: rename those under Shared. Type a new name, or an existing category's name to merge them.`
          : `“${category.name}” is on ${artifactsText(category.count)}. Type a new name, or an existing category's name to merge them.`
      }
      footer={
        <>
          <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy === "save"}>
            Remove category
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={unchanged || busy === "remove"}
            loading={busy === "save"}
          >
            {plan.into ? "Merge" : "Rename"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate aria-busy={busy !== null || undefined}>
        <Input
          label="New name"
          value={typed}
          maxLength={LIMITS.maxCategoryLength}
          list={listId}
          hint={hint}
          error={error ?? undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
        <datalist id={listId}>
          {others.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
      </form>
    </Dialog>
  );
}
