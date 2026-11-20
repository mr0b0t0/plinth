// On-page editing of a doc (#36), app side: the state machine behind the Edit toggle, the edit bar
// and the unsaved-edits notice. The doc frame does the editing; this hook talks to it with the
// renderer protocol (rendererProtocol.ts) and to the server with the session cookie.
//
// Modes (gate.live.mode, decided by the server):
// - "room": the frame edits the live draft in the artifact's room with the other editors. The app
//   never sees draft text: it gets numbers, booleans and co-editor emails, and saves a version
//   with a checkpoint (POST live/checkpoint) on Save, on Done, or after a quiet spell (autosave,
//   by the editor whose edit was last, other editors 30 s later as a fallback).
// - "solo": origin isolation without rooms (or a room that never answered). The frame edits its
//   own copy; Save asks it for the text (collect with a nonce) and publishes it with PUT and the
//   shown version as base_version. A copy goes to sessionStorage every 5 s, so a reload can offer
//   to save it.
// Opaque isolation and the path fallback have no on-page editing (no gate.live).
//
// Phases: idle (not editing, no room), watching (not editing, the frame follows the room),
// editing, dirty, saving, conflict (a version changed the same lines; review needed), solo.
import {
  API,
  type AppConfig,
  type ArtifactDetail,
  type LiveCheckpointResult,
  type LiveInfo,
  type PublishResult,
  route,
  sourceOf,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  api,
  liveCheckpoint,
  liveDiscard,
  liveDraft,
  liveInfo,
} from "../../lib/api.ts";
import { clearPageDraft, loadPageDraft, type PageDraft, savePageDraft } from "../editor/draft.ts";
import { showToast } from "../ui/index.ts";
import {
  collectMessage,
  editMessage,
  editTargetOrigin,
  type LiveFrameStatus,
  matchFrameMessage,
  newNonce,
  postToRenderer,
  readFrameMessage,
} from "./rendererProtocol.ts";
import type { WatchPause } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

export type LivePhase = "idle" | "watching" | "editing" | "dirty" | "saving" | "conflict" | "solo";

/** Draft and published text side by side, for the review dialog. */
export interface LiveConflict {
  draft: string;
  /** The version the draft is based on. */
  base: number;
  /** The version that changed the same lines (or, solo, the one now current). */
  current: number;
  currentText: string;
  /** Room mode: the draft revision and base the resolution is checked against. */
  rev?: number;
}

/** How often solo edits are copied to sessionStorage while dirty. */
export const SOLO_KEEP_MS = 5000;
/** How long the frame has to answer a collect. */
export const COLLECT_TIMEOUT_MS = 5000;
/** Editors whose edit was not the last one autosave this much later. */
export const AUTOSAVE_FALLBACK_MS = 30_000;

export interface UseLiveEditOptions {
  gate: OkGate;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  /** Fetch a fresh gate (a solo save, a discard, a lost session). */
  onReload: () => void;
}

export interface LiveEdit {
  /** On-page editing exists for this person here (owner or editor, origin isolation). */
  available: boolean;
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
  conflict: LiveConflict | null;
  reviewing: boolean;
  /** Solo: page edits this tab kept from before a reload. */
  restore: PageDraft | null;
  pause: WatchPause;
  /** Room mode with the frame connected: the shared draft can be saved or discarded from here. */
  roomReady: boolean;
  start(): void;
  /** Finish editing (saving dirty edits first); false when it stayed in edit mode. */
  done(): Promise<boolean>;
  save(note?: string): Promise<void>;
  discard(): Promise<void>;
  review(): Promise<void>;
  closeReview(): void;
  keepMine(): Promise<void>;
  takeLatest(): Promise<void>;
  saveRestore(): Promise<void>;
  dropRestore(): void;
}

const toast = (title: string, tone: "neutral" | "danger" | "success" | "warning" = "danger") =>
  showToast({ title, tone });

