// Following the presenter, in the deck: the slides socket client (backoff, the hidden-tab close,
// 4401 and 4404 stop it, reconnecting leads again) and the deck's side (following, pausing by hand,
// "Back to the presenter", Lead viewers sending start, goto and stop, a takeover), with a fake
// socket.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  ROOM_LIMITS,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import {
  FOLLOW_BACKOFF_S,
  FOLLOW_HIDDEN_CLOSE_MS,
  FOLLOW_PING_MS,
  Follow,
  type FollowSocket,
  followSocketUrl,
  leadLabel,
} from "./follow.ts";
import { DeckController } from "./nav.ts";

class FakeSocket implements FollowSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  closed: number | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    this.sent.push(raw === "ping" ? raw : JSON.parse(raw));
  }
  close(code = 1000) {
    this.closed = code;
  }
  frame(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
  drop(code = 1006) {
    this.onclose?.({ code } as CloseEvent);
  }
  frames() {
    return this.sent.filter((f) => f !== "ping");
  }
}

const connect = (url: string, protocols: string[]) => new FakeSocket(url, protocols);
const last = () => {
  const s = FakeSocket.all.at(-1);
  if (!s) throw new Error("no socket");
  return s;
};
const welcome = (
  s: FakeSocket,
  o: { id?: string; present?: boolean; at?: { slide: number; by: string } | null } = {},
) =>
  s.frame({
    t: "welcome",
    v: 1,
    you: { id: o.id ?? "s_me", present: o.present ?? false },
    at: o.at ?? null,
  });

let visibility: "visible" | "hidden" = "visible";
/** Everything a test started, stopped after it. */
const started: (() => void)[] = [];

function fakeWin(): Window {
  return {
    document,
    location: { protocol: "https:", host: "abc.content.example" },
  } as unknown as Window;
}

function setup(right: "present" | "watch", count = 5) {
  const win = fakeWin();
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  const deck = new DeckController(count);
  /** What the deck told the app about the person's lead. */
  const told: boolean[] = [];
  const f = new Follow({
    win,
    root,
    deck,
    right,
    connect,
    random: () => 1,
    onLead: (on) => told.push(on),
  });
  root.append(f.pill);
  f.start();
  started.push(() => f.stop());
  return { win, root, deck, f, told, s: last() };
}

beforeEach(() => {
  FakeSocket.all = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  for (const stop of started.splice(0)) stop();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("FollowClient", () => {
  it("connects to the deck's own origin with the room subprotocol", () => {
    const { s } = setup("watch");
    expect(s.url).toBe("wss://abc.content.example/__plinth/room/v1/slides");
    expect(s.protocols).toEqual(["plinth.room.v1"]);
    expect(followSocketUrl({ protocol: "http:", host: "x.localhost:8787" })).toBe(
      "ws://x.localhost:8787/__plinth/room/v1/slides",
    );
  });

  it("repeats the room's timings", () => {
    expect([...FOLLOW_BACKOFF_S]).toEqual([...ROOM_LIMITS.backoffS]);
    expect(FOLLOW_HIDDEN_CLOSE_MS).toBe(ROOM_LIMITS.hiddenCloseS * 1000);
    expect(FOLLOW_PING_MS).toBe(ROOM_LIMITS.pingIntervalS * 1000);
  });

  it("pings every 30 s once welcomed", () => {
    const { s } = setup("watch");
    welcome(s);
    vi.advanceTimersByTime(FOLLOW_PING_MS);
    expect(s.sent).toEqual(["ping"]);
  });

  it("backs off 1, 2, 5, 10 then 30 s after a welcome, and gives up if it never got one", () => {
    const { s } = setup("watch");
    welcome(s);
    s.drop();
    const delays = [1, 2, 5, 10, 30, 30];
    for (const d of delays) {
      const before = FakeSocket.all.length;
      vi.advanceTimersByTime(d * 1000 - 1);
      expect(FakeSocket.all.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all.length).toBe(before + 1);
      last().drop();
    }
    // Never welcomed: five tries, then the deck pages alone.
    for (const stop of started.splice(0)) stop();
    FakeSocket.all = [];
    const { f, s: first } = setup("watch");
    first.drop();
    for (const d of FOLLOW_BACKOFF_S) {
      vi.advanceTimersByTime(d * 1000);
      last().drop();
    }
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(FOLLOW_BACKOFF_S.length + 1);
    expect(f.client.connected).toBe(false);
  });

  it("4401 stops it and says to reload; 4404 stops it", () => {
    const { f, s, root } = setup("watch");
    welcome(s, { at: { slide: 2, by: "s_lead" } });
    s.drop(4401);
    expect(f.client.ended).toBe("unauthorized");
    expect(f.pill.hidden).toBe(false);
    expect(f.pill.textContent).toContain("Your access changed. Reload to keep following.");
    expect(root.hasAttribute("data-follow")).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all.length).toBe(1);

    const g = setup("watch");
    welcome(g.s);
    g.s.drop(4404);
    expect(g.f.client.ended).toBe("gone");
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all.length).toBe(2);
  });

  it("closes after 60 s hidden and reconnects when shown; a leader stays connected", () => {
    const { s } = setup("watch");
    welcome(s);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(FOLLOW_HIDDEN_CLOSE_MS);
    expect(s.closed).toBe(1000);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all.length).toBe(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.all.length).toBe(2);

    for (const stop of started.splice(0)) stop();
    FakeSocket.all = [];
    const p = setup("present");
    welcome(p.s, { id: "s_me", present: true });
    p.f.toggleLead();
    p.s.frame({ t: "at", slide: 1, by: "s_me" });
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(FOLLOW_HIDDEN_CLOSE_MS * 2);
    expect(p.s.closed).toBeNull();
  });

  it("a tab hidden for 60 s between reconnects stops retrying until it is shown", () => {
    const { f, s } = setup("watch");
    welcome(s);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    s.drop();
    // Every retry fails at once (1, 2, 5, 10 and 30 s), so at 48 s the next one is due at 78 s,
    // and the hidden close fires at 60 s while no socket is open.
    for (const d of [1, 2, 5, 10, 30]) {
      vi.advanceTimersByTime(d * 1000);
      last().drop();
    }
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.all.length).toBe(n);
    expect(f.client.connected).toBe(false);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.all.length).toBe(n + 1);
  });
});

