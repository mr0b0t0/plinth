// The review of page edits that a newer version overlaps (#36), in a dialog on the artifact page.
// It is its own lazy chunk: the diff is Monaco's, which loads only when a conflict happens. It
// reuses the source editor's ConflictView: nothing was saved and nothing is merged until the
// person chooses to keep their page edits on top of the new version or to take the new version.

import { ConflictView } from "../editor/ConflictView.tsx";
import { Dialog, showToast } from "../ui/index.ts";
import type { LiveConflict } from "./useLiveEdit.ts";

export interface LiveConflictDialogProps {
  conflict: LiveConflict;
  artifactId: string;
  saving: boolean;
  onClose: () => void;
  onKeepMine: () => void;
  onTakeLatest: () => void;
}

export default function LiveConflictDialog({
  conflict,
  artifactId,
  saving,
  onClose,
  onKeepMine,
  onTakeLatest,
}: LiveConflictDialogProps) {
  return (
    <Dialog open onClose={onClose} title="Review the page edits" size="lg">
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
        language="markdown"
        sourceLabel="Markdown"
        onCopyDraft={() => {
          navigator.clipboard
            ?.writeText(conflict.draft)
            .then(() => showToast({ title: "Page edits copied", tone: "success" }))
            .catch(() => showToast({ title: "Could not copy", tone: "danger" }));
        }}
        onLoadLatest={onTakeLatest}
        onSaveOnTop={onKeepMine}
      />
    </Dialog>
  );
}
