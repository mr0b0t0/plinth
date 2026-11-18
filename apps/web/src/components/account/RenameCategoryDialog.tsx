// The dashboard's "Rename category" dialog: renames one of the owner's categories on every artifact
// that has it, merges it into another when the new name matches one (the same snapping the Worker
// applies), or removes it. Session only on the Worker (POST /api/v1/categories/rename).
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
import { Button, Dialog, Input, useToast } from "../ui/index.ts";

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
  onClose,
  onDone,
}: {
  /** The category being renamed, as listed. */
  category: CategoryCount;
  /** All of the owner's categories (for the datalist and the merge hint). */
  categories: readonly CategoryCount[];
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
  const plan = renamePlan(category, typed, categories);
  const unchanged = plan.name === category.name;
  const others = categories.filter((c) => categoryKey(c.name) !== categoryKey(category.name));

  const send = async (to: string | null) => {
    setBusy(to === null ? "remove" : "save");
    try {
      const res = await api<{ updated: number; category: string | null }>(API.categoryRename, {
        method: "POST",
        body: { from: category.name, to },
      });
      if (to === null) toast.success("Category removed", category.name);
      else toast.success(plan.into ? "Categories merged" : "Category renamed", res.category ?? "");
      onDone(res.category);
    } catch (err) {
      setBusy(null);
      setError(err instanceof ApiRequestError ? err.message : "Could not reach Plinth. Try again.");
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

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename category"
      description={`“${category.name}” is on ${artifactsText(category.count)}. Type a new name, or an existing category's name to merge them.`}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => void send(null)}
            loading={busy === "remove"}
            disabled={busy === "save"}
          >
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