describe("Follow: watching", () => {
  it("follows the leader, pauses when paged by hand, and goes back on request", () => {
    const { f, s, deck, root } = setup("watch");
    welcome(s);
    expect(f.pill.hidden).toBe(true);
    s.frame({ t: "at", slide: 3, by: "s_lead" });
    expect(deck.current).toBe(3);
    expect(f.pill.hidden).toBe(false);
    expect(f.pill.textContent).toContain("Following the presenter");
    expect(root.getAttribute("data-follow")).toBe("on");
    s.frame({ t: "at", slide: 4, by: "s_lead" });
    expect(deck.current).toBe(4);
    // Paging by hand pauses following.
    deck.prev();
    expect(f.following).toBe(false);
    expect(root.getAttribute("data-follow")).toBe("paused");
    s.frame({ t: "at", slide: 5, by: "s_lead" });
    expect(deck.current).toBe(3);
    const back = f.pill.querySelector("button");
    expect(back?.textContent).toBe("Back to the presenter (slide 5)");
    back?.click();
    expect(deck.current).toBe(5);
    expect(f.following).toBe(true);
    // Stop pauses too.
    f.pill.querySelector("button")?.click();
    expect(f.following).toBe(false);
    // Nobody leads: the pill goes, and the next presenter is followed again.
    s.frame({ t: "stopped" });
    expect(f.pill.hidden).toBe(true);
    expect(root.hasAttribute("data-follow")).toBe(false);
    s.frame({ t: "at", slide: 2, by: "s_other" });
    expect(deck.current).toBe(2);
  });

  it("a late joiner's welcome moves the deck; watchers send nothing but ping", () => {
    const { s, deck } = setup("watch");
    welcome(s, { at: { slide: 4, by: "s_lead" } });
    expect(deck.current).toBe(4);
    deck.next();
    vi.advanceTimersByTime(FOLLOW_PING_MS);
    expect(s.frames()).toEqual([]);
  });

  it("ignores frames it cannot read", () => {
    const { s, deck } = setup("watch");
    welcome(s);
    s.frame({ t: "at", slide: 0, by: "s_lead" });
    s.frame({ t: "at", slide: 2, by: "someone@example.com" });
    s.onmessage?.({ data: "{" } as MessageEvent);
    expect(deck.current).toBe(1);
  });
});

