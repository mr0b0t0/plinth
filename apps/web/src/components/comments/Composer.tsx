// New comment: Markdown text, optional pin (an element picked through the bridge, or a spot the
// page placed itself through plinth.comments), send. In request mode (Ask an agent) the same form
// asks the owner's agent for a change: "Point at something" picks the element, the text describes
// the change, and the person picks which of the owner's agents gets it.
import { MapPinIcon, PaperPlaneRightIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { type ClientType, isPageAnchor, LIMITS, type PageAnchor } from "@plinth/shared";
import { type RefObject, useId } from "react";
import { Button, ICON_SIZE, IconButton } from "../ui/index.ts";
import { askTargetName } from "./askTargets.ts";
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
  /** Request mode (Ask an agent): the agents the request can go to, and the one chosen. */
  request?: AskRequestProps;
}

export interface AskRequestProps {
  /** The gate's `ask.targets`; empty: the request is posted as a plain comment. */
  targets: ClientType[];
  to: ClientType | null;
  onTo: (t: ClientType) => void;
  /** The viewer owns the artifact ("My other agent"). */
  owner: boolean;
  /** Back to a plain comment. */
  onLeave: () => void;
}

/** The agent choice of request mode, as radio buttons (or why there is none). */
function AgentChoice({ request }: { request: AskRequestProps }) {
  const name = `cm-ask-to-${useId()}`;
  if (request.targets.length === 0) {
    return (
      <p className="cm-note cm-ask__none">
        The owner has no agent connected to take requests yet. Your request will be posted as a
        comment.
      </p>
    );
  }
  return (
    <fieldset className="cm-ask__to">
      <legend className="cm-ask__legend">Send to</legend>
      {request.targets.map((t) => (
        <label key={t} className="cm-ask__option">
          <input
            type="radio"
            name={name}
            value={t}
            checked={request.to === t}
            onChange={() => request.onTo(t)}
          />
          <span>{askTargetName(t, request.owner)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The chip's words. Anchor text is untrusted: it is only ever rendered as text. */
function chipText(anchor: PickedAnchor | PageAnchor, asking: boolean) {
  if (asking) {
    const text = isPageAnchor(anchor) ? anchor.text || anchor.key : anchor.text?.trim();
    return text ? (
      <>
        Pointing at <q>{excerpt(text, 40)}</q>
      </>
    ) : (
      "Pointing at an element"
    );
  }
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
  request,
}: ComposerProps) {
  const asking = request !== undefined;
  const titleId = useId();
  return (
    <form
      className={`cm-composer${asking ? " cm-composer--ask" : ""}`}
      {...(asking ? { "aria-labelledby": titleId } : { "aria-label": "New comment" })}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {asking && (
        <div className="cm-ask__head">
          <RobotIcon size={ICON_SIZE.md} aria-hidden="true" />
          <h3 id={titleId} className="cm-ask__title">
            Ask an agent to change this page
          </h3>
          <Button size="sm" variant="ghost" onClick={request.onLeave}>
            Write a comment instead
          </Button>
        </div>
      )}
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
          <span className="cm-anchor-chip__text">{chipText(anchor, asking)}</span>
          <IconButton
            size="sm"
            icon={XIcon}
            label={asking ? "Stop pointing" : "Remove pin"}
            onClick={onRemoveAnchor}
          />
        </div>
      ) : null}
      <div className="cm-composer__field" hidden={picking}>
        <MentionTextarea
          label={asking ? "What should change?" : "New comment"}
          hideLabel={!asking}
          hint={
            asking
              ? "Describe the change. Ctrl or ⌘ + Enter sends."
              : "Markdown works. Type @ to ask an agent. Ctrl or ⌘ + Enter sends."
          }
          error={error}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={asking ? "Describe the change…" : "Add a comment…"}
          rows={2}
          textareaRef={textareaRef}
          maxLength={LIMITS.maxCommentLength}
        />
      </div>
      {asking && !picking && <AgentChoice request={request} />}
      <div className="cm-actions" hidden={picking}>
        {!anchor && onStartPick && (
          <Button
            size="sm"
            variant="ghost"
            icon={MapPinIcon}
            onClick={onStartPick}
            disabled={!canPin}
          >
            {asking ? "Point at something" : "Pin to an element"}
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
          {asking ? (request.targets.length > 0 ? "Send request" : "Post as a comment") : "Comment"}
        </Button>
      </div>
    </form>
  );
}
