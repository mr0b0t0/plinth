// New comment: Markdown text, optional pin (an element picked through the bridge, a spot the page
// placed itself through plinth.comments, or the place a renderer's "Comment" named), send. People
// ask an agent here by mentioning it ("@claude"): the text area suggests the owner's agents.
import { MapPinIcon, PaperPlaneRightIcon, XIcon } from "@phosphor-icons/react";
import { type ClientType, isPageAnchor, LIMITS, type PageAnchor } from "@plinth/shared";
import type { RefObject } from "react";
import { Button, ICON_SIZE, IconButton } from "../ui/index.ts";
import type { AskWhat } from "../viewer/rendererProtocol.ts";
import type { PickedAnchor } from "./bridge.ts";
import { MentionTextarea } from "./MentionTextarea.tsx";
import { excerpt } from "./model.ts";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  anchor: PickedAnchor | PageAnchor | null;
  /**
   * What kind of block a renderer's place is, for a place with no words ("Pinned to the divider").
   * Null for every other anchor.
   */
  anchorWhat?: AskWhat | null;
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
  /** The owner's agents a mention can reach (the gate's `ask.targets`), for the suggestions. */
  agents?: readonly ClientType[];
}

/**
 * The chip's words. A renderer's place (`what` given) reads as its words, or the kind of block for
 * one with none ("Pinned to the divider"); "New image below …" for a doc's Insert below, Image
 * (`…:add-image`), which is not about an image there; and "(not published yet)" after a block
 * only in the draft (`new-…`). Anchor text is untrusted: only ever rendered as text.
 */
function chipText(anchor: PickedAnchor | PageAnchor, what: AskWhat | null) {
  const words = anchor.text?.trim();
  const quoted = (label: string) => (
    <q>
      <bdi>{excerpt(label, 40)}</bdi>
    </q>
  );
  if (isPageAnchor(anchor) && what) {
    const target = words ? quoted(words) : what !== "block" ? `the ${what}` : "this block";
    return (
      <>
        {anchor.key.endsWith(":add-image") ? "New image below" : "Pinned to"} {target}
        {anchor.key.startsWith("new-") ? " (not published yet)" : ""}
      </>
    );
  }
  const label = isPageAnchor(anchor) ? words || anchor.key : words;
  return label ? <>Pinned to {quoted(label)}</> : "Pinned to an element";
}

export function Composer({
  value,
  onChange,
  anchor,
  anchorWhat = null,
  onRemoveAnchor,
  picking,
  canPin,
  onStartPick,
  onCancelPick,
  onSubmit,
  sending,
  error,
  textareaRef,
  agents,
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
          <span className="cm-anchor-chip__text">{chipText(anchor, anchorWhat)}</span>
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
          agents={agents}
        />
      </div>
      <div className="cm-actions" hidden={picking}>
        {!anchor && onStartPick ? (
          <Button
            size="sm"
            variant="ghost"
            icon={MapPinIcon}
            onClick={onStartPick}
            disabled={!canPin}
          >
            Pin to an element
          </Button>
        ) : null}
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
