// Applies a newer version to the frame on view (docs/spec.md "Live views", keeping state). The
// version watch (useVersionWatch.ts) hands over a fresh gate as `pending`; this hook picks how to
// apply it (viewUpdate.ts planUpdate) and runs that:
// - in-place (docs): asks the doc renderer to show the version (`version`), and on its `shown`
//   answer keeps the frame and its enter URL, so nothing reloads; otherwise, or after 5 s, swaps.
// - hold (HTML that declares `hold`, focus in the frame, with or without the runtime): only the
//   count of versions moves on and the stage offers "vN is available · Update", which loads it
//   without an "Updated" toast (the viewer chose it).
// - ask (HTML with the runtime): posts `update` at the exact content origin; on `update:ok` the new
//   version lands where the page was (one more gate read with `next`), on `update:hold` it waits;
//   a page that declares `hold` and got focus while the app waited is held either way; with no
//   answer in 1 s it swaps.
// - swap: the fresh gate replaces the frame, as before.
// After every wait the hook looks again: a frame paused meanwhile (a doc edited on its page) is
// kept, as the "keep" plan keeps it, instead of being replaced under the person editing it.
// Every frame answer is checked for the frame's window, its exact origin and the app's nonce, and
// only ever chooses among things the page could cause anyway: a hold, or a path in its artifact.
import {
  type AppConfig,
  LIVE_VIEW_LIMITS,
  type ViewGate,
  type ViewPageMessage,
} from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  editTargetOrigin,
  type FrameMessage,
  newNonce,
  postToRenderer,
  readFrameMessage,
  versionMessage,
} from "./rendererProtocol.ts";
import { nextGate, type WatchPause } from "./useVersionWatch.ts";
import { frameHasFocus, planUpdate, readViewMessage, updateMessage } from "./viewUpdate.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** What the page gives the stage to apply updates with (ArtifactPage). */
export interface UpdateHandlers {
  /** A fresh gate for a newer version, waiting to be applied; null when none. */
  pending: OkGate | null;
  /**
   * Show this gate (it replaces the frame unless its enter URL is the shown one) and say so, unless
   * `quiet`: the viewer chose Update, and the new version on screen says it.
   */
  apply: (gate: OkGate, quiet?: boolean) => void;
  /** Show this gate without saying "Updated" (only the count of versions moved). */
  count: (gate: OkGate) => void;
  /** Forget `pending` (it is no newer than what is on view). */
  drop: () => void;
  /** A fresh gate for the current version, landing on `next` inside the artifact (null: root). */
  fetchGate: (next: string | null) => Promise<OkGate | null>;
}

export interface ViewUpdate {
  /** The version waiting behind the Update button, or null. */
  held: number | null;
  /** The viewer chose Update: apply the newest version now. */
  update: () => void;
  /** Update is under way. */
  updating: boolean;
}

interface Waiting {
  kind: "update" | "shown";
  nonce: string;
  resolve: (m: ViewPageMessage | FrameMessage | null) => void;
}

