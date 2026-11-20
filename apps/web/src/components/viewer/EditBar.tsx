// The slim strip under the artifact bar while a doc is edited on its page (#36): what is going on
// (announced politely), who else is editing, Save version (the one primary action), Discard in the
// overflow menu behind a confirm, and Done.
import { DotsThreeIcon, FloppyDiskIcon, PencilSimpleIcon, UsersIcon } from "@phosphor-icons/react";
import { type FormEvent, type Ref, useId, useState } from "react";
import { Button, ConfirmDialog, Dialog, Input, Menu } from "../ui/index.ts";
import type { LivePhase } from "./useLiveEdit.ts";

export interface EditBarProps {
  phase: LivePhase;
  mode: "room" | "solo";
  /** The version the edits are based on. */
  version: number;
  connected: boolean;
  /** Room mode, before the frame first reported. */
  connecting?: boolean;
  dirty: boolean;
  saving: boolean;
  savedVersion: number | null;
  rebasedVersion: number | null;
  /** Solo: a version published while editing. */
  newerVersion?: number | null;
  /**
   * False for a type whose page edits are never merged (a sheet): a version published meanwhile
   * always stops editing for a review, whatever lines it changed. Default true (a doc).
   */
  merges?: boolean;
  /** The version the frozen page edits are reviewed against, when known. */
  conflictVersion?: number | null;
  editors: { email: string; block: boolean }[];
  onSave: (note?: string) => void;
  onDiscard: () => void;
  onDone: () => void;
  onReview?: () => void;
  /** The strip's accessible name (the design page shows several at once). */
  label?: string;
  /** The strip itself, focusable, so focus can move to it when editing starts. */
  focusRef?: Ref<HTMLElement>;
}

/** The status line's words. */
export function editStatus(p: EditBarProps): string {
  if (p.saving) return "Saving…";
  if (p.phase === "conflict" && p.merges === false) {
    return p.conflictVersion ? `v${p.conflictVersion} published` : "A newer version was published";
  }
  if (p.phase === "conflict") return "A newer version changed the same lines. Review the changes.";
  if (p.newerVersion) return `v${p.newerVersion} was published while you were editing`;
  if (p.mode === "room" && p.connecting) return "Connecting…";
  if (p.mode === "room" && !p.connected) return "Not connected, your edits are kept";
  if (p.rebasedVersion && p.dirty)
    return `v${p.rebasedVersion} was published; your edits were kept`;
  if (p.savedVersion && !p.dirty) return `Saved as v${p.savedVersion}`;
  if (p.dirty) return "Unsaved changes";
  return `Editing v${p.version}`;
}

/** A button's label, shorter at phone width so the strip stays one line (the name is aria-label). */
function Label({ wide, narrow }: { wide: string; narrow: string }) {
  return (
    <>
      <span className="pl-editbar__wide">{wide}</span>
      <span className="pl-editbar__narrow">{narrow}</span>
    </>
  );
}

export function EditBar(props: EditBarProps) {
  const { phase, dirty, saving, editors, onSave, onDiscard, onDone, onReview } = props;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const noteForm = useId();
  const conflict = phase === "conflict";
  const shown = editors.slice(0, 3);
  const more = editors.length - shown.length;
  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    setNoteOpen(false);
    onSave(note.trim() || undefined);
    setNote("");
  };

  return (
    <section
      ref={props.focusRef}
      tabIndex={-1}
      className="pl-editbar"
      aria-label={props.label ?? "Editing on the page"}
    >
      <span className="pl-editbar__state">
        <PencilSimpleIcon size={14} aria-hidden="true" />
        <span aria-live="polite" className="pl-editbar__status">
          {editStatus(props)}
        </span>
      </span>
      {editors.length > 0 && (
        <span className="pl-editbar__editors">
          <UsersIcon size={14} aria-hidden="true" />
          {/* At phone width the names collapse to a count (they stay for screen readers). */}
          <span className="pl-editbar__count" aria-hidden="true">
            {editors.length}
          </span>
          <span className="pl-editbar__names">
            <span className="visually-hidden">Also here: </span>
            {shown.map((e) => (
              <span key={e.email} className="pl-editbar__editor">
                {e.email}
                {e.block && <span className="pl-editbar__typing"> (editing)</span>}
              </span>
            ))}
            {more > 0 && <span className="pl-editbar__editor">+{more}</span>}
          </span>
        </span>
      )}
      <span className="pl-editbar__actions">
        {conflict && onReview ? (
          <Button variant="primary" size="sm" onClick={onReview} aria-label="Review changes">
            <Label wide="Review changes" narrow="Review" />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={FloppyDiskIcon}
            loading={saving}
            disabled={!dirty}
            aria-keyshortcuts="Meta+S Control+S"
            // The label hides under the spinner while saving; the name stays.
            aria-label="Save version"
            onClick={() => onSave()}
          >
            <Label wide="Save version" narrow="Save" />
          </Button>
        )}
        <Menu
          label="More editing actions"
          icon={DotsThreeIcon}
          iconOnly
          variant="ghost"
          size="sm"
          align="end"
          items={[
            {
              label: "Save with a note…",
              disabled: !dirty || conflict,
              onSelect: () => setNoteOpen(true),
            },
            {
              label: "Discard unsaved changes",
              danger: true,
              disabled: !dirty,
              onSelect: () => setConfirmDiscard(true),
            },
          ]}
        />
        <Button variant="secondary" size="sm" onClick={onDone} disabled={saving}>
          Done
        </Button>
      </span>
      <Dialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Save version"
        description="A short note helps people find this version in the history."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={noteForm}>
              Save version
            </Button>
          </>
        }
      >
        <form id={noteForm} onSubmit={submitNote} noValidate>
          <Input
            label="Note"
            value={note}
            maxLength={500}
            autoComplete="off"
            onChange={(e) => setNote(e.currentTarget.value)}
          />
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard();
        }}
        title="Discard unsaved changes?"
        description="The page goes back to the current version, for everyone editing it. Saved versions are not touched."
        confirmLabel="Discard changes"
        danger
      />
    </section>
  );
}
