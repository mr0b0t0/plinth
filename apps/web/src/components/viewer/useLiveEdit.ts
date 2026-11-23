// On-page editing of a doc, a deck, a sheet or a design system (#36), app side: the state machine
// behind the save status in the artifact bar and the unpublished-changes notice. Editing is always
// on for whoever may edit here (decided 2026-11-23): the frame turns edit mode on as soon as it has
// loaded, as a whiteboard is always live, and changes publish on their own. There is no Edit
// toggle and no Done. The frame does the editing (the type's renderer); this hook talks to it with
// the renderer protocol (rendererProtocol.ts) and to the server with the session cookie. It accepts
// the frame's editing messages only with the key of the frame it holds (`frameKey`, which
// ViewerStage put in the frame's address).
//
// Modes (gate.live.mode, decided by the server):
// - "room": the frame edits the live draft in the artifact's room with the other editors. The app
//   never sees draft text: it gets numbers, booleans and co-editor emails. The room keeps the
//   draft (the status says "Draft saved"); a version is published with a checkpoint (POST
//   live/checkpoint) after a quiet spell (autosave, by the editor whose edit was last, other
//   editors 30 s later as a fallback), on Cmd/Ctrl+S or the ⋯ menu's "Publish changes", and when
//   the person leaves the page (pagehide, or the viewer closing).
// - "solo": origin isolation without rooms (or a room that never answered). The frame edits its
//   own copy; publishing asks it for the text (collect with a nonce) and publishes it with PUT, the
//   version the copy is based on as base_version and that version's files (files_from_version).
//   The same quiet spell autosaves it; the frame stays as it is (no reload), and the next publish
//   is based on the version this one made. A copy goes to sessionStorage every 5 s, so a reload
//   can offer to publish it. The frame never held that copy, so when a newer version refuses it,
//   the review message carries it to the frame.
// Opaque isolation and the path fallback have no on-page editing (no gate.live): the page is
// read-only.
//
// A version published while the page changes were not combined with it freezes them: the frame
// shows the whole-draft review (renderers/common/review.ts), and the person's choice comes back as
// `resolved`. "Publish your changes" is POST live/checkpoint with conflict_version (room), or PUT with
// base_version: n and files_from_version: the draft's base (solo); "Discard your changes", once the
// app's own confirmation (discardAsk) says so, is DELETE live/draft with conflict_version (room),
// or dropping the tab copy (solo); a cancelled confirmation answers `failed`. The app answers the
// frame with `reviewed`, so its buttons say when another editor is choosing. Nothing autosaves
// over a newer version: a frozen draft (room) or a solo copy older than the current version waits
// for that review.
//
// Comments while editing: the comments panel's "Pin to an element" asks the frame to pick a place
// (`pick`); the frame answers with `picked` and a structural page anchor (or null when cancelled).
//
// Phases: idle (not editing, no room), watching (not editing, the frame follows the room),
// editing, dirty, saving, conflict (a version froze the draft; review needed), solo.
import {
  API,
  type AppConfig,
  type ArtifactDetail,
  fileChanges,
  type LiveCheckpointResult,
  type LiveInfo,
  liveReplacesNote,
  liveRules,
  type PublishResult,
  route,
  summarizeFileChanges,
  typeDef,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api, liveCheckpoint, liveDiscard, liveInfo } from "../../lib/api.ts";
import {
  clearPageDraft,
  clearRescue,
  countRescue,
  loadPageDraft,
  loadRescue,
  mergeRescue,
  type PageDraft,
  savePageDraft,
} from "../editor/draft.ts";
import { showToast } from "../ui/index.ts";
import { unpublishableReason } from "./deckItems.ts";
import {
  type AskWhat,
  collectMessage,
  editMessage,
  editTargetOrigin,
  type FrameMessage,
  type LiveFrameStatus,
  matchFrameMessage,
  newNonce,
  pickMessage,
  postToRenderer,
  type ReviewResult,
  readFrameMessage,
  readRescueItems,
  rescueMessage,
  reviewedMessage,
  reviewMessage,
} from "./rendererProtocol.ts";
import type { WatchPause } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;
type Resolved = Extract<FrameMessage, { type: "resolved" }>;

export type LivePhase = "idle" | "watching" | "editing" | "dirty" | "saving" | "conflict" | "solo";

/** The review the frame shows: never any text, in either mode. */
export interface LiveReview {
  nonce: string;
  /** The version the draft is based on. */
  base: number;
  /** The newest version it is reviewed against. */
  current: number;
  mode: "room" | "solo";
}

/**
 * The types whose renderer picks a place on the page while editing (common/pick.ts), named as its
 * Comment controls name places. A sheet's cells have no such names yet.
 */
const PICK_TYPES: ReadonlySet<string> = new Set(["doc", "slides", "design_system"]);

/** The note a version of page edits carries when the editor gave none (as the server's). */
export const LIVE_NOTE = "Edited on the page";

/** How often solo edits are copied to sessionStorage while dirty. */
export const SOLO_KEEP_MS = 5000;
/** How long the frame has to answer a collect. */
export const COLLECT_TIMEOUT_MS = 5000;
/** Room: how long Publish and Done wait for a change the frame is still sending (`pending`). */
export const PENDING_WAIT_MS = 3000;
/**
 * Solo: how often keeping the tab's copy with rescue items the frame wrote is tried (storage full
 * or blocked), the first retry after this long, each next one twice as late.
 */
export const SOLO_KEEP_TRIES = 4;
export const SOLO_KEEP_RETRY_MS = 1000;
/** Editors whose edit was not the last one autosave this much later. */
export const AUTOSAVE_FALLBACK_MS = 30_000;
/** A choice or a discard refused because another one or a save holds the room's lock. */
export const CHOOSING_BUSY = "Someone else is publishing or discarding these changes right now.";

type RescueReportMsg = Extract<FrameMessage, { type: "rescue" }>;

