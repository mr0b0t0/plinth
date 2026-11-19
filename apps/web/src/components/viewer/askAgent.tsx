// Ask an agent (docs/spec.md "Ask an agent"): a person describes a change, optionally points at a
// place on the page, and the request goes to the owner's connected agent as an ordinary mention
// comment with `request_to`. The server decides who may ask (the gate's `ask` part, policy
// "mention": the owner, editors and commenters, never viewers) and where it can go (`ask.targets`,
// client types only).
//
// Where it appears, from this file's items:
// - the bar's Edit slot (owners and editors, at desktop width) for a type people change by asking
//   (registry `edit: "ask"`: HTML pages, designs, and decks and design systems until they edit on
//   the page) and for any type whose editing on the page is off here (`live_off`, with its reason);
// - the ⋯ menu everywhere else it may be used: commenters, phone width, and live types whose
//   editing is on;
// - the strip, as the `?edit` notices (editing off here, or a commenter).
//
// Not editing, it opens the comments panel in request mode (one reload into review mode, which the
// bridge pick needs; nothing is unpublished then). In edit mode it opens the Ask dialog instead
// (AskDialog.tsx), which leaves the frame, its draft and edit mode as they are.
import { RobotIcon } from "@phosphor-icons/react";
import {
  type ClientType,
  type LiveOffReason,
  type PageAnchor,
  typeDef,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "../ui/index.ts";
import { AskDialog } from "./AskDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageContext, StageDialog, StageNode } from "./stageItems.tsx";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** The dialog's id in STAGE_DIALOGS. */
export const ASK_DIALOG = "ask-agent";

/** Why editing on the page is off, as the Edit slot and the `?edit` notice say it. */
export const LIVE_OFF_TEXT: Record<LiveOffReason, string> = {
  disabled: "Editing on the page is turned off on this Plinth instance.",
  isolation: "Editing on the page isn't available with this instance's content isolation.",
};

/** What the `?edit` notice tells a commenter. */
export const COMMENTER_EDIT_TEXT =
  "Only the owner and editors can edit this page. You can ask an agent to change it.";

/** A place on the page the renderer named (an in-frame `ask`), as the comments API takes it. */
export type AskAnchor = PageAnchor;

export function pageAnchorOf(a: { key: string; text: string } | null): AskAnchor | null {
  return a ? { kind: "page", key: a.key, ...(a.text ? { text: a.text } : {}) } : null;
}

/** The `?edit` notice: why this person cannot edit here, with Ask an agent. */
export type EditNotice = { kind: "live_off"; reason: LiveOffReason } | { kind: "commenter" };

/** What `?edit` does for this gate: a notice, focus on "Sign in to edit", or nothing. */
export function editArrival(gate: OkGate): EditNotice | "sign_in" | null {
  if (gate.live_off) return { kind: "live_off", reason: gate.live_off.reason };
  if (gate.live?.sign_in) return "sign_in";
  if (gate.role === "commenter" && gate.ask) return { kind: "commenter" };
  return null;
}

export interface AskAgent {
  /** This person may ask the owner's agents here (the gate's `ask` part). */
  available: boolean;
  /** Ask an agent takes the bar's Edit slot (an `ask` type, or editing on the page is off). */
  inSlot: boolean;
  /** Why editing on the page is off, in words, or null. */
  reason: string | null;
  targets: ClientType[];
  /** Open Ask an agent: the Ask dialog in edit mode, the comments panel in request mode otherwise. */
  open(anchor?: AskAnchor | null): void;
  /** The anchor the Ask dialog opened with (edit mode), or null for the whole page. */
  dialogAnchor: AskAnchor | null;
  /** The `?edit` notice, or null. */
  notice: EditNotice | null;
  dismissNotice(): void;
}

/** Remove one search parameter from the address, keeping the rest and the history entry. */
function dropParam(name: string): boolean {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return false;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

export function useAskAgent({
  gate,
  editing,
  openDialog,
  openRequest,
  focusSignIn,
}: {
  gate: OkGate;
  editing: boolean;
  openDialog: (id: string) => void;
  /** Open the comments panel in request mode, with an anchor when one was given. */
  openRequest: (anchor: AskAnchor | null) => void;
  /** `?edit` for an editor who must sign in first: focus "Sign in to edit". */
  focusSignIn: () => void;
}): AskAgent {
  const available = gate.ask !== undefined;
  const def = typeDef(gate.artifact.type);
  const inSlot = available && (def?.edit === "ask" || gate.live_off !== undefined);
  const reason = gate.live_off ? LIVE_OFF_TEXT[gate.live_off.reason] : null;
  const [dialogAnchor, setDialogAnchor] = useState<AskAnchor | null>(null);
  const [notice, setNotice] = useState<EditNotice | null>(null);

  const latest = useRef({ editing, openDialog, openRequest, available });
  latest.current = { editing, openDialog, openRequest, available };
  const open = useCallback((anchor: AskAnchor | null = null) => {
    const l = latest.current;
    if (!l.available) return;
    setNotice(null);
    if (l.editing) {
      setDialogAnchor(anchor);
      l.openDialog(ASK_DIALOG);
    } else {
      l.openRequest(anchor);
    }
  }, []);

  // `?ask` and `?edit` are read once, when the page opens, and dropped from the address so a
  // reload or a shared copy of it opens the page as usual.
  const arrival = useRef<{ ask: boolean; edit: boolean } | null>(null);
  if (arrival.current === null) {
    const q = new URLSearchParams(window.location.search);
    arrival.current = { ask: q.has("ask"), edit: q.has("edit") };
  }
  const handled = useRef(false);
  const focusRef = useRef(focusSignIn);
  focusRef.current = focusSignIn;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, with the first gate
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const { ask, edit } = arrival.current ?? { ask: false, edit: false };
    if (ask) dropParam("ask");
    if (edit) {
      // With `live` the page starts editing (New and Import); every other case is here. A viewer
      // gets nothing, since no control ever offered them Edit.
      const what = editArrival(gate);
      if (what === "sign_in") requestAnimationFrame(() => focusRef.current());
      else if (what) setNotice(what);
      if (!gate.live || gate.live.sign_in) dropParam("edit");
    }
    if (ask && available) open(null);
  }, []);

  return {
    available,
    inSlot,
    reason,
    targets: gate.ask?.targets ?? [],
    open,
    dialogAnchor,
    notice,
    dismissNotice: () => setNotice(null),
  };
}