describe("Follow: presenting", () => {
  it("Lead viewers sends start, goto on every change and stop", () => {
    const { f, s, deck, root } = setup("present");
    const button = f.leadButton();
    expect(button.disabled).toBe(true);
    welcome(s, { id: "s_me", present: true });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Lead viewers");
    deck.go(2);
    button.click();
    expect(s.frames()).toEqual([{ t: "start", slide: 2 }]);
    s.frame({ t: "at", slide: 2, by: "s_me" });
    s.frame({ t: "audience", n: 3 });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("Leading · 3 following");
    expect(root.getAttribute("data-follow")).toBe("leading");
    expect(f.pill.hidden).toBe(true);
    deck.next();
    expect(s.frames().at(-1)).toEqual({ t: "goto", slide: 3 });
    button.click();
    expect(s.frames().at(-1)).toEqual({ t: "stop" });
    expect(button.textContent).toBe("Lead viewers");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // Not leading: paging sends nothing.
    const n = s.frames().length;
    deck.next();
    expect(s.frames().length).toBe(n);
  });

  it("a slide changed while start was on the way goes to the room when the lead is confirmed", () => {
    const { f, s, deck } = setup("present");
    welcome(s, { id: "s_me", present: true });
    deck.go(4);
    f.toggleLead();
    // Paged before the room's own `at` came back: nothing to send yet.
    deck.next();
    expect(s.frames()).toEqual([{ t: "start", slide: 4 }]);
    s.frame({ t: "at", slide: 4, by: "s_me" });
    expect(f.client.leading).toBe(true);
    expect(s.frames().at(-1)).toEqual({ t: "goto", slide: 5 });
    // The same slide: nothing more.
    const n = s.frames().length;
    s.frame({ t: "at", slide: 5, by: "s_me" });
    expect(s.frames().length).toBe(n);
  });

  it("another presenter taking over turns Lead viewers off and follows them", () => {
    const { f, s, deck } = setup("present");
    const button = f.leadButton();
    welcome(s, { id: "s_me", present: true });
    button.click();
    s.frame({ t: "at", slide: 1, by: "s_me" });
    s.frame({ t: "at", slide: 4, by: "s_other" });
    expect(f.client.leading).toBe(false);
    expect(s.frames().at(-1)).toEqual({ t: "stop" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(deck.current).toBe(4);
    expect(f.pill.textContent).toContain("Following the presenter");
  });

  it("takes the lead again after a reconnect, unless someone else leads by then", () => {
    const { f, s, deck } = setup("present");
    f.leadButton();
    welcome(s, { id: "s_me", present: true });
    deck.go(3);
    f.toggleLead();
    s.frame({ t: "at", slide: 3, by: "s_me" });
    s.drop();
    vi.advanceTimersByTime(1000);
    const again = last();
    welcome(again, { id: "s_new", present: true });
    expect(again.frames()).toEqual([{ t: "start", slide: 3 }]);
    again.drop();
    vi.advanceTimersByTime(1000);
    const third = last();
    welcome(third, { id: "s_third", present: true, at: { slide: 2, by: "s_other" } });
    expect(third.frames()).toEqual([]);
    expect(f.client.wantLead).toBe(false);
    expect(deck.current).toBe(2);
  });

  it("tells the app the person's lead: on and off, a takeover, a refusal, never a closed socket", () => {
    const { f, s, told } = setup("present");
    welcome(s, { id: "s_me", present: true });
    f.toggleLead();
    s.frame({ t: "at", slide: 1, by: "s_me" });
    f.toggleLead();
    expect(told).toEqual([true, false]);
    f.toggleLead();
    s.frame({ t: "at", slide: 1, by: "s_me" });
    s.frame({ t: "at", slide: 2, by: "s_other" });
    expect(told).toEqual([true, false, true, false]);
    f.toggleLead();
    s.frame({ t: "error", code: "not_leading" });
    expect(told.at(-1)).toBe(false);
    f.toggleLead();
    s.frame({ t: "error", code: "forbidden" });
    expect(told).toEqual([true, false, true, false, true, false, true, false]);
    // A sharing change closes the socket for good: the lead is not reported off, so the frame
    // that replaces this one can lead again.
    f.toggleLead();
    s.drop(4401);
    expect(f.client.wantLead).toBe(false);
    expect(told.at(-1)).toBe(true);
  });

  it("a resumed lead (the app's lead) takes the lead even if the room lists the old frame's socket", () => {
    const { f, s, deck, told } = setup("present");
    f.leadButton();
    // The app sent the slide, then lead, before the room's welcome.
    deck.go(4);
    f.resumeLead();
    expect(s.frames()).toEqual([]);
    expect(told).toEqual([true]);
    // The old frame's socket has not gone yet: the room still lists it as leading.
    welcome(s, { id: "s_new", present: true, at: { slide: 4, by: "s_old" } });
    expect(s.frames()).toEqual([{ t: "start", slide: 4 }]);
    expect(f.client.wantLead).toBe(true);
    expect(f.client.takenOver).toBe(false);
    s.frame({ t: "at", slide: 4, by: "s_new" });
    expect(f.client.leading).toBe(true);
    deck.next();
    expect(s.frames().at(-1)).toEqual({ t: "goto", slide: 5 });
    // Only that welcome: after a later reconnect someone else leading wins, as before.
    s.drop();
    vi.advanceTimersByTime(1000);
    const again = last();
    welcome(again, { id: "s_again", present: true, at: { slide: 2, by: "s_other" } });
    expect(again.frames()).toEqual([]);
    expect(f.client.wantLead).toBe(false);
    expect(told.at(-1)).toBe(false);
  });

  it("a resumed lead starts at once when already welcomed, and a watcher ignores it", () => {
    const { f, s, deck } = setup("present");
    welcome(s, { id: "s_me", present: true });
    deck.go(3);
    f.resumeLead();
    expect(s.frames()).toEqual([{ t: "start", slide: 3 }]);
    // Twice is once.
    f.resumeLead();
    expect(s.frames()).toEqual([{ t: "start", slide: 3 }]);

    const w = setup("watch");
    welcome(w.s, { id: "s_w", present: false });
    w.f.resumeLead();
    expect(w.s.frames()).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it("a resumed lead without the right to present any more is dropped and reported off", () => {
    const { f, s, told } = setup("present");
    f.resumeLead();
    welcome(s, { id: "s_me", present: false });
    expect(s.frames()).toEqual([]);
    expect(f.client.wantLead).toBe(false);
    expect(told).toEqual([true, false]);
  });

  it("labels the toggle by its audience", () => {
    expect(leadLabel(false, 4)).toBe("Lead viewers");
    expect(leadLabel(true, 0)).toBe("Leading · 0 following");
    expect(leadLabel(true, 1)).toBe("Leading · 1 following");
  });
});

describe("boot with follow", () => {
  function mount(follow?: "present" | "watch", view?: "overview") {
    const html = typedShellHtml(TYPE_REGISTRY.slides, {
      title: "T",
      text: "# One\n\n---\n\n## Two\n\n---\n\n## Three\n",
      base: "",
      appOrigin: "https://plinth.example.com",
      ...(follow ? { follow } : {}),
      ...(view ? { view } : {}),
    });
    const main = /<main [^>]*><\/main>/.exec(html)?.[0];
    const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
    if (!main || !data) throw new Error("unexpected shell");
    document.body.innerHTML = main + data;
  }
  const APP = "https://plinth.example.com";
  let target = new EventTarget();
  let parent = { postMessage: vi.fn() };
  /** A message from the app page that frames the deck. */
  const app = (m: Record<string, unknown>) =>
    target.dispatchEvent(
      new MessageEvent("message", {
        data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
        origin: APP,
        source: parent as unknown as Window,
      }),
    );
  function framedWin(): Window {
    target = new EventTarget();
    parent = { postMessage: vi.fn() };
    return {
      document,
      parent,
      print: vi.fn(),
      origin: "https://abc.content.example",
      location: { protocol: "https:", host: "abc.content.example" },
      innerWidth: 1280,
      innerHeight: 800,
      getSelection: () => window.getSelection(),
      matchMedia: () => ({ matches: false }),
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    } as unknown as Window;
  }
  const measure = () => false;

  it("opens no socket without follow, in review mode or the editor preview", () => {
    mount();
    boot(framedWin(), { measure, connect })();
    mount("watch", "overview");
    boot(framedWin(), { measure, connect })();
    expect(FakeSocket.all).toEqual([]);
    expect(document.querySelector(".plinth-slides__follow")).toBeNull();
  });

  it("a watcher gets the pill and no Lead viewers toggle; a presenter gets the toggle", () => {
    mount("watch");
    const stop = boot(framedWin(), { measure, connect });
    started.push(stop);
    expect(FakeSocket.all.length).toBe(1);
    expect(document.querySelector(".plinth-slides__follow")).not.toBeNull();
    expect(document.querySelector(".plinth-slides__lead")).toBeNull();
    welcome(last(), { at: { slide: 3, by: "s_lead" } });
    expect(document.documentElement.getAttribute("data-slide")).toBe("3");
    stop();
    expect(last().closed).toBe(1000);

    mount("present");
    started.push(boot(framedWin(), { measure, connect }));
    const toggle = document.querySelector<HTMLButtonElement>(
      ".plinth-slides__controls .plinth-slides__lead",
    );
    expect(toggle?.textContent).toBe("Lead viewers");
  });

  it("an audience window (paired) leaves the room; its presenter window's slides never pause it", () => {
    // The owner's audience window: the shell gives it `present`, and the main window leads.
    mount("present");
    started.push(boot(framedWin(), { measure, connect }));
    const s = last();
    welcome(s, { id: "s_audience", present: true, at: { slide: 1, by: "s_main" } });
    expect(document.querySelector(".plinth-slides__follow")?.hasAttribute("hidden")).toBe(false);
    app({ type: "paired" });
    expect(s.closed).toBe(1000);
    expect(document.querySelector(".plinth-slides__follow")).toBeNull();
    expect(document.querySelector(".plinth-slides__lead")).toBeNull();
    expect(document.getElementById("__plinth-slides")?.hasAttribute("data-follow")).toBe(false);
    // The presenter window's next slide reaches it before the room's `at` would.
    app({ type: "goto", slide: 2 });
    expect(document.documentElement.getAttribute("data-slide")).toBe("2");
    expect(document.querySelector(".plinth-slides__follow")).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.all.length).toBe(1);
    // Presenter view in the audience window has no Lead viewers toggle either.
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", cancelable: true }));
    expect(document.querySelector(".plinth-slides__lead")).toBeNull();
  });

  it("tells the app when the person leads, and leads again when the app says the old frame did", () => {
    mount("present");
    started.push(boot(framedWin(), { measure, connect }));
    const s = last();
    const leading = () =>
      parent.postMessage.mock.calls
        .map((c) => c[0] as { type: string; on?: boolean })
        .filter((m) => m.type === "leading")
        .map((m) => m.on);
    welcome(s, { id: "s_me", present: true });
    document
      .querySelector<HTMLButtonElement>(".plinth-slides__controls .plinth-slides__lead")
      ?.click();
    expect(leading()).toEqual([true]);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "leading", on: true },
      APP,
    );

    // The frame that replaces it: the app sends the slide, then lead.
    mount("present");
    started.push(boot(framedWin(), { measure, connect }));
    const next = last();
    app({ type: "goto", slide: 2 });
    app({ type: "lead" });
    welcome(next, { id: "s_next", present: true, at: { slide: 1, by: "s_me" } });
    expect(next.frames()).toEqual([{ t: "start", slide: 2 }]);
    next.frame({ t: "at", slide: 2, by: "s_next" });
    const toggle = document.querySelector<HTMLButtonElement>(
      ".plinth-slides__controls .plinth-slides__lead",
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("__plinth-slides")?.getAttribute("data-follow")).toBe("leading");

    // A watcher's frame ignores lead.
    mount("watch");
    started.push(boot(framedWin(), { measure, connect }));
    const w = last();
    app({ type: "lead" });
    welcome(w, { id: "s_w" });
    expect(w.frames()).toEqual([]);
  });

  it("while following, the presenter's slide wins over the app's goto", () => {
    mount("watch");
    started.push(boot(framedWin(), { measure, connect }));
    welcome(last(), { at: { slide: 3, by: "s_lead" } });
    app({ type: "goto", slide: 1 });
    expect(document.documentElement.getAttribute("data-slide")).toBe("3");
    expect(document.getElementById("__plinth-slides")?.getAttribute("data-follow")).toBe("on");
    // Paused by hand, the app's goto applies again.
    document.querySelector<HTMLButtonElement>(".plinth-slides__follow button")?.click();
    app({ type: "goto", slide: 2 });
    expect(document.documentElement.getAttribute("data-slide")).toBe("2");
  });

  it("refuses a payload with an unknown follow value", () => {
    mount();
    const data = document.getElementById("__plinth-content");
    if (!data?.textContent) throw new Error("no payload");
    data.textContent = data.textContent.replace('"text"', '"follow":"lead","text"');
    boot(framedWin(), { measure, connect });
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
    expect(FakeSocket.all).toEqual([]);
  });
});
