// One line above a doc, a deck, a sheet or a design system for its owners and editors while they
// are not editing it on the page (#36; editing is always on otherwise, so this is an editor who
// must sign in first, or a page that stays read-only): someone left unpublished changes on the
// page ("Unpublished changes · Ana, 3 h ago"), someone is editing right now, or a version
// published meanwhile waits for review beside the unpublished changes. The line only says so (a
// bronze rule and a pencil), on one line, with no buttons. Only a copy this tab kept from before a
// reload (solo mode), which no frame holds, gets its own Publish and Discard here, also while
// editing. Viewers and commenters never get here: the gate gives them no `live`, so they see
// versions only.
import { PencilSimpleIcon } from "@phosphor-icons/react";
import type { LiveDraftInfo } from "@plinth/shared";
import type { PageDraft } from "../editor/draft.ts";
import { Button } from "../ui/index.ts";
import { personName, timeAgo } from "./format.ts";
import type { LiveFrameStatus } from "./rendererProtocol.ts";

export interface LiveDraftNoticeProps {
  /** The unpublished draft as the gate reported it. */
  draft: LiveDraftInfo | null;
  /** What the frame reports (room mode), or null. */
  status: LiveFrameStatus | null;
  /** Solo: page edits this tab kept before a reload. */
  restore?: PageDraft | null;
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

/** The line's words, and whose email it names by first name (shown whole on hover). */
export function noticeText(
  p: Pick<LiveDraftNoticeProps, "draft" | "status" | "restore" | "now">,
): { text: string; who?: string } | null {
  const { draft, status, restore } = p;
  const kind = noticeKind(p);
  if (kind === "conflict") {
    const n = (status?.connected ? status.conflict_version : draft?.conflict_version) as number;
    return { text: `v${n} was published over unpublished changes` };
  }
  if (kind === "editing") {
    const who = status?.editors.find((e) => e.block)?.email;
    return { text: `${who ? personName(who) : "Someone"} is editing`, who };
  }
  if (kind === "draft") {
    // Who is known from the gate's draft; when, also from the room once the frame reports.
    const who = draft?.updated_by_email ?? undefined;
    const at = status?.connected ? (status.last_edit_at ?? draft?.updated_at) : draft?.updated_at;
    const by = [who && personName(who), timeAgo(at, p.now)].filter(Boolean).join(", ");
    return { text: by ? `Unpublished changes · ${by}` : "Unpublished changes", who };
  }
  if (kind === "restore") {
    return { text: `Unpublished changes from earlier in this tab, based on v${restore?.base}` };
  }
  return null;
}

export function LiveDraftNotice(props: LiveDraftNoticeProps) {
  const line = noticeText(props);
  if (!line) return null;
  return (
    <div className="pl-livenotice" role="note">
      <PencilSimpleIcon size={14} aria-hidden="true" />
      <span className="pl-livenotice__text" title={line.who}>
        {line.text}
      </span>
      {props.restore && noticeKind(props) === "restore" && (
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
