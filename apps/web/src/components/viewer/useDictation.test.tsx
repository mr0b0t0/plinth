// useDictation: the app runs the recognizer and posts only words to the frame. The frame is a real
// iframe whose window stands in for the page runtime; its messages are dispatched with that window
// as their source. The recognizer is a fake class; navigator.userActivation is stubbed.
import type { AppConfig, ViewGate } from "@plinth/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "./test-utils.ts";
import { FOCUS_POLL_MS, useDictation } from "./useDictation.ts";
import { CONSENT_PREFIX, forgetAllConsents, VOICE_LIMITS } from "./voiceProtocol.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;
const ORIGIN = "http://art1.content.localhost:8787";
const ON: AppConfig = { ...CONFIG, dictation: true };
/** This viewer's id on the page (the gate's voice.viewer_id): the consent is bound to it. */
const VIEWER = "u_viewer1";

const gate = (over: Partial<OkGate> = {}): OkGate => ({
  status: "ok",
  artifact: {
    id: "art1",
    slug: "notes",
    title: "Field notes",
    type: "html",
    current_version: 1,
    version: 1,
    visibility: "allowlist",
    owner_name: "Ada",
  },
  enter_url: `${ORIGIN}/__plinth/enter?t=x`,
  role: "viewer",
  voice: { dictation: { available: true, reason: null }, viewer_id: VIEWER },
  ...over,
});

class FakeRec {
  static all: FakeRec[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRec.all.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
}

let frame: HTMLIFrameElement;
/** The owner's email for the consent dialog, fetched only when it opens. */
let loadOwner: ReturnType<typeof vi.fn<(id: string) => Promise<string>>>;
let toFrame: ReturnType<typeof vi.fn>;
let frameWin: { postMessage: ReturnType<typeof vi.fn> };
const activation = { isActive: true };
let focused = true;
/** Where focus is in the app document: the frame after a click in the page. */
let active: Element | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeRec.all = [];
  loadOwner = vi.fn(async () => "ada@example.com");
  frame = document.createElement("iframe");
  toFrame = vi.fn();
  frameWin = { postMessage: toFrame };
  Object.defineProperty(frame, "contentWindow", { value: frameWin });
  vi.stubGlobal("webkitSpeechRecognition", FakeRec);
  Object.defineProperty(navigator, "userActivation", { value: activation, configurable: true });
  activation.isActive = true;
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  active = frame;
  vi.spyOn(document, "activeElement", "get").mockImplementation(() => active);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function mount(over: { gate?: OkGate; config?: AppConfig | null } = {}) {
  return renderHook(
    (p: { gate: OkGate; config: AppConfig | null }) =>
      useDictation({ frame, contentOrigin: ORIGIN, gate: p.gate, config: p.config, loadOwner }),
    {
      initialProps: {
        gate: over.gate ?? gate(),
        config: over.config === undefined ? ON : over.config,
      },
    },
  );
}

const voice = (body: Record<string, unknown>) => ({ source: "plinth-voice", v: 1, ...body });

function fromFrame(
  body: Record<string, unknown>,
  opts: { origin?: string; source?: unknown } = {},
) {
  act(() => {
    const e = new MessageEvent("message", { data: voice(body), origin: opts.origin ?? ORIGIN });
    Object.defineProperty(e, "source", { value: opts.source ?? frameWin });
    window.dispatchEvent(e);
  });
}

const sent = () => toFrame.mock.calls.map((c) => c[0] as Record<string, unknown>);
const last = () => sent().at(-1);
const start = (id = "s1", extra: Record<string, unknown> = {}) =>
  fromFrame({ type: "start", id, interim: true, ...extra });
const rec = () => FakeRec.all.at(-1) as FakeRec;
const allow = () => {
  localStorage.setItem(`${CONSENT_PREFIX}art1`, VIEWER);
};
/** Let the owner's email arrive, so the consent dialog opens. */
const settle = () => act(async () => {});
/** Start with stored consent and let the recognizer report it is listening. */
function listen(result: { current: ReturnType<typeof useDictation> }, id = "s1") {
  allow();
  start(id);
  act(() => rec().onstart?.());
  expect(result.current.listening).toBe(true);
}
const later = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useDictation: answering the page", () => {
  it("says whether dictation is offered, and why not", () => {
    const cases: [Partial<Parameters<typeof mount>[0]>, unknown][] = [
      [{}, { available: true, reason: null }],
      [{ config: { ...ON, dictation: false } }, { available: false, reason: "disabled" }],
      [{ gate: gate({ voice: undefined }) }, { available: false, reason: "not_declared" }],
      [
        { gate: gate({ voice: { dictation: { available: false, reason: "not_identified" } } }) },
        { available: false, reason: "not_identified" },
      ],
    ];
    for (const [opts, status] of cases) {
      toFrame.mockClear();
      const h = mount(opts);
      fromFrame({ type: "hello" });
      expect(last()).toEqual(voice({ type: "status", ...(status as object) }));
      h.unmount();
    }
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    mount();
    fromFrame({ type: "hello" });
    expect(last()).toEqual(voice({ type: "status", available: false, reason: "unsupported" }));
  });