// ---------- the bar, the menu, the strip and the dialog ----------

const mayEdit = (c: StageContext) => c.gate.role === "owner" || c.gate.role === "editor";

/** In the bar's Edit slot: owners and editors at desktop width, where Edit is not offered. */
const inBar = (c: StageContext) => c.ask.inSlot && mayEdit(c) && !c.compact;

export const askAgentButton: StageNode = (c) =>
  inBar(c) && (
    <Tooltip content={c.ask.reason ?? "Ask an agent to change this page"} placement="bottom">
      <Button
        variant="ghost"
        icon={RobotIcon}
        aria-label="Ask an agent"
        className="pl-viewer__ask"
        onClick={() => c.ask.open(null)}
      />
    </Tooltip>
  );

/** The ⋯ item, wherever Ask an agent may be used and the bar does not offer it. */
export const askAgentMenu: MenuItem = (c) =>
  c.ask.available && !inBar(c)
    ? [{ label: "Ask an agent", icon: RobotIcon, onSelect: () => c.ask.open(null) }]
    : [];

/** `?edit` where this person cannot edit on the page: why, and Ask an agent. */
export const editNotice: StageNode = (c) => {
  const n = c.ask.notice;
  if (!n || c.editing) return null;
  const text =
    n.kind === "live_off"
      ? `${LIVE_OFF_TEXT[n.reason]} Ask an agent to make the change.`
      : COMMENTER_EDIT_TEXT;
  return (
    <div className="pl-livenotice pl-livenotice--ask" role="status">
      <span className="pl-livenotice__text">{text}</span>
      <span className="pl-livenotice__actions">
        <Button size="sm" variant="secondary" icon={RobotIcon} onClick={() => c.ask.open(null)}>
          Ask an agent
        </Button>
        <Button size="sm" variant="ghost" onClick={c.ask.dismissNotice}>
          Dismiss
        </Button>
      </span>
    </div>
  );
};

export const askAgentDialog: StageDialog = {
  id: ASK_DIALOG,
  render: (c, close) => (
    <AskDialog
      artifactId={c.gate.artifact.id}
      targets={c.ask.targets}
      owner={c.gate.role === "owner"}
      anchor={c.ask.dialogAnchor}
      live={c.live}
      version={c.live.status?.base_version || c.gate.artifact.version}
      onClose={close}
    />
  ),
};
