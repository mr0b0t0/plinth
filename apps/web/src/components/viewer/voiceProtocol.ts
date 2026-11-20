// The app's side of dictation (docs/spec.md "Voice: dictation and text to speech"): the browser's
// speech recognizer, who runs it, and the viewer's per-artifact consent. The protocol itself is
// packages/shared/src/voice.ts. Only the app (APP_HOST) ever touches the recognizer: the artifact
// frame has no microphone (the app's Permissions-Policy and the frame's `allow=""`), and receives
// words only.

export {
  clipResult,
  type DictationAccess,
  type DictationIdleReason,
  type DictationRefusal,
  parseVoiceFrameMessage,
  VOICE_LIMITS,
  voiceMessage,
} from "@plinth/shared";

/** The part of the Web Speech API's SpeechRecognition the app uses. */
export interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

export interface RecognizerCtor {
  new (): Recognizer;
  /** Chrome's on-device check, where it exists: never installs a model on its own. */
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

/** The browser's recognizer class (standard, then the WebKit name), or null when it has none. */
export function recognizerCtor(): RecognizerCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognizerCtor;
    webkitSpeechRecognition?: RecognizerCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whose speech service turns the viewer's audio into text, as far as the browser says. */
export type SpeechVendor = "google" | "microsoft" | "apple" | null;

export function speechVendor(): SpeechVendor {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } };
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? null;
  if (brands) {
    if (brands.includes("Microsoft Edge")) return "microsoft";
    if (brands.includes("Google Chrome")) return "google";
    return null;
  }
  // WebKit without User-Agent Client Hints, with its own recognizer: Safari.
  return "webkitSpeechRecognition" in window ? "apple" : null;
}

/** The consent dialog's sentence about the speech service. */
export function vendorLine(vendor: SpeechVendor): string {
  switch (vendor) {
    case "google":
      return "Chrome sends the audio to Google.";
    case "microsoft":
      return "Edge sends the audio to Microsoft.";
    case "apple":
      return "Safari sends the audio to Apple.";
    default:
      return "Your browser may send the audio to its maker.";
  }
}

// ---------- consent: one viewer's choice in this browser, per artifact ----------

/**
 * localStorage key prefix: `plinth:dictation:<artifact id>` = the viewer id it was given for (the
 * gate's `voice.viewer_id`), so another person on this browser is asked again.
 */
export const CONSENT_PREFIX = "plinth:dictation:";

export function hasConsent(artifactId: string, viewerId: string | null): boolean {
  if (!viewerId) return false;
  try {
    return window.localStorage.getItem(CONSENT_PREFIX + artifactId) === viewerId;
  } catch {
    return false;
  }
}

export function storeConsent(artifactId: string, viewerId: string): void {
  try {
    window.localStorage.setItem(CONSENT_PREFIX + artifactId, viewerId);
  } catch {
    // Storage blocked: the viewer is asked again next time.
  }
}

export function forgetConsent(artifactId: string): void {
  try {
    window.localStorage.removeItem(CONSENT_PREFIX + artifactId);
  } catch {
    // Nothing stored.
  }
}

/** On sign-out: every artifact's consent in this browser. */
export function forgetAllConsents(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(CONSENT_PREFIX)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // Storage blocked: nothing was stored.
  }
}
