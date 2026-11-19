// One line above a doc or a sheet for its owners and editors while they are not editing it on the
// page (#36): someone left unpublished changes on the page, someone is editing right now, or a
// version published meanwhile waits for review beside the unpublished changes. Editing starts from
// the bar's Edit toggle, the one way in, so the line offers no button for it. Viewers and
// commenters never get here: the gate gives them no `live`, so they see versions only.
import { WarningIcon } from "@phosphor-icons/react";
import type { LiveDraftInfo } from "@plinth/shared";
import { type ReactNode, useId, useState } from "react";
import type { PageDraft } from "../editor/draft.ts";
import { Button, ConfirmDialog } from "../ui/index.ts";
import { timeAgo } from "./format.ts";
import type { LiveFrameStatus } from "./rendererProtocol.ts";

export interface LiveDraftNoticeProps {
  /** The unpublished draft as the gate reported it. */
  draft: LiveDraftInfo | null;
  /** What the frame reports (room mode), or null. */
  status: LiveFrameStatus | null;
  /** Solo: page edits this tab kept before a reload. */
  restore?: PageDraft | null;
  /** Confirmed by code without an account: no editing actions. */
  signIn?: boolean;
  /**
   * Why the shared draft cannot be published or discarded from here right now (the room is not
   * connected), or null when it can. Those two actions are disabled with this as the reason.
   */
  unavailable?: string | null;
  /** For tests. */
  now?: number;
  onSave: () => void;
  onDiscard: () => void;
  onReview: () => void;
  onSaveRestore?: () => void;
  onDropRestore?: () => void;
}

export type NoticeKind = "conflict" | "editing" | "draft" | "restore" | null;

/** Which line to show, most urgent first. */
export function noticeKind(
  p: Pick<LiveDraftNoticeProps, "draft" | "status" | "restore">,
): NoticeKind {
  const conflict = p.status?.connected ? p.status.conflict_version : p.draft?.conflict_version;
  if (conflict != null) return "conflict";
  if (p.status?.editors.some((e) => e.block)) return "editing";
  const dirty = p.status?.connected ? p.status.dirty : p.draft?.dirty === true;
  if (dirty) return "draft";
  if (p.restore) return "restore";
  return null;
}

const draftAuthor = (d: LiveDraftInfo | null) => d?.updated_by_email ?? null;

export function LiveDraftNotice(props: LiveDraftNoticeProps) {
  const { draft, status, restore, signIn, onSave, onDiscard, onReview } = props;
  const kind = noticeKind(props);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const reasonId = useId();
  if (!kind) return null;
  const blocked = kind === "draft" ? (props.unavailable ?? null) : null;
  const actions = !signIn;
  let text: string;
  let buttons: ReactNode = null;
  if (kind === "conflict") {
    const n = (status?.connected ? status.conflict_version : draft?.conflict_version) as number;
    text = `v${n} was published over unpublished changes`;
    if (actions) {
      buttons = (
        <Button size="sm" variant="secondary" onClick={onReview}>
          Review changes
        </Button>
      );
    }
  } else if (kind === "editing") {
    const who = status?.editors.find((e) => e.block)?.email ?? "Someone";
    text = `${who} is editing`;
  } else if (kind === "draft") {
    const by = draft?.updated_by_email;
    const when = timeAgo(draft?.updated_at, props.now);
    text = `Unpublished changes on the page${by ? ` by ${by}` : ""}${when ? `, ${when}` : ""}`;
    if (actions) {
      const why = blocked ? { "aria-describedby": reasonId } : {};
      buttons = (
        <>
          <Button size="sm" variant="secondary" onClick={onSave} disabled={!!blocked} {...why}>
            Publish
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDiscard(true)}
            disabled={!!blocked}
            {...why}
          >
            Discard
          </Button>
        </>
      );
    }
  } else {
    text = `Unpublished changes from earlier in this tab, based on v${restore?.base}`;
    buttons = (
      <>
        <Button size="sm" variant="secondary" onClick={props.onSaveRestore}>
          Publish
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDropRestore}>
          Discard
        </Button>
      </>
    );
  }
  return (
    <div className={`pl-livenotice pl-livenotice--${kind}`} role="note">
      {kind === "conflict" && <WarningIcon size={14} aria-hidden="true" />}
      <span className="pl-livenotice__text">{text}</span>
      {signIn && kind !== "restore" && (
        <span className="pl-livenotice__hint">Sign in to edit.</span>
      )}
      {blocked && actions && (
        <span id={reasonId} className="pl-livenotice__hint">
          {blocked}
        </span>
      )}
      {buttons && <span className="pl-livenotice__actions">{buttons}</span>}
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard();
        }}
        title="Discard the unpublished changes?"
        description={`The page goes back to the published version for everyone editing it.${draftAuthor(draft) ? ` The changes by ${draftAuthor(draft)} are not kept anywhere.` : ""}`}
        confirmLabel="Discard changes"
        danger
      />
    </div>
  );
}
