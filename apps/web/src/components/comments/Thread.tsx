// One comment thread: the root comment, its replies, a reply box and Resolve / Reopen.
import {
  ArrowBendUpLeftIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  MapPinIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import {
  APP_ROUTES,
  type ClientType,
  type CommentInfo,
  isPageAnchor,
  REQUEST_TARGET_LABELS,
  renderMarkdown,
  route,
} from "@plinth/shared";
import { useMemo, useRef, useState } from "react";
import { Link } from "../../lib/router.tsx";
import { Button, ICON_SIZE } from "../ui/index.ts";
import { MentionTextarea } from "./MentionTextarea.tsx";
import { anchorLabel, fullTime, relativeTime, type Thread as ThreadData } from "./model.ts";

type Mention = CommentInfo["mentions"][number];

/** Mention task state, in words. "done" links the version the agent published. */
/**
 * A request's state in words: a pending one says whether an agent session was woken for it
 * ("sent") or none has it yet ("waiting"), docs/spec.md "Mention wake-ups".
 */
export function mentionStateLabel(m: Pick<Mention, "state" | "delivery">): string {
  return m.state === "pending" && m.delivery ? m.delivery : m.state;
}

export function MentionChip({ mention, slug }: { mention: Mention; slug: string }) {
  const { state, target, result_version: v } = mention;
  const published = state === "done" && v;
  return (
    <li className={`cm-chip cm-chip--${state}`} data-state={state}>
      {published ? (
        <ClockCounterClockwiseIcon size={ICON_SIZE.xs} aria-hidden="true" />
      ) : (
        <RobotIcon size={ICON_SIZE.xs} aria-hidden="true" />
      )}
      <span className="cm-chip__target">
        {target === REQUEST_TARGET_LABELS.other ? "The owner's other agent" : target}
      </span>
      <span className="cm-chip__state">
        {published ? (
          <>
            done<span className="visually-hidden">,</span> <span aria-hidden="true">·</span>{" "}
            published{" "}
            <Link to={route(APP_ROUTES.artifactVersion, { slug, n: v })} className="cm-chip__link">
              v{v}
            </Link>
          </>
        ) : (
          mentionStateLabel(mention)
        )}
      </span>
    </li>
  );
}

/** Two capitals for a comment author's avatar. */
export function authorInitials(label: string): string {
  const words = label
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length > 1) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  const w = words[0] ?? "?";
  return (w.charAt(0).toUpperCase() + w.charAt(1).toLowerCase()).trim() || "?";
}