  it("ignores messages from another origin, another window or with a bad shape", () => {
    mount();
    fromFrame({ type: "hello" }, { origin: "http://other.content.localhost:8787" });
    fromFrame({ type: "hello" }, { source: {} });
    fromFrame({ type: "hello", extra: true });
    fromFrame({ type: "start", id: "bad id", interim: true });
    expect(toFrame).not.toHaveBeenCalled();
  });

  it("posts only to the exact content origin, never *", () => {
    const { result } = mount();
    listen(result);
    expect(toFrame.mock.calls.length).toBeGreaterThan(0);
    for (const c of toFrame.mock.calls) expect(c[1]).toBe(ORIGIN);
  });

  it("does nothing under opaque isolation", () => {
    mount({ config: { ...ON, content_isolation: "opaque" } });
    fromFrame({ type: "hello" }, { origin: "null" });
    fromFrame({ type: "hello" });
    expect(toFrame).not.toHaveBeenCalled();
  });

  it("answers a page that asks before the app's config arrives, from the gate", () => {
    // Opened directly: the frame loads and its page says hello while GET /config and /me are
    // still on their way. The runtime asks once, so a dropped hello would cost the whole load.
    const h = mount({ config: null });
    fromFrame({ type: "hello" });
    expect(last()).toEqual(voice({ type: "status", available: true, reason: null }));
    // A dictation started before the config arrives keeps going when it does.
    listen(h.result);
    h.rerender({ gate: gate(), config: ON });
    expect(h.result.current.listening).toBe(true);
    expect(rec().aborted).toBe(false);
  });

  it("holds a hello the gate cannot settle until the config arrives", () => {
    const h = mount({ config: null, gate: gate({ voice: undefined }) });
    fromFrame({ type: "hello" });
    start("s1");
    expect(toFrame).not.toHaveBeenCalled();
    h.rerender({ gate: gate({ voice: undefined }), config: { ...ON, dictation: false } });
    expect(sent()).toEqual([voice({ type: "status", available: false, reason: "disabled" })]);
    // Answered once only.
    h.rerender({ gate: gate({ voice: undefined }), config: ON });
    expect(sent()).toHaveLength(1);
  });

  it("before the config, a gate that says opaque isolation keeps the app silent", () => {
    const opaque = gate({ voice: { dictation: { available: false, reason: "opaque_isolation" } } });
    const h = mount({ config: null, gate: opaque });
    fromFrame({ type: "hello" });
    h.rerender({ gate: opaque, config: { ...ON, content_isolation: "opaque" } });
    expect(toFrame).not.toHaveBeenCalled();
  });
});

