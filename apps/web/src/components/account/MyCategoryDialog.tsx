// "Move to category…" on an artifact shared with you (issue #42): your own category for it, seen by
// you only. The owner's category stays the owner's and is never shown to you; this one is never
// shown to the owner or to anyone else it is shared with, and agents never read or set it.
import {
  API,
  type ArtifactSummary,
  type CategoryCount,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  route,
  snapCategory,
} from "@plinth/shared";
import { type FormEvent, useId, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Button, Dialog, Input, useToast } from "../ui/index.ts";

export function MyCategoryDialog({
  artifact,
  names,
  onClose,
  onDone,
}: {
  artifact: ArtifactSummary;
  /** The person's own category names (their personal ones first), to snap onto. */
  names: readonly CategoryCount[];
  onClose: () => void;
  /** The stored name, or null once removed. */
  onDone: (stored: string | null) => void;
}) {
  const toast = useToast();
  const formId = useId();
  const listId = useId();
  const current = artifact.my_category ?? null;
  const [typed, setTyped] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const name = normalizeCategory(typed);
  const target = name
    ? snapCategory(
        name,
        names.map((n) => n.name),
      )
    : "";

  const put = async (category: string | null) => {
    setBusy(category === null ? "remove" : "save");
    try {
      const res = await api<ArtifactSummary>(route(API.myCategory, { ref: artifact.id }), {
        method: "PUT",
        body: { category },
      });
      if (category === null) toast.success("Category removed");
      else toast.success("Filed", res.my_category ?? undefined);
      onDone(res.my_category ?? null);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.");
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = categoryProblem(name);
    if (problem) {
      setError(`${problem}.`);
      return;
    }
    void put(name);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Move to category"
      description={`File “${artifact.title}” under a category of your own. Only you see it; ${
        artifact.owner.name || artifact.owner.email || "the owner"
      } does not.`}
      footer={
        <>
          {current !== null && (
            <Button variant="danger" onClick={() => void put(null)} loading={busy === "remove"}>
              Remove category
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy === "save"}
            disabled={!name || target === current}
          >
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <Input
          label="Your category"
          value={typed}
          maxLength={LIMITS.maxCategoryLength}
          list={listId}
          placeholder="No category"
          hint={target && target !== name ? `Matches “${target}”.` : undefined}
          error={error ?? undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n.name} value={n.name} />
          ))}
        </datalist>
      </form>
    </Dialog>
  );
}
