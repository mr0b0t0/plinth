// Ask an agent (docs/spec.md "Ask an agent"): a person describes a change, optionally points at a
// place on the page, and the request goes to the owner's connected agent as an ordinary mention
// comment with `request_to`. The server decides who may ask (the gate's `ask` part, policy
// "mention": the owner, editors and commenters, never viewers) and where it can go (`ask.targets`,
// client types only).
//
// It is offered only when the owner has an agent that can take the request. Where it appears,
// from this file's items (one place each time):
// - the bar's Edit slot (owners and editors, at desktop width) for a type people change by asking
//   (registry `edit: "ask"`: HTML pages, designs and design systems; and an HTML deck, `no_editor`)
//   and for any type whose editing on the page is off here (`live_off`, with its reason);
// - the ⋯ menu everywhere else it may be used: commenters, phone width, and live types whose
//   editing is on.
//
// Not editing, it opens the comments panel in request mode (one reload into review mode, which the
// bridge pick needs; nothing is unpublished then). In edit mode it opens the Ask dialog instead
// (AskDialog.tsx), which leaves the frame, its draft and edit mode as they are.
import { RobotIcon } from "@phosphor-icons/react";
import {
  type ClientType,
  type LiveOffReason,
  PAGE_COMMENT_LIMITS,
  type PageAnchor,
  typeDef,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ReopenGate, reopenGate } from "../comments/reopenGate.ts";
import { Button, Tooltip } from "../ui/index.ts";
import { AskDialog } from "./AskDialog.tsx";
import type { AskWhat } from "./rendererProtocol.ts";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageContext, StageDialog, StageNode } from "./stageItems.tsx";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** The dialog's id in STAGE_DIALOGS. */
export const ASK_DIALOG = "ask-agent";

/** Why editing on the page is off, as the Edit slot's description says it. */
export const LIVE_OFF_TEXT: Record<LiveOffReason, string> = {
  disabled: "Editing on the page is turned off on this Plinth instance.",
  isolation: "Editing on the page isn't available with this instance's content isolation.",
};

/** A place on the page the renderer named (an in-frame `ask`), as the comments API takes it. */
export type AskAnchor = PageAnchor;

export function pageAnchorOf(a: { key: string; text: string } | null): AskAnchor | null {
  return a ? { kind: "page", key: a.key, ...(a.text ? { text: a.text } : {}) } : null;
}

/** What `?edit` does for this gate: focus "Sign in to edit", or nothing. */
export function editArrival(gate: OkGate): "sign_in" | null {
  return !gate.live_off && gate.live?.sign_in ? "sign_in" : null;
}

