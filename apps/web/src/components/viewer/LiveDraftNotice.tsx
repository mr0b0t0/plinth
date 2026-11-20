// One line above a doc or a sheet for its owners and editors while they are not editing it on the
// page (#36): someone left unpublished changes on the page, someone is editing right now, or a
// version published meanwhile waits for review beside the unpublished changes. The line only says
// so: the bar's Edit toggle is the one way in, and the edit strip holds Publish, Discard and Review
// changes. Only a copy this tab kept from before a reload (solo mode), which no frame holds, gets
// its own Publish and Discard here. Viewers and commenters never get here: the gate gives them no
// `live`, so they see versions only.
import { WarningIcon } from "@phosphor-icons/react";
import type { LiveDraftInfo } from "@plinth/shared";
import type { PageDraft } from "../editor/draft.ts";
import { Button } from "../ui/index.ts";
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
  /** For tests. */
  now?: number;
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
  const { draft, status, restore, signIn } = props;
  const kind = noticeKind(props);
  if (!kind) return null;
  let text: string;
  if (kind === "conflict") {
    const n = (status?.connected ? status.conflict_version : draft?.conflict_version) as number;
    text = `v${n} was published over unpublished changes`;
  } else if (kind === "editing") {
    const who = status?.editors.find((e) => e.block)?.email ?? "Someone";
    text = `${who} is editing`;
  } else if (kind === "draft") {
    const by = draft?.updated_by_email;
    const when = timeAgo(draft?.updated_at, props.now);
    text = `Unpublished changes on the page${by ? ` by ${by}` : ""}${when ? `, ${when}` : ""}`;
  } else {
    text = `Unpublished changes from earlier in this tab, based on v${restore?.base}`;
  }
  return (
    <div className={`pl-livenotice pl-livenotice--${kind}`} role="note">
      {kind === "conflict" && <WarningIcon size={14} aria-hidden="true" />}
      <span className="pl-livenotice__text">{text}</span>
      {signIn && kind !== "restore" && (
        <span className="pl-livenotice__hint">Sign in to edit.</span>
      )}
      {kind === "restore" && (
        <span className="pl-livenotice__actions">
          <Button size="sm" variant="secondary" onClick={props.onSaveRestore}>
            Publish
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onDropRestore}>
            Discard
          </Button>
        </span>
      )}
    </div>
  );
}
