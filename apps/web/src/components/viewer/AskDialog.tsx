// The Ask dialog: Ask an agent while editing on the page (docs/spec.md "Ask an agent"). It is a
// modal in the app and changes nothing in the frame: no review mode, no reload, the comments panel
// stays closed, and the frame keeps edit mode and its draft (the renderer released its own lease
// before it asked). The request is an ordinary comment with `request_to`, posted against the
// version being edited, or, with "Publish my changes first" (off by default), against the version
// that Publish makes. When that Publish does not succeed, nothing is posted: the dialog says why
// and offers to post without publishing. It matches the request composer: the same "Pointing at"
// chip, and the same agent choice ("Ask: Claude | Codex") under the description, so the footer
// holds only Cancel and Send.
import {
  API,
  type ClientType,
  type CommentInfo,
  LIMITS,
  route,
  type ViewGate,
} from "@plinth/shared";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { askTargetInText } from "../comments/askTargets.ts";
import { AgentChoice, askSendLabel, PointingChip } from "../comments/Composer.tsx";
import "../comments/comments.css";
import { Button, Checkbox, Dialog, showToast, Textarea } from "../ui/index.ts";
// Types only: askAgent.tsx imports this file.
import type { AskAnchor } from "./askAgent.tsx";
import type { LiveEdit } from "./useLiveEdit.ts";

export interface AskDialogProps {
  artifactId: string;
  /** The gate's `ask.targets`. */
  targets: ClientType[];
  /** The viewer owns the artifact ("My other agent"). */
  owner: boolean;
  /** The place the renderer named (an in-frame `ask`), or null for the whole page. */
  anchor: AskAnchor | null;
  live: Pick<LiveEdit, "status" | "mode" | "publishFirst">;
  /** The version being edited. */
  version: number;
  onClose: () => void;
}

/** The words a refused comment gets in the dialog; `stale` when the agent went away meanwhile. */
function postError(e: unknown): { text: string; stale: boolean } {
  if (e instanceof ApiRequestError) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (e.status === 400 && reason === "no_agent") {
      return {
        text: "That agent was disconnected. Pick another, or post as a comment.",
        stale: true,
      };
    }
    if (e.status === 401)
      return { text: "Sign in again to ask. Nothing was posted.", stale: false };
    if (e.status === 403) {
      return { text: "You can no longer ask an agent here. Nothing was posted.", stale: false };
    }
    if (e.status === 429) {
      return { text: "You are commenting too fast. Try again in a while.", stale: false };
    }
    if (e.status === 400) return { text: e.message, stale: false };
  }
  return { text: "That did not work. Try again.", stale: false };
}

export function AskDialog({
  artifactId,
  targets: initialTargets,
  owner,
  anchor: initialAnchor,
  live,
  version,
  onClose,
}: AskDialogProps) {
  const formId = useId();
  // The place it is about; "Stop pointing" makes it about the whole page.
  const [anchor, setAnchor] = useState(initialAnchor);
  const [targets, setTargets] = useState(initialTargets);
  const [to, setTo] = useState<ClientType | null>(initialTargets[0] ?? null);
  const [body, setBody] = useState("");
  const [publishFirst, setPublishFirst] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Publish first did not succeed: why, in the strip's words. Nothing was posted. */
  const [unpublished, setUnpublished] = useState<string | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const dirty = live.status?.dirty === true;
  const others = live.mode === "room" && (live.status?.editors.length ?? 0) > 0;
  const firstHint = `Otherwise the agent works from v${version}.${
    others ? " This also publishes the others' changes." : ""
  }`;

  const refreshTargets = async () => {
    try {
      const g = await api<ViewGate>(route(API.view, { ref: artifactId }));
      if (!alive.current || g.status !== "ok") return;
      const next = g.ask?.targets ?? [];
      setTargets(next);
      setTo((t) => (t && next.includes(t) ? t : (next[0] ?? null)));
    } catch {
      // Offline: the person can try again or post as a comment.
    }
  };

  const post = async (opts: { skipPublish: boolean }) => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      let at = version;
      if (publishFirst && dirty && !opts.skipPublish) {
        const r = await live.publishFirst();
        if (!alive.current) return;
        if ("error" in r) {
          setUnpublished(r.error);
          return;
        }
        at = r.version;
      }
      setUnpublished(null);
      const target = targets.length > 0 ? to : null;
      await api<CommentInfo>(route(API.comments, { ref: artifactId }), {
        method: "POST",
        body: {
          body: text,
          version_number: at,
          ...(anchor ? { anchor } : {}),
          ...(target ? { request_to: target } : {}),
        },
      });
      showToast({
        title: target ? `Request sent to ${askTargetInText(target, owner)}` : "Posted as a comment",
        tone: "success",
      });
      onClose();
    } catch (e) {
      if (!alive.current) return;
      const why = postError(e);
      setError(why.text);
      if (why.stale) void refreshTargets();
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void post({ skipPublish: false });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Ask an agent"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {unpublished ? (
            <Button
              variant="primary"
              loading={sending}
              onClick={() => void post({ skipPublish: true })}
            >
              Post without publishing
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              form={formId}
              loading={sending}
              disabled={!body.trim()}
            >
              {askSendLabel({ targets, to, owner })}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="pl-ask">
        {anchor && (
          <PointingChip text={anchor.text || anchor.key} onRemove={() => setAnchor(null)} />
        )}
        <Textarea
          label="What should change?"
          hideLabel
          placeholder="Describe the change…"
          value={body}
          rows={4}
          maxLength={LIMITS.maxCommentLength}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void post({ skipPublish: false });
            }
          }}
        />
        <AgentChoice targets={targets} to={to} onTo={setTo} owner={owner} />
        {dirty && (
          <Checkbox
            label="Publish my changes first"
            hint={firstHint}
            checked={publishFirst}
            onChange={(e) => setPublishFirst(e.target.checked)}
          />
        )}
        {unpublished && (
          <p className="pl-ask__error" role="alert">
            Nothing was sent. {unpublished}
          </p>
        )}
        {error && (
          <p className="pl-ask__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
