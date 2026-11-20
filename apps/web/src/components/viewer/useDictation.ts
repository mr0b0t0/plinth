// Dictation run by the app (docs/spec.md "Voice: dictation and text to speech"). The page in the
// artifact frame asks over postMessage (its runtime's plinth.dictation); this hook, Plinth's own
// code on APP_HOST, decides, runs the browser's speech recognizer and posts back only words. The
// frame never gets the microphone: frames keep `allow=""`, and the app's Permissions-Policy names
// only the app's own origin.
//
// A start goes through, in order: a message from this frame's window at its exact content origin
// that parses (anything else is dropped); dictation offered here (config and gate); a click or key
// press the app can see (navigator.userActivation, which a click inside the frame gives its
// ancestors) made in the page (focus is inside this frame, so a click on the app's chrome or the
// link that opened the page does not count); the tab visible and focused; not busy, not too soon,
// not after Stop or "Not now";
// the viewer's consent for this artifact; then the recognizer. Listening stops at the page's stop,
// the viewer's Stop, silence, 60 s, a hidden tab, a blurred window (polled while listening: with
// focus inside the frame, a switch to another window sends this document no event), a frame
// reload (any load of the frame after its first) and unmount.
// Posts go only to the frame's exact content origin, never "*", so dictation is off under opaque
// isolation (the server says so too).
//
// The app listens from the moment the stage hands it the frame, before its config arrives: the
// gate's voice part already carries the server's decision (switch, isolation, identity), and a
// page's `hello` that only the config can answer is answered once it arrives.
import { API, type AppConfig, type DictationOwner, route, type ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { acceptFrom, targetOriginFor } from "../comments/frameGuard.ts";
import {
  clipResult,
  type DictationAccess,
  type DictationIdleReason,
  type DictationRefusal,
  forgetConsent,
  hasConsent,
  parseVoiceFrameMessage,
  type Recognizer,
  recognizerCtor,
  type SpeechVendor,
  speechVendor,
  storeConsent,
  VOICE_LIMITS,
  voiceMessage,
} from "./voiceProtocol.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** The consent dialog the stage shows while a start waits for the viewer's answer. */
export interface DictationConsentRequest {
  title: string;
  /** The owner's email, never the display name the owner chose. */
  owner: string;
  vendor: SpeechVendor;
  allow: () => void;
  notNow: () => void;
  dismiss: () => void;
}

export interface Dictation {
  /** The page declares dictation and the instance offers it: the stage's controls apply. */
  declared: boolean;
  listening: boolean;
  /** The viewer allowed dictation on this page in this browser. */
  allowed: boolean;
  consent: DictationConsentRequest | null;
  /** The app's Stop. */
  stop: () => void;
  /** "Turn off" in the ⋯ menu: forget the consent and stop. */
  turnOff: () => void;
}

export interface UseDictationOptions {
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  gate: OkGate;
  config: AppConfig | null;
  /**
   * The owner's email for the consent dialog, fetched only when the dialog opens (never with the
   * gate, so a plain page load does not hand it out). Tests replace it.
   */
  loadOwner?: (artifactId: string) => Promise<string>;
}

const loadOwnerEmail = (artifactId: string) =>
  api<DictationOwner>(route(API.viewDictation, { ref: artifactId })).then((r) => r.owner_email);

type Phase = "consent" | "starting" | "listening";

interface Session {
  id: string;
  lang?: string;
  interim: boolean;
  phase: Phase;
  rec: Recognizer | null;
  /** Why it is stopping, while the recognizer delivers its last results. */
  reason: DictationIdleReason | null;
  timers: number[];
  /** The focus check while listening (window.setInterval). */
  poll: number | null;
}

/** What lasts for the whole viewer page load, across frame reloads. */
interface LoadState {
  notNow: boolean;
  denied: boolean;
  viewerStops: number;
  lastStart: number;
  lastViewerStop: number;
}

/** How long the on-device check may take before the browser's default is used. */
const LOCAL_CHECK_MS = 500;
/** While listening, how often the app checks that its window still has focus. */
export const FOCUS_POLL_MS = 250;

/**
 * Loads seen per artifact frame, counted from the moment the viewer stage first hands the frame
 * over, whatever else the hook waits for (the config, the gate). The first load is the page's own
 * document finishing; every later one is a reload or a navigation.
 */
const frameLoads = new WeakMap<HTMLIFrameElement, number>();

/**
 * Frames whose page said `hello` while the app could not answer yet (no config, and a gate that
 * does not settle it). The answer goes out as soon as the app knows.
 */
const unansweredHello = new WeakSet<HTMLIFrameElement>();

/**
 * How the app may answer this frame: "origin" (each artifact its own origin: answer at the exact
 * content origin), "off" (opaque isolation: never answer) or "unknown" (wait). The config decides;
 * before it arrives, the gate's voice part does when present, since the server decided it with the
 * same switch and isolation. Without either, the page does not get dictation whatever the config
 * says, only the reason it is told (`disabled` or `not_declared`) waits.
 */
function answerMode(
  config: AppConfig | null,
  voice: OkGate["voice"],
): { mode: "origin" | "off" | "unknown"; on: boolean } {
  if (config) {
    const exact = config.content_isolation === "origin";
    return { mode: exact ? "origin" : "off", on: exact && config.dictation === true };
  }
  if (!voice) return { mode: "unknown", on: false };
  if (voice.dictation.reason === "opaque_isolation") return { mode: "off", on: false };
  return { mode: "origin", on: voice.dictation.reason !== "disabled" };
}

export function useDictation({
  frame,
  contentOrigin,
  gate,
  config,
  loadOwner = loadOwnerEmail,
}: UseDictationOptions): Dictation {
  const artifactId = gate.artifact.id;
  const voice = gate.voice?.dictation;
  // Consent is this viewer's, on this page: another person on this browser is asked again.
  const viewerId = gate.voice?.viewer_id ?? null;
  // Origin isolation only: the app answers a page (even "disabled") only at its exact origin.
  const { mode, on } = answerMode(config, gate.voice);
  const declared = on && voice !== undefined;
  const [listening, setListening] = useState(false);
  const [allowed, setAllowed] = useState(() => hasConsent(artifactId, viewerId));
  const [consent, setConsent] = useState<DictationConsentRequest | null>(null);
  const load = useRef<LoadState>({
    notNow: false,
    denied: false,
    viewerStops: 0,
    lastStart: Number.NEGATIVE_INFINITY,
    lastViewerStop: Number.NEGATIVE_INFINITY,
  });
  const stopRef = useRef<((reason: DictationIdleReason) => void) | null>(null);
  const reloadRef = useRef<(() => void) | null>(null);
  const about = useRef({ title: gate.artifact.title, loadOwner });
  about.current = { title: gate.artifact.title, loadOwner };

  // Count the frame's loads from the start, so a dictation started before the page finished
  // loading is not cut off by that first load, and a reload after a late setup still counts.
  useEffect(() => {
    if (!frame) return;
    const onLoad = () => {
      const n = (frameLoads.get(frame) ?? 0) + 1;
      frameLoads.set(frame, n);
      if (n > 1) reloadRef.current?.();
    };
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [frame]);

  useEffect(() => {
    setAllowed(hasConsent(artifactId, viewerId));
  }, [artifactId, viewerId]);

  const hasVoice = voice !== undefined;
  const available = voice?.available === true;
  const reason = voice?.reason ?? null;

  useEffect(() => {
    if (!frame || mode === "off") return;
    const target = targetOriginFor(contentOrigin, false);
    if (!target) return;
    const accept = acceptFrom(frame, contentOrigin, false);
    let session: Session | null = null;

    const post = (body: Parameters<typeof voiceMessage>[0]) => {
      try {
        frame.contentWindow?.postMessage(voiceMessage(body), target);
      } catch {
        // The frame is gone.
      }
    };
    const refuse = (id: string, code: DictationRefusal) => post({ type: "refused", id, code });

    const access = (): DictationAccess => {
      if (!on) return { available: false, reason: "disabled" };
      if (!hasVoice) return { available: false, reason: "not_declared" };
      if (!available) return { available: false, reason: reason ?? "not_declared" };
      if (!recognizerCtor() || !("userActivation" in navigator)) {
        return { available: false, reason: "unsupported" };
      }
      return { available: true, reason: null };
    };

    /** End the session now, telling the page why. */
    const finish = (s: Session, why: DictationIdleReason, refusal?: DictationRefusal) => {
      if (session !== s) return;
      session = null;
      for (const t of s.timers) window.clearTimeout(t);
      if (s.poll !== null) window.clearInterval(s.poll);
      s.poll = null;
      const rec = s.rec;
      if (rec) {
        rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
        try {
          rec.abort();
        } catch {
          // Already ended.
        }
      }
      setListening(false);
      if (s.phase === "consent") setConsent(null);
      if (s.phase === "listening") {
        post({ type: "state", id: s.id, state: "idle", reason: why });
        return;
      }
      const code: DictationRefusal =
        refusal ??
        (why === "not_granted" ? "not_granted" : why === "error" ? "network" : "dismissed");
      refuse(s.id, code);
    };

    /** Stop listening: the page's stop and the time limit let the last words arrive first. */
    const end = (s: Session, why: DictationIdleReason) => {
      if (session !== s) return;
      if (s.phase !== "listening" || !s.rec || (why !== "stopped" && why !== "time_limit")) {
        finish(s, why);
        return;
      }
      s.reason = why;
      try {
        s.rec.stop();
      } catch {
        finish(s, why);
        return;
      }
      // Shorter than the runtime's own wait, so the page hears the last words and idle first.
      s.timers.push(window.setTimeout(() => finish(s, why), VOICE_LIMITS.appStopWaitMs));
    };

    const begin = async (s: Session) => {
      const Ctor = recognizerCtor();
      if (!Ctor) {
        finish(s, "error", "unavailable");
        return;
      }
      let rec: Recognizer;
      try {
        rec = new Ctor();
      } catch {
        finish(s, "error");
        return;
      }
      rec.continuous = true;
      rec.interimResults = s.interim;
      rec.lang = s.lang ?? navigator.language;
      // On-device recognition where the browser offers it, never by installing a model.
      if ("processLocally" in rec && typeof Ctor.available === "function") {
        try {
          const r = await Promise.race([
            Ctor.available({ langs: [rec.lang], processLocally: true }),
            new Promise<string>((res) => window.setTimeout(() => res("timeout"), LOCAL_CHECK_MS)),
          ]);
          if (r === "available") {
            rec.processLocally = true;
          }
        } catch {
          // The browser's default applies.
        }
        if (session !== s) return;
      }
      s.rec = rec;
      s.phase = "starting";
      rec.onstart = () => {
        if (session !== s) return;
        s.phase = "listening";
        setListening(true);
        post({ type: "started", id: s.id });
        post({ type: "state", id: s.id, state: "listening" });
        s.timers.push(window.setTimeout(() => end(s, "time_limit"), VOICE_LIMITS.maxSessionMs));
        // Focus inside the frame: a switch to another window blurs only the frame's window,
        // which this document cannot observe, so its focus is checked instead.
        s.poll = window.setInterval(() => {
          if (!document.hasFocus()) end(s, "blurred");
        }, FOCUS_POLL_MS);
      };
      rec.onresult = (e) => {
        if (session !== s || s.phase !== "listening") return;
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r?.[0]?.transcript ?? "";
          if (!r || !text) continue;
          if (r.isFinal) post({ type: "final", id: s.id, text: clipResult(text) });
          else interim += text;
        }
        if (s.interim && interim) post({ type: "partial", id: s.id, text: clipResult(interim) });
      };
      rec.onerror = (e) => {
        if (session !== s) return;
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          // The browser's own prompt was refused (or the microphone is blocked).
          load.current.denied = true;
          finish(s, "not_granted");
        } else if (e.error !== "no-speech" && e.error !== "aborted") {
          finish(s, "error");
        }
      };
      rec.onend = () => finish(s, s.reason ?? "silence");
      post({ type: "state", id: s.id, state: "starting" });
      try {
        rec.start();
      } catch {
        finish(s, "error");
      }
    };

    const onStart = (m: { id: string; lang?: string; interim: boolean }) => {
      if (!access().available || !viewerId) return refuse(m.id, "unavailable");
      // Read at once: a click or key press in the frame activates the app as its ancestor.
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation;
      if (!activation?.isActive) return refuse(m.id, "no_activation");
      // And the click or key press was in the page: focus is inside this frame. Activation from a
      // click in the app's own chrome (or the link that opened this page) does not count.
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        document.activeElement !== frame
      ) {
        return refuse(m.id, "no_activation");
      }
      if (session) return refuse(m.id, "busy");
      const L = load.current;
      const now = Date.now();
      if (
        now - L.lastStart < VOICE_LIMITS.minStartGapMs ||
        now - L.lastViewerStop < VOICE_LIMITS.stopCooldownMs
      ) {
        return refuse(m.id, "rate_limited");
      }
      if (L.notNow || L.denied || L.viewerStops >= VOICE_LIMITS.maxViewerStops) {
        return refuse(m.id, "not_granted");
      }
      L.lastStart = now;
      const s: Session = {
        id: m.id,
        lang: m.lang,
        interim: m.interim,
        phase: "consent",
        rec: null,
        reason: null,
        timers: [],
        poll: null,
      };
      session = s;
      if (hasConsent(artifactId, viewerId)) {
        setAllowed(true);
        void begin(s);
        return;
      }
      void ask(s, viewerId);
    };

    /** Open the consent dialog, once the app has the owner's email to name them by. */
    const ask = async (s: Session, viewer: string) => {
      const { title, loadOwner: fetchOwner } = about.current;
      let owner: string;
      try {
        owner = await fetchOwner(artifactId);
      } catch {
        finish(s, "error", "network");
        return;
      }
      if (session !== s || s.phase !== "consent") return;
      setConsent({
        title,
        owner,
        vendor: speechVendor(),
        allow: () => {
          if (session !== s || s.phase !== "consent") return;
          setConsent(null);
          storeConsent(artifactId, viewer);
          setAllowed(true);
          void begin(s);
        },
        notNow: () => {
          if (session !== s) return;
          load.current.notNow = true;
          finish(s, "not_granted", "not_granted");
        },
        dismiss: () => {
          if (session !== s) return;
          finish(s, "stopped", "dismissed");
        },
      });
    };

    const status = () => {
      const a = access();
      post({ type: "status", available: a.available, reason: a.reason });
    };

    const onMessage = (e: MessageEvent) => {
      if (!accept(e)) return;
      const m = parseVoiceFrameMessage(e.data);
      if (!m) return;
      if (mode === "unknown") {
        // Not yet known how to answer: remember the hello. A start goes unanswered; the page's
        // start() settles with the status (unavailable whatever the config says).
        if (m.type === "hello") unansweredHello.add(frame);
        return;
      }
      if (m.type === "hello") status();
      else if (m.type === "stop") {
        if (session?.id === m.id) end(session, "stopped");
      } else onStart(m);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && session) end(session, "hidden");
    };
    // Focus moving into the frame blurs this window too; only a real loss of focus counts.
    const onBlur = () => {
      window.setTimeout(() => {
        if (session && !document.hasFocus()) end(session, "blurred");
      }, 0);
    };

    window.addEventListener("message", onMessage);
    if (mode === "origin" && unansweredHello.delete(frame)) status();
    reloadRef.current = () => {
      if (session) finish(session, "frame_reloaded");
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    stopRef.current = (why) => {
      if (session) end(session, why);
    };
    return () => {
      window.removeEventListener("message", onMessage);
      reloadRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      stopRef.current = null;
      if (session) finish(session, "frame_reloaded");
    };
  }, [frame, contentOrigin, mode, on, hasVoice, available, reason, artifactId, viewerId]);

  const stop = useCallback(() => {
    const L = load.current;
    L.viewerStops += 1;
    L.lastViewerStop = Date.now();
    stopRef.current?.("viewer_stopped");
  }, []);

  const turnOff = useCallback(() => {
    forgetConsent(artifactId);
    setAllowed(false);
    stopRef.current?.("not_granted");
  }, [artifactId]);

  return { declared, listening, allowed, consent, stop, turnOff };
}
