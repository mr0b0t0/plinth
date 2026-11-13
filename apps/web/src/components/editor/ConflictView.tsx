// Shown when a save was refused because someone published a newer version. Nothing was saved and
// nothing is merged: the person compares the published version with their draft and chooses.
import { ArrowsClockwiseIcon, CopyIcon, FloppyDiskIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button, Checkbox, Dialog } from "../ui/index.ts";
import { CodeDiff } from "./CodeEditor.tsx";

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

export interface ConflictViewProps {
  conflict: ConflictInfo;
  draft: string;
  artifactId: string;
  saving: boolean;
  onCopyDraft: () => void;
  onLoadLatest: () => void;
  onSaveOnTop: () => void;
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
}: ConflictViewProps) {
  const [confirming, setConfirming] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const closeConfirm = () => {
    setConfirming(false);
    setReviewed(false);
  };
  const { current, base } = conflict;
  const when = formatWhen(conflict.createdAt);
  const same = draft === conflict.currentHtml;
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
            Nothing was saved, and nothing was overwritten. Your draft, based on v{base}, is kept
            here. Compare it with v{current} and choose what to do.
          </p>
        </div>
      </div>

      <div className="pl-conflict__actions">
        <Button variant="secondary" icon={CopyIcon} onClick={onCopyDraft}>
          Copy my draft
        </Button>
        <Button variant="secondary" icon={ArrowsClockwiseIcon} onClick={onLoadLatest}>
          Load latest and reapply manually
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
        <span>Your draft, based on v{base}</span>
      </div>
      <div className="pl-conflict__diff">
        <CodeDiff
          original={conflict.currentHtml}
          modified={draft}
          originalLabel={`v${current}, published (read only)`}
          modifiedLabel={`Your draft, based on v${base} (read only)`}
          path={`inmemory://plinth/${artifactId}/conflict-v${current}`}
        />
      </div>
      {same && (
        <p className="pl-conflict__same" role="status">
          Your draft is identical to v{current}.
        </p>
      )}

      <Dialog
        open={confirming}
        onClose={closeConfirm}
        title={`Save your draft as v${current + 1}?`}
        description={`Your draft becomes v${current + 1} exactly as it is. Changes made in v${current} that are not in your draft will not be in it; v${current} stays in the history and can be restored.`}
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
          label={`I reviewed the differences between v${current} and my draft`}
          checked={reviewed}
          onChange={(e) => setReviewed(e.currentTarget.checked)}
        />
      </Dialog>
    </section>
  );
}