export interface UseLiveEditOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  /** The key of the frame's current load (withFrameKey), or null when it has none. */
  frameKey: string | null;
  /** Fetch a fresh gate (a solo publish, a discard, a lost session). */
  onReload: () => void;
  /**
   * The signed-in account, whose rescue store this is: null when no one is signed in, undefined
   * while the session is still loading. The store is read, offered and written only for a known
   * account.
   */
  userId?: string | null;
  /** Esc at the top level of edit mode in the frame. */
  onLeave?: () => void;
  /** "Comment" on a place on the page, from the frame (with the kind of block it is). */
  onAsk?: (anchor: { key: string; text: string } | null, what?: AskWhat) => void;
  /**
   * The place the person picked in the frame after `pick(true)` (the comments panel's "Point at
   * something" while editing), or null when they cancelled the pick in the frame (Esc).
   */
  onPicked?: (anchor: { key: string; text: string } | null, what?: AskWhat) => void;
}

export interface LiveEdit {
  /** On-page editing exists for this person here (owner or editor, origin isolation). */
  available: boolean;
  /**
   * A version published meanwhile is merged under the page edits when that is clean (a doc).
   * False for a sheet: the page edits are never merged, and the review offers exactly two
   * choices, publish them as they are or discard them.
   */
  merges: boolean;
  /** Confirmed by code without an account: they must sign in to edit. */
  signIn: boolean;
  /**
   * Why the page stays read-only although editing on the page exists here: the version has
   * problems only an agent can fix, or is too large to edit on its page (the frame said so), in
   * words. Null otherwise.
   */
  blocked: string | null;
  mode: "room" | "solo" | null;
  /**
   * The frame is in edit mode: always, for whoever may edit here (available, signed in, not
   * blocked). There is no way to turn it off.
   */
  editing: boolean;
  /**
   * There are changes that are not a version yet: the room's draft differs from its base, or the
   * solo copy changed since it was last published.
   */
  unpublished: boolean;
  phase: LivePhase;
  status: LiveFrameStatus | null;
  saving: boolean;
  savedVersion: number | null;
  rebasedVersion: number | null;
  /** Solo: a newer version was published while the page holds changes (the review waits). */
  newerVersion: number | null;
  /**
   * Solo: the version this frame last published, which the frame shows (it is not reloaded after
   * its own save), or null. The bar names it as the version on view.
   */
  ownVersion: number | null;
  /** The review open in the frame, if any. */
  review: LiveReview | null;
  reviewing: boolean;
  /**
   * The review's "Discard your changes" waits for the app's confirmation (the app's own dialog,
   * over the dimmed page): the version the page goes back to, or null.
   */
  discardAsk: number | null;
  /** The person's answer to discardAsk: true discards, false goes back to the review. */
  answerDiscard(ok: boolean): void;
  /** Solo: page edits this tab kept from before a reload. */
  restore: PageDraft | null;
  pause: WatchPause;
  /** Room mode with the frame connected: the shared draft can be published or discarded here. */
  roomReady: boolean;
  /**
   * `?edit` (from New and Import): the frame gets the focus, on its first block or cell, once it
   * has loaded and turned editing on.
   */
  focusFirst(): void;
  /** Publish the changes now (Cmd/Ctrl+S, the ⋯ menu's "Publish changes"). */
  publish(note?: string): Promise<void>;
  discard(): Promise<void>;
  /** Open the whole-draft review in the frame. */
  openReview(): Promise<void>;
  saveRestore(): Promise<void>;
  dropRestore(): void;
  /** The type's renderer can pick a place on the page while editing (a doc, a deck, a design system). */
  canPick: boolean;
  /**
   * Ask the frame to let the person pick a place on the page (true), or stop (false): the comments
   * panel's "Pin to an element" while editing. False when the frame cannot be asked.
   */
  pick(on: boolean): boolean;
}

/**
 * What came of a publish: the version it made (or, with nothing new to publish, the version being
 * edited), or why nothing was published, in the save status's words.
 */
type PublishOutcome = { version: number } | { error: string };

/**
 * How a publish that did not happen is told: "toast" (Cmd/Ctrl+S, the ⋯ menu's Publish changes,
 * the review), or "quiet" (an autosave), which shows no toast and only returns the words. A lost
 * session reloads the gate either way. A room's conflict opens the review; a solo autosave's opens
 * none (its caller says what a 409 does): a newer version it met waits in the bar's status, with
 * Review changes.
 */
type Tell = "toast" | "quiet";

type Tone = "neutral" | "danger" | "success" | "warning";
const toast = (title: string, tone: Tone = "danger") => showToast({ title, tone });

const reasonOf = (e: unknown): string | null =>
  e instanceof ApiRequestError
    ? ((e.details as { reason?: string } | undefined)?.reason ?? null)
    : null;

const UNPUBLISHABLE = "These changes can't be published yet.";
/** A block holds typing the page cannot save as typed (the frame's `unsavable`). */
const UNSAVABLE = "Some text on the page can't be saved as typed. Change it to continue.";
const NOT_CONNECTED = "Not connected, your changes are kept.";
const conflictText = (n: number | null) =>
  n
    ? `v${n} was published while you edited. Review it to go on.`
    : "A newer version was published while you edited. Review it to go on.";

/** A refused Publish with nothing newer to review against: the server's words, or these. */
const NOT_PUBLISHED = "These changes could not be published. Try again.";
const refusedText = (e: unknown): string =>
  e instanceof Error && e.message.trim() !== "" ? e.message : NOT_PUBLISHED;

const currentOf = (e: unknown): number | null => {
  const v = (e instanceof ApiRequestError ? e.details : undefined) as
    | { current_version?: unknown }
    | undefined;
  return typeof v?.current_version === "number" ? v.current_version : null;
};