describe("useDictation: starting", () => {
  it("refuses no_activation without a recent click, and opens no dialog", () => {
    const { result } = mount();
    activation.isActive = false;
    start();
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "no_activation" }));
    expect(result.current.consent).toBeNull();
    activation.isActive = true;
    focused = false;
    later(VOICE_LIMITS.minStartGapMs);
    start("s2");
    expect(last()).toEqual(voice({ type: "refused", id: "s2", code: "no_activation" }));
    // A click on the app's own chrome activates the app too, but focus is not in the page.
    focused = true;
    active = document.body;
    later(VOICE_LIMITS.minStartGapMs);
    start("s3");
    expect(last()).toEqual(voice({ type: "refused", id: "s3", code: "no_activation" }));
  });

  it("refuses unavailable when the gate or the instance says no", () => {
    mount({ config: { ...ON, dictation: false } });
    start();
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "unavailable" }));
    expect(FakeRec.all).toEqual([]);
  });

  it("asks first; Allow stores the consent and starts the recognizer", async () => {
    const { result } = mount();
    expect(result.current.allowed).toBe(false);
    start("s1", { lang: "pt-PT", interim: false });
    await settle();
    // The owner by email, never by the display name the owner chose ("Ada").
    expect(result.current.consent).toMatchObject({
      title: "Field notes",
      owner: "ada@example.com",
    });
    expect(FakeRec.all).toEqual([]);
    // Another start while the dialog is open is busy.
    later(VOICE_LIMITS.minStartGapMs);
    start("s2");
    expect(last()).toEqual(voice({ type: "refused", id: "s2", code: "busy" }));
    act(() => result.current.consent?.allow());
    expect(result.current.consent).toBeNull();
    expect(result.current.allowed).toBe(true);
    expect(localStorage.getItem(`${CONSENT_PREFIX}art1`)).toBe(VIEWER);
    expect(rec()).toMatchObject({
      started: true,
      continuous: true,
      interimResults: false,
      lang: "pt-PT",
    });
    expect(last()).toEqual(voice({ type: "state", id: "s1", state: "starting" }));
    act(() => rec().onstart?.());
    expect(sent().slice(-2)).toEqual([
      voice({ type: "started", id: "s1" }),
      voice({ type: "state", id: "s1", state: "listening" }),
    ]);
    expect(result.current.listening).toBe(true);
  });

  it("starts without the dialog once consent is stored", () => {
    const { result } = mount();
    listen(result);
    expect(result.current.consent).toBeNull();
    // Nobody asked for the owner's email: there was no dialog to name them in.
    expect(loadOwner).not.toHaveBeenCalled();
  });

  it("fetches the owner's email only when the dialog opens, and refuses network without it", async () => {
    const { result } = mount();
    fromFrame({ type: "hello" });
    expect(loadOwner).not.toHaveBeenCalled();
    loadOwner.mockRejectedValueOnce(new Error("offline"));
    start("s1");
    expect(loadOwner).toHaveBeenCalledWith("art1");
    await settle();
    expect(result.current.consent).toBeNull();
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "network" }));
    expect(FakeRec.all).toEqual([]);
  });

  it("a consent another viewer gave on this browser does not count: this viewer is asked", async () => {
    // Someone else allowed dictation on this page here and left without signing out.
    localStorage.setItem(`${CONSENT_PREFIX}art1`, "u_someone_else");
    const { result } = mount();
    expect(result.current.allowed).toBe(false);
    start("s1");
    await settle();
    expect(result.current.consent).toMatchObject({ owner: "ada@example.com" });
    expect(FakeRec.all).toEqual([]);
    later(VOICE_LIMITS.dialogArmMs);
    act(() => result.current.consent?.allow());
    expect(localStorage.getItem(`${CONSENT_PREFIX}art1`)).toBe(VIEWER);
    expect(rec().started).toBe(true);
  });

  it("a stored consent never starts for a viewer the gate gives no id", () => {
    allow();
    const { result } = mount({
      gate: gate({ voice: { dictation: { available: true, reason: null } } }),
    });
    expect(result.current.allowed).toBe(false);
    start("s1");
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "unavailable" }));
    expect(FakeRec.all).toEqual([]);
  });

  it("Not now answers not_granted and never reopens on this load; closing answers dismissed", async () => {
    const { result } = mount();
    start("s1");
    await settle();
    act(() => result.current.consent?.dismiss());
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "dismissed" }));
    later(VOICE_LIMITS.minStartGapMs);
    start("s2");
    await settle();
    act(() => result.current.consent?.notNow());
    expect(last()).toEqual(voice({ type: "refused", id: "s2", code: "not_granted" }));
    later(VOICE_LIMITS.minStartGapMs);
    start("s3");
    expect(last()).toEqual(voice({ type: "refused", id: "s3", code: "not_granted" }));
    expect(result.current.consent).toBeNull();
    expect(localStorage.getItem(`${CONSENT_PREFIX}art1`)).toBeNull();
  });

  it("refuses rate_limited for starts closer than a second", () => {
    const { result } = mount();
    allow();
    start("s1");
    act(() => rec().onerror?.({ error: "network" }));
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "network" }));
    start("s2");
    expect(last()).toEqual(voice({ type: "refused", id: "s2", code: "rate_limited" }));
    expect(result.current.listening).toBe(false);
  });

  it("the browser's own refusal is not_granted for the rest of the load", () => {
    mount();
    allow();
    start("s1");
    act(() => rec().onerror?.({ error: "not-allowed" }));
    expect(last()).toEqual(voice({ type: "refused", id: "s1", code: "not_granted" }));
    later(VOICE_LIMITS.minStartGapMs);
    start("s2");
    expect(last()).toEqual(voice({ type: "refused", id: "s2", code: "not_granted" }));
  });
});