export interface AskAgent {
  /** This person may ask here (the gate's `ask` part) and an agent can take it. */
  available: boolean;
  /** Ask an agent takes the bar's Edit slot (an `ask` type, or editing on the page is off). */
  inSlot: boolean;
  /** Why editing on the page is off, in words, or null. */
  reason: string | null;
  targets: ClientType[];
  /** Open Ask an agent: the Ask dialog in edit mode, the comments panel in request mode otherwise. */
  open(anchor?: AskAnchor | null, what?: AskWhat): void;
  /**
   * An `ask` the renderer posted: `open`, as a hint the app may refuse, under the rules for a
   * page's own compose (usePageComments.ts): only while the tab is visible and no dialog is open,
   * and one that would open the closed panel or the Ask dialog at most once a second.
   */
  fromFrame(anchor: AskAnchor | null, what?: AskWhat): void;
  /** The anchor the Ask dialog opened with (edit mode), or null for the whole page. */
  dialogAnchor: AskAnchor | null;
  /** What kind of block that anchor is, when the frame said (a doc block, which has no text). */
  dialogWhat: AskWhat | null;
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
  blocked,
  panelOpen,
  openDialog,
  openRequest,
  focusSignIn,
}: {
  gate: OkGate;
  editing: boolean;
  /** A dialog is open over the stage (Share, or a stage dialog such as Ask itself). */
  blocked: boolean;
  /** The comments panel is open. */
  panelOpen: boolean;
  openDialog: (id: string) => void;
  /** Open the comments panel in request mode, with an anchor when one was given. */
  openRequest: (anchor: AskAnchor | null) => void;
  /** `?edit` for an editor who must sign in first: focus "Sign in to edit". */
  focusSignIn: () => void;
}): AskAgent {
  const available = (gate.ask?.targets.length ?? 0) > 0;
  const def = typeDef(gate.artifact.type);
  // An HTML deck (`no_editor`) is a deck people change by asking, though Markdown decks edit live.
  const inSlot =
    available && (def?.edit === "ask" || gate.live_off !== undefined || gate.no_editor === true);
  const reason = gate.live_off ? LIVE_OFF_TEXT[gate.live_off.reason] : null;
  const [dialogAnchor, setDialogAnchor] = useState<AskAnchor | null>(null);
  const [dialogWhat, setDialogWhat] = useState<AskWhat | null>(null);

  const latest = useRef({ editing, openDialog, openRequest, available, blocked, panelOpen });
  latest.current = { editing, openDialog, openRequest, available, blocked, panelOpen };
  const open = useCallback((anchor: AskAnchor | null = null, what?: AskWhat) => {
    const l = latest.current;
    if (!l.available) return;
    if (l.editing) {
      setDialogAnchor(anchor);
      setDialogWhat(anchor ? (what ?? null) : null);
      l.openDialog(ASK_DIALOG);
    } else {
      l.openRequest(anchor);
    }
  }, []);
  const reopen = useRef<ReopenGate | null>(null);
  const lastAsk = useRef(Number.NEGATIVE_INFINITY);
  const fromFrame = useCallback(
    (anchor: AskAnchor | null, what?: AskWhat) => {
      const l = latest.current;
      if (!l.available || l.blocked || document.visibilityState !== "visible") return;
      const t = Date.now();
      // At most one a second, whatever is open: with the comments panel open (nothing to reopen)
      // each one would point the composer somewhere else and take the focus again.
      if (t - lastAsk.current < PAGE_COMMENT_LIMITS.composeMinIntervalMs) return;
      // In edit mode it opens the Ask dialog, which is closed whenever nothing blocks; otherwise
      // the comments panel, unless it is open already.
      const closed = l.editing || !l.panelOpen;
      reopen.current ??= reopenGate();
      if (reopen.current.refused(t, closed)) return;
      reopen.current.take(t, closed);
      lastAsk.current = t;
      open(anchor, what);
    },
    [open],
  );

  // `?edit` is read once, when the page opens, and dropped from the address so a reload or a
  // shared copy of it opens the page as usual.
  const arrival = useRef<boolean | null>(null);
  if (arrival.current === null) {
    arrival.current = new URLSearchParams(window.location.search).has("edit");
  }
  const handled = useRef(false);
  const focusRef = useRef(focusSignIn);
  focusRef.current = focusSignIn;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, with the first gate
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (!arrival.current) return;
    // With `live` the page starts editing (New and Import); every other case is here. Where this
    // person cannot edit, the page opens as usual: the bar already offers what they can do.
    if (editArrival(gate) === "sign_in") requestAnimationFrame(() => focusRef.current());
    if (!gate.live || gate.live.sign_in) dropParam("edit");
  }, []);

  return {
    available,
    inSlot,
    reason,
    targets: gate.ask?.targets ?? [],
    open,
    fromFrame,
    dialogAnchor,
    dialogWhat,
  };
}

// ---------- the bar, the menu and the dialog ----------

const mayEdit = (c: StageContext) => c.gate.role === "owner" || c.gate.role === "editor";

/** In the bar's Edit slot: owners and editors at desktop width, where Edit is not offered. */
const inBar = (c: StageContext) => c.ask.inSlot && mayEdit(c) && !c.compact;

export const askAgentButton: StageNode = (c) =>
  inBar(c) && (
    <Tooltip content={c.ask.reason ?? "Ask an agent"} placement="bottom">
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

export const askAgentDialog: StageDialog = {
  id: ASK_DIALOG,
  render: (c, close) => (
    <AskDialog
      artifactId={c.gate.artifact.id}
      targets={c.ask.targets}
      owner={c.gate.role === "owner"}
      anchor={c.ask.dialogAnchor}
      what={c.ask.dialogWhat}
      live={c.live}
      version={c.live.status?.base_version || c.gate.artifact.version}
      onClose={close}
    />
  ),
};
