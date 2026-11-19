// The dictation protocol between the page runtime and the app (voice.ts): strict schemas both ways,
// so neither side acts on a message it does not fully understand.
import { describe, expect, it } from "vitest";
import {
  clipResult,
  parseCapabilities,
  parseVoiceAppMessage,
  parseVoiceFrameMessage,
  VOICE_LANG_RE,
  VOICE_LIMITS,
  voiceMessage,
} from "../src/index.ts";

const m = (body: Record<string, unknown>) => ({ source: "plinth-voice", v: 1, ...body });

describe("voice messages from the frame", () => {
  it("accepts hello, start and stop", () => {
    expect(parseVoiceFrameMessage(m({ type: "hello" }))).toEqual(m({ type: "hello" }));
    expect(parseVoiceFrameMessage(m({ type: "start", id: "d1_x", interim: true }))).toEqual(
      m({ type: "start", id: "d1_x", interim: true }),
    );
    expect(
      parseVoiceFrameMessage(m({ type: "start", id: "a", lang: "pt-PT", interim: false })),
    ).toMatchObject({ lang: "pt-PT" });
    expect(parseVoiceFrameMessage(m({ type: "stop", id: "a" }))).toEqual(
      m({ type: "stop", id: "a" }),
    );
  });

  it("rejects a wrong source, a wrong version, an unknown type, a bad id, a bad lang and extra keys", () => {
    const bad: unknown[] = [
      null,
      "hello",
      [],
      { source: "plinth-bridge", v: 1, type: "hello" },
      { source: "plinth-voice", v: 2, type: "hello" },
      m({ type: "listen" }),
      m({ type: "start", id: "", interim: true }),
      m({ type: "start", id: "x".repeat(33), interim: true }),
      m({ type: "start", id: "a b", interim: true }),
      m({ type: "start", id: "a", interim: "yes" }),
      m({ type: "start", id: "a" }),
      m({ type: "start", id: "a", lang: "english please", interim: true }),
      m({ type: "start", id: "a", lang: "e", interim: true }),
      m({ type: "hello", extra: 1 }),
      m({ type: "stop", id: "a", text: "x" }),
      // Anything long is dropped before it is parsed.
      m({ type: "stop", id: "a", pad: "x".repeat(VOICE_LIMITS.maxFrameMessageChars) }),
    ];
    for (const b of bad) expect(parseVoiceFrameMessage(b), JSON.stringify(b)).toBeNull();
    const cyclic: Record<string, unknown> = m({ type: "hello" });
    cyclic.self = cyclic;
    expect(parseVoiceFrameMessage(cyclic)).toBeNull();
  });
});

describe("voice messages from the app", () => {
  it("accepts every kind the app sends", () => {
    for (const body of [
      { type: "status", available: true, reason: null },
      { type: "status", available: false, reason: "not_identified" },
      { type: "started", id: "a" },
      { type: "refused", id: "a", code: "no_activation" },
      { type: "partial", id: "a", text: "hel" },
      { type: "final", id: "a", text: "hello" },
      { type: "state", id: "a", state: "listening" },
      { type: "state", id: "a", state: "idle", reason: "viewer_stopped" },
    ]) {
      expect(parseVoiceAppMessage(m(body)), body.type).toEqual(m(body));
    }
  });

  it("rejects an oversized text, an unknown code, reason or state, and extra keys", () => {
    for (const body of [
      { type: "partial", id: "a", text: "x".repeat(VOICE_LIMITS.maxResultChars + 1) },
      { type: "refused", id: "a", code: "nope" },
      { type: "status", available: false, reason: "because" },
      { type: "state", id: "a", state: "recording" },
      { type: "state", id: "a", state: "idle", reason: "bored" },
      { type: "final", id: "a", text: "x", audio: "AAAA" },
      { type: "final", text: "x" },
    ]) {
      expect(parseVoiceAppMessage(m(body)), JSON.stringify(body)).toBeNull();
    }
  });

  it("builds messages with the protocol's source and version", () => {
    expect(voiceMessage({ type: "started", id: "a" })).toEqual(m({ type: "started", id: "a" }));
  });
});

describe("voice limits", () => {
  it("clips results to the limit without splitting a surrogate pair", () => {
    const max = VOICE_LIMITS.maxResultChars;
    expect(clipResult("x".repeat(max + 10))).toHaveLength(max);
    expect(clipResult("short")).toBe("short");
    const pair = `${"x".repeat(max - 1)}😀`;
    expect(clipResult(pair)).toBe("x".repeat(max - 1));
  });

  it("accepts language tags and refuses other text", () => {
    for (const ok of ["en", "pt-PT", "zh-Hant-TW", "es-419"])
      expect(VOICE_LANG_RE.test(ok), ok).toBe(true);
    for (const no of ["", "e", "english", "en_US", "en-", "en-US-x-y-zzzz"])
      expect(VOICE_LANG_RE.test(no), no).toBe(false);
  });
});

describe("the dictation token", () => {
  it("declares on its own; viewer alone still declares nothing", () => {
    const c = parseCapabilities('<meta name="plinth-capabilities" content="dictation">');
    expect(c).toMatchObject({ data: false, room: false, dictation: true });
    expect(parseCapabilities('<meta name="plinth-capabilities" content="viewer">')).toBeNull();
    expect(
      parseCapabilities('<meta name="plinth-capabilities" content="data dictation">'),
    ).toMatchObject({ data: true, dictation: true });
    expect(parseCapabilities('<meta name="plinth-capabilities" content="data">')?.dictation).toBe(
      false,
    );
  });
});
