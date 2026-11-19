// New comment: Markdown text, optional pin (an element picked through the bridge, or a spot the
// page placed itself through plinth.comments), send.
import { MapPinIcon, PaperPlaneRightIcon, XIcon } from "@phosphor-icons/react";
import { isPageAnchor, LIMITS, type PageAnchor } from "@plinth/shared";
import type { RefObject } from "react";
import { Button, ICON_SIZE, IconButton } from "../ui/index.ts";
import type { PickedAnchor } from "./bridge.ts";
import { MentionTextarea } from "./MentionTextarea.tsx";
import { excerpt } from "./model.ts";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  anchor: PickedAnchor | PageAnchor | null;
  onRemoveAnchor: () => void;
  picking: boolean;
  /** The bridge can be reached (a frame and a content origin are known). */
  canPin: boolean;
  /** Pick an element. Absent when the page anchors its own comments: no pick button then. */
  onStartPick?: () => void;
  onCancelPick: () => void;
  onSubmit: () => void;
  sending: boolean;
  error?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/** The chip's words. Anchor text is untrusted: it is only ever rendered as text. */
function chipText(anchor: PickedAnchor | PageAnchor) {
  if (isPageAnchor(anchor)) {
    return (
      <>
        Placed by the page: <q>{excerpt(anchor.text || anchor.key, 40)}</q>
      </>
    );
  }
  return anchor.text?.trim() ? (
    <>
      Pinned to <q>{excerpt(anchor.text, 40)}</q>
    </>
  ) : (
    "Pinned to an element"
  );
}

export function Composer({
  value,
  onChange,
  anchor,
  onRemoveAnchor,
  picking,
  canPin,
  onStartPick,
  onCancelPick,
  onSubmit,
  sending,
  error,
  textareaRef,
}: ComposerProps) {
  return (
    <form
      className="cm-composer"
      aria-label="New comment"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {picking ? (
        <div className="cm-picking" role="status">
          <MapPinIcon size={ICON_SIZE.md} aria-hidden="true" />
          <p>Click an element in the artifact (Esc to cancel)</p>
          <Button size="sm" variant="ghost" onClick={onCancelPick}>
            Cancel
          </Button>
        </div>
      ) : anchor ? (
        <div className="cm-anchor-chip">
          <MapPinIcon size={ICON_SIZE.sm} aria-hidden="true" />
          <span className="cm-anchor-chip__text">{chipText(anchor)}</span>
          <IconButton size="sm" icon={XIcon} label="Remove pin" onClick={onRemoveAnchor} />
        </div>
      ) : null}
      <div className="cm-composer__field" hidden={picking}>
        <MentionTextarea
          label="New comment"
          hideLabel
          hint="Markdown works. Type @ to ask an agent. Ctrl or ⌘ + Enter sends."
          error={error}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Add a comment…"
          rows={2}
          textareaRef={textareaRef}
          maxLength={LIMITS.maxCommentLength}
        />
      </div>
      <div className="cm-actions" hidden={picking}>
        {!anchor && onStartPick && (
          <Button
            size="sm"
            variant="ghost"
            icon={MapPinIcon}
            onClick={onStartPick}
            disabled={!canPin}
          >
            Pin to an element
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          variant="primary"
          icon={PaperPlaneRightIcon}
          loading={sending}
          disabled={!value.trim()}
        >
          Comment
        </Button>
      </div>
    </form>
  );
}
