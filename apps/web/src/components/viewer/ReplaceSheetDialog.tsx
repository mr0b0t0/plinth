// "Replace with a file…" on a sheet's page (docs/spec.md "New and Import"): the ⋯ item opens the
// file picker, this dialog confirms the chosen .xlsx, .csv or .tsv file, and the file becomes the
// sheet's next version, which keeps its link, sharing and comments. The file goes as it is (`content_format`), the Worker converts
// it, and the save names the version on screen as `base_version`: when someone published a newer
// version since, the Worker refuses it (409) and the dialog asks again against that version, so
// nothing is overwritten unseen. Any other refusal reads as New's Import error: "Could not use
// <file>" as the title, the Worker's sentence under it, and the cells it names. Every step's
// sentence is the dialog's muted description. Owners and editors only; the API checks the role
// again. A person confirmed by code
// without an account is told to sign in instead: a version needs an account. Replace waits while
// unpublished page changes exist or someone edits on the page (`blocked`), checked again on the
// press, and a draft started after the press meets the room's "published meanwhile" review. What
// the import would leave out or change (other sheets, formulas kept as values, long column names, a
// CSV that is not UTF-8) is listed under the confirmation, before anything is sent. "Choose a
// file…" and "Choose another file…" open the same picker as the ⋯ item (pickSpreadsheetFile).
import { FileArrowUpIcon } from "@phosphor-icons/react";
import {
  API,
  type PublishResult,
  route,
  type SheetImportWarning,
  type VersionInfo,
} from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { useSession } from "../../lib/session.ts";
import { hasIssues, ImportIssues, ImportWarnings } from "../account/ImportIssues.tsx";
import {
  CHOOSE_ANOTHER_LABEL,
  cleanFileName,
  type ImportProblem,
  importProblem,
  pickSpreadsheetFile,
  readSpreadsheet,
  type SpreadsheetBody,
} from "../account/newArtifact.ts";
import { Button, ButtonLink, Dialog, useToast } from "../ui/index.ts";

export interface ReplaceSheetDialogProps {
  artifactId: string;
  /** The version on screen: the file replaces it, and the save is refused if it is not current. */
  version: number;
  /** The file the ⋯ item's picker gave, confirmed first; null opens on "Choose a file…". */
  file?: File | null;
  /**
   * Why Replace must wait now (unpublished page changes, or someone editing on the page), or
   * null. Read again when Replace is pressed, so a draft started while the dialog was open stops
   * the save.
   */
  blocked?: string | null;
  /** The sign-in link, shown instead of the picker to a person without an account. */
  signInHref: string;
  /** The gate says this person was confirmed by code and must sign in to edit. */
  mustSignIn?: boolean;
  onClose: () => void;
  /** After the file was published as `version`. */
  onReplaced: (version: number) => void;
}

interface Picked {
  /** The file's name as shown (cleanFileName). */
  file: string;
  sent: SpreadsheetBody;
  warnings: SheetImportWarning[];
}

type Step =
  | { kind: "pick" }
  | { kind: "reading" }
  | ({ kind: "confirm"; base: number } & Picked)
  | ({ kind: "conflict"; base: number; by: string | null } & Picked)
  | ({ kind: "problem"; file: string } & ImportProblem)
  | { kind: "sign_in" };

/** What a person confirmed by code without an account is told: a version needs an account. */
export const SIGN_IN_TEXT = "Sign in to replace this sheet.";

/** The version note of a replacement. */
export const replacedNote = (file: string) => `Replaced from ${cleanFileName(file)}`;

/** What the confirmation says before anything is sent. */
export function confirmText(file: string, base: number): string {
  return `${file} becomes v${base + 1}. v${base} stays in history.`;
}

/** What the dialog asks after a newer version was published since the file was chosen. */
export function conflictText(current: number, by: string | null, file: string): string {
  const news = by
    ? `${by} published v${current} meanwhile.`
    : `v${current} was published meanwhile.`;
  return `${news} Replace it with ${file}?`;
}

/** The dialog's title when the file cannot be used; the Worker's sentence goes under it. */
export function problemTitle(file: string): string {
  return `Could not use ${file}`;
}

/** The current version a 409 names, or null for any other refusal. */
function currentOf(e: unknown): number | null {
  if (!(e instanceof ApiRequestError) || e.status !== 409) return null;
  const v = (e.details as { current_version?: unknown } | undefined)?.current_version;
  return typeof v === "number" ? v : null;
}

