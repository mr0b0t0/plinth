// "Share category": the owner shares one of their categories with people (docs/spec.md "Category
// sharing and personal categories"). The people see the share's title, never the category name,
// and only the artifacts ticked here. Filing more artifacts under the category later never shares
// them: they wait for the owner's review. Changing the people re-confirms the artifacts in the same
// request. Session only on the Worker (/api/v1/category-shares).
import { CopyIcon, TrashIcon } from "@phosphor-icons/react";
import {
  API,
  type CategoryPerson,
  type CategoryReviewResult,
  type CategoryRole,
  type CategoryShareArtifact,
  type CategoryShareDetail,
  type CategorySharePreview,
  type CategoryShareWriteResult,
  invitationSkippedSummary,
  LIMITS,
  route,
} from "@plinth/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  Select,
  Spinner,
  Stack,
  Tooltip,
  useToast,
} from "../ui/index.ts";
import { copyText } from "./clipboard.ts";
import { Note } from "./Note.tsx";

const ROLE_OPTIONS: { value: CategoryRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "commenter", label: "Commenter" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One review item per row: ticked rows are shared, the rest kept private. */
export function reviewItems(rows: readonly CategoryShareArtifact[], ticked: ReadonlySet<string>) {
  return rows
    .filter((r) => !r.taken_down)
    .map((r) => ({
      id: r.id,
      version: r.current_version,
      category_rev: r.category_rev,
      decision: ticked.has(r.id) ? ("shared" as const) : ("private" as const),
    }));
}

const stateOf = (rows: readonly CategoryShareArtifact[], id: string) =>
  rows.find((r) => r.id === id)?.state ?? null;

export function peopleText(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

const artifactsText = (n: number) => (n === 1 ? "One artifact" : `${n} artifacts`);

/**
 * What the skipped items of a review say to the owner. Keeping an artifact private holds whatever
 * version it reached, so only a share is skipped for a change; a private decision is skipped only
 * when the artifact left the category (moved, deleted or taken down).
 */
export function skippedText(
  review: CategoryReviewResult | null,
  sent: readonly { id: string; decision: "shared" | "private" }[],
): string | null {
  const skipped = review?.skipped ?? [];
  if (skipped.length === 0) return null;
  const kept = new Set(sent.filter((i) => i.decision === "private").map((i) => i.id));
  const left = skipped.filter((s) => kept.has(s.id)).length;
  const changed = skipped.length - left;
  const parts: string[] = [];
  if (changed > 0) {
    parts.push(
      `${artifactsText(changed)} changed since you opened this, so ${
        changed === 1 ? "it was" : "they were"
      } not shared. Review again.`,
    );
  }
  if (left > 0) {
    parts.push(
      `${artifactsText(left)} left this category since you opened this (moved, deleted or taken down), so ${
        left === 1 ? "it is" : "they are"
      } not shared here.`,
    );
  }
  return parts.join(" ");
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: CategoryShareArtifact[]; share: CategoryShareDetail | null };

export interface ShareCategoryDialogProps {
  /** The owner's category name. */
  category: string;
  /** The share's id when the category is already shared. */
  shareId: string | null;
  onClose: () => void;
  /** After a change: the share (null once it stopped). */
  onDone: (share: { id: string } | null) => void;
}

export function ShareCategoryDialog({
  category,
  shareId,
  onClose,
  onDone,
}: ShareCategoryDialogProps) {
  const toast = useToast();
  const formId = useId();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [title, setTitle] = useState(category);
  const [people, setPeople] = useState<CategoryPerson[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CategoryRole>("viewer");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Invitation emails (docs/spec.md "Invitation emails"): on by default, for the people added.
  const [notify, setNotify] = useState(true);
  /** The people as loaded, to tell whether they changed. */
  const [loadedPeople, setLoadedPeople] = useState<string>("[]");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the fetch
  useEffect(() => {
    const ctrl = new AbortController();
    const path = shareId
      ? route(API.categoryShare, { id: shareId })
      : `${API.categorySharePreview}?category=${encodeURIComponent(category)}`;
    api<CategoryShareDetail | CategorySharePreview>(path, { signal: ctrl.signal })
      .then((res) => {
        const share = "id" in res ? res : null;
        setLoad({ status: "ready", rows: res.artifacts, share });
        if (share) {
          setTitle(share.title);
          setPeople(share.people);
          setLoadedPeople(JSON.stringify(share.people));
          setTicked(new Set(res.artifacts.filter((r) => r.state === "shared").map((r) => r.id)));
        } else {
          // A new share starts with every artifact of the category ticked.
          setTicked(new Set(res.artifacts.filter((r) => !r.taken_down).map((r) => r.id)));
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({
          status: "error",
          message: e instanceof ApiRequestError ? e.message : "Could not reach Plinth.",
        });
      });
    return () => ctrl.abort();
  }, [shareId, category, reload]);

  const rows = load.status === "ready" ? load.rows : [];
  const share = load.status === "ready" ? load.share : null;
  const peopleChanged = JSON.stringify(people) !== loadedPeople;
  // Ask to email only when the box is ticked and someone new is on the list.
  const had = new Set((JSON.parse(loadedPeople) as CategoryPerson[]).map((p) => p.email));
  const invite = notify && people.some((p) => !had.has(p.email)) ? { notify: true } : {};
  const reviewChanged =
    share !== null && rows.some((r) => (r.state === "shared") !== ticked.has(r.id));

  const addPerson = (e?: FormEvent) => {
    e?.preventDefault();
    const typed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(typed)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (people.some((p) => p.email === typed)) {
      setEmailError("That address is already on the list.");
      return;
    }
    if (people.length >= LIMITS.maxAllowlistEmails) {
      setEmailError(`A category is shared with at most ${LIMITS.maxAllowlistEmails} people.`);
      return;
    }
    setPeople([...people, { email: typed, role }]);
    setEmail("");
    setEmailError(null);
  };

  const finish = (
    res: CategoryShareWriteResult | CategoryReviewResult | null,
    id: string,
    sent: ReturnType<typeof reviewItems>,
  ) => {
    const review = res && "share" in res ? res.review : res;
    const notEmailed = invitationSkippedSummary(
      res && "share" in res ? res.invitations : undefined,
    );
    if (notEmailed) {
      toast.toast({ title: "No invitation sent", description: notEmailed, tone: "warning" });
    }
    const skipped = skippedText(review, sent);
    if (skipped) {
      setNote(skipped);
      setReload((n) => n + 1);
      setBusy(false);
      return;
    }
    toast.success(shareId ? "Sharing saved" : "Category shared", title.trim() || category);
    onDone({ id });
  };

  const save = async () => {
    if (busy) return;
    if (!title.trim()) {
      setError("Give the people you share with a name to see.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const review = reviewItems(rows, ticked);
      if (!share) {
        const res = await api<CategoryShareWriteResult>(API.categoryShares, {
          method: "POST",
          body: { category, title: title.trim(), people, review, ...invite },
        });
        finish(res, res.share.id, review);
        return;
      }
      const id = share.id;
      const titleChanged = title.trim() !== share.title;
      if (peopleChanged) {
        const res = await api<CategoryShareWriteResult>(route(API.categoryShare, { id }), {
          method: "PATCH",
          body: { ...(titleChanged ? { title: title.trim() } : {}), people, review, ...invite },
        });
        finish(res, id, review);
        return;
      }
      if (titleChanged) {
        await api(route(API.categoryShare, { id }), {
          method: "PATCH",
          body: { title: title.trim() },
        });
      }
      let res: CategoryReviewResult | null = null;
      // Only what changed: rows still waiting for review stay pending.
      const changed = review.filter(
        (item) => (item.decision === "shared") !== (stateOf(rows, item.id) === "shared"),
      );
      if (reviewChanged && changed.length > 0) {
        res = await api<CategoryReviewResult>(route(API.categoryShareReview, { id }), {
          method: "POST",
          body: { items: changed },
        });
      }
      finish(res, id, changed);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.");
    }
  };

  const stop = async () => {
    if (!share) return;
    setBusy(true);
    try {
      await api(route(API.categoryShare, { id: share.id }), { method: "DELETE" });
      toast.success("Stopped sharing", category);
      onDone(null);
    } catch (e) {
      setBusy(false);
      setStopping(false);
      setError(e instanceof ApiRequestError ? e.message : "Could not reach Plinth. Try again.");
    }
  };

  const copyLink = async () => {
    if (!share) return;
    if (await copyText(share.portal_url)) toast.success("Link copied");
    else toast.error("Could not copy the link", share.portal_url);
  };

  if (stopping && share) {
    const n = share.people.length;
    return (
      <ConfirmDialog
        open
        danger
        onClose={() => !busy && setStopping(false)}
        onConfirm={() => void stop()}
        loading={busy}
        title={`Stop sharing “${category}”?`}
        description={`${peopleText(n)} will lose access to every artifact they see through it. The artifacts stay in the category, and stay yours.`}
        confirmLabel="Stop sharing"
        cancelLabel="Back"
      />
    );
  }

  const shareable = rows.filter((r) => !r.taken_down);
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={share ? `Sharing “${category}”` : `Share “${category}”`}
      description="The people you add see the artifacts you tick, under the name below. Artifacts filed in this category later wait for your review before they can see them."
      footer={
        <>
          {share && (
            <Button variant="danger" onClick={() => setStopping(true)} disabled={busy}>
              Stop sharing
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy}
            disabled={load.status !== "ready"}
          >
            {share ? "Save" : "Share"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap={4}>
          <Input
            label="Name people see"
            hint="People you share with see this name, never the category's."
            value={title}
            maxLength={LIMITS.maxTitleLength}
            onChange={(e) => setTitle(e.target.value)}
          />
          {share && (
            <div className="pl-share-cat__link">
              <Input label="Link for them" value={share.portal_url} readOnly mono />
              <Button icon={CopyIcon} onClick={() => void copyLink()}>
                Copy
              </Button>
            </div>
          )}
          <fieldset className="pl-share-cat__people">
            <legend>People</legend>
            {people.length > 0 ? (
              <ul className="pl-acct-people">
                {people.map((p) => (
                  <li key={p.email} className="pl-acct-person">
                    <span className="pl-acct-person__email">{p.email}</span>
                    <div className="pl-acct-person__controls">
                      <Select
                        label={`Role for ${p.email}`}
                        hideLabel
                        value={p.role}
                        options={ROLE_OPTIONS}
                        onChange={(e) =>
                          setPeople(
                            people.map((x) =>
                              x.email === p.email
                                ? { ...x, role: e.target.value as CategoryRole }
                                : x,
                            ),
                          )
                        }
                      />
                      <Tooltip content={`Remove ${p.email}`}>
                        <IconButton
                          icon={TrashIcon}
                          label={`Remove ${p.email}`}
                          onClick={() => setPeople(people.filter((x) => x.email !== p.email))}
                        />
                      </Tooltip>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pl-acct-group__empty">Nobody yet.</p>
            )}
            <div className="pl-acct-add">
              <Input
                label="Email address"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                value={email}
                error={emailError ?? undefined}
                className="pl-acct-add__email"
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPerson(e);
                }}
              />
              <Select
                label="Role"
                value={role}
                options={ROLE_OPTIONS}
                onChange={(e) => setRole(e.target.value as CategoryRole)}
              />
              <Button onClick={() => addPerson()}>Add</Button>
            </div>
            <Checkbox
              label="Notify people"
              hint="When you save, email the people you add the link to this collection, in your name."
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
          </fieldset>
          <fieldset className="pl-share-cat__artifacts">
            <legend>Artifacts they see</legend>
            {load.status === "loading" ? (
              <Spinner size={16} label="Loading the category's artifacts" />
            ) : load.status === "error" ? (
              <p className="pl-field__error" role="alert">
                {load.message}
              </p>
            ) : shareable.length === 0 ? (
              <p className="pl-acct-group__empty">This category has no artifacts yet.</p>
            ) : (
              <ul className="pl-share-cat__list">
                {shareable.map((r) => (
                  <li key={r.id}>
                    <Checkbox
                      label={r.title}
                      hint={
                        share && r.state === "pending"
                          ? `Waiting for your review · filed by ${r.last_author ?? "someone"}`
                          : `Visible to these people when ticked · v${r.current_version}`
                      }
                      checked={ticked.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setTicked(next);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {note && <Note tone="warning">{note}</Note>}
          {error && (
            <p className="pl-field__error" role="alert">
              {error}
            </p>
          )}
        </Stack>
      </form>
    </Dialog>
  );
}
