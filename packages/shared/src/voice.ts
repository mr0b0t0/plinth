// Dictation (docs/spec.md "Voice: dictation and text to speech"): a page that declares `dictation`
// receives words the viewer speaks. The app (Plinth's own code on APP_HOST) runs the browser's
// speech recognizer and posts only words into the artifact frame; the frame never gets the
// microphone. This file holds the postMessage protocol between the page runtime and the app, its
// fixed limits and the reasons dictation is unavailable. Pure code, used by the Worker (the gate)
// and by the web app; the page's side is the static runtime script.
import { z } from "zod";

/** `source` of every dictation message, in both directions. */
export const VOICE_MESSAGE_SOURCE = "plinth-voice";
export const VOICE_PROTOCOL_VERSION = 1;

/** Fixed dictation rules, not env vars. */
export const VOICE_LIMITS = {
  /** One start listens at most this long. */
  maxSessionMs: 60_000,
  /** A partial or final result is cut to this many characters. */
  maxResultChars: 2_000,
  /** Starts closer together than this are refused `rate_limited`. */
  minStartGapMs: 1_000,
  /** After the viewer presses Stop, the page's starts wait this long (`rate_limited`). */
  stopCooldownMs: 10_000,
  /** After this many viewer stops, starts are refused `not_granted` for the page load. */
  maxViewerStops: 3,
  /** The consent dialog's buttons ignore input this long after it opens. */
  dialogArmMs: 500,
  /** Runtime: no answer from the app within this long means `no_host`. */
  helloTimeoutMs: 3_000,
  /** Runtime: stop() resolves at the latest this long after it is called. */
  stopWaitMs: 2_000,
  /**
   * App: after the page's stop or the time limit, how long it waits for the recognizer's last
   * results before it goes idle. Shorter than `stopWaitMs`, so the page hears them and idle first.
   */
  appStopWaitMs: 1_500,
  /** The app ignores a message from the frame whose JSON is longer than this. */
  maxFrameMessageChars: 512,
} as const;

/** A BCP 47 language tag, as `start({ lang })` takes it (e.g. "en", "pt-PT", "zh-Hant-TW"). */
export const VOICE_LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
/** A start's id, chosen by the page: 1 to 32 of A-Z a-z 0-9 _ - */
export const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Why dictation is unavailable to a page. `disabled`: ALLOW_DICTATION is off. `opaque_isolation`:
 * the instance runs opaque isolation (or the path fallback). `not_declared`: the current version
 * does not declare `dictation`, or the artifact is not an HTML page. `not_identified`: an
 * anonymous link viewer. `unsupported`: this browser has no speech recognizer. `no_host`: the page
 * is not framed by the Plinth viewer (an in-chat preview, a thumbnail, the editor preview, opened
 * on its own).
 */
export const DICTATION_REASONS = [
  "disabled",
  "opaque_isolation",
  "not_declared",
  "not_identified",
  "unsupported",
  "no_host",
] as const;
export type DictationReason = (typeof DICTATION_REASONS)[number];

/** Why a start was refused: the codes `plinth.dictation.start()` rejects with. */
export const DICTATION_REFUSALS = [
  "unavailable",
  "no_activation",
  "not_granted",
  "dismissed",
  "busy",
  "rate_limited",
  "invalid",
  "network",
] as const;
export type DictationRefusal = (typeof DICTATION_REFUSALS)[number];

export const DICTATION_STATES = ["idle", "starting", "listening"] as const;
export type DictationState = (typeof DICTATION_STATES)[number];

/** Why a session went idle. */
export const DICTATION_IDLE_REASONS = [
  "stopped",
  "viewer_stopped",
  "silence",
  "time_limit",
  "hidden",
  "blurred",
  "frame_reloaded",
  "error",
  "not_granted",
] as const;
export type DictationIdleReason = (typeof DICTATION_IDLE_REASONS)[number];

/** Whether dictation is offered to this viewer on this page (the gate's `voice.dictation`). */
export interface DictationAccess {
  available: boolean;
  reason: DictationReason | null;
}

const head = {
  source: z.literal(VOICE_MESSAGE_SOURCE),
  v: z.literal(VOICE_PROTOCOL_VERSION),
};
const id = z.string().regex(VOICE_ID_RE);
const text = z.string().max(VOICE_LIMITS.maxResultChars);

const frameMessage = z.discriminatedUnion("type", [
  z.strictObject({ ...head, type: z.literal("hello") }),
  z.strictObject({
    ...head,
    type: z.literal("start"),
    id,
    lang: z.string().regex(VOICE_LANG_RE).optional(),
    interim: z.boolean(),
  }),
  z.strictObject({ ...head, type: z.literal("stop"), id }),
]);

const appMessage = z.discriminatedUnion("type", [
  z.strictObject({
    ...head,
    type: z.literal("status"),
    available: z.boolean(),
    reason: z.enum(DICTATION_REASONS).nullable(),
  }),
  z.strictObject({ ...head, type: z.literal("started"), id }),
  z.strictObject({ ...head, type: z.literal("refused"), id, code: z.enum(DICTATION_REFUSALS) }),
  z.strictObject({ ...head, type: z.literal("partial"), id, text }),
  z.strictObject({ ...head, type: z.literal("final"), id, text }),
  z.strictObject({
    ...head,
    type: z.literal("state"),
    id,
    state: z.enum(DICTATION_STATES),
    reason: z.enum(DICTATION_IDLE_REASONS).optional(),
  }),
]);

/** A message the page runtime posts to the app. */
export type VoiceFrameMessage = z.infer<typeof frameMessage>;
/** A message the app posts to the page. */
export type VoiceAppMessage = z.infer<typeof appMessage>;

/** Distributes Omit over a union, so each message keeps its own fields. */
type Body<T> = T extends unknown ? Omit<T, "source" | "v"> : never;

/** A message from the frame, or null when it is not a valid one (wrong source, version, shape). */
export function parseVoiceFrameMessage(data: unknown): VoiceFrameMessage | null {
  if (!isVoiceMessage(data)) return null;
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return null;
  }
  if (size > VOICE_LIMITS.maxFrameMessageChars) return null;
  const r = frameMessage.safeParse(data);
  return r.success ? r.data : null;
}

/** A message from the app, or null when it is not a valid one. */
export function parseVoiceAppMessage(data: unknown): VoiceAppMessage | null {
  if (!isVoiceMessage(data)) return null;
  const r = appMessage.safeParse(data);
  return r.success ? r.data : null;
}

/** A dictation message to post: the body with the protocol's source and version. */
export function voiceMessage<T extends Body<VoiceAppMessage> | Body<VoiceFrameMessage>>(
  body: T,
): T & { source: typeof VOICE_MESSAGE_SOURCE; v: typeof VOICE_PROTOCOL_VERSION } {
  return { source: VOICE_MESSAGE_SOURCE, v: VOICE_PROTOCOL_VERSION, ...body };
}

function isVoiceMessage(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { source?: unknown }).source === VOICE_MESSAGE_SOURCE
  );
}

/** Cut a result to VOICE_LIMITS.maxResultChars, never splitting a surrogate pair. */
export function clipResult(s: string): string {
  const max = VOICE_LIMITS.maxResultChars;
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}
