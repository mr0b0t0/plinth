// New comment: Markdown text, optional pin (an element picked through the bridge, or a spot the
// page placed itself through plinth.comments), send. In request mode (Ask an agent) the same form
// asks the owner's agent for a change: the text describes the change, then one row holds the agent
// choice on the left ("Ask Claude | Codex", when the owner has more than one) and, on the right,
// "Point at something" (an icon button) and Send. Picking shows one short line, "Pick an element",
// and Cancel (Esc also cancels). The form has no visible title (its name, "Ask an agent", is for
// assistive technology) and no close button of its own: closing the panel ends request mode.
import { MapPinIcon, PaperPlaneRightIcon, XIcon } from "@phosphor-icons/react";
import { type ClientType, isPageAnchor, LIMITS, type PageAnchor } from "@plinth/shared";
import type { RefObject } from "react";
import { Button, ICON_SIZE, IconButton, SegmentedControl, Select, Tooltip } from "../ui/index.ts";
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
}

/**
 * The agent choice of request mode, labelled "Ask": two agents are a segmented control, three a
 * select. None when there is only one agent to pick.
 */
export function AgentChoice({
  targets,
  to,
  onTo,
  owner,
}: Pick<AskRequestProps, "targets" | "to" | "onTo" | "owner">) {
  if (targets.length < 2 || !to) return null;
  const options = targets.map((t) => ({ value: t, label: askTargetName(t, owner) }));
  if (targets.length > 2) {
    return (
      <Select
        label="Ask"
        className="cm-ask-to cm-ask-to--select"
        value={to}
        onChange={(e) => onTo(e.target.value as ClientType)}
        options={options}
      />
    );
  }
  return (
    <SegmentedControl<ClientType>
      label="Ask"
      showLabel
      size="sm"
      className="cm-ask-to"
      value={to}
      onChange={onTo}
      options={options}
    />
  );
}

/** The send button's words: the one agent by name, "Send" beside a choice, or a plain comment. */
export function askSendLabel(r: Pick<AskRequestProps, "targets" | "to" | "owner">): string {
  if (r.targets.length === 0 || !r.to) return "Post as a comment";
  return r.targets.length === 1 ? `Send to ${askTargetInText(r.to, r.owner)}` : "Send";
}

/**
 * The place a request is about, in the comments panel and the Ask dialog alike: "Pointing at …"
 * with a button to drop it (the request is then about the whole page). `text` is untrusted: it is
 * only ever rendered as text.
 */
export function PointingChip({
  text,
  onRemove,
}: {
  text: string | undefined;
  onRemove: () => void;
}) {
  const label = text?.trim();
  return (
    <div className="cm-anchor-chip">
      <MapPinIcon size={ICON_SIZE.sm} aria-hidden="true" />
      <span className="cm-anchor-chip__text">
        {label ? (
          <>
            Pointing at <q>{excerpt(label, 40)}</q>
          </>
        ) : (
          "Pointing at an element"
        )}
      </span>
      <IconButton size="sm" icon={XIcon} label="Stop pointing" onClick={onRemove} />
    </div>
  );
}

/** The chip's words, the same for both kinds. Anchor text is untrusted: only ever rendered as text. */
function chipText(anchor: PickedAnchor | PageAnchor) {
  const label = isPageAnchor(anchor) ? anchor.text?.trim() || anchor.key : anchor.text?.trim();
  return label ? (
    <>
      Pinned to{" "}
      <q>
        <bdi>{excerpt(label, 40)}</bdi>
      </q>
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
      aria-label={asking ? "Ask an agent" : "New comment"}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {picking ? (
        <div className="cm-picking" role="status">
          <MapPinIcon size={ICON_SIZE.md} aria-hidden="true" />
          <p>{asking ? "Pick an element" : "Click an element in the artifact (Esc to cancel)"}</p>
          <Button size="sm" variant="ghost" onClick={onCancelPick}>
            Cancel
          </Button>
        </div>
      ) : anchor && asking ? (
        <PointingChip
          text={isPageAnchor(anchor) ? anchor.text || anchor.key : anchor.text}
          onRemove={onRemoveAnchor}
        />
      ) : anchor ? (
        <div className="cm-anchor-chip">
          <MapPinIcon size={ICON_SIZE.sm} aria-hidden="true" />
          <span className="cm-anchor-chip__text">{chipText(anchor)}</span>
          <IconButton size="sm" icon={XIcon} label="Remove pin" onClick={onRemoveAnchor} />
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
      {asking ? (
        <div className="cm-actions" hidden={picking}>
          <AgentChoice {...request} />
          <div className="cm-actions__send">
            {!anchor && onStartPick && (
              <Tooltip content="Point at something">
                <IconButton
                  size="sm"
                  icon={MapPinIcon}
                  label="Point at something"
                  onClick={onStartPick}
                  disabled={!canPin}
                />
              </Tooltip>
            )}
            {send}
          </div>
        </div>
      ) : (
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
          {send}
        </div>
      )}
    </form>
  );
}
