// On-page editing of a doc or a sheet (#36), app side: the state machine behind the Edit toggle,
// the edit bar and the unpublished-changes notice. The frame does the editing (the doc or sheet
// renderer); this hook talks to it with the renderer protocol (rendererProtocol.ts) and to the
// server with the session cookie. It accepts the frame's editing messages only with the key of
// the frame it holds (`frameKey`, which ViewerStage put in the frame's address).
//
// Modes (gate.live.mode, decided by the server):
// - "room": the frame edits the live draft in the artifact's room with the other editors. The app
//   never sees draft text: it gets numbers, booleans and co-editor emails, and publishes a version
//   with a checkpoint (POST live/checkpoint) on Publish, on Done, or after a quiet spell
//   (autosave, by the editor whose edit was last, other editors 30 s later as a fallback).
// - "solo": origin isolation without rooms (or a room that never answered). The frame edits its
//   own copy; Publish asks it for the text (collect with a nonce) and publishes it with PUT, the
//   shown version as base_version and that version's files (files_from_version). A copy goes to
//   sessionStorage every 5 s, so a reload can offer to publish it. The frame never held that
//   copy, so when a newer version refuses it, the review message carries it to the frame.
// Opaque isolation and the path fallback have no on-page editing (no gate.live).
//
// A version published while the page changes were not combined with it freezes them: the frame
// shows the whole-draft review (renderers/common/review.ts), and the person's choice comes back as
// `resolved`. "Publish your changes" is POST live/checkpoint with conflict_version (room), or PUT with
// base_version: n and files_from_version: the draft's base (solo); "Discard your changes", once the
// app's own confirmation (discardAsk) says so, is DELETE live/draft with conflict_version (room),
// or dropping the tab copy (solo); a cancelled confirmation answers `failed`. The app answers the
// frame with `reviewed`, so its buttons say when another editor is choosing.
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
import { clearPageDraft, loadPageDraft, type PageDraft, savePageDraft } from "../editor/draft.ts";
import { showToast } from "../ui/index.ts";
import {
  type AskWhat,
  collectMessage,
  editMessage,
  editTargetOrigin,
  type FrameMessage,
  type LiveFrameStatus,
  matchFrameMessage,
  newNonce,
  postToRenderer,
  type ReviewResult,
  readFrameMessage,
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

/** The note a version of page edits carries when the editor gave none (as the server's). */
export const LIVE_NOTE = "Edited on the page";

/** How often solo edits are copied to sessionStorage while dirty. */
export const SOLO_KEEP_MS = 5000;
/** How long the frame has to answer a collect. */
export const COLLECT_TIMEOUT_MS = 5000;
/** Editors whose edit was not the last one autosave this much later. */
export const AUTOSAVE_FALLBACK_MS = 30_000;
/** A choice or a discard refused because another one or a save holds the room's lock. */
export const CHOOSING_BUSY = "Someone else is publishing or discarding these changes right now.";

export interface UseLiveEditOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  /** The key of the frame's current load (withFrameKey), or null when it has none. */
  frameKey: string | null;
  /** Fetch a fresh gate (a solo publish, a discard, a lost session). */
  onReload: () => void;
  /** Esc at the top level of edit mode in the frame. */
  onLeave?: () => void;
  /** "Ask an agent" about a place on the page, from the frame (with the kind of block it is). */
  onAsk?: (anchor: { key: string; text: string } | null, what?: AskWhat) => void;
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
  mode: "room" | "solo" | null;
  editing: boolean;
  phase: LivePhase;
  status: LiveFrameStatus | null;
  saving: boolean;
  savedVersion: number | null;
  rebasedVersion: number | null;
  /** Solo: a newer version was published while editing. */
  newerVersion: number | null;
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
   * Turn edit mode on. `focus: "first"` (`?edit`, from New and Import): the frame gets the focus,
   * on its first block or cell, once it has loaded and turned editing on.
   */
  start(opts?: { focus?: "first" }): void;
  /** Finish editing (publishing dirty edits first); false when it stayed in edit mode. */
  done(): Promise<boolean>;
  publish(note?: string): Promise<void>;
  discard(): Promise<void>;
  /** Open the whole-draft review in the frame. */
  openReview(): Promise<void>;
  saveRestore(): Promise<void>;
  dropRestore(): void;
  /**
   * Ask an agent's "Publish my changes first": Publish, on the same path as the strip's, reporting
   * instead of toasting. It says what came of it: the version the request is then posted against,
   * or why nothing was published, in the strip's words. A lost session reloads the gate and a
   * conflict opens the review, as Publish does.
   */
  publishFirst(): Promise<PublishOutcome>;
}

