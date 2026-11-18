// Shown when a save was refused because someone published a newer version. Nothing was saved and
// nothing is merged: the person compares the published version with their draft and chooses.
import { ArrowsClockwiseIcon, CopyIcon, FloppyDiskIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button, Checkbox, ConfirmDialog, Dialog } from "../ui/index.ts";
import { CodeDiff, type EditorLanguage } from "./CodeEditor.tsx";

export interface ConflictInfo {
  /** The version now current. */
  current: number;
  currentHtml: string;
  /** Who published it (person or connection label), when known. */
  author: string | null;
  createdAt: string | null;
  /** The version the draft was based on. */
  base: number;
}

/** The words that name the draft and the actions; the source editor's are the defaults. */
export interface ConflictWords {
  /** The draft, as a column label: "Your draft". */
  draft: string;
  /** What the lede says is kept: "Your draft, based on v3, is kept here." */
  kept: (base: number) => string;
  copy: string;
  loadLatest: (current: number) => string;
  saveTitle: (next: number) => string;
  saveDescription: (current: number, next: number) => string;
  reviewed: (current: number) => string;
  same: (current: number) => string;
  /** When set, loading the latest version asks first (it throws the draft away). */
  confirmLoadLatest?: (current: number) => {
    title: string;
    description: string;
    confirmLabel: string;
  };
}

export const SOURCE_DRAFT_WORDS: ConflictWords = {
  draft: "Your draft",
  kept: (base) => `Your draft, based on v${base}, is kept here.`,
  copy: "Copy my draft",
  loadLatest: () => "Load latest and reapply manually",
  saveTitle: (next) => `Save your draft as v${next}?`,
  saveDescription: (current, next) =>
    `Your draft becomes v${next} exactly as it is. Changes made in v${current} that are not in your draft will not be in it; v${current} stays in the history and can be restored.`,
  reviewed: (current) => `I reviewed the differences between v${current} and my draft`,
  same: (current) => `Your draft is identical to v${current}.`,
};

export interface ConflictViewProps {
  conflict: ConflictInfo;
  draft: string;
  artifactId: string;
  saving: boolean;
  onCopyDraft: () => void;
  onLoadLatest: () => void;
  onSaveOnTop: () => void;
  /** The source's editor language and name (the type's registry row); HTML by default. */
  language?: EditorLanguage;
  sourceLabel?: string;
  words?: ConflictWords;
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ConflictView({
  conflict,
  draft,
  artifactId,
  saving,
  onCopyDraft,
  onLoadLatest,
  onSaveOnTop,
  language = "html",
  sourceLabel = "HTML",
  words = SOURCE_DRAFT_WORDS,
}: ConflictViewProps) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingLatest, setConfirmingLatest] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const closeConfirm = () => {
    setConfirming(false);
    setReviewed(false);
  };
  const { current, base } = conflict;
  const when = formatWhen(conflict.createdAt);
  const same = draft === conflict.currentHtml;
  const latestConfirm = words.confirmLoadLatest?.(current);
  return (
    <section className="pl-conflict" aria-labelledby="conflict-title">
      <div className="pl-conflict__banner" role="alert">
        <WarningIcon className="pl-conflict__icon" aria-hidden="true" />
        <div className="pl-conflict__text">
          <h2 id="conflict-title" className="pl-conflict__title">
            v{current} was published while you were editing
            {conflict.author ? <> (by {conflict.author})</> : null}
          </h2>
          <p className="pl-conflict__lede">
            {when ? <>Published {when}. </> : null}
            {`Nothing was saved, and nothing was overwritten. ${words.kept(base)} Compare it with v${current} and choose what to do.`}
          </p>
        </div>
      </div>

      <div className="pl-conflict__actions">
        <Button variant="secondary" icon={CopyIcon} onClick={onCopyDraft}>
          {words.copy}
        </Button>
        <Button
          variant="secondary"
          icon={ArrowsClockwiseIcon}
          onClick={latestConfirm ? () => setConfirmingLatest(true) : onLoadLatest}
        >
          {words.loadLatest(current)}
        </Button>
        <Button
          variant="primary"
          icon={FloppyDiskIcon}
          onClick={() => setConfirming(true)}
          loading={saving}
        >
          Save as new version on top of v{current}
        </Button>
      </div>

      <div className="pl-conflict__labels" aria-hidden="true">
        <span>v{current}, published</span>
        <span>
          {words.draft}, based on v{base}
        </span>
      </div>
      <div className="pl-conflict__diff">
        <CodeDiff
          original={conflict.currentHtml}
          modified={draft}
          originalLabel={`${sourceLabel} of v${current}, published (read only)`}
          modifiedLabel={
            words === SOURCE_DRAFT_WORDS
              ? `Your ${sourceLabel} draft, based on v${base} (read only)`
              : `${words.draft} (${sourceLabel}), based on v${base} (read only)`
          }
          path={`inmemory://plinth/${artifactId}/conflict-v${current}`}
          language={language}
        />
      </div>
      {same && (
        <p className="pl-conflict__same" role="status">
          {words.same(current)}
        </p>
      )}

      <Dialog
        open={confirming}
        onClose={closeConfirm}
        title={words.saveTitle(current + 1)}
        description={words.saveDescription(current, current + 1)}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!reviewed}
              onClick={() => {
                closeConfirm();
                onSaveOnTop();
              }}
            >
              Save as v{current + 1}
            </Button>
          </>
        }
      >
        <Checkbox
          label={words.reviewed(current)}
          checked={reviewed}
          onChange={(e) => setReviewed(e.currentTarget.checked)}
        />
      </Dialog>
      {latestConfirm && (
        <ConfirmDialog
          open={confirmingLatest}
          onClose={() => setConfirmingLatest(false)}
          onConfirm={() => {
            setConfirmingLatest(false);
            onLoadLatest();
          }}
          title={latestConfirm.title}
          description={latestConfirm.description}
          confirmLabel={latestConfirm.confirmLabel}
          danger
        />
      )}
    </section>
  );
}