function CommentBody({ body }: { body: string }) {
  // renderMarkdown escapes the whole source first; its output is the only HTML we inject.
  const html = useMemo(() => renderMarkdown(body), [body]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: escape-first renderer from @plinth/shared
  return <div className="cm-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CommentItem({
  comment,
  slug,
  version,
}: {
  comment: CommentInfo;
  slug: string;
  version: number;
}) {
  const isAgent = comment.author.connection_id !== null;
  return (
    <div className="cm-comment" data-agent={isAgent || undefined}>
      {/* People get a round avatar, agents a square one. */}
      <span className={`cm-avatar${isAgent ? " cm-avatar--agent" : ""}`} aria-hidden="true">
        {authorInitials(comment.author.label)}
      </span>
      <p className="cm-meta">
        <span className="cm-author">
          <span className="cm-author__name">{comment.author.label}</span>
          {isAgent && <span className="cm-agent">Agent</span>}
          {/* From the server, never the name: a name chosen to look like the owner's lacks it. */}
          {!isAgent && comment.author.is_owner && <span className="cm-agent">Owner</span>}
        </span>
        <time
          className="cm-time"
          dateTime={comment.created_at}
          title={fullTime(comment.created_at)}
        >
          {relativeTime(comment.created_at)}
        </time>
        {comment.version_number !== version && (
          <span className="cm-version">on v{comment.version_number}</span>
        )}
      </p>
      <CommentBody body={comment.body} />
      {comment.mentions.length > 0 && (
        <ul className="cm-chips" aria-label="Agent requests">
          {comment.mentions.map((m) => (
            <MentionChip key={m.task_id} mention={m} slug={slug} />
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ThreadProps {
  thread: ThreadData;
  slug: string;
  version: number;
  active: boolean;
  /** Writing is blocked (signed out or no comment right): hide the controls. */
  readOnly: boolean;
  onActivate: (id: string) => void;
  onReply: (rootId: string, body: string) => Promise<boolean>;
  onSetStatus: (rootId: string, status: "open" | "resolved") => Promise<void>;
  /** The owner's agents a mention can reach (the gate's `ask.targets`), for the suggestions. */
  agents?: readonly ClientType[];
}

export function Thread({
  thread,
  slug,
  version,
  active,
  readOnly,
  onActivate,
  onReply,
  onSetStatus,
  agents,
}: ThreadProps) {
  const { root, replies, pin } = thread;
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const replyButton = useRef<HTMLButtonElement | null>(null);
  const resolved = root.status === "resolved";
  const headingId = `cm-thread-${root.id}-title`;

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const ok = await onReply(root.id, draft.trim());
    setSending(false);
    if (ok) {
      setDraft("");
      setReplying(false);
      requestAnimationFrame(() => replyButton.current?.focus());
    }
  };

  return (
    <article
      className="cm-thread"
      id={`cm-thread-${root.id}`}
      data-thread-id={root.id}
      data-active={active || undefined}
      data-status={root.status}
      aria-labelledby={headingId}
      tabIndex={-1}
      onFocus={() => onActivate(root.id)}
      onPointerDown={() => onActivate(root.id)}
    >
      <h3 id={headingId} className="visually-hidden">
        {pin ? `Comment ${pin}` : "Comment"} by {root.author.label}
        {resolved ? ", resolved" : ""}
      </h3>
      {(pin || resolved) && (
        <div className="cm-thread__tags">
          {pin && root.anchor && (
            <span className="cm-anchor">
              <span className="cm-pin-num" aria-hidden="true">
                {pin}
              </span>
              <MapPinIcon size={ICON_SIZE.sm} aria-hidden="true" />
              <span className="cm-anchor__text">
                <span className="visually-hidden">Pinned to </span>
                {root.anchor.text?.trim() || isPageAnchor(root.anchor) ? (
                  // Isolated, so the page's text cannot reorder what is around it.
                  <>
                    “<bdi>{anchorLabel(root.anchor)}</bdi>”
                  </>
                ) : (
                  "Pinned to an element"
                )}
              </span>
            </span>
          )}
          {resolved && (
            <span className="cm-resolved">
              <CheckIcon size={ICON_SIZE.sm} aria-hidden="true" />
              Resolved
            </span>
          )}
        </div>
      )}
      <CommentItem comment={root} slug={slug} version={version} />
      {replies.length > 0 && (
        <ol className="cm-replies" aria-label="Replies">
          {replies.map((r) => (
            <li key={r.id}>
              <CommentItem comment={r} slug={slug} version={version} />
            </li>
          ))}
        </ol>
      )}
      {!readOnly && replying && (
        <div className="cm-reply">
          <MentionTextarea
            label="Reply"
            hideLabel
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            placeholder="Reply…"
            rows={2}
            textareaRef={replyRef}
            agents={agents}
          />
          <div className="cm-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplying(false);
                setDraft("");
                requestAnimationFrame(() => replyButton.current?.focus());
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={sending}
              disabled={!draft.trim()}
              onClick={send}
            >
              Send reply
            </Button>
          </div>
        </div>
      )}
      {!readOnly && !replying && (
        <div className="cm-actions cm-actions--thread">
          <Button
            ref={replyButton}
            size="sm"
            variant="ghost"
            icon={ArrowBendUpLeftIcon}
            onClick={() => {
              setReplying(true);
              requestAnimationFrame(() => replyRef.current?.focus());
            }}
          >
            Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={resolved ? ArrowCounterClockwiseIcon : CheckIcon}
            loading={statusBusy}
            onClick={async () => {
              setStatusBusy(true);
              await onSetStatus(root.id, resolved ? "open" : "resolved");
              setStatusBusy(false);
            }}
          >
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        </div>
      )}
    </article>
  );
}