export function useLiveEdit({
  gate,
  frame,
  contentOrigin,
  config,
  onReload,
}: UseLiveEditOptions): LiveEdit {
  const { artifact } = gate;
  const id = artifact.id;
  const target = editTargetOrigin(config, contentOrigin);
  const available = gate.live !== undefined && target !== null;
  const signIn = gate.live?.sign_in === true;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<LiveFrameStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [rebasedVersion, setRebasedVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<LiveConflict | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [restore, setRestore] = useState<PageDraft | null>(null);
  /** An idle autosave refused as too soon: try again after `ms`, unless the draft moved on. */
  const [idleRetry, setIdleRetry] = useState<{ rev: number; ms: number } | null>(null);
  const mode: LiveEdit["mode"] = !available
    ? null
    : gate.live?.mode === "room" && !status?.failed
      ? "room"
      : "solo";

  const latest = useRef({ status, mode, saving, editing, gate, onReload });
  latest.current = { status, mode, saving, editing, gate, onReload };
  const collecting = useRef<{ nonce: string; resolve: (t: string) => void } | null>(null);
  const savingRef = useRef(false);

  // ---------- frame messages ----------

  useEffect(() => {
    if (!available) return;
    const onMessage = (e: MessageEvent) => {
      const m = readFrameMessage(e, {
        frame,
        contentOrigin: target,
        solo: latest.current.mode === "solo",
        nonce: collecting.current?.nonce ?? null,
        maxDocBytes: config?.limits.max_doc_bytes,
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
            !savingRef.current
          ) {
            setRebasedVersion(next.base_version);
            showToast({
              title: `v${next.base_version} was published. Your page edits were kept on top of it.`,
            });
          }
          setStatus(next);
        },
        save() {
          void saveRef.current();
        },
        draft({ nonce, text }) {
          const c = collecting.current;
          if (c?.nonce !== nonce) return;
          collecting.current = null;
          c.resolve(text);
        },
        // A version shown in place is the live-view update's answer (useViewUpdate.ts).
        shown() {},
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [available, frame, target, config]);

  // A new frame (a reload, review mode off) starts in view mode: tell it again, once it loaded.
  const told = useRef(false);
  useEffect(() => {
    if (!available || !frame) return;
    if (!editing && !told.current) return;
    told.current = editing;
    const send = () => postToRenderer(frame, target, editMessage(editing));
    send();
    frame.addEventListener("load", send);
    return () => frame.removeEventListener("load", send);
  }, [available, frame, target, editing]);

  const collect = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const nonce = newNonce();
      const timer = window.setTimeout(() => {
        if (collecting.current?.nonce === nonce) collecting.current = null;
        reject(new Error("The page did not answer."));
      }, COLLECT_TIMEOUT_MS);
      collecting.current = {
        nonce,
        resolve: (t) => {
          window.clearTimeout(timer);
          resolve(t);
        },
      };
      if (!postToRenderer(frame, target, collectMessage(nonce))) {
        window.clearTimeout(timer);
        collecting.current = null;
        reject(new Error("The page is not ready."));
      }
    });
  }, [frame, target]);

  // ---------- errors ----------

  const fail = useCallback((e: unknown, onConflict?: () => void) => {
    if (!(e instanceof ApiRequestError)) {
      toast(e instanceof Error ? e.message : "Something went wrong. Your edits are kept.");
      return;
    }
    if (e.status === 401) {
      toast("Sign in again to save. Your edits are kept.");
      latest.current.onReload();
    } else if (e.status === 403) toast("You can no longer edit this doc.");
    else if (e.status === 409 && onConflict) onConflict();
    else if (e.status === 409) toast(e.message);
    else if (e.status === 413) toast("This doc is too large to save as a version.");
    else if (e.status === 429) toast("Hourly version limit reached. Your edits stay as a draft.");
    else if (e.status === 503) toast("Live editing is unavailable. Your edits are kept.");
    else toast(e.message);
  }, []);

  // ---------- review (conflicts) ----------

  const versionText = useCallback(
    async (n: number) => {
      const d = await api<ArtifactDetail>(route(API.version, { ref: id, n }));
      return sourceOf(d).text;
    },
    [id],
  );

  const review = useCallback(async () => {
    if (latest.current.mode === "solo") {
      // Solo: compare this frame's edits with the version published meanwhile.
      try {
        const text = await collect();
        const g = latest.current.gate.artifact;
        await soloConflictRef.current(text, g.version, { current_version: g.current_version });
      } catch (e) {
        fail(e);
      }
      return;
    }
    setReviewing(true);
    try {
      const d = await liveDraft(id);
      if (d.conflict_version === null) {
        setReviewing(false);
        toast("Nothing to review: the page edits merged cleanly.", "neutral");
        return;
      }
      const currentText = await versionText(d.conflict_version);
      setConflict({
        draft: d.text,
        base: d.base_version,
        current: d.conflict_version,
        currentText,
        rev: d.rev,
      });
    } catch (e) {
      setReviewing(false);
      fail(e);
    }
  }, [id, versionText, fail, collect]);

  const soloConflict = useCallback(
    async (draft: string, base: number, details: unknown) => {
      const n =
        typeof (details as { current_version?: unknown } | undefined)?.current_version === "number"
          ? (details as { current_version: number }).current_version
          : latest.current.gate.artifact.current_version;
      try {
        const currentText = await versionText(n);
        setConflict({ draft, base, current: n, currentText });
        setReviewing(true);
      } catch (e) {
        fail(e);
      }
    },
    [versionText, fail],
  );

  const soloConflictRef = useRef(soloConflict);
  soloConflictRef.current = soloConflict;

  const closeReview = useCallback(() => {
    setReviewing(false);
    setConflict(null);
  }, []);

  // ---------- saving ----------

  const publishSolo = useCallback(
    async (text: string, base: number, note?: string): Promise<PublishResult | null> => {
      try {
        const r = await api<PublishResult>(route(API.artifact, { ref: id }), {
          method: "PUT",
          body: { content: text, base_version: base, ...(note ? { note } : {}) },
        });
        clearPageDraft(id);
        setRestore(null);
        setSavedVersion(r.version);
        latest.current.onReload();
        return r;
      } catch (e) {
        fail(e, () => {
          void soloConflict(text, base, e instanceof ApiRequestError ? e.details : undefined);
        });
        return null;
      }
    },
    [id, fail, soloConflict],
  );

  const checkpoint = useCallback(
    async (reason: "save" | "done" | "idle", note?: string): Promise<boolean> => {
      const s = latest.current.status;
      if (!s || savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        const r: LiveCheckpointResult = await liveCheckpoint(id, {
          base_version: s.base_version,
          rev: s.rev,
          reason,
          ...(note ? { note } : {}),
        });
        if (r.saved) setSavedVersion(r.version.version);
        else if (reason === "idle" && r.reason === "too_soon" && r.retry_in_s) {
          setIdleRetry({ rev: s.rev, ms: r.retry_in_s * 1000 });
        } else if (reason === "save" && (r.reason === "clean" || r.reason === "unchanged")) {
          toast("Nothing to save: the page matches the current version.", "neutral");
        } else if (reason !== "idle" && r.reason === "busy") {
          toast("Someone else is saving these edits right now.", "neutral");
        }
        return true;
      } catch (e) {
        const reasonCode =
          e instanceof ApiRequestError ? (e.details as { reason?: string })?.reason : null;
        fail(e, reasonCode === "live_conflict" ? () => void review() : undefined);
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [id, fail, review],
  );

  const save = useCallback(
    async (note?: string) => {
      const m = latest.current.mode;
      if (m === "room") {
        await checkpoint("save", note);
        return;
      }
      if (m !== "solo" || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const text = await collect();
        await publishSolo(text, latest.current.gate.artifact.version, note);
      } catch (e) {
        fail(e);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [checkpoint, collect, publishSolo, fail],
  );
  const saveRef = useRef(save);
  saveRef.current = () => save();

  const start = useCallback(() => {
    if (!available || signIn) return;
    setSavedVersion(null);
    setRebasedVersion(null);
    setEditing(true);
  }, [available, signIn]);

  const done = useCallback(async (): Promise<boolean> => {
    const s = latest.current.status;
    const m = latest.current.mode;
    // Room edits stay in the shared draft whatever the save does, so editing ends either way.
    if (m === "room" && s?.dirty && s.conflict_version === null) await checkpoint("done");
    if (m === "solo" && s?.dirty) {
      // Solo edits live only in this frame: leave edit mode only once they are saved.
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        const text = await collect();
        const r = await publishSolo(text, latest.current.gate.artifact.version);
        if (!r) return false;
      } catch (e) {
        fail(e);
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }
    setEditing(false);
    return true;
  }, [checkpoint, collect, publishSolo, fail]);

  const discard = useCallback(async () => {
    const m = latest.current.mode;
    if (m === "solo") {
      clearPageDraft(id);
      setRestore(null);
      latest.current.onReload();
      return;
    }
    const s = latest.current.status;
    try {
      const rev = s?.rev ?? (await liveDraft(id)).rev;
      await liveDiscard(id, rev);
      showToast({ title: "Unsaved page edits discarded." });
    } catch (e) {
      fail(e);
    }
  }, [id, fail]);

  // A resolution is checked against the conflict it was reviewed for: when a newer version
  // conflicts now, the review opens again on that one instead of overwriting it.
  const failResolve = useCallback(
    (e: unknown) => {
      const code = e instanceof ApiRequestError ? (e.details as { reason?: string })?.reason : null;
      if (e instanceof ApiRequestError && e.status === 409 && code === "live_conflict") {
        toast(e.message, "warning");
        setConflict(null);
        void review();
        return;
      }
      fail(e);
    },
    [fail, review],
  );

  const keepMine = useCallback(async () => {
    const c = conflict;
    if (!c) return;
    if (latest.current.mode === "solo" || c.rev === undefined) {
      const r = await publishSolo(c.draft, c.current);
      if (r) closeReview();
      return;
    }
    setSaving(true);
    try {
      const r = await liveCheckpoint(id, {
        base_version: c.base,
        rev: c.rev,
        reason: "save",
        resolved_text: c.draft,
        conflict_version: c.current,
      });
      if (r.saved) setSavedVersion(r.version.version);
      closeReview();
    } catch (e) {
      failResolve(e);
    } finally {
      setSaving(false);
    }
  }, [conflict, id, publishSolo, closeReview, failResolve]);

  const takeLatest = useCallback(async () => {
    const c = conflict;
    if (!c) return;
    if (latest.current.mode === "solo" || c.rev === undefined) {
      clearPageDraft(id);
      setRestore(null);
      closeReview();
      latest.current.onReload();
      return;
    }
    setSaving(true);
    try {
      await liveCheckpoint(id, {
        base_version: c.base,
        rev: c.rev,
        reason: "save",
        resolved_text: c.currentText,
        conflict_version: c.current,
      });
      closeReview();
      showToast({ title: `The page is back to v${c.current}.` });
    } catch (e) {
      failResolve(e);
    } finally {
      setSaving(false);
    }
  }, [conflict, id, closeReview, failResolve]);

  // ---------- solo: keep a copy, offer it back after a reload ----------

  useEffect(() => {
    if (!available || gate.live?.mode !== "solo") return;
    setRestore(loadPageDraft(id));
  }, [available, gate.live?.mode, id]);

  const soloDirty = mode === "solo" && editing && status?.dirty === true;
  useEffect(() => {
    if (!soloDirty) return;
    const base = gate.artifact.version;
    const t = window.setInterval(() => {
      collect()
        .then((text) => savePageDraft(id, base, text))
        .catch(() => undefined);
    }, SOLO_KEEP_MS);
    return () => window.clearInterval(t);
  }, [soloDirty, collect, id, gate.artifact.version]);

  const saveRestore = useCallback(async () => {
    if (!restore) return;
    await publishSolo(restore.text, restore.base);
  }, [restore, publishSolo]);

  const dropRestore = useCallback(() => {
    clearPageDraft(id);
    setRestore(null);
  }, [id]);

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
  // A new rev restarts the quiet spell.
  useEffect(() => {
    if (mode !== "room" || !editing || !dirty || frozen || idleS <= 0) return;
    // Refused as too soon (the current version is younger than LIVE_AUTO_CHECKPOINT_MIN_S): try
    // again when the server said, as long as nobody typed since.
    const ms =
      idleRetry && idleRetry.rev === rev
        ? idleRetry.ms
        : idleS * 1000 + (lastByYou ? 0 : AUTOSAVE_FALLBACK_MS);
    const t = window.setTimeout(() => void checkpoint("idle"), ms);
    return () => window.clearTimeout(t);
  }, [mode, editing, dirty, frozen, idleS, lastByYou, rev, idleRetry, checkpoint]);

  // ---------- leaving the page, the save shortcut ----------

  const unsaved = (mode === "room" && status?.unflushed === true) || (mode === "solo" && soloDirty);
  useEffect(() => {
    if (!unsaved) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [unsaved]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // ---------- derived ----------

  const phase: LivePhase = useMemo(() => {
    if (conflict || status?.conflict_version != null) return "conflict";
    if (saving) return "saving";
    if (!editing) return mode === "room" && status?.connected ? "watching" : "idle";
    if (mode === "solo") return "solo";
    return status?.dirty ? "dirty" : "editing";
  }, [conflict, status, saving, editing, mode]);

  const roomReady = mode === "room" && status?.connected === true;
  const pause: WatchPause =
    mode === "room" && status?.connected ? "follow" : soloDirty ? "hold" : null;
  const newerVersion =
    mode === "solo" && editing && artifact.current_version > artifact.version
      ? artifact.current_version
      : null;

  return {
    available,
    signIn,
    mode,
    editing,
    phase,
    status,
    saving,
    savedVersion,
    rebasedVersion,
    newerVersion,
    conflict,
    reviewing,
    restore,
    pause,
    roomReady,
    start,
    done,
    save,
    discard,
    review,
    closeReview,
    keepMine,
    takeLatest,
    saveRestore,
    dropRestore,
  };
}