describe("useDictation: listening", () => {
  it("forwards partials and finals, cut to the limit", () => {
    const { result } = mount();
    listen(result);
    const long = "x".repeat(VOICE_LIMITS.maxResultChars + 50);
    act(() =>
      rec().onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "hello" } },
          { isFinal: false, 0: { transcript: long } },
        ],
      }),
    );
    expect(sent().slice(-2)).toEqual([
      voice({ type: "final", id: "s1", text: "hello" }),
      voice({ type: "partial", id: "s1", text: "x".repeat(VOICE_LIMITS.maxResultChars) }),
    ]);
  });

  it("the page's stop lets the last words arrive, then goes idle stopped", () => {
    const { result } = mount();
    listen(result);
    fromFrame({ type: "stop", id: "s1" });
    expect(rec().stopped).toBe(true);
    expect(result.current.listening).toBe(true);
    act(() =>
      rec().onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "end" } }] }),
    );
    act(() => rec().onend?.());
    expect(sent().slice(-2)).toEqual([
      voice({ type: "final", id: "s1", text: "end" }),
      voice({ type: "state", id: "s1", state: "idle", reason: "stopped" }),
    ]);
    expect(result.current.listening).toBe(false);
  });

  it("goes idle silence when the recognizer ends on its own", () => {
    const { result } = mount();
    listen(result);
    act(() => rec().onend?.());
    expect(last()).toEqual(voice({ type: "state", id: "s1", state: "idle", reason: "silence" }));
  });

  it("stops on a hidden tab, a blurred window, a frame reload, the time limit and unmount", () => {
    const idle = (reason: string) => voice({ type: "state", id: "s1", state: "idle", reason });
    let h = mount();
    listen(h.result);
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(last()).toEqual(idle("hidden"));
    expect(rec().aborted).toBe(true);
    vis.mockRestore();
    h.unmount();
    localStorage.clear();

    h = mount();
    listen(h.result);
    // Focus moving into the frame blurs the window but keeps the document focused: no stop.
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(0);
    });
    expect(h.result.current.listening).toBe(true);
    focused = false;
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(0);
    });
    expect(last()).toEqual(idle("blurred"));
    focused = true;
    h.unmount();

    h = mount();
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    listen(h.result);
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(last()).toEqual(idle("frame_reloaded"));
    h.unmount();

    h = mount();
    listen(h.result);
    later(VOICE_LIMITS.maxSessionMs);
    expect(rec().stopped).toBe(true);
    act(() => rec().onend?.());
    expect(last()).toEqual(idle("time_limit"));
    h.unmount();

    h = mount();
    listen(h.result);
    h.unmount();
    expect(last()).toEqual(idle("frame_reloaded"));
    expect(rec().aborted).toBe(true);
  });

  it("the page's own first load does not end a dictation started before it; a reload does", () => {
    const { result } = mount();
    listen(result);
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(result.current.listening).toBe(true);
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(last()).toEqual(
      voice({ type: "state", id: "s1", state: "idle", reason: "frame_reloaded" }),
    );
  });

  it("counts the frame's loads even before the config arrives", () => {
    // The page loads while the app's config is still on its way; its next load is a reload.
    const h = mount({ config: null });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    h.rerender({ gate: gate(), config: ON });
    listen(h.result);
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(last()).toEqual(
      voice({ type: "state", id: "s1", state: "idle", reason: "frame_reloaded" }),
    );
  });

  it("stops when the window loses focus while focus is inside the frame (no blur event here)", () => {
    const { result } = mount();
    listen(result);
    later(FOCUS_POLL_MS * 4);
    expect(result.current.listening).toBe(true);
    // A switch to another app blurs only the frame's window: this document sees no event.
    focused = false;
    later(FOCUS_POLL_MS);
    expect(last()).toEqual(voice({ type: "state", id: "s1", state: "idle", reason: "blurred" }));
    expect(rec().aborted).toBe(true);
    expect(result.current.listening).toBe(false);
  });

  it("after the page's stop, goes idle before the page stops waiting, without the recognizer's end", () => {
    const { result } = mount();
    listen(result);
    fromFrame({ type: "stop", id: "s1" });
    later(VOICE_LIMITS.stopWaitMs - 250);
    expect(last()).toEqual(voice({ type: "state", id: "s1", state: "idle", reason: "stopped" }));
    expect(result.current.listening).toBe(false);
  });

  it("the viewer's Stop: idle viewer_stopped, a cooldown, and not_granted after three", () => {
    const { result } = mount();
    const idle = (id: string) =>
      voice({ type: "state", id, state: "idle", reason: "viewer_stopped" });
    listen(result, "a1");
    act(() => result.current.stop());
    expect(last()).toEqual(idle("a1"));
    later(VOICE_LIMITS.minStartGapMs);
    start("a2");
    expect(last()).toEqual(voice({ type: "refused", id: "a2", code: "rate_limited" }));
    for (const id of ["b1", "c1"]) {
      later(VOICE_LIMITS.stopCooldownMs);
      start(id);
      act(() => rec().onstart?.());
      act(() => result.current.stop());
      expect(last()).toEqual(idle(id));
    }
    later(VOICE_LIMITS.stopCooldownMs);
    start("d1");
    expect(last()).toEqual(voice({ type: "refused", id: "d1", code: "not_granted" }));
  });

  it("Turn off forgets the consent and stops listening", () => {
    const { result } = mount();
    listen(result);
    expect(result.current.allowed).toBe(true);
    act(() => result.current.turnOff());
    expect(result.current.allowed).toBe(false);
    expect(localStorage.getItem(`${CONSENT_PREFIX}art1`)).toBeNull();
    expect(last()).toEqual(
      voice({ type: "state", id: "s1", state: "idle", reason: "not_granted" }),
    );
  });
});

describe("dictation consent storage", () => {
  it("sign-out forgets every artifact's consent and nothing else", () => {
    localStorage.setItem(`${CONSENT_PREFIX}a`, VIEWER);
    localStorage.setItem(`${CONSENT_PREFIX}b`, VIEWER);
    localStorage.setItem("plinth:theme", "dark");
    forgetAllConsents();
    expect(localStorage.getItem(`${CONSENT_PREFIX}a`)).toBeNull();
    expect(localStorage.getItem(`${CONSENT_PREFIX}b`)).toBeNull();
    expect(localStorage.getItem("plinth:theme")).toBe("dark");
  });
});
