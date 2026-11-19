// "Replace with a file…" on a sheet's page (docs/spec.md "New and Import"): the person picks a
// .xlsx, .csv or .tsv file, confirms, and the file becomes the sheet's next version, which keeps
// its link, sharing and comments. The file goes as it is (`content_format`), the Worker converts
// it, and the save names the version on screen as `base_version`: when someone published a newer
// version since, the Worker refuses it (409) and the dialog asks again against that version, so
// nothing is overwritten unseen. Any other refusal shows the Worker's sentence and the cells it
// names. Owners and editors only; the API checks the role again.
import { FileArrowUpIcon } from "@phosphor-icons/react";
import { API, type PublishResult, route, type VersionInfo } from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import {
  type ImportProblem,
  importProblem,
  readSpreadsheet,
  SPREADSHEET_ACCEPT,
  type SpreadsheetFormat,
} from "../account/newArtifact.ts";
import { Button, Dialog, useToast } from "../ui/index.ts";
import "../account/account.css";

export interface ReplaceSheetDialogProps {
  artifactId: string;
  /** The version on screen: the file replaces it, and the save is refused if it is not current. */
  version: number;
  onClose: () => void;
  /** After the file was published as `version`. */
  onReplaced: (version: number) => void;
}

interface Picked {
  file: string;
  sent: { content_format: SpreadsheetFormat; content: string };
}

type Step =
  | { kind: "pick" }
  | ({ kind: "confirm"; base: number } & Picked)
  | ({ kind: "conflict"; base: number; by: string | null } & Picked)
  | ({ kind: "problem"; file: string } & ImportProblem);

/** The version note of a replacement. */
export const replacedNote = (file: string) => `Replaced from ${file}`;

/** What the confirmation says before anything is sent. */
export function confirmText(file: string, base: number): string {
  return `This makes v${base + 1} from ${file}. Comments and sharing stay. v${base} stays in history.`;
}

/** What the dialog asks after a newer version was published since the file was chosen. */
export function conflictText(current: number, by: string | null): string {
  return `v${current} was published${by ? ` by ${by}` : ""} since you chose the file. Replace v${current} too?`;
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
  onClose,
  onReplaced,
}: ReplaceSheetDialogProps) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [saving, setSaving] = useState(false);
  // Results that arrive after the dialog closed change nothing (StrictMode runs the effect twice).
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const choose = () => input.current?.click();

  const onFile = async (file: File) => {
    try {
      const sent = await readSpreadsheet(file);
      if (alive.current) setStep({ kind: "confirm", base: version, file: file.name, sent });
    } catch (e) {
      if (alive.current) setStep({ kind: "problem", file: file.name, ...importProblem(e) });
    }
  };

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
    if (saving) return;
    setSaving(true);
    try {
      const r = await api<PublishResult>(route(API.artifact, { ref: artifactId }), {
        method: "PUT",
        body: { ...s.sent, base_version: s.base, note: replacedNote(s.file) },
      });
      if (!alive.current) return;
      toast.success(`Replaced: v${r.version} from ${s.file}`);
      onReplaced(r.version);
    } catch (e) {
      if (!alive.current) return;
      const current = currentOf(e);
      if (current !== null && current > s.base) {
        const by = await publisherOf(current);
        if (alive.current) setStep({ ...s, kind: "conflict", base: current, by });
      } else {
        setStep({ kind: "problem", file: s.file, ...importProblem(e) });
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept={SPREADSHEET_ACCEPT}
      hidden
      aria-hidden="true"
      tabIndex={-1}
      data-testid="replace-sheet-file"
      onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        if (file) void onFile(file);
      }}
    />
  );

  const cancel = (
    <Button variant="ghost" onClick={onClose} disabled={saving}>
      Cancel
    </Button>
  );
  const another = (
    <Button variant="secondary" icon={FileArrowUpIcon} onClick={choose} disabled={saving}>
      {step.kind === "pick" ? "Choose a file…" : "Choose another file…"}
    </Button>
  );

  const footer =
    step.kind === "confirm" || step.kind === "conflict" ? (
      <>
        {cancel}
        {another}
        <Button variant="primary" loading={saving} onClick={() => void replace(step)}>
          {step.kind === "conflict" ? `Replace v${step.base}` : "Replace"}
        </Button>
      </>
    ) : (
      <>
        {cancel}
        {another}
      </>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Replace with a file"
      description="Pick a .xlsx, .csv or .tsv file of at most 2 MB. Its first row names the columns, and it becomes this sheet's next version."
      footer={footer}
    >
      {picker}
      <div role="status" className="pl-replace-sheet__status">
        {step.kind === "confirm" && <p>{confirmText(step.file, step.base)}</p>}
        {step.kind === "conflict" && <p>{conflictText(step.base, step.by)}</p>}
      </div>
      {step.kind === "problem" && (
        <div role="alert" className="pl-replace-sheet__problem">
          <p>{`${step.file} could not be used: ${step.message}`}</p>
          {step.issues.length > 0 && (
            <ul className="pl-import-issues">
              {step.issues.map((m, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two issues may read the same
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          {step.count > step.issues.length && (
            <p className="text-muted">{`and ${step.count - step.issues.length} more`}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
