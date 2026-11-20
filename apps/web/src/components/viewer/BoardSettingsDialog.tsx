// A whiteboard's settings for an editor (docs/spec.md "Whiteboards"): the background and who may
// change the board, in the "Board settings" dialog that Settings in the board's ⋯ menu opens. The
// owner changes the same two in the Board section of the settings page. useBoardSettings reads the current version
// and saves against it; after a refused save that read a newer version, `onNewer` loads that
// version on the page behind the dialog, so the header and the board match what the dialog shows.
import { type FormEvent, useId } from "react";
import { Button, Dialog } from "../ui/index.ts";
import { BoardSettingsFields } from "./BoardSettingsFields.tsx";
import { useBoardSettings } from "./useBoardSettings.ts";

export interface BoardSettingsDialogProps {
  /** The artifact's id. */
  artifactId: string;
  onClose: () => void;
  /** After a version with the new settings was published. */
  onSaved: (version: number) => void;
  /** After a refused save read a newer version: show it behind the dialog. */
  onNewer?: (version: number) => void;
}

export function BoardSettingsDialog({
  artifactId,
  onClose,
  onSaved,
  onNewer,
}: BoardSettingsDialogProps) {
  const formId = useId();
  const form = useBoardSettings(artifactId, onNewer);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const version = await form.save();
    if (version !== null) onSaved(version);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Board settings"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={form.saving}
            disabled={!form.changed}
          >
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate>
        <BoardSettingsFields form={form} />
      </form>
    </Dialog>
  );
}