/**
 * What came of a publish: the version it made (or, with nothing new to publish, the version being
 * edited), or why nothing was published, in the strip's words.
 */
export type PublishOutcome = { version: number } | { error: string };

/**
 * How a publish that did not happen is told: "toast" (the strip's Publish, Done, the review), or
 * "report" (Ask's "Publish my changes first"), which shows no toast and only returns the words, for
 * the dialog to show. Either way a lost session reloads the gate and a conflict opens the review.
 */
type Tell = "toast" | "report";

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
}: UseLiveEditOptions): LiveEdit {
  const { artifact } = gate;
  const id = artifact.id;
  const def = typeDef(artifact.type);
  const merges = liveRules(artifact.type)?.merge === "lines";
  // What the person edits, in messages ("doc", "sheet"), and how much the frame may hand back.
  const noun = (def?.badge ?? "doc").toLowerCase();
  const maxBytes =
    artifact.type === "doc" ? config?.limits.max_doc_bytes : (def?.maxSourceBytes ?? undefined);
  const target = editTargetOrigin(config, contentOrigin);
  const available = gate.live !== undefined && target !== null;
  const signIn = gate.live?.sign_in === true;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<LiveFrameStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [rebasedVersion, setRebasedVersion] = useState<number | null>(null);
  const [review, setReview] = useState<LiveReview | null>(null);
  /** The review's Discard, waiting for the app's confirmation. */
  const [discardAsk, setDiscardAsk] = useState<Resolved | null>(null);
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [restore, setRestore] = useState<PageDraft | null>(null);
  /** An idle autosave refused as too soon: try again after `ms`, unless the draft moved on. */
  const [idleRetry, setIdleRetry] = useState<{ rev: number; ms: number } | null>(null);
  const mode: LiveEdit["mode"] = !available
    ? null
    : gate.live?.mode === "room" && !status?.failed
      ? "room"
      : "solo";

  const latest = useRef({ status, mode, saving, editing, gate, onReload, review, onLeave, onAsk });
  latest.current = { status, mode, saving, editing, gate, onReload, review, onLeave, onAsk };
  const collecting = useRef<{
    nonce: string;
    resolve: (t: string, unsavable: boolean) => void;
  } | null>(null);
  const savingRef = useRef(false);
  const reviewRef = useRef<LiveReview | null>(null);
  reviewRef.current = review;
  /** Solo: the kept copy a review is of (saveRestore), which its "Publish your changes" publishes. */
  const keptReview = useRef<{ nonce: string; text: string } | null>(null);

  // ---------- errors ----------

  /**
   * A refused publish or discard, in the strip's words: shown as a toast, or only returned
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

  /** Room mode: the frame reviews the room's frozen draft; nothing crosses but the request. */
  const openReview = useCallback(async () => {
    const s = latest.current.status;
    if (latest.current.mode === "solo") return;
    if (s?.conflict_version == null) {
      toast("Nothing to review: your changes were kept on top of the new version.", "neutral");
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
      toast("The page is not ready. Try again in a moment.");
      return;
    }
    setReview(r);
  }, [frame, target]);

  /**
   * Solo mode: a Publish was refused because version n is current now. The frame reviews its own
   * copy beside n; the app says which files n changed since the base, from the two versions'
   * file lists (it reads only their `assets`). For a copy this tab kept from before a reload
   * (`kept`), the frame never held it: the review carries it, and the choice publishes it. A
   * refusal (`e`) that leaves nothing newer than the base to review says why instead.
   */
  const soloReview = useCallback(
    async (base: number, e: unknown, kept?: string) => {
      const n = currentOf(e) ?? latest.current.gate.artifact.current_version;
      if (n <= base) {
        toast(refusedText(e));
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
          toast("The page is not ready. Try again in a moment.");
          return;
        }
        keptReview.current = kept !== undefined ? { nonce, text: kept } : null;
        setReview({ nonce, base, current: n, mode: "solo" });
      } catch (e) {
        fail(e);
      }
    },
    [id, frame, target, fail],
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
        leave() {
          latest.current.onLeave?.();
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
  useEffect(() => {
    if (!available || !frame) return;
    if (!editing && !told.current) return;
    told.current = editing;
    const send = () => {
      const focus = editing && focusFirst.current ? ("first" as const) : undefined;
      // The frame's own focus() moves the keyboard only once its window has the focus.
      if (focus) frame.focus();
      postToRenderer(frame, target, editMessage(editing, soloBase, focus));
    };
    send();
    frame.addEventListener("load", send);
    return () => frame.removeEventListener("load", send);
  }, [available, frame, target, editing, soloBase]);

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
      opts: { note?: string; onConflict?: (e: ApiRequestError) => void; tell?: Tell } = {},
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
        latest.current.onReload();
        return { version: r.version };
      } catch (e) {
        return refuse(
          e,
          () => {
            if (opts.onConflict && e instanceof ApiRequestError) opts.onConflict(e);
            else void soloReviewRef.current(base, e);
          },
          opts.tell,
        );
      }
    },
    [id, refuse],
  );

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
      const quiet = tell === "report" || reason === "idle";
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
          if (!quiet) toast(UNPUBLISHABLE, "neutral");
          return { error: UNPUBLISHABLE };
        }
        return refuse(e, code === "live_conflict" ? () => void openReview() : undefined, tell);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [id, refuse, openReview],
  );

  /**
   * Publish the page edits as the next version: the strip's Publish, Done in solo mode, and Ask's
   * "Publish my changes first" (`tell: "report"`). Room: a checkpoint; solo: the frame's text over
   * the version shown, with its files.
   */
  const publishNow = useCallback(
    async (note: string | undefined, tell: Tell): Promise<PublishOutcome> => {
      const m = latest.current.mode;
      const s = latest.current.status;
      // Every way to publish (the strip, Cmd/Ctrl+S, Done, Ask's publish first) comes here: nothing
      // goes out while a block holds typing the page cannot save, or the draft cannot be a version.
      if (s?.unsavable) {
        if (tell === "toast") toast(UNSAVABLE, "neutral");
        return { error: UNSAVABLE };
      }
      if (s?.publishable === false) {
        if (tell === "toast") toast(UNPUBLISHABLE, "neutral");
        return { error: UNPUBLISHABLE };
      }
      if (m === "room") return checkpoint("save", { note, tell });
      if (m !== "solo") return { error: "Editing on the page is not available." };
      if (savingRef.current) return { error: CHOOSING_BUSY };
      savingRef.current = true;
      setSaving(true);
      try {
        const text = await collect();
        const v = latest.current.gate.artifact.version;
        return await publishSolo(text, v, v, { note, tell });
      } catch (e) {
        return refuse(e, undefined, tell);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [checkpoint, collect, publishSolo, refuse],
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
            done("done");
          }
          setReview(null);
        } catch (e) {
          roomFail(e);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      })();
      return;
    }
    // Solo: the frame's own copy, or dropping it.
    if (m.outcome === "discard") {
      clearPageDraft(id);
      setRestore(null);
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

  // ---------- starting and finishing ----------

  const start = useCallback(
    (opts?: { focus?: "first" }) => {
      if (!available || signIn) return;
      focusFirst.current = opts?.focus === "first";
      setSavedVersion(null);
      setRebasedVersion(null);
      setEditing(true);
    },
    [available, signIn],
  );

  const done = useCallback(async (): Promise<boolean> => {
    const s = latest.current.status;
    const m = latest.current.mode;
    // A block holds text the page cannot write yet: it is not in the draft, so editing stays on
    // (the frame says what to change) rather than losing it.
    if (s?.unsavable) return false;
    // Room edits stay in the shared draft whatever the save does, so editing ends either way. A
    // frozen draft, or one that cannot be a version yet, is kept as it is.
    if (m === "room" && s?.dirty && s.conflict_version === null && s.publishable !== false) {
      await checkpoint("done");
    }
    // Solo edits live only in this frame: leave edit mode only once they are published.
    if (m === "solo" && s?.dirty && "error" in (await publishNow(undefined, "toast"))) {
      return false;
    }
    setEditing(false);
    return true;
  }, [checkpoint, publishNow]);

  const discard = useCallback(async () => {
    const m = latest.current.mode;
    if (m === "solo") {
      clearPageDraft(id);
      setRestore(null);
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
      showToast({ title: "Unpublished changes discarded." });
    } catch (e) {
      fail(e);
    }
  }, [id, fail]);

  // ---------- solo: keep a copy, offer it back after a reload ----------

  useEffect(() => {
    if (!available || gate.live?.mode !== "solo") return;
    setRestore(loadPageDraft(id));
  }, [available, gate.live?.mode, id]);

  const soloDirty = mode === "solo" && editing && status?.dirty === true;
  // Typing a block cannot save as typed is not in the frame's text, so it does not make it dirty:
  // it is kept (without its formatting) and warned about all the same.
  const soloStuck = mode === "solo" && editing && status?.unsavable === true;
  useEffect(() => {
    if (!soloDirty && !soloStuck) return;
    const base = gate.artifact.version;
    const t = window.setInterval(() => {
      collect({ keep: true })
        .then((text) => savePageDraft(id, base, text))
        .catch(() => undefined);
    }, SOLO_KEEP_MS);
    return () => window.clearInterval(t);
  }, [soloDirty, soloStuck, collect, id, gate.artifact.version]);

  const saveRestore = useCallback(async () => {
    if (!restore) return;
    const { text, base } = restore;
    // Refused because a newer version is current: the frame reviews this copy, not its own (it
    // holds none, or one of the version it shows).
    await publishSolo(text, base, base, {
      onConflict: (e) => void soloReviewRef.current(base, e, text),
    });
  }, [restore, publishSolo]);

  const dropRestore = useCallback(() => {
    clearPageDraft(id);
    setRestore(null);
  }, [id]);

  // ---------- Ask an agent: publish first ----------

  const publishFirst = useCallback(async (): Promise<PublishOutcome> => {
    const s = latest.current.status;
    const m = latest.current.mode;
    // What the strip shows instead of Publish, said up front: nothing is tried.
    if (m === "room" || m === "solo") {
      if (savingRef.current) return { error: CHOOSING_BUSY };
      if (s?.conflict_version != null) return { error: conflictText(s.conflict_version) };
      if (s?.unsavable) return { error: UNSAVABLE };
      if (s?.publishable === false) return { error: UNPUBLISHABLE };
      if (m === "room" && !s?.connected) return { error: NOT_CONNECTED };
    }
    return publishNow(undefined, "report");
  }, [publishNow]);

  // ---------- room: autosave after a quiet spell ----------

  useEffect(() => {
    if (!available || mode !== "room" || !editing || info) return;
    const ctrl = new AbortController();
    liveInfo(id, ctrl.signal)
      .then(setInfo)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [available, mode, editing, info, id]);

  const idleS = info?.idle_checkpoint_s ?? 0;
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

  // A review the room closed (another editor's choice, a version that unfroze the draft) ends
  // here too; the frame says why.
  useEffect(() => {
    if (review?.mode === "room" && status && status.conflict_version === null && !saving) {
      setReview(null);
    }
  }, [review, status, saving]);

  // ---------- leaving the page, the publish shortcut ----------

  const unsaved =
    (mode === "room" && status?.unflushed === true) ||
    (mode === "solo" && soloDirty) ||
    status?.unsavable === true;
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

  const phase: LivePhase = useMemo(() => {
    if (review || status?.conflict_version != null) return "conflict";
    if (saving) return "saving";
    if (!editing) return mode === "room" && status?.connected ? "watching" : "idle";
    if (mode === "solo") return "solo";
    return status?.dirty ? "dirty" : "editing";
  }, [review, status, saving, editing, mode]);

  const roomReady = mode === "room" && status?.connected === true;
  const pause: WatchPause =
    mode === "room" && status?.connected ? "follow" : soloDirty || review ? "hold" : null;
  const newerVersion =
    mode === "solo" && editing && artifact.current_version > artifact.version
      ? artifact.current_version
      : null;

  return {
    available,
    merges,
    signIn,
    mode,
    editing,
    phase,
    status,
    saving,
    savedVersion,
    rebasedVersion,
    newerVersion,
    review,
    reviewing: review !== null,
    discardAsk: discardAsk && review && discardAsk.nonce === review.nonce ? review.current : null,
    answerDiscard,
    restore,
    pause,
    roomReady,
    start,
    done,
    publish,
    discard,
    openReview,
    saveRestore,
    dropRestore,
    publishFirst,
  };
}
