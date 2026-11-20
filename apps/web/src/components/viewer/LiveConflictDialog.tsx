// The review of page edits that a newer version overlaps (#36), in a dialog on the artifact page.
// It is its own lazy chunk: the diff is Monaco's, which loads only when a conflict happens. It
// reuses the source editor's ConflictView (and its styles, which the artifact page does not load
// otherwise): nothing was saved and nothing is merged until the person chooses to keep the page
// edits on top of the new version or to take the new version.
//
// In room mode the draft is everyone's unsaved page edits, not just this person's, and taking the
// new version throws them away for everyone: the words say so, and that choice asks first.
import type { EditorLanguage } from "@plinth/shared";
import { ConflictView, type ConflictWords } from "../editor/ConflictView.tsx";
import { Dialog, showToast } from "../ui/index.ts";
import type { LiveConflict } from "./useLiveEdit.ts";
import "../editor/editor.css";

export interface LiveConflictDialogProps {
  conflict: LiveConflict;
  artifactId: string;
  saving: boolean;
  /** "room": the shared draft of everyone editing; "solo": this tab's own edits. */
  mode: "room" | "solo";
  /** The source as the diff shows it: Markdown for a doc, JSON lines for a sheet. */
  language?: EditorLanguage;
  sourceLabel?: string;
  onClose: () => void;
  onKeepMine: () => void;
  onTakeLatest: () => void;
}

const ROOM_WORDS: ConflictWords = {
  draft: "Unsaved page edits (everyone's)",
  kept: (base) => `The unsaved page edits of everyone editing, based on v${base}, are kept here.`,
  copy: "Copy the page edits",
  loadLatest: (current) => `Discard the page edits and keep v${current}`,
  saveTitle: (next) => `Save the page edits as v${next}?`,
  saveDescription: (current, next) =>
    `The page edits become v${next} exactly as they are. Changes made in v${current} that are not in them will not be in it; v${current} stays in the history and can be restored.`,
  reviewed: (current) => `I reviewed the differences between v${current} and the page edits`,
  same: (current) => `The page edits are identical to v${current}.`,
  confirmLoadLatest: (current) => ({
    title: "Discard everyone's page edits?",
    description: `The page goes back to v${current} for everyone editing it. The unsaved page edits are not kept anywhere: copy them first if you want to reapply any.`,
    confirmLabel: "Discard page edits",
  }),
};

const SOLO_WORDS: ConflictWords = {
  draft: "Your page edits",
  kept: (base) => `Your page edits, based on v${base}, are kept here.`,
  copy: "Copy my page edits",
  loadLatest: (current) => `Discard my page edits and keep v${current}`,
  saveTitle: (next) => `Save your page edits as v${next}?`,
  saveDescription: (current, next) =>
    `Your page edits become v${next} exactly as they are. Changes made in v${current} that are not in them will not be in it; v${current} stays in the history and can be restored.`,
  reviewed: (current) => `I reviewed the differences between v${current} and my page edits`,
  same: (current) => `Your page edits are identical to v${current}.`,
  confirmLoadLatest: (current) => ({
    title: "Discard your page edits?",
    description: `The page reloads with v${current}. Your unsaved page edits are not kept anywhere: copy them first if you want to reapply any.`,
    confirmLabel: "Discard my edits",
  }),
};

export default function LiveConflictDialog({
  conflict,
  artifactId,
  saving,
  mode,
  language = "markdown",
  sourceLabel = "Markdown",
  onClose,
  onKeepMine,
  onTakeLatest,
}: LiveConflictDialogProps) {
  return (
    <Dialog open onClose={onClose} title="Review the page edits" size="lg">
      <div className="pl-liveconflict">
        <ConflictView
          conflict={{
            current: conflict.current,
            currentHtml: conflict.currentText,
            author: null,
            createdAt: null,
            base: conflict.base,
          }}
          draft={conflict.draft}
          artifactId={artifactId}
          saving={saving}
          language={language}
          sourceLabel={sourceLabel}
          words={mode === "room" ? ROOM_WORDS : SOLO_WORDS}
          onCopyDraft={() => {
            navigator.clipboard
              ?.writeText(conflict.draft)
              .then(() => showToast({ title: "Page edits copied", tone: "success" }))
              .catch(() => showToast({ title: "Could not copy", tone: "danger" }));
          }}
          onLoadLatest={onTakeLatest}
          onSaveOnTop={onKeepMine}
        />
      </div>
    </Dialog>
  );
}
