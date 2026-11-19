// The sections of /a/:slug/settings: title, category, who can open it, people, delete. Owner only (the
// Worker checks that on every call; the page only hides what would fail).
import { TrashIcon, UserPlusIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ArtifactSummary,
  type CategoryCount,
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  ROLES,
  type Role,
  route,
  type SharingSettings,
  snapCategory,
  VISIBILITIES,
  type Visibility,
} from "@plinth/shared";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  ROLE_META,
  Select,
  Tooltip,
  useToast,
  VISIBILITY_META,
} from "../ui/index.ts";
import { CATEGORY_SECTION_ID } from "./ArtifactRow.tsx";
import { ChoiceList } from "./ChoiceList.tsx";
import { CopyField } from "./CopyField.tsx";
import { versionsText } from "./format.ts";
import { addGrant, type GrantDraft, removeGrant, setGrantRole } from "./grants.ts";
import { Note } from "./Note.tsx";

const ACCESS_NOTE =
  "Saving this changes who can open the artifact. Anyone who has it open now will need to open the link again.";

const errMsg = (e: unknown, fallback = "Could not reach Plinth. Try again.") =>
  e instanceof ApiRequestError ? e.message : fallback;

export function Section({
  id,
  title,
  description,
  children,
  tone,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: "danger";
}) {
  return (
    <section
      className={`pl-acct-setting${tone ? ` pl-acct-setting--${tone}` : ""}`}
      aria-labelledby={id}
    >
      <div className="pl-acct-setting__head">
        <h2 id={id} className="type-heading">
          {title}
        </h2>
        {description && <p className="text-muted">{description}</p>}
      </div>
      <div className="pl-acct-setting__body">{children}</div>
    </section>
  );
}

// ---------- Title ----------