export function useLiveEdit({
  gate,
  frame,
  contentOrigin,
  config,
  frameKey,
  onReload,
  onLeave,
  onAsk,
  onPicked,
  userId,
}: UseLiveEditOptions): LiveEdit {
  const { artifact } = gate;
  const id = artifact.id;
  /** Whose rescue store this is, once known (never while the session loads or no one is in). */
  const who = typeof userId === "string" ? userId : null;
  const def = typeDef(artifact.type);
  const merges = liveRules(artifact.type)?.merge === "lines";
  // What the person edits, in messages ("doc", "sheet"), and how much the frame may hand back.
  const noun = def?.noun ?? (def?.badge ?? "doc").toLowerCase();
  // Why Publish is off for a draft that cannot be a version yet (an empty deck), in its words.
  const unpublishable = unpublishableReason(artifact.type) ?? UNPUBLISHABLE;
  const maxBytes =
    artifact.type === "doc" ? config?.limits.max_doc_bytes : (def?.maxSourceBytes ?? undefined);
  const target = editTargetOrigin(config, contentOrigin);
  const available = gate.live !== undefined && target !== null;
  const signIn = gate.live?.sign_in === true;
  const [status, setStatus] = useState<LiveFrameStatus | null>(null);
  /**
   * The frame said this page cannot be edited on it (problems only an agent can fix, or too large):
   * kept for this version, since a frame out of edit mode stops saying "too large" (and a frame
   * loaded again for the same version would only say it again).
   */
  const [blockedBy, setBlockedBy] = useState<"invalid" | "too_large" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another version is checked again
  useEffect(() => setBlockedBy(null), [artifact.version]);
  const unavailable = blockedBy ?? status?.unavailable ?? null;
  // Always in edit mode for whoever may edit here: no toggle turns it on or off.
  const editing = available && !signIn && unavailable === null;
  const [saving, setSaving] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [rebasedVersion, setRebasedVersion] = useState<number | null>(null);
  const [review, setReview] = useState<LiveReview | null>(null);
  /** The review's Discard, waiting for the app's confirmation. */
  const [discardAsk, setDiscardAsk] = useState<Resolved | null>(null);
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [restore, setRestore] = useState<PageDraft | null>(null);
  /**
   * How many typed texts are kept to rescue for this artifact in this tab (the signed-in account's
   * store, any account's while the session is unknown, and what the frame reported before it was
   * known): leaving the page warns while any.
   */
  const [rescued, setRescued] = useState(() => countRescue(gate.artifact.id, userId));
  /** The frame's rescue reports, in order, while there is no known account to keep them under. */
  const unkept = useRef<RescueReportMsg[]>([]);
  /** What a `rescue` report from the frame does (set once collect exists, below). */
  const onRescue = useRef<(r: RescueReportMsg) => void>(() => undefined);
  /**
   * A discard (the ⋯ menu's, a review's, the restore notice's): what was kept to rescue goes with
   * the changes it belongs to, so it is never written back on the next Edit.
   */
  const forgetRescue = useCallback(() => {
    if (who) clearRescue(who, id);
    unkept.current = [];
    setRescued(countRescue(id, userId));
  }, [who, id, userId]);
  /** An idle autosave refused as too soon: try again after `ms`, unless the draft moved on. */
  const [idleRetry, setIdleRetry] = useState<{ rev: number; ms: number } | null>(null);
  const mode: LiveEdit["mode"] = !available
    ? null
    : gate.live?.mode === "room" && !status?.failed
      ? "room"
      : "solo";

  // ---------- solo: what this frame published ----------

  /**
   * Solo: the version this frame's copy was last published as, and the text published, for this
   * frame load. The next publish is based on it; the frame is not reloaded after its own save.
   */
  const [soloSaved, setSoloSaved] = useState<{ version: number; text: string } | null>(null);
  /** Solo: frame status reports with changes, counted; and the count the last publish took in. */
  const [soloTick, setSoloTick] = useState(0);
  const [soloSavedTick, setSoloSavedTick] = useState(0);
  /** Solo: a newer version that refused an autosave (409), before the gate shows it. */
  const [soloConflict, setSoloConflict] = useState<number | null>(null);
  /** When this tab last published the solo copy (autosaves keep LIVE_AUTO_CHECKPOINT_MIN_S apart). */
  const soloSavedAt = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new frame load starts over
  useEffect(() => {
    setSoloSaved(null);
    setSoloTick(0);
    setSoloSavedTick(0);
    setSoloConflict(null);
  }, [frameKey]);
  /** Solo: the version the frame's copy is based on. */
  const soloOver = soloSaved?.version ?? artifact.version;
  /** Solo: the newest version this tab knows of, when it is newer than the copy's base. */
  const soloNewest = Math.max(artifact.current_version, soloConflict ?? 0);
  const soloNewer = mode === "solo" && editing && soloNewest > soloOver ? soloNewest : null;
  /** Solo: the copy changed since it was last published (or since the frame loaded). */
  const soloChanged =
    mode === "solo" && editing && status?.dirty === true && soloTick > soloSavedTick;

  const latest = useRef({
    status,
    mode,
    saving,
    editing,
    gate,
    onReload,
    review,
    onLeave,
    onAsk,
    onPicked,
    soloOver,
    soloSaved,
    soloTick,
    soloNewest,
  });
  latest.current = {
    status,
    mode,
    saving,
    editing,
    gate,
    onReload,
    review,
    onLeave,
    onAsk,
    onPicked,
    soloOver,
    soloSaved,
    soloTick,
    soloNewest,
  };
  const collecting = useRef<{
    nonce: string;
    resolve: (t: string, unsavable: boolean) => void;
  } | null>(null);
  const savingRef = useRef(false);
  /** A pick the app asked the frame for (`pick`), waiting for its `picked`. */
  const picking = useRef(false);
  const reviewRef = useRef<LiveReview | null>(null);
  reviewRef.current = review;
  /** Solo: the kept copy a review is of (saveRestore), which its "Publish your changes" publishes. */
  const keptReview = useRef<{ nonce: string; text: string } | null>(null);

  // ---------- errors ----------

  /**
   * A refused publish or discard, in the save status's words: shown as a toast, or only returned
   * (`tell`). A lost session reloads the gate; a conflict runs `onConflict` (the review opens), and
   * then nothing is shown, since the review says it, but the words are still returned.
   */
  const refuse = useCallback(
    (e: unknown, onConflict?: () => void, tell: Tell = "toast"): { error: string } => {
      const say = (text: string, tone: Tone = "danger") => {
        if (tell === "toast") toast(text, tone);
        return { error: text };
      };
      if (!(e instanceof ApiRequestError)) {
        return say(e instanceof Error ? e.message : "Something went wrong. Your changes are kept.");
      }
      if (e.status === 401) {
        latest.current.onReload();
        return say("Sign in again to publish. Your changes are kept.");
      }
      if (e.status === 403) return say(`You can no longer edit this ${noun}.`);
      if (e.status === 409 && onConflict) {
        onConflict();
        return { error: conflictText(currentOf(e)) };
      }
      if (e.status === 409 && reasonOf(e) === "live_busy") return say(CHOOSING_BUSY, "neutral");
      if (e.status === 409) return say(e.message);
      if (e.status === 413) return say(`This ${noun} is too large to publish as a version.`);
      if (e.status === 429)
        return say("Hourly version limit reached. Your changes stay as a draft.");
      if (e.status === 503) return say("Live editing is unavailable. Your changes are kept.");
      return say(e.message);
    },
    [noun],
  );
  const fail = useCallback(
    (e: unknown, onConflict?: () => void) => {
      refuse(e, onConflict);
    },
    [refuse],
  );

  // ---------- the review, in the frame ----------

  /** Tell the frame what came of its review's choice. */
  const answer = useCallback(
    (nonce: string, result: ReviewResult) => {
      postToRenderer(frame, target, reviewedMessage(nonce, result));
    },
    [frame, target],
  );

  /**
   * Room mode: the frame reviews the room's frozen draft; nothing crosses but the request. With
   * `tell: "quiet"` it shows no toast: a conflict can arrive before the room's status shows it.
   */
  const openReview = useCallback(
    async (tell: Tell = "toast") => {
      const s = latest.current.status;
      if (latest.current.mode === "solo") {
        // A newer version the solo copy has not been published over: reviewed beside it.
        await soloReviewRef.current(latest.current.soloOver, null, undefined, tell);
        return;
      }
      const say = (text: string, tone: Tone = "danger") => {
        if (tell === "toast") toast(text, tone);
      };
      if (s?.conflict_version == null) {
        say("Nothing to review: your changes were kept on top of the new version.", "neutral");
        return;
      }
      const nonce = newNonce();
      const r: LiveReview = {
        nonce,
        base: s.base_version,
        current: s.conflict_version,
        mode: "room",
      };
      if (!postToRenderer(frame, target, reviewMessage(nonce))) {
        say("The page is not ready. Try again in a moment.");
        return;
      }
      setReview(r);
    },
    [frame, target],
  );

  /**
   * Solo mode: a Publish was refused because version n is current now. The frame reviews its own
   * copy beside n; the app says which files n changed since the base, from the two versions'
   * file lists (it reads only their `assets`). For a copy this tab kept from before a reload
   * (`kept`), the frame never held it: the review carries it, and the choice publishes it. A
   * refusal (`e`) that leaves nothing newer than the base to review says why instead, unless
   * `tell` is "quiet".
   */
  const soloReview = useCallback(
    async (base: number, e: unknown, kept?: string, tell: Tell = "toast") => {
      const say = (text: string) => {
        if (tell === "toast") toast(text);
      };
      const n = currentOf(e) ?? latest.current.soloNewest;
      if (n <= base) {
        say(refusedText(e));
        return;
      }
      try {
        const [b, v] = await Promise.all([
          api<ArtifactDetail>(route(API.version, { ref: id, n: base })),
          api<ArtifactDetail>(route(API.version, { ref: id, n })),
        ]);
        const files = summarizeFileChanges(fileChanges(b.assets, v.assets));
        const nonce = newNonce();
        const solo = { n, base, files, ...(kept !== undefined ? { text: kept } : {}) };
        if (!postToRenderer(frame, target, reviewMessage(nonce, solo))) {
          say("The page is not ready. Try again in a moment.");
          return;
        }
        keptReview.current = kept !== undefined ? { nonce, text: kept } : null;
        setReview({ nonce, base, current: n, mode: "solo" });
      } catch (e) {
        refuse(e, undefined, tell);
      }
    },
    [id, frame, target, refuse],
  );
  const soloReviewRef = useRef(soloReview);
  soloReviewRef.current = soloReview;

  // ---------- frame messages ----------

  const onResolvedRef = useRef<(m: Resolved, confirmed?: boolean) => void>(() => undefined);
  /** Editing was started from `?edit`: the next edit message asks for focus on the first place. */
  const focusFirst = useRef(false);

  useEffect(() => {
    if (!available) return;
    const onMessage = (e: MessageEvent) => {
      const m = readFrameMessage(e, {
        frame,
        contentOrigin: target,
        solo: latest.current.mode === "solo",
        nonce: collecting.current?.nonce ?? null,
        maxDocBytes: maxBytes,
        key: frameKey,
        review: reviewRef.current?.nonce ?? null,
        editing: latest.current.editing,
      });
      if (!m) return;
      matchFrameMessage(m, {
        live({ status: next }) {
          const prev = latest.current.status;
          if (
            prev &&
            next.connected &&
            next.base_version > prev.base_version &&
            prev.base_version > 0 &&
            next.dirty &&
            next.conflict_version === null &&
            !savingRef.current
          ) {
            setRebasedVersion(next.base_version);
          }
          // The frame turned editing on: a `focus: "first"` it was sent has been acted on.
          if (next.editing) focusFirst.current = false;
          // Too large to edit on its page (a design system past its projection's line cap), or
          // problems only an agent can fix (a design system the format refuses): the page stays
          // read-only for this frame load, and the bar says why once (LiveEdit.blocked).
          if (next.unavailable) setBlockedBy((b) => b ?? next.unavailable ?? null);
          // Solo: every report of changes counts, so a publish knows whether typing came after it.
          if (latest.current.mode === "solo" && next.dirty) setSoloTick((t) => t + 1);
          setStatus(next);
        },
        save() {
          void publishRef.current();
        },
        draft({ nonce, text, unsavable }) {
          const c = collecting.current;
          if (c?.nonce !== nonce) return;
          collecting.current = null;
          c.resolve(text, unsavable === true);
        },
        resolved(r) {
          onResolvedRef.current(r);
        },
        ask({ anchor, what }) {
          latest.current.onAsk?.(anchor, what);
        },
        picked({ anchor, what }) {
          // Only a pick the app asked for; anything else is ignored.
          if (!picking.current) return;
          picking.current = false;
          latest.current.onPicked?.(anchor, what);
        },
        leave() {
          latest.current.onLeave?.();
        },
        rescue(r) {
          // Typed text the room's draft does not hold yet: merged into the store here.
          onRescue.current(r);
        },
        // A version shown in place is the live-view update's answer (useViewUpdate.ts).
        shown() {},
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [available, frame, target, maxBytes, frameKey]);

  // A new frame (a reload, review mode off) starts in view mode: tell it again, once it loaded.
  const told = useRef(false);
  const soloBase = gate.live?.mode === "solo" || status?.failed ? artifact.version : undefined;
  // Published from code (gate `from_code`): the frame says so in edit mode.
  const fromCode = gate.from_code === true;
  useEffect(() => {
    if (!available || !frame) return;
    if (!editing && !told.current) return;
    told.current = editing;
    const send = () => {
      const focus = editing && focusFirst.current ? ("first" as const) : undefined;
      // The frame's own focus() moves the keyboard only once its window has the focus.
      if (focus) frame.focus();
      postToRenderer(frame, target, editMessage(editing, soloBase, focus, fromCode));
    };
    send();
    frame.addEventListener("load", send);
    return () => frame.removeEventListener("load", send);
  }, [available, frame, target, editing, soloBase, fromCode]);

  // ---------- the frame's rescue store ----------

  // Once the account is known: what the frame reported meanwhile is kept under it, and what was
  // kept from an earlier frame is counted and offered to this one (again on each load), which
  // writes what the draft does not hold yet. Nothing is read, offered or dropped before.
  useEffect(() => {
    if (!who) {
      // No account (yet): no store of anyone else's counts once no one is signed in.
      setRescued(countRescue(id, userId) + unkept.current.reduce((n, x) => n + x.upsert.length, 0));
      return;
    }
    // Merged in order, as they came: the store only grows by them, minus ids named as written.
    const waiting = unkept.current;
    unkept.current = [];
    for (const r of waiting) onRescue.current(r);
    setRescued(countRescue(id, userId));
    if (!available || !frame || !editing) return;
    const offer = () => {
      const items = readRescueItems(loadRescue(who, id)) ?? [];
      if (items.length > 0) postToRenderer(frame, target, rescueMessage(items));
    };
    offer();
    frame.addEventListener("load", offer);
    return () => frame.removeEventListener("load", offer);
  }, [who, userId, id, available, frame, target, editing]);

  /**
   * Solo: the frame's text. Refused while a block holds typing that cannot be saved as typed,
   * unless `keep` (the kept copy, which then has that typing without its formatting).
   */
  const collect = useCallback(
    (opts: { keep?: boolean } = {}): Promise<string> => {
      return new Promise((resolve, reject) => {
        const nonce = newNonce();
        const timer = window.setTimeout(() => {
          if (collecting.current?.nonce === nonce) collecting.current = null;
          reject(new Error("The page did not answer."));
        }, COLLECT_TIMEOUT_MS);
        collecting.current = {
          nonce,
          resolve: (t, unsavable) => {
            window.clearTimeout(timer);
            if (unsavable && !opts.keep) reject(new Error(UNSAVABLE));
            else resolve(t);
          },
        };
        if (!postToRenderer(frame, target, collectMessage(nonce))) {
          window.clearTimeout(timer);
          collecting.current = null;
          reject(new Error("The page is not ready."));
        }
      });
    },
    [frame, target],
  );

  // ---------- publishing ----------

  /**
   * Solo: publish the frame's text as the next version over `over`, with the files of `base`
   * (the version the text was made from). A refusal because a newer version is current opens the
   * review (or runs `onConflict`).
   */
  const publishSolo = useCallback(
    async (
      text: string,
      over: number,
      base: number,
      opts: {
        note?: string;
        onConflict?: (e: ApiRequestError) => void;
        tell?: Tell;
        /**
         * The frame holds this text and goes on editing it (an ordinary publish, an autosave): it
         * is not reloaded, and the next publish is based on the version this one makes. `tick` is
         * the count of change reports the text took in. Otherwise (a review's choice, the copy kept
         * from before a reload) the page loads the new version.
         */
        keep?: { tick: number };
      } = {},
    ): Promise<PublishOutcome> => {
      try {
        const r = await api<PublishResult>(route(API.artifact, { ref: id }), {
          method: "PUT",
          body: {
            content: text,
            base_version: over,
            files_from_version: base,
            ...(opts.note ? { note: opts.note } : {}),
          },
        });
        clearPageDraft(id);
        setRestore(null);
        setSavedVersion(r.version);
        setSoloConflict(null);
        soloSavedAt.current = Date.now();
        if (opts.keep) {
          setSoloSaved({ version: r.version, text });
          setSoloSavedTick(opts.keep.tick);
        } else latest.current.onReload();
        return { version: r.version };
      } catch (e) {
        return refuse(
          e,
          () => {
            if (opts.onConflict && e instanceof ApiRequestError) opts.onConflict(e);
            else void soloReviewRef.current(base, e, undefined, opts.tell);
          },
          opts.tell,
        );
      }
    },
    [id, refuse],
  );

  /**
   * Room: the frame's last change on its way to the room (a field's value written as Done or
   * Publish was pressed, its lease still to come) lands before the checkpoint is taken. The
   * frame's status is a message on its way too, so it is read after one turn; then this waits
   * while the frame says `pending`, at most PENDING_WAIT_MS (the change then stays in the draft).
   */
  const settleFrame = useCallback(async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    const until = Date.now() + PENDING_WAIT_MS;
    while (latest.current.status?.pending === true && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }, []);

  /**
   * Room: publish the shared draft (POST live/checkpoint). With nothing new to publish, the
   * outcome is the version being edited.
   */
  const checkpoint = useCallback(
    async (
      reason: "save" | "done" | "idle",
      opts: { note?: string; tell?: Tell } = {},
    ): Promise<PublishOutcome> => {
      const s = latest.current.status;
      if (!s) return { error: NOT_CONNECTED };
      if (savingRef.current) return { error: CHOOSING_BUSY };
      const tell = opts.tell ?? "toast";
      // An autosave says nothing about a draft it left as it was, only about a refusal.
      const quiet = tell === "quiet" || reason === "idle";
      savingRef.current = true;
      setSaving(true);
      try {
        const r: LiveCheckpointResult = await liveCheckpoint(id, {
          base_version: s.base_version,
          rev: s.rev,
          reason,
          ...(opts.note ? { note: opts.note } : {}),
        });
        if (r.saved) {
          setSavedVersion(r.version.version);
          return { version: r.version.version };
        }
        if (r.reason === "clean" || r.reason === "unchanged") {
          if (reason === "save" && tell === "toast") {
            toast("Nothing to publish: the page matches the current version.", "neutral");
          }
          return { version: s.base_version };
        }
        if (r.reason === "too_soon" && reason === "idle" && r.retry_in_s) {
          setIdleRetry({ rev: s.rev, ms: r.retry_in_s * 1000 });
        }
        if (r.reason === "busy" && !quiet) toast(CHOOSING_BUSY, "neutral");
        return { error: r.reason === "busy" ? CHOOSING_BUSY : NOT_PUBLISHED };
      } catch (e) {
        const code = reasonOf(e);
        if (code === "live_unpublishable") {
          if (!quiet) toast(unpublishable, "neutral");
          return { error: unpublishable };
        }
        return refuse(e, code === "live_conflict" ? () => void openReview(tell) : undefined, tell);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [id, refuse, openReview, unpublishable],
  );

  /**
   * Publish the page edits as the next version: Publish changes, Cmd/Ctrl+S and the solo autosave
   * (`tell: "quiet"`). Room: a checkpoint; solo: the frame's text over
   * the version shown, with its files.
   */
  const publishNow = useCallback(
    async (note: string | undefined, tell: Tell): Promise<PublishOutcome> => {
      const m = latest.current.mode;
      const s = latest.current.status;
      // Every way to publish (Publish changes, Cmd/Ctrl+S, the solo autosave) comes here: nothing
      // goes out while a block holds typing the page cannot save, or the draft cannot be a version.
      if (s?.unsavable) {
        if (tell === "toast") toast(UNSAVABLE, "neutral");
        return { error: UNSAVABLE };
      }
      if (s?.publishable === false) {
        if (tell === "toast") toast(unpublishable, "neutral");
        return { error: unpublishable };
      }
      if (m === "room") {
        await settleFrame();
        return checkpoint("save", { note, tell });
      }
      if (m !== "solo") return { error: "Editing on the page is not available." };
      if (savingRef.current) return { error: CHOOSING_BUSY };
      savingRef.current = true;
      setSaving(true);
      try {
        // The change reports this text takes in: one that comes later means typing after it.
        const tick = latest.current.soloTick;
        const text = await collect();
        // Over the version the copy is based on (the one this frame last published, if any).
        const v = latest.current.soloOver;
        if (latest.current.soloSaved?.text === text) {
          // The same text as the version this frame last published: nothing new.
          setSoloSavedTick(tick);
          return { version: v };
        }
        return await publishSolo(text, v, v, {
          note,
          tell,
          keep: { tick },
          ...(tell === "quiet"
            ? { onConflict: (e: ApiRequestError) => setSoloConflict(currentOf(e)) }
            : {}),
        });
      } catch (e) {
        return refuse(e, undefined, tell);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [checkpoint, collect, publishSolo, refuse, settleFrame, unpublishable],
  );
  const publish = useCallback(
    async (note?: string) => {
      await publishNow(note, "toast");
    },
    [publishNow],
  );
  const publishRef = useRef(publish);
  publishRef.current = () => publish();

  const answerDiscard = useCallback(
    (ok: boolean) => {
      const m = discardAsk;
      setDiscardAsk(null);
      const r = reviewRef.current;
      if (!m || !r || m.nonce !== r.nonce) return;
      // Cancel answers "failed": the review's buttons come back on, focus on its Discard.
      if (ok) onResolvedRef.current(m, true);
      else answer(r.nonce, "failed");
    },
    [discardAsk, answer],
  );

  // ---------- the review's choice ----------

  onResolvedRef.current = (m, confirmed = false) => {
    const r = reviewRef.current;
    if (!r || m.nonce !== r.nonce) return;
    if (m.outcome === "cancelled") {
      setDiscardAsk(null);
      setReview(null);
      return;
    }
    if (m.outcome === "discard" && !confirmed) {
      // The frame cannot dim the app around it, so the app asks, as the ⋯ menu's Discard does.
      setDiscardAsk(m);
      return;
    }
    const done = (result: ReviewResult) => answer(r.nonce, result);
    const roomFail = (e: unknown) => {
      const code = reasonOf(e);
      if (code === "live_busy") return done("busy");
      if (code === "live_resolved") return done("resolved");
      if (code === "live_conflict") return done("conflict");
      done("failed");
      if (code === "live_moved")
        toast("The unpublished changes moved on. Review them again.", "warning");
      else fail(e);
    };
    if (r.mode === "room") {
      if (m.version === undefined || m.rev === undefined) return;
      const version = m.version;
      const rev = m.rev;
      void (async () => {
        savingRef.current = true;
        setSaving(true);
        try {
          if (m.outcome === "publish") {
            const res = await liveCheckpoint(id, {
              base_version: r.base,
              rev,
              reason: "save",
              conflict_version: version,
              ...(m.note ? { note: m.note } : {}),
            });
            if (!res.saved && res.reason === "busy") return done("busy");
            if (res.saved) setSavedVersion(res.version.version);
            done("done");
          } else {
            await liveDiscard(id, rev, version);
            // Discarded: so is what was kept to rescue (the frame drops its own on the reset).
            forgetRescue();
            done("done");
          }
          setReview(null);
          // Reviewed beside an HTML deck, which is never edited on its page: the page is read
          // again, as the deck published now or as the HTML deck with no changes left.
          if (latest.current.gate.no_editor) latest.current.onReload();
        } catch (e) {
          roomFail(e);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      })();
      return;
    }
    // Solo: the frame's own copy, or dropping it (with what was kept to rescue, as the menu does).
    if (m.outcome === "discard") {
      clearPageDraft(id);
      setRestore(null);
      forgetRescue();
      done("done");
      setReview(null);
      latest.current.onReload();
      return;
    }
    // A kept copy's review publishes the copy the app sent, whatever the frame sends back.
    const kept = keptReview.current?.nonce === r.nonce ? keptReview.current.text : undefined;
    const text = kept ?? m.text;
    if (text === undefined) return;
    void (async () => {
      savingRef.current = true;
      setSaving(true);
      try {
        const note = liveReplacesNote(m.note ?? LIVE_NOTE, r.base + 1, r.current);
        const out = await publishSolo(text, r.current, r.base, {
          note,
          onConflict: (e) => {
            const newer = currentOf(e);
            if (newer !== null && newer > r.current) {
              // Another version is current now: the review opens again on the whole range.
              done("conflict");
              void soloReviewRef.current(r.base, e, kept);
            } else {
              done("failed");
              toast(refusedText(e));
            }
          },
        });
        if (!("error" in out)) {
          done("done");
          setReview(null);
        } else if (reviewRef.current?.nonce === r.nonce) done("failed");
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  };

  // ---------- focus on arrival, picking a place ----------

  const focusFirstNow = useCallback(() => {
    if (!latest.current.editing) return;
    focusFirst.current = true;
    // Sent now to a frame that has loaded; a frame still loading gets it with its `load`.
    if (frame) {
      frame.focus();
      postToRenderer(frame, target, editMessage(true, soloBase, "first", fromCode));
    }
  }, [frame, target, soloBase, fromCode]);

  const pick = useCallback(
    (on: boolean): boolean => {
      if (!on) {
        const was = picking.current;
        picking.current = false;
        if (was) postToRenderer(frame, target, pickMessage(false));
        return true;
      }
      if (!latest.current.editing) return false;
      if (!postToRenderer(frame, target, pickMessage(true))) return false;
      picking.current = true;
      return true;
    },
    [frame, target],
  );
  // A new frame load forgets a pick the old one was asked for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per frame load
  useEffect(() => {
    picking.current = false;
  }, [frameKey]);

  const discard = useCallback(async () => {
    const m = latest.current.mode;
    if (m === "solo") {
      clearPageDraft(id);
      setRestore(null);
      forgetRescue();
      latest.current.onReload();
      return;
    }
    const s = latest.current.status;
    // The revision discarded is the one the frame shows; without one there is nothing to name.
    if (!s?.connected) {
      toast("Not connected to the live draft. Try again in a moment.");
      return;
    }
    try {
      await liveDiscard(id, s.rev);
      // What was kept to rescue goes too; the frame drops its own on the room's reset.
      forgetRescue();
      showToast({ title: "Unpublished changes discarded." });
    } catch (e) {
      fail(e);
    }
  }, [id, fail, forgetRescue]);

  // ---------- solo: keep a copy, offer it back after a reload ----------

  useEffect(() => {
    if (!available || gate.live?.mode !== "solo") return;
    setRestore(loadPageDraft(id));
  }, [available, gate.live?.mode, id]);

  onRescue.current = (r) => {
    if (!who) {
      unkept.current.push(r);
      setRescued(countRescue(id, userId) + unkept.current.reduce((n, x) => n + x.upsert.length, 0));
      return;
    }
    const answer = (ids: string[]) => {
      setRescued(countRescue(id, userId));
      // The ids the store holds: an item the frame sent that is not among them stays only there.
      postToRenderer(frame, target, rescueMessage([], { ids, n: r.n }));
    };
    if (latest.current.mode === "solo" && r.written.length > 0) {
      // Solo: items the frame wrote into its own text are in no copy yet (the tab's copy is taken
      // every few seconds). That text is kept first, then they leave the store; if it cannot be
      // kept, the store keeps them.
      answer(mergeRescue(who, id, r.upsert, r.gone));
      const base = latest.current.soloOver;
      // Storage full or blocked: tried again a few times, further apart, then the frame shows them
      // with Copy (they are in its text, so it does not write them again).
      const keepWritten = (tries: number) => {
        const again = () => {
          if (tries + 1 < SOLO_KEEP_TRIES) {
            setTimeout(() => keepWritten(tries + 1), SOLO_KEEP_RETRY_MS * 2 ** tries);
            return;
          }
          const items = (readRescueItems(loadRescue(who, id)) ?? []).filter((i) =>
            r.written.includes(i.id),
          );
          if (items.length > 0)
            postToRenderer(frame, target, rescueMessage(items, undefined, true));
        };
        collect({ keep: true })
          .then((text) => {
            if (savePageDraft(id, base, text)) answer(mergeRescue(who, id, [], r.written));
            else again();
          })
          .catch(again);
      };
      keepWritten(0);
      return;
    }
    answer(mergeRescue(who, id, r.upsert, [...r.written, ...r.gone]));
  };

  // Typing a block cannot save as typed is not in the frame's text, so it does not make it dirty:
  // it is kept (without its formatting) and warned about all the same.
  const soloStuck = mode === "solo" && editing && status?.unsavable === true;
  useEffect(() => {
    if (!soloChanged && !soloStuck) return;
    const base = soloOver;
    const t = window.setInterval(() => {
      collect({ keep: true })
        .then((text) => savePageDraft(id, base, text))
        .catch(() => undefined);
    }, SOLO_KEEP_MS);
    return () => window.clearInterval(t);
  }, [soloChanged, soloStuck, collect, id, soloOver]);

  const saveRestore = useCallback(async () => {
    if (!restore) return;
    const { text, base } = restore;
    // Refused because a newer version is current: the frame reviews this copy, not its own (it
    // holds none, or one of the version it shows).
    await publishSolo(text, base, base, {
      onConflict: (e) => void soloReviewRef.current(base, e, text),
    });
  }, [restore, publishSolo]);

  // The notice's Discard drops the typing kept apart from the copy too (a deck at its size limit
  // keeps the copy as written and that typing in the rescue store), so Edit never writes it back.
  const dropRestore = useCallback(() => {
    clearPageDraft(id);
    setRestore(null);
    forgetRescue();
  }, [id, forgetRescue]);

  // ---------- autosave after a quiet spell ----------

  useEffect(() => {
    if (!available || mode === null || !editing || info) return;
    const ctrl = new AbortController();
    liveInfo(id, ctrl.signal)
      .then(setInfo)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [available, mode, editing, info, id]);

  const idleS = info?.idle_checkpoint_s ?? 0;
  const minS = info?.auto_checkpoint_min_s ?? 0;
  const rev = status?.rev;
  const dirty = status?.dirty === true;
  const lastByYou = status?.last_by_you === true;
  const frozen = status?.conflict_version != null;
  const publishable = status?.publishable !== false;
  // A new rev restarts the quiet spell. A frozen draft, or one that cannot be a version yet, is
  // never autosaved.
  useEffect(() => {
    if (mode !== "room" || !editing || !dirty || frozen || !publishable || idleS <= 0) return;
    // Refused as too soon (the current version is younger than LIVE_AUTO_CHECKPOINT_MIN_S): try
    // again when the server said, as long as nobody typed since.
    const ms =
      idleRetry && idleRetry.rev === rev
        ? idleRetry.ms
        : idleS * 1000 + (lastByYou ? 0 : AUTOSAVE_FALLBACK_MS);
    const t = window.setTimeout(() => void checkpoint("idle"), ms);
    return () => window.clearTimeout(t);
  }, [mode, editing, dirty, frozen, publishable, idleS, lastByYou, rev, idleRetry, checkpoint]);

  // Solo: the copy publishes itself after the same quiet spell (each new change report restarts
  // it), with the version it is based on as base_version, and never sooner than
  // LIVE_AUTO_CHECKPOINT_MIN_S after this tab's last publish. Not over a newer version: that waits
  // for the review (Review changes), as a room's frozen draft does.
  const unsavable = status?.unsavable === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each change report (soloTick) restarts the quiet spell
  useEffect(() => {
    if (!soloChanged || soloNewer !== null || review || unsavable || !publishable) return;
    if (idleS <= 0) return;
    const since = soloSavedAt.current ? Date.now() - soloSavedAt.current : Number.POSITIVE_INFINITY;
    const ms = Math.max(idleS * 1000, minS * 1000 - since);
    const t = window.setTimeout(() => void publishNow(undefined, "quiet"), ms);
    return () => window.clearTimeout(t);
  }, [soloChanged, soloNewer, review, unsavable, publishable, idleS, minS, soloTick, publishNow]);

  // Solo: a version published elsewhere while the copy has no changes of its own: the page loads
  // it (nothing is lost). With changes, it waits for the review instead.
  useEffect(() => {
    if (soloNewer === null || soloChanged || review || saving || soloStuck) return;
    latest.current.onReload();
  }, [soloNewer, soloChanged, review, saving, soloStuck]);

  // A review the room closed (another editor's choice, a version that unfroze the draft) ends
  // here too; the frame says why.
  useEffect(() => {
    if (review?.mode === "room" && status && status.conflict_version === null && !saving) {
      setReview(null);
    }
  }, [review, status, saving]);

  // ---------- leaving the page, the publish shortcut ----------

  // Room: leaving the page (closing the tab, going elsewhere in the app) publishes the draft, as
  // Done did: changes made on the page become a version without anyone pressing anything. A frozen
  // draft, one that cannot be a version yet or typing the page cannot save stays as it is.
  const leaveRef = useRef<(keepalive: boolean) => void>(() => undefined);
  leaveRef.current = (keepalive: boolean) => {
    const s = latest.current.status;
    if (latest.current.mode !== "room" || !latest.current.editing || !s?.connected) return;
    if (!s.dirty || s.conflict_version !== null || s.publishable === false || s.unsavable) return;
    if (savingRef.current) return;
    void liveCheckpoint(
      id,
      { base_version: s.base_version, rev: s.rev, reason: "done" },
      { keepalive },
    ).catch(() => undefined);
  };
  useEffect(() => {
    const onHide = () => leaveRef.current(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  useEffect(() => () => leaveRef.current(false), []);

  const unsaved =
    (mode === "room" && status?.unflushed === true) ||
    soloChanged ||
    status?.unsavable === true ||
    rescued > 0;
  useEffect(() => {
    if (!unsaved) return;
    const onLeavePage = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeavePage);
    return () => window.removeEventListener("beforeunload", onLeavePage);
  }, [unsaved]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void publishRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // ---------- derived ----------

  const newerVersion = soloChanged ? soloNewer : null;
  const phase: LivePhase = useMemo(() => {
    if (review || status?.conflict_version != null || newerVersion !== null) return "conflict";
    if (saving) return "saving";
    if (!editing) return mode === "room" && status?.connected ? "watching" : "idle";
    if (mode === "solo") return "solo";
    return status?.dirty ? "dirty" : "editing";
  }, [review, status, saving, editing, mode, newerVersion]);

  const roomReady = mode === "room" && status?.connected === true;
  // The frame is never swapped under someone editing: the room's frame follows new versions
  // itself, and a solo frame holds its copy (a newer version reloads it only when it has no
  // changes, above).
  const pause: WatchPause =
    mode === "room" && status?.connected
      ? "follow"
      : (mode === "solo" && editing) || review
        ? "hold"
        : null;
  const unpublished = mode === "room" ? status?.dirty === true : soloChanged;

  return {
    available,
    merges,
    signIn,
    blocked:
      unavailable === "invalid"
        ? `This ${noun} has problems only an agent can fix, so it can't be edited on the page. Mention @claude in a comment to fix them.`
        : unavailable === "too_large"
          ? `This ${noun} is too large to edit on the page. Mention @claude in a comment to change it.`
          : null,
    mode,
    editing,
    phase,
    status,
    saving,
    savedVersion,
    rebasedVersion,
    newerVersion,
    ownVersion: mode === "solo" ? (soloSaved?.version ?? null) : null,
    review,
    reviewing: review !== null,
    discardAsk: discardAsk && review && discardAsk.nonce === review.nonce ? review.current : null,
    answerDiscard,
    restore,
    pause,
    roomReady,
    unpublished,
    focusFirst: focusFirstNow,
    publish,
    discard,
    openReview,
    saveRestore,
    dropRestore,
    // An HTML deck (`no_editor`) never enters edit mode in its frame, so nothing there can pick.
    canPick: editing && PICK_TYPES.has(artifact.type) && gate.no_editor !== true,
    pick,
  };
}
