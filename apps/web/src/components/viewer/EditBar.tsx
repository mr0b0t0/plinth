// The slim strip under the artifact bar while a doc or a sheet is edited on its page (#36): what
// is going on (announced politely), how many others are editing (who and where in its tooltip
// and its name), Publish (the one primary
// action, Cmd/Ctrl+S), "Publish with a note…" and "Discard unpublished changes" (behind a confirm)
// in the overflow menu, and Done. While a version published meanwhile waits for review, Publish
// and the overflow menu give way to "Review changes", which opens the whole-draft review in the
// frame (the review holds the two choices and its own way out, Back). While that review is open the
// strip shows its status only: no second exit. At phone width the status is short ("v5 published"),
// so the strip stays one line.
import {
  DotsThreeIcon,
  PencilSimpleIcon,
  UploadSimpleIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { versionRange } from "@plinth/shared";
import { type FormEvent, type Ref, useId, useState } from "react";
import { Button, ConfirmDialog, Dialog, Input, Menu, Tooltip } from "../ui/index.ts";
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
  /** Room mode: everything typed has been written to the draft (flushed). */
  flushed?: boolean;
  saving: boolean;
  savedVersion: number | null;
  rebasedVersion: number | null;
  /** Solo: a version published while editing. */
  newerVersion?: number | null;
  /** The version the frozen page edits are reviewed against, when known. */
  conflictVersion?: number | null;
  /** False when the draft cannot be a version yet: Publish is off, with `unpublishableReason`. */
  publishable?: boolean;
  unpublishableReason?: string;
  editors: { email: string; block: boolean; where?: string }[];
  onPublish: (note?: string) => void;
  onDiscard: () => void;
  onDone: () => void;
  onReview?: () => void;
  /** The whole-draft review is open in the frame: the strip shows its status only. */
  reviewing?: boolean;
  /** The strip's accessible name (the design page shows several at once). */
  label?: string;
  /** The strip itself, focusable, so focus can move to it when editing starts. */
  focusRef?: Ref<HTMLElement>;
}

/** The status line's words, most urgent first. */
export function editStatus(p: EditBarProps): string {
  if (p.saving) return "Publishing…";
  if (p.phase === "conflict") {
    const n = p.conflictVersion;
    if (!n) return "A newer version was published while you edited";
    const from = Math.min(p.version + 1, n);
    return from < n
      ? `${versionRange(from, n)} were published while you edited`
      : `v${n} was published while you edited`;
  }
  if (p.newerVersion) return `v${p.newerVersion} was published while you edited`;
  if (p.mode === "room" && p.connecting) return "Connecting…";
  if (p.mode === "room" && !p.connected) return "Not connected, your changes are kept";
  if (p.rebasedVersion && p.dirty) {
    return `v${p.rebasedVersion} was published; your changes were kept`;
  }
  if (p.savedVersion && !p.dirty) return `Published as v${p.savedVersion}`;
  if (p.dirty && p.mode === "solo") return "Unpublished changes, kept in this tab";
  if (p.dirty) return p.flushed === false ? "Saving draft…" : "Draft saved";
  return `Editing v${p.version}`;
}

/**
 * The status at phone width, where the long words would wrap the strip to two lines, or null when
 * it is the same as the long one.
 */
export function editStatusShort(p: EditBarProps): string | null {
  if (p.saving) return null;
  if (p.phase === "conflict") {
    const n = p.conflictVersion;
    if (!n) return "Newer version published";
    const from = Math.min(p.version + 1, n);
    return `${versionRange(from, n)} published`;
  }
  if (p.newerVersion) return `v${p.newerVersion} published`;
  return null;
}

/** "ana@example.org (editing row 12)" for one of the others editing. */
function editorText(e: { email: string; block: boolean; where?: string }): string {
  if (!e.block) return e.email;
  return e.where ? `${e.email} (editing ${e.where})` : `${e.email} (editing)`;
}

/** Who else is editing and where, for the count's tooltip and name. */
export function editorsText(editors: EditBarProps["editors"]): string {
  return `Also here: ${editors.map(editorText).join(", ")}`;
}

export function EditBar(props: EditBarProps) {
  const { phase, dirty, saving, editors, onPublish, onDiscard, onDone, onReview } = props;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const noteForm = useId();
  const reasonId = useId();
  const conflict = phase === "conflict";
  const publishable = props.publishable !== false;
  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    setNoteOpen(false);
    onPublish(note.trim() || undefined);
    setNote("");
  };
  const status = editStatus(props);
  const short = editStatusShort(props);
  const reason = !publishable
    ? (props.unpublishableReason ?? "These changes can't be published yet.")
    : null;

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
          {short ? (
            <>
              <span className="pl-editbar__long">{status}</span>
              <span className="pl-editbar__short" aria-hidden="true">
                {short}
              </span>
            </>
          ) : (
            status
          )}
        </span>
      </span>
      {editors.length > 0 && (
        // How many others are here, at every width; who and where are its tooltip and its name.
        <Tooltip content={editorsText(editors)} placement="bottom">
          <span
            className="pl-editbar__editors"
            role="img"
            aria-label={editorsText(editors)}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can read who in the tooltip
            tabIndex={0}
          >
            <UsersIcon size={14} aria-hidden="true" />
            {editors.length}
          </span>
        </Tooltip>
      )}
      {reason && (
        <span id={reasonId} className="pl-editbar__reason">
          {reason}
        </span>
      )}
      {!props.reviewing && (
        <span className="pl-editbar__actions">
          {conflict ? (
            onReview && (
              <Button variant="primary" size="sm" onClick={onReview}>
                Review changes
              </Button>
            )
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={UploadSimpleIcon}
                loading={saving}
                disabled={!dirty || !publishable}
                aria-keyshortcuts="Meta+S Control+S"
                {...(reason ? { "aria-describedby": reasonId } : {})}
                // The label hides under the spinner while publishing; the name stays.
                aria-label="Publish"
                onClick={() => onPublish()}
              >
                Publish
              </Button>
              <Menu
                label="More editing actions"
                icon={DotsThreeIcon}
                iconOnly
                variant="ghost"
                size="sm"
                align="end"
                items={[
                  {
                    label: "Publish with a note…",
                    disabled: !dirty || !publishable,
                    onSelect: () => setNoteOpen(true),
                  },
                  {
                    label: "Discard unpublished changes",
                    danger: true,
                    disabled: !dirty,
                    onSelect: () => setConfirmDiscard(true),
                  },
                ]}
              />
            </>
          )}
          <Button variant="secondary" size="sm" onClick={onDone} disabled={saving}>
            Done
          </Button>
        </span>
      )}
      <Dialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title="Publish with a note"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={noteForm}>
              Publish
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
        title="Discard unpublished changes?"
        description={
          props.mode === "room"
            ? "The page goes back to the published version for everyone editing it."
            : "The page goes back to the published version."
        }
        confirmLabel="Discard changes"
        danger
      />
    </section>
  );
}