export function TitleSection({
  artifact,
  onRenamed,
}: {
  artifact: ArtifactSummary;
  onRenamed: (title: string) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(artifact.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = title.trim();
  const dirty = trimmed !== artifact.title;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (!trimmed) {
      setError("Enter a title.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<ArtifactSummary>(route(API.artifact, { ref: artifact.id }), {
        method: "PATCH",
        body: { title: trimmed },
      });
      onRenamed(res.title);
      setTitle(res.title);
      toast.success("Title saved");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="settings-title"
      title="Title"
      description="Shown on the artifact page, your dashboard and in shared links."
    >
      <form className="pl-acct-inline-form" onSubmit={submit} noValidate>
        <Input
          label="Title"
          hideLabel
          value={title}
          maxLength={LIMITS.maxTitleLength}
          error={error ?? undefined}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
          autoComplete="off"
        />
        <Button type="submit" disabled={!dirty} loading={busy}>
          Save title
        </Button>
      </form>
    </Section>
  );
}

// ---------- Category ----------

/**
 * The names a new category for `artifact` snaps onto, as the Worker does it: every one of the
 * owner's categories except one that only this artifact uses (so "acme" can become "Acme").
 */
export function snapTargets(
  artifact: Pick<ArtifactSummary, "category">,
  categories: readonly CategoryCount[],
): string[] {
  const own = artifact.category === null ? null : categoryKey(artifact.category);
  return categories
    .filter((c) => !(own !== null && categoryKey(c.name) === own && c.count <= 1))
    .map((c) => c.name);
}

export function CategorySection({
  artifact,
  onSaved,
}: {
  artifact: ArtifactSummary;
  /** The stored category after a save (the Worker's spelling), or null once removed. */
  onSaved: (category: string | null) => void;
}) {
  const toast = useToast();
  const listId = useId();
  const [value, setValue] = useState(artifact.category ?? "");
  const [names, setNames] = useState<CategoryCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The owner's names, for the datalist and the snap hint. Without them the Worker still snaps.
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ items: CategoryCount[] }>(API.categories, { signal: ctrl.signal })
      .then((res) => setNames(res.items))
      .catch(() => {
        if (!ctrl.signal.aborted) setNames([]);
      });
    return () => ctrl.abort();
  }, []);

  const typed = normalizeCategory(value);
  const target = typed ? snapCategory(typed, snapTargets(artifact, names ?? [])) : "";
  const dirty = target !== "" && target !== artifact.category;
  // A respelling that snaps back onto the current name, which other artifacts share: Save stays
  // off, so say why and where a respelling for all of them happens.
  const sameAsCurrent = typed !== "" && typed !== artifact.category && target === artifact.category;
  const hint = dirty
    ? `Will be filed under “${target}”.`
    : sameAsCurrent
      ? `Matches “${target}”, its current category. To respell it on every artifact, use Rename category on your dashboard.`
      : undefined;

  const patch = async (category: string | null) => {
    setBusy(category === null ? "remove" : "save");
    try {
      const res = await api<ArtifactSummary>(route(API.artifact, { ref: artifact.id }), {
        method: "PATCH",
        body: { category },
      });
      setValue(res.category ?? "");
      if (category === null) toast.success("Category removed");
      else toast.success("Category saved", res.category ?? undefined);
      onSaved(res.category);
      // Save turns off and Remove may go away, so the focus would fall to the page: keep it here.
      inputRef.current?.focus();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    const problem = categoryProblem(typed);
    if (problem) {
      setError(`${problem}.`);
      return;
    }
    void patch(typed);
  };

  return (
    <Section
      id={CATEGORY_SECTION_ID}
      title="Category"
      description="Group this artifact with others on your dashboard. Only you see it; people you share it with do not."
    >
      <form
        className="pl-acct-form"
        onSubmit={submit}
        noValidate
        aria-busy={busy !== null || undefined}
      >
        <Input
          label="Category"
          hideLabel
          value={value}
          list={listId}
          maxLength={LIMITS.maxCategoryLength}
          placeholder="No category"
          ref={inputRef}
          hint={hint}
          error={error ?? undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id={listId}>
          {(names ?? []).map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
        <div className="pl-acct-save">
          <Button type="submit" disabled={!dirty || busy === "remove"} loading={busy === "save"}>
            Save category
          </Button>
          {artifact.category !== null && (
            <Button
              variant="ghost"
              onClick={() => void patch(null)}
              disabled={busy === "save"}
              loading={busy === "remove"}
            >
              Remove category
            </Button>
          )}
        </div>
      </form>
    </Section>
  );
}

// ---------- Who can open it ----------

export function AccessSection({
  artifact,
  sharing,
  publicEnabled,
  onSaved,
}: {
  artifact: ArtifactSummary;
  sharing: SharingSettings;
  publicEnabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [visibility, setVisibility] = useState<Visibility>(sharing.visibility);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const dirty = visibility !== sharing.visibility || password !== "";
  const needsPassword = visibility === "password" && !sharing.has_password;
  const publicLocked = !sharing.public_allowed && sharing.visibility !== "public";

  const choices = VISIBILITIES.map((v) => ({
    value: v,
    label: VISIBILITY_META[v].label,
    description: VISIBILITY_META[v].description,
    icon: VISIBILITY_META[v].icon,
    disabled: v === "public" && publicLocked,
    disabledReason:
      v === "public"
        ? publicEnabled
          ? "Unlocks once your email is verified and your account is a few days old."
          : "Not available on this instance."
        : undefined,
  }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (visibility === "password") {
      if (needsPassword && !password) {
        setError("Set a password.");
        passwordRef.current?.focus();
        return;
      }
      if (password && password.length < LIMITS.minPasswordLength) {
        setError(`Use at least ${LIMITS.minPasswordLength} characters.`);
        passwordRef.current?.focus();
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await api<ArtifactSummary>(route(API.visibility, { ref: artifact.id }), {
        method: "PUT",
        body: {
          visibility,
          ...(visibility === "password" && password ? { password } : {}),
        },
      });
      setPassword("");
      await onSaved();
      toast.success(
        "Access saved",
        `${VISIBILITY_META[visibility].label}. Current viewers need to open the link again.`,
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const people = sharing.grants.length;

  return (
    <Section
      id="settings-access"
      title="Who can open it"
      description="People you add below can always open it, whatever you choose here."
    >
      <CopyField
        label="Link"
        value={artifact.url}
        copyLabel="Copy link"
        copiedMessage="Link copied"
        hint="The same link works for every option; it only changes what a visitor has to do."
      />
      <form className="pl-acct-form" onSubmit={save} noValidate>
        <ChoiceList
          legend="Visibility"
          choices={choices}
          value={visibility}
          onChange={(v) => {
            setVisibility(v);
            setError(null);
          }}
        />
        {visibility === "password" && (
          <Input
            ref={passwordRef}
            label={sharing.has_password ? "New password" : "Password"}
            type="password"
            autoComplete="new-password"
            value={password}
            maxLength={LIMITS.maxPasswordLength}
            error={error ?? undefined}
            hint={
              sharing.has_password
                ? "A password is set. Leave this empty to keep it, or type a new one to change it."
                : `At least ${LIMITS.minPasswordLength} characters. Send it separately from the link.`
            }
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
        )}
        {visibility === "allowlist" && people === 0 && (
          <Note>Only you can open it for now. Add people below to share it with them.</Note>
        )}
        {error && visibility !== "password" && (
          <p className="pl-field__error" role="alert">
            {error}
          </p>
        )}
        <div className="pl-acct-save">
          <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>
            Save access
          </Button>
          <span className="type-small text-muted">{ACCESS_NOTE}</span>
        </div>
      </form>
    </Section>
  );
}

// ---------- People ----------

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }));

export function PeopleSection({
  artifact,
  sharing,
  ownerEmail,
  onChange,
}: {
  artifact: ArtifactSummary;
  sharing: SharingSettings;
  ownerEmail: string | null;
  onChange: (next: SharingSettings) => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const grants: GrantDraft[] = sharing.grants.map((g) => ({ email: g.email, role: g.role }));
  // The display name of the account behind each address, when it has one (display text only).
  const names = new Map(sharing.grants.map((g) => [g.email, g.name ?? null]));

  const put = async (next: GrantDraft[]): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api<SharingSettings>(route(API.sharing, { ref: artifact.id }), {
        method: "PUT",
        body: { grants: next },
      });
      onChange(res);
      return true;
    } catch (err) {
      toast.error("Could not update people", errMsg(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = addGrant(grants, email, role, ownerEmail);
    if (!r.ok) {
      setError(r.error);
      emailRef.current?.focus();
      return;
    }
    setError(null);
    const added = r.grants[r.grants.length - 1];
    if (await put(r.grants)) {
      setEmail("");
      toast.success("Person added", `${added?.email} · ${ROLE_META[role].label}`);
      emailRef.current?.focus();
    }
  };

  const changeRole = async (target: string, next: Role) => {
    if (await put(setGrantRole(grants, target, next))) {
      toast.success("Role changed", `${target} · ${ROLE_META[next].label}`);
    }
  };

  const remove = async (target: string) => {
    const before = grants;
    if (await put(removeGrant(grants, target))) {
      toast.toast({
        title: "Person removed",
        description: target,
        action: { label: "Undo", onClick: () => void put(before) },
      });
    }
  };

  return (
    <Section
      id="settings-people"
      title="People"
      description="Viewers can open it while it is private. Commenters can also comment; editors can also publish new versions."
    >
      {grants.length > 0 ? (
        <ul className="pl-acct-people" aria-busy={busy || undefined}>
          {grants.map((g) => (
            <li key={g.email} className="pl-acct-person">
              <span className="pl-acct-person__email">
                {names.get(g.email) ? (
                  <>
                    <span className="pl-acct-person__name">{names.get(g.email)}</span>{" "}
                    <span className="text-muted">{g.email}</span>
                  </>
                ) : (
                  g.email
                )}
              </span>
              <div className="pl-acct-person__controls">
                <Select
                  label={`Role for ${g.email}`}
                  hideLabel
                  value={g.role}
                  options={ROLE_OPTIONS}
                  disabled={busy}
                  onChange={(e) => void changeRole(g.email, e.target.value as Role)}
                />
                <Tooltip content={`Remove ${g.email}`}>
                  <IconButton
                    icon={TrashIcon}
                    label={`Remove ${g.email}`}
                    disabled={busy}
                    onClick={() => void remove(g.email)}
                  />
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pl-acct-group__empty">Nobody else has access yet.</p>
      )}
      <form className="pl-acct-add" onSubmit={add} noValidate>
        <Input
          ref={emailRef}
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          error={error ?? undefined}
          className="pl-acct-add__email"
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
        />
        <Select
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          className="pl-acct-add__role"
          onChange={(e) => setRole(e.target.value as Role)}
        />
        <Button type="submit" icon={UserPlusIcon} loading={busy} className="pl-acct-add__button">
          Add person
        </Button>
      </form>
      <p className="type-small text-muted">
        Changes apply at once. Anyone who has it open now will need to open the link again.
      </p>
    </Section>
  );
}

// ---------- Delete ----------

export function DeleteSection({ artifact }: { artifact: ArtifactSummary }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const matches = typed.trim() === artifact.title.trim();

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    try {
      await api(route(API.artifact, { ref: artifact.id }), { method: "DELETE" });
      toast.success("Artifact deleted", artifact.title);
      navigate(APP_ROUTES.dashboard, { replace: true });
    } catch (err) {
      setBusy(false);
      setError(errMsg(err));
    }
  };

  return (
    <Section
      id="settings-delete"
      title="Delete artifact"
      tone="danger"
      description={`Removes it with ${
        artifact.version_count === 1
          ? "its only version"
          : `all ${versionsText(artifact.version_count)}`
      } and its comments. The link stops working for everyone. This cannot be undone.`}
    >
      <div>
        <Button variant="danger" icon={TrashIcon} onClick={() => setOpen(true)}>
          Delete artifact
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        role="alertdialog"
        size="sm"
        title={`Delete “${artifact.title}”?`}
        description="Every version, comment and link goes with it. This cannot be undone."
        footer={
          <>
            <Button ref={cancelRef} variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              form="delete-artifact-form"
              disabled={!matches}
              loading={busy}
            >
              Delete artifact
            </Button>
          </>
        }
      >
        <form id="delete-artifact-form" onSubmit={confirm} noValidate>
          <Input
            label="Type the title to confirm"
            hint={artifact.title}
            value={typed}
            error={error ?? undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
          />
        </form>
      </Dialog>
    </Section>
  );
}