export function ReplaceSheetDialog({
  artifactId,
  version,
  file = null,
  blocked = null,
  signInHref,
  mustSignIn = false,
  onClose,
  onReplaced,
}: ReplaceSheetDialogProps) {
  const toast = useToast();
  const session = useSession();
  // Confirmed by code (no account): the Worker refuses the save, so say so before a file is picked.
  const noAccount = mustSignIn || (!session.loading && session.me === null);
  const [step, setStep] = useState<Step>(() => (file ? { kind: "reading" } : { kind: "pick" }));
  const [saving, setSaving] = useState(false);
  // The newest version known to be current: the one on screen, or a newer one a 409 named. A file
  // picked after a conflict is confirmed against it, never against the stale `version`.
  const known = useRef(version);
  known.current = Math.max(known.current, version);
  // Results that arrive after the dialog closed change nothing (StrictMode runs the effect twice).
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onFile = async (f: File) => {
    const name = cleanFileName(f.name);
    try {
      const { sent, warnings } = await readSpreadsheet(f);
      if (alive.current) {
        setStep({ kind: "confirm", base: known.current, file: name, sent, warnings });
      }
    } catch (e) {
      if (alive.current) setStep({ kind: "problem", file: name, ...importProblem(e) });
    }
  };

  // Inside the click, so the browser lets the picker open.
  const choose = () =>
    pickSpreadsheetFile((f) => {
      if (!alive.current) return;
      setStep({ kind: "reading" });
      void onFile(f);
    });

  // The file the ⋯ item's picker gave: read once, then confirmed. After `alive` is set above.
  const first = useRef(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the file the dialog opened with
  useEffect(() => {
    const f = first.current;
    first.current = null;
    if (f) void onFile(f);
  }, []);

  /** Who published version n, as History names them, or null when that cannot be read. */
  const publisherOf = async (n: number): Promise<string | null> => {
    try {
      const r = await api<{ items: VersionInfo[] }>(route(API.versions, { ref: artifactId }));
      return r.items.find((v) => v.number === n)?.author.label ?? null;
    } catch {
      return null;
    }
  };

  const replace = async (s: Extract<Step, { kind: "confirm" | "conflict" }>) => {
    if (saving || blocked) return;
    setSaving(true);
    try {
      const r = await api<PublishResult>(route(API.artifact, { ref: artifactId }), {
        method: "PUT",
        body: { ...s.sent, base_version: s.base, note: replacedNote(s.file) },
      });
      if (!alive.current) return;
      toast.success(`Replaced with ${s.file}`);
      onReplaced(r.version);
    } catch (e) {
      if (!alive.current) return;
      const current = currentOf(e);
      if (e instanceof ApiRequestError && e.status === 401) {
        setStep({ kind: "sign_in" });
      } else if (current !== null && current > s.base) {
        known.current = Math.max(known.current, current);
        const by = await publisherOf(current);
        if (alive.current) setStep({ ...s, kind: "conflict", base: current, by });
      } else {
        setStep({ kind: "problem", file: s.file, ...importProblem(e) });
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const cancel = (
    <Button variant="ghost" onClick={onClose} disabled={saving}>
      Cancel
    </Button>
  );
  const another = (
    <Button variant="primary" icon={FileArrowUpIcon} onClick={choose} disabled={saving}>
      {step.kind === "pick" ? "Choose a file…" : CHOOSE_ANOTHER_LABEL}
    </Button>
  );

  const signIn = noAccount || step.kind === "sign_in";
  const footer = signIn ? (
    <>
      {cancel}
      <ButtonLink to={signInHref} variant="primary">
        Sign in
      </ButtonLink>
    </>
  ) : step.kind === "confirm" || step.kind === "conflict" ? (
    <>
      {cancel}
      <Button
        variant="primary"
        loading={saving}
        disabled={blocked !== null}
        onClick={() => void replace(step)}
      >
        Replace
      </Button>
    </>
  ) : step.kind === "reading" ? (
    cancel
  ) : (
    <>
      {cancel}
      {another}
    </>
  );

  const sentence = signIn
    ? SIGN_IN_TEXT
    : step.kind === "confirm"
      ? confirmText(step.file, step.base)
      : step.kind === "conflict"
        ? conflictText(step.base, step.by, step.file)
        : step.kind === "problem"
          ? step.message
          : "";
  const asking = !signIn && (step.kind === "confirm" || step.kind === "conflict");
  const waiting = asking && blocked !== null;
  const warnings = asking ? step.warnings : [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={!signIn && step.kind === "problem" ? problemTitle(step.file) : "Replace with a file"}
      // One live region from the moment a file is being read, so every later step is announced.
      description={
        !signIn && step.kind === "pick" ? undefined : <span role="status">{sentence}</span>
      }
      // The body renders only when it has something to show, so every step keeps the same
      // title-to-text gap.
      footer={footer}
    >
      {waiting || warnings.length > 0 ? (
        <>
          {warnings.length > 0 && <ImportWarnings warnings={warnings} />}
          {waiting && <p role="status">{blocked}</p>}
        </>
      ) : !signIn && step.kind === "problem" && hasIssues(step) ? (
        <ImportIssues problem={step} />
      ) : null}
    </Dialog>
  );
}
