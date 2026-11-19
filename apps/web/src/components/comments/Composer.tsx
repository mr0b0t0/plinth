// New comment: Markdown text, optional pin (an element picked through the bridge, or a spot the
// page placed itself through plinth.comments), send. In request mode (Ask an agent) the same form
// asks the owner's agent for a change: "Point at something" picks the element, the text describes
// the change, and, when the owner has more than one, the person picks which agent gets it.
import { MapPinIcon, PaperPlaneRightIcon, XIcon } from "@phosphor-icons/react";
import { type ClientType, isPageAnchor, LIMITS, type PageAnchor } from "@plinth/shared";
import { type RefObject, useId } from "react";
import { Button, ICON_SIZE, IconButton, SegmentedControl } from "../ui/index.ts";
import { askTargetInText, askTargetName } from "./askTargets.ts";
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

/** The agent choice of request mode: shown only when there is more than one agent to pick. */
export function AgentChoice({
  targets,
  to,
  onTo,
  owner,
}: Pick<AskRequestProps, "targets" | "to" | "onTo" | "owner">) {
  if (targets.length < 2 || !to) return null;
  return (
    <SegmentedControl<ClientType>
      label="Send to"
      size="sm"
      value={to}
      onChange={onTo}
      options={targets.map((t) => ({ value: t, label: askTargetName(t, owner) }))}
    />
  );
}

/** The send button's words: the one agent by name, "Send" beside a choice, or a plain comment. */
export function askSendLabel(r: Pick<AskRequestProps, "targets" | "to" | "owner">): string {
  if (r.targets.length === 0 || !r.to) return "Post as a comment";
  return r.targets.length === 1 ? `Send to ${askTargetInText(r.to, r.owner)}` : "Send";
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
  const send = (
    <Button
      type="submit"
      size="sm"
      variant="primary"
      icon={PaperPlaneRightIcon}
      loading={sending}
      disabled={!value.trim()}
    >
      {asking ? askSendLabel(request) : "Comment"}
    </Button>
  );
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
          <h3 id={titleId} className="cm-ask__title">
            Ask an agent
          </h3>
          <IconButton
            size="sm"
            icon={XIcon}
            label="Write a comment instead"
            onClick={request.onLeave}
          />
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
          hideLabel
          hint={
            asking ? undefined : "Markdown works. Type @ to ask an agent. Ctrl or ⌘ + Enter sends."
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
        {asking ? (
          <div className="cm-actions__send">
            <AgentChoice {...request} />
            {send}
          </div>
        ) : (
          send
        )}
      </div>
    </form>
  );
}