export function useViewUpdate(o: {
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  config: AppConfig | null;
  gate: OkGate;
  pinned: boolean;
  pause: WatchPause;
  review: boolean;
  handlers: UpdateHandlers | undefined;
}): ViewUpdate {
  const [held, setHeld] = useState<number | null>(null);
  const [updating, setUpdating] = useState(false);
  const latest = useRef(o);
  latest.current = o;
  /** The frame window whose runtime said hello. */
  const hello = useRef<Window | null>(null);
  const waiting = useRef<Waiting | null>(null);
  const exactOrigin = editTargetOrigin(o.config, o.contentOrigin);
  const originRef = useRef(exactOrigin);
  originRef.current = exactOrigin;

  // Frame answers: the runtime's hello and update replies, the doc renderer's `shown`.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const { frame } = latest.current;
      const w = waiting.current;
      const contentOrigin = originRef.current;
      const vm = readViewMessage(e, {
        frame,
        contentOrigin,
        nonce: w?.kind === "update" ? w.nonce : null,
      });
      if (vm) {
        if (vm.type === "hello") hello.current = frame?.contentWindow ?? null;
        else w?.resolve(vm);
        return;
      }
      if (w?.kind !== "shown") return;
      const fm = readFrameMessage(e, {
        frame,
        contentOrigin,
        solo: false,
        nonce: null,
        shown: w.nonce,
      });
      if (fm?.type === "shown") w.resolve(fm);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      waiting.current?.resolve(null);
    };
  }, []);

  /** Wait for the frame's answer to `nonce`, at most `ms`; null when none came. */
  const waitFor = useCallback(
    <T extends ViewPageMessage | FrameMessage>(
      kind: Waiting["kind"],
      nonce: string,
      ms: number,
    ): Promise<T | null> => {
      waiting.current?.resolve(null);
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => entry.resolve(null), ms);
        const entry: Waiting = {
          kind,
          nonce,
          resolve: (m) => {
            window.clearTimeout(timer);
            if (waiting.current === entry) waiting.current = null;
            resolve(m as T | null);
          },
        };
        waiting.current = entry;
      });
    },
    [],
  );

  /** Ask the frame's runtime to record its state for `to`; its answer, or null. */
  const askRuntime = useCallback(
    async (from: number, to: number, force: boolean) => {
      const { frame } = latest.current;
      const win = frame?.contentWindow;
      const target = originRef.current;
      if (!win || !target || hello.current !== win) return null;
      const nonce = newNonce();
      const reply = waitFor<ViewPageMessage>("update", nonce, LIVE_VIEW_LIMITS.updateReplyMs);
      win.postMessage(updateMessage({ from, to, nonce, force }), target);
      return reply;
    },
    [waitFor],
  );

  /** Wait for the viewer: only the count of versions moves on. */
  const hold = useCallback((pending: OkGate) => {
    const { gate, handlers } = latest.current;
    const to = pending.artifact.current_version;
    setHeld(to);
    handlers?.count({ ...gate, artifact: { ...gate.artifact, current_version: to } });
  }, []);

  /**
   * Whether the frame was paused or pinned meanwhile (a doc being edited on its page, a deck
   * presented): then only the count moves on, as the version watch does for a paused frame, and
   * true is returned.
   */
  const kept = useCallback((pending: OkGate) => {
    const { gate, handlers, pinned, pause } = latest.current;
    if (!pinned && pause === null) return false;
    const next = nextGate(gate, pending, pinned, pause);
    if (next) handlers?.count(next);
    else handlers?.drop();
    return true;
  }, []);

  /** Apply `pending`, landing on `path` inside the artifact when the page reported one. */
  const applyAt = useCallback(async (pending: OkGate, path: string | null) => {
    const handlers = latest.current.handlers;
    if (!handlers) return;
    const g = path ? await handlers.fetchGate(path).catch(() => null) : null;
    setHeld(null);
    handlers.apply(g ?? pending);
  }, []);

  const pending = o.handlers?.pending ?? null;
  useEffect(() => {
    if (!pending) return;
    let current = true;
    const run = async () => {
      const s = latest.current;
      const handlers = s.handlers;
      if (!handlers) return;
      const shown = s.gate;
      const to = pending.artifact.current_version;
      // Already on view (or older): nothing to apply.
      if (to <= shown.artifact.version) return handlers.drop();
      const plan = planUpdate({
        enabled: s.config?.live_views === true,
        type: shown.artifact.type,
        pinned: s.pinned,
        pause: s.pause,
        review: s.review,
        isolation: s.config?.content_isolation ?? "origin",
        pathFallback: s.config?.content_path_fallback === true,
        runtimeHello: hello.current !== null && hello.current === s.frame?.contentWindow,
        frameFocused: frameHasFocus(s.frame),
        liveRoomFrame: shown.live?.mode === "room",
        holdDeclared: shown.hold === true,
      });
      switch (plan.kind) {
        case "keep":
          // Paused since the watch looked: do what it does for a paused frame.
          kept(pending);
          return;
        case "swap":
          setHeld(null);
          return handlers.apply(pending);
        case "hold":
          return hold(pending);
        case "in-place": {
          const nonce = newNonce();
          const reply = waitFor<FrameMessage>("shown", nonce, LIVE_VIEW_LIMITS.inPlaceReplyMs);
          if (!postToRenderer(s.frame, originRef.current, versionMessage(to, nonce))) {
            waiting.current?.resolve(null);
          }
          const m = await reply;
          if (!current) return;
          const now = latest.current;
          // Shown in place: the frame stays, with its enter URL, so nothing reloads. The frame
          // shows `to` now, so this holds even if editing began right after it answered.
          if (m?.type === "shown" && m.ok && m.n === to) {
            setHeld(null);
            return now.handlers?.apply({ ...pending, enter_url: now.gate.enter_url });
          }
          // Refused: editing may have begun while the renderer fetched. Then the frame stays.
          if (kept(pending)) return;
          setHeld(null);
          return now.handlers?.apply(pending);
        }
        case "ask": {
          const m = await askRuntime(shown.artifact.version, to, false);
          if (!current) return;
          if (kept(pending)) return;
          if (m?.type === "update:hold") return hold(pending);
          // The hold rule wins over the runtime's answer: its carry has no unsaved input in it.
          const now = latest.current;
          if (now.gate.hold === true && frameHasFocus(now.frame)) return hold(pending);
          if (m?.type === "update:ok") return applyAt(pending, m.path);
          setHeld(null);
          return now.handlers?.apply(pending);
        }
      }
    };
    void run();
    return () => {
      current = false;
    };
  }, [pending, askRuntime, applyAt, hold, kept, waitFor]);

  // A held version that is no longer newer than what is on view (a reload showed it) is done.
  const shownVersion = o.gate.artifact.version;
  useEffect(() => {
    if (held !== null && shownVersion >= held) setHeld(null);
  }, [held, shownVersion]);

  const busy = useRef(false);
  const update = useCallback(() => {
    if (busy.current) return;
    const s = latest.current;
    if (!s.handlers) return;
    busy.current = true;
    setUpdating(true);
    const from = s.gate.artifact.version;
    const to = s.gate.artifact.current_version;
    void (async () => {
      try {
        // The viewer chose it: a page that asked to hold still records its state (force).
        const m = await askRuntime(from, to, true);
        const path = m?.type === "update:ok" ? m.path : null;
        const g = await latest.current.handlers?.fetchGate(path).catch(() => null);
        if (g) {
          setHeld(null);
          latest.current.handlers?.apply(g, true);
        }
      } finally {
        busy.current = false;
        setUpdating(false);
      }
    })();
  }, [askRuntime]);

  return { held, update, updating };
}
