// One line above a doc for its owners and editors while they are not editing it on the page
// (#36): someone left unsaved page edits, someone is editing right now, or a version published
// meanwhile changed the same lines as the unsaved edits. Viewers and commenters never get here:
// the gate gives them no `live`, so they see versions only.
import { WarningIcon } from "@phosphor-icons/react";
import type { LiveDraftInfo } from "@plinth/shared";
import type { ReactNode } from "react";
import type { PageDraft } from "../editor/draft.ts";
import { Button } from "../ui/index.ts";
import { timeAgo } from "./format.ts";
import type { LiveFrameStatus } from "./rendererProtocol.ts";

export interface LiveDraftNoticeProps {
  /** The unsaved draft as the gate reported it. */
  draft: LiveDraftInfo | null;
  /** What the frame reports (room mode), or null. */
  status: LiveFrameStatus | null;
  /** Solo: page edits this tab kept before a reload. */
  restore?: PageDraft | null;
  /** Confirmed by code without an account: no editing actions. */
  signIn?: boolean;
  /** For tests. */
  now?: number;
  onSave: () => void;
  onContinue: () => void;
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

export function LiveDraftNotice(props: LiveDraftNoticeProps) {
  const { draft, status, restore, signIn, onSave, onContinue, onDiscard, onReview } = props;
  const kind = noticeKind(props);
  if (!kind) return null;
  const actions = !signIn;
  let text: string;
  let buttons: ReactNode = null;
  if (kind === "conflict") {
    const n = (status?.connected ? status.conflict_version : draft?.conflict_version) as number;
    text = `v${n} changed the same paragraphs as the unsaved page edits`;
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
    if (actions) {
      buttons = (
        <Button size="sm" variant="secondary" onClick={onContinue}>
          Join
        </Button>
      );
    }
  } else if (kind === "draft") {
    const by = draft?.updated_by_email;
    const when = timeAgo(draft?.updated_at, props.now);
    text = `Unsaved page edits${by ? ` by ${by}` : ""}${when ? `, ${when}` : ""}`;
    if (actions) {
      buttons = (
        <>
          <Button size="sm" variant="secondary" onClick={onSave}>
            Save as version
          </Button>
          <Button size="sm" variant="ghost" onClick={onContinue}>
            Continue editing
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        </>
      );
    }
  } else {
    text = `Unsaved page edits from earlier in this tab, based on v${restore?.base}`;
    buttons = (
      <>
        <Button size="sm" variant="secondary" onClick={props.onSaveRestore}>
          Save as version
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
      {buttons && <span className="pl-livenotice__actions">{buttons}</span>}
    </div>
  );
}
