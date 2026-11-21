// Following the presenter (docs/spec.md "Slides"): the deck's side of the room's `slides` channel
// (apps/worker/src/rooms/slides.ts). The shell's payload says `follow: "present"` for an owner or
// editor and `follow: "watch"` for everyone else identified; without it nothing here runs.
//
// FollowClient is the socket: it connects to /__plinth/room/v1/slides on the deck's own origin,
// validates every server frame by hand, pings every 30 s, backs off 1, 2, 5, 10 then 30 s, closes
// after 60 s in a hidden tab (unless it leads; between reconnects it stops retrying instead) and
// reconnects when shown, and stops for good on 4401 (access changed) and 4404 (gone). A presenter
// that was leading takes the lead again after a reconnect, unless someone else leads by then (its
// own old socket, which the room may still list, is not someone else), and sends the slide it
// moved to while its `start` was on the way. It sends `goto` at most every 100 ms, always ending on
// the slide on screen (trailing edge), and after the room's `rate_limited` at most once a second,
// sending the room what it may have dropped again.
//
// The app replaces a deck's frame for a newer version or a sharing change (outside full screen and
// presenter view), and the old frame's socket closes with it. So the frame tells the app whether
// the person leads (`leading`), and the app asks the new frame to lead again (`lead`): that resume
// takes the lead even if the room still lists the old frame's socket as leading, since the person
// never stopped. A lead that ends because the socket closed for good is not reported, so the next
// frame leads again; one that the person stopped, or another presenter took over, is.
//
// Follow is the deck's side: it moves the deck to the leader's slide while following, pauses when
// the person pages by hand ("Back to slide 7"), and, for a presenter, sends `start`,
// `goto` on every change and `stop`. An audience window (the app's `paired`) detaches it: its
// presenter window moves it instead. Only slide numbers go in and out; every element is made with
// createElement and textContent.
import {
  parseSlidesServerFrame,
  ROOM_CLOSE,
  ROOM_PATH_PREFIX,
  ROOM_PROTOCOL,
  type SlidesPosition,
  type SlidesServerFrame,
} from "@plinth/shared";
import { el } from "./dom.ts";
import type { DeckController } from "./nav.ts";

// ROOM_LIMITS' backoffS, hiddenCloseS and pingIntervalS, repeated here (as the doc socket does) so
// the deck's bundle never carries room.ts and its zod schemas; follow.test.ts pins them equal.
export const FOLLOW_BACKOFF_S = [1, 2, 5, 10, 30] as const;
export const FOLLOW_HIDDEN_CLOSE_MS = 60_000;
export const FOLLOW_PING_MS = 30_000;
/**
 * A leader sends `goto` at most this often: paging faster (a held arrow key, a quick flick) sends
 * only the latest slide once the gap has passed, well under the room's default 20 frames a second.
 */
export const FOLLOW_GOTO_GAP_MS = 100;
/**
 * After the room answered `rate_limited` (an instance with a low ROOM_MESSAGES_PER_SECOND, at
 * least 1): the gap for the rest of the socket's life, and how long to wait before sending again.
 */
export const FOLLOW_GOTO_SLOW_GAP_MS = 1000;

/** The slides socket's URL on this content origin. */
export function followSocketUrl(loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${ROOM_PATH_PREFIX}slides`;
}

export type FollowSocket = Pick<WebSocket, "send" | "close"> & {
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export interface FollowClientOptions {
  win: Window;
  /** Something the deck shows changed: the leader, the audience, the lead, the connection. */
  changed(): void;
  /**
   * The person's lead changed: on (they led), or off (they stopped, another presenter took over,
   * or they may no longer present). Never called when the socket closes for good.
   */
  leadChanged?: (on: boolean) => void;
  /** For tests: makes the socket. */
  connect?: (url: string, protocols: string[]) => FollowSocket;
  /** For tests: the random part of the backoff (0 to 1). */
  random?: () => number;
}

export class FollowClient {
  /** This socket's id and right, from the last welcome. */
  you: { id: string; present: boolean } | null = null;
  /** The leading presenter's position, this socket's own included; null when nobody leads. */
  at: SlidesPosition | null = null;
  /** The person asked to lead (and nobody took over since). */
  wantLead = false;
  /** People following while this socket leads. */
  audience = 0;
  connected = false;
  /** Why the room closed the socket for good. */
  ended: "unauthorized" | "gone" | null = null;
  /** Another presenter took over while this one led; cleared when it leads again. */
  takenOver = false;

  private ws: FollowSocket | null = null;
  private attempt = 0;
  private everWelcomed = false;
  private stopped = false;
  private pausedHidden = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  /** The slide this socket last showed, for `start` after a reconnect. */
  private slide = 1;
  /** A lead the frame this one replaced had: the next welcome takes it whoever the room lists. */
  private resuming = false;
  /**
   * The ids this client's earlier sockets had (the last few): after a reconnect the room may
   * still list the old socket as leading, and that is this presenter, not someone else.
   */
  private readonly ownIds: string[] = [];
  /** When the last `goto` went, and the gap before the next (FOLLOW_GOTO_GAP_MS or slow). */
  private lastGotoAt = Number.NEGATIVE_INFINITY;
  private gotoGap = FOLLOW_GOTO_GAP_MS;
  /** The trailing `goto` (or the resend after `rate_limited`), waiting for the gap. */
  private gotoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: FollowClientOptions) {}

  /** This socket leads: it asked to, and the room's latest position is its own. */
  get leading(): boolean {
    return this.wantLead && this.you !== null && this.at?.by === this.you.id;
  }

  /** Someone else leads: the position to follow, or null. */
  get leader(): SlidesPosition | null {
    return this.at && this.at.by !== this.you?.id ? this.at : null;
  }

  start(): void {
    this.stopped = false;
    this.opts.win.document.addEventListener("visibilitychange", this.onVisibility);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.opts.win.document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
    this.connected = false;
  }

  /**
   * Lead the others from `slide`. `resume`: the frame this one replaced was leading, so a welcome
   * still to come takes the lead even if the room lists someone leading (most likely that frame's
   * socket, not yet gone).
   */
  lead(slide: number, resume = false): void {
    this.slide = slide;
    this.wantLead = true;
    this.takenOver = false;
    this.resuming = resume && !this.connected;
    this.send({ t: "start", slide });
    this.opts.leadChanged?.(true);
    this.opts.changed();
  }

  /** Stop leading. */
  unlead(): void {
    this.wantLead = false;
    this.resuming = false;
    this.audience = 0;
    this.send({ t: "stop" });
    this.opts.leadChanged?.(false);
    this.opts.changed();
  }

  /** The lead ended without the person asking: another presenter, or no right to present. */
  private lostLead(takenOver: boolean): void {
    this.wantLead = false;
    this.resuming = false;
    this.takenOver = takenOver;
    this.audience = 0;
    this.opts.leadChanged?.(false);
  }

  /** The deck moved to `slide`: the others follow while this socket leads. */
  moved(slide: number): void {
    this.slide = slide;
    if (this.leading) this.queueGoto(0);
  }

  /**
   * Send the slide on screen once the gap since the last `goto` (and at least `wait` ms) has
   * passed. While one is queued, later moves only change the slide it sends.
   */
  private queueGoto(wait: number): void {
    if (this.gotoTimer) return;
    const due = Math.max(wait, this.lastGotoAt + this.gotoGap - Date.now());
    if (due <= 0) {
      this.sendGoto();
      return;
    }
    this.gotoTimer = setTimeout(() => {
      this.gotoTimer = null;
      this.resync();
    }, due);
  }

  private sendGoto(): void {
    this.lastGotoAt = Date.now();
    this.send({ t: "goto", slide: this.slide });
  }

  /**
   * Bring the room up to date with what the person wants: the slide on screen while leading, a
   * `start` the room has not confirmed (it may have dropped it), or a `stop` it still lacks.
   */
  private resync(): void {
    if (!this.connected) return;
    if (this.leading) this.sendGoto();
    else if (this.wantLead) this.send({ t: "start", slide: this.slide });
    else if (this.you !== null && this.at?.by === this.you.id) this.send({ t: "stop" });
  }

  private clearGoto(): void {
    if (this.gotoTimer) clearTimeout(this.gotoTimer);
    this.gotoTimer = null;
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (this.ping) clearInterval(this.ping);
    this.clearGoto();
    this.retry = null;
    this.hiddenTimer = null;
    this.ping = null;
  }

  private open(): void {
    if (this.stopped || this.ws) return;
    const make = this.opts.connect ?? ((u, p) => new WebSocket(u, p) as unknown as FollowSocket);
    let ws: FollowSocket;
    try {
      ws = make(followSocketUrl(this.opts.win.location), [ROOM_PROTOCOL]);
    } catch {
      this.onClosed(1006);
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string" || ev.data === "pong") return;
      const f = parseSlidesServerFrame(ev.data);
      if (f) this.handle(f);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClosed(ev.code);
    };
    ws.onerror = () => undefined;
  }

  private onClosed(code: number): void {
    const was = this.connected;
    this.connected = false;
    this.at = null;
    this.audience = 0;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    // The next socket's `start` carries the slide on screen; its rate starts afresh.
    this.clearGoto();
    this.gotoGap = FOLLOW_GOTO_GAP_MS;
    this.lastGotoAt = Number.NEGATIVE_INFINITY;
    if (code === ROOM_CLOSE.unauthorized || code === ROOM_CLOSE.gone) {
      this.ended = code === ROOM_CLOSE.gone ? "gone" : "unauthorized";
      this.stopped = true;
      this.wantLead = false;
    } else if (!this.everWelcomed && this.attempt >= FOLLOW_BACKOFF_S.length) {
      // The room never answered: the deck pages alone.
      this.stopped = true;
    }
    if (was || this.stopped) this.opts.changed();
    if (this.stopped || this.pausedHidden) return;
    const base = FOLLOW_BACKOFF_S[Math.min(this.attempt, FOLLOW_BACKOFF_S.length - 1)] ?? 30;
    this.attempt++;
    const jitter = 0.5 + (this.opts.random ?? Math.random)() * 0.5;
    this.retry = setTimeout(
      () => {
        this.retry = null;
        this.open();
      },
      base * 1000 * jitter,
    );
  }

  private readonly onVisibility = () => {
    const hidden = this.opts.win.document.visibilityState === "hidden";
    if (hidden) {
      if (this.hiddenTimer) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        // A presenter keeps leading from a background tab (its audience window may be in front).
        if (this.stopped || this.wantLead) return;
        this.pausedHidden = true;
        // Between reconnects: no retry until the tab is shown again.
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        const ws = this.ws;
        if (!ws) return;
        this.ws = null;
        ws.onclose = null;
        ws.close(1000);
        this.onClosed(1000);
      }, FOLLOW_HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.pausedHidden) {
      this.pausedHidden = false;
      this.open();
    }
  };

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || !this.connected) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Closing; the reconnect resends what matters.
    }
  }

  /** Exposed for tests: one validated frame. */
  handle(f: SlidesServerFrame): void {
    switch (f.t) {
      case "welcome": {
        const before = this.you?.id;
        if (before && before !== f.you.id && !this.ownIds.includes(before)) {
          this.ownIds.push(before);
          if (this.ownIds.length > 8) this.ownIds.shift();
        }
        this.you = f.you;
        this.at = f.at;
        this.connected = true;
        this.everWelcomed = true;
        this.attempt = 0;
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => {
          try {
            this.ws?.send("ping");
          } catch {
            // Closing.
          }
        }, FOLLOW_PING_MS);
        if (this.wantLead) {
          // Back after a reconnect: lead again, unless someone else leads now. This client's own
          // old socket, which the room may not have seen close yet, is not someone else: its
          // `start` takes over at once, and followers carry on. A resumed lead takes it whoever
          // leads: the person never stopped.
          const mine = f.at !== null && this.ownIds.includes(f.at.by);
          if (f.you.present && (f.at === null || mine || this.resuming)) {
            this.send({ t: "start", slide: this.slide });
          } else this.lostLead(f.at !== null);
        }
        this.resuming = false;
        break;
      }
      case "at": {
        const mine = f.by === this.you?.id;
        if (mine && this.wantLead && f.slide !== this.slide) {
          // The deck moved while `start` was on the way: the room's own `at` confirms the lead at
          // the old slide, so the followers get the one on screen (now, or once the gap passed).
          this.at = { slide: this.slide, by: f.by };
          this.queueGoto(0);
          break;
        }
        if (!mine && this.wantLead && this.at?.by === this.you?.id) {
          // Another presenter started after this one: it leads now, and this one stops for good,
          // so the room never hands the lead back to it unasked.
          this.lostLead(true);
          this.send({ t: "stop" });
        }
        this.at = { slide: f.slide, by: f.by };
        break;
      }
      case "stopped":
        this.at = null;
        break;
      case "audience":
        this.audience = f.n;
        break;
      case "error":
        if (f.code === "not_leading" && this.wantLead) {
          this.lostLead(true);
          this.send({ t: "stop" });
        } else if (f.code === "forbidden" && this.wantLead) {
          this.lostLead(false);
        } else if (f.code === "rate_limited") {
          // The room dropped a frame (most likely a `goto`): slow down for this socket, and send
          // the slide on screen (or the start or stop it lacks) once a second has passed.
          this.gotoGap = FOLLOW_GOTO_SLOW_GAP_MS;
          this.lastGotoAt = Date.now();
          this.clearGoto();
          this.queueGoto(FOLLOW_GOTO_SLOW_GAP_MS);
        }
        break;
    }
    this.opts.changed();
  }
}

// ---------- the deck's side ----------

export interface FollowOptions {
  win: Window;
  root: HTMLElement;
  deck: DeckController;
  right: "present" | "watch";
  /** The person's lead changed (FollowClientOptions.leadChanged): the deck tells the app. */
  onLead?: (on: boolean) => void;
  /** For tests: makes the socket. */
  connect?: FollowClientOptions["connect"];
  random?: () => number;
}

/** The text of a presenter's Lead viewers toggle: pressed, it shows how many follow, if any. */
export function leadLabel(leading: boolean, audience: number): string {
  if (!leading) return "Lead viewers";
  return audience > 0 ? `${audience} following` : "Leading";
}

/**
 * Following and leading for one deck. `pill` is the follower's status, one item at the end of the
 * deck's controls (shown while someone else leads, or after access changed); `leadButton()` makes a
 * Lead viewers toggle for the controls and one for presenter view, kept in step.
 */
export class Follow {
  readonly client: FollowClient;
  readonly pill: HTMLElement;
  /** Following the leader (on by default); paging by hand pauses it. */
  following = true;
  private readonly pillText: HTMLElement;
  private readonly pillButton: HTMLButtonElement;
  private readonly leadButtons: HTMLButtonElement[] = [];
  /** The deck is moving to the leader's slide: that change is not the person paging. */
  private applying = false;
  /** An audience window: its presenter window moves the deck, so this follows nobody. */
  detached = false;
  private readonly unwatch: () => void;

  constructor(private readonly o: FollowOptions) {
    const doc = o.win.document;
    this.pill = el(doc, "span", "plinth-slides__follow");
    this.pill.setAttribute("role", "status");
    this.pill.hidden = true;
    this.pillText = el(doc, "span", "plinth-slides__follow-text");
    this.pillButton = el(doc, "button", "plinth-slides__btn");
    this.pillButton.type = "button";
    this.pillButton.addEventListener("click", () => this.resume());
    this.pill.append(this.pillText, this.pillButton);
    this.client = new FollowClient({
      win: o.win,
      changed: () => this.sync(),
      leadChanged: (on) => {
        if (!this.detached) o.onLead?.(on);
      },
      ...(o.connect ? { connect: o.connect } : {}),
      ...(o.random ? { random: o.random } : {}),
    });
    this.unwatch = o.deck.onChange((n) => this.moved(n));
  }

  start(): void {
    this.client.start();
    this.sync();
  }

  stop(): void {
    this.unwatch();
    this.client.stop();
  }

  /** Following someone else: the deck shows the leader's slide, whatever the app asks for. */
  get holding(): boolean {
    return (
      !this.detached &&
      !this.paused &&
      this.following &&
      !this.client.wantLead &&
      this.client.leader !== null
    );
  }

  /**
   * The app says this frame is an audience window (`paired`): the presenter window moves it over
   * the pair's channel, so it leaves the room and shows no note, toggle or data-follow.
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.stop();
    this.pill.remove();
    for (const b of this.leadButtons) b.remove();
    this.leadButtons.length = 0;
    this.o.root.removeAttribute("data-follow");
  }

  /** A Lead viewers toggle (presenters only), kept in step with the others. */
  leadButton(): HTMLButtonElement {
    const b = el(this.o.win.document, "button", "plinth-slides__btn plinth-slides__lead");
    b.type = "button";
    b.addEventListener("click", () => this.toggleLead());
    this.leadButtons.push(b);
    this.sync();
    return b;
  }

  toggleLead(): void {
    if (this.o.right !== "present") return;
    if (this.client.leading || this.client.wantLead) this.client.unlead();
    else {
      this.following = true;
      this.client.lead(this.o.deck.current);
    }
  }

  /**
   * The app says the frame this one replaced was leading (and the person never stopped): lead
   * again from the slide on screen, which the app has just sent.
   */
  resumeLead(): void {
    if (this.o.right !== "present" || this.detached || this.client.wantLead) return;
    if (this.client.ended) return;
    this.following = true;
    this.client.lead(this.o.deck.current, true);
  }

  /** Back to the leader's slide after paging by hand. */
  private resume(): void {
    this.following = true;
    this.sync();
  }

  /**
   * Edit mode (slides-text): the deck shows every raw slide, so its numbers are not the ones
   * viewers see. While paused the deck neither follows the leader nor sends its own slide; on
   * resume it catches up (a lead sends the slide shown, `shown` in the deck's own numbers).
   */
  pause(on: boolean, shown?: number): void {
    if (this.paused === on) return;
    this.paused = on;
    if (on) return;
    if ((this.client.leading || this.client.wantLead) && shown !== undefined) {
      this.client.moved(shown);
    }
    this.sync();
  }

  private paused = false;

  /** The deck changed slide, by the person, the app or the leader. */
  private moved(n: number): void {
    if (this.applying || this.paused) return;
    if (this.client.leading || this.client.wantLead) {
      this.client.moved(n);
      return;
    }
    // Paging by hand while someone leads pauses following.
    if (this.client.leader && this.following && n !== this.client.leader.slide) {
      this.following = false;
      this.sync();
    }
  }

  /** Brings the deck, the pill and the toggles up to date with the client. */
  sync(): void {
    if (this.detached) return;
    const c = this.client;
    const leader = c.leader;
    if (!leader) this.following = true;
    if (
      !this.paused &&
      leader &&
      this.following &&
      !c.wantLead &&
      this.o.deck.current !== leader.slide
    ) {
      this.applying = true;
      try {
        this.o.deck.go(leader.slide);
      } finally {
        this.applying = false;
      }
    }
    const root = this.o.root;
    if (c.ended === "unauthorized") {
      this.showPill("Your access changed. Reload the page.", null);
    } else if (leader && !c.wantLead) {
      if (this.following) this.showPill("Following", null);
      else this.showPill("", `Back to slide ${leader.slide}`);
    } else {
      this.pill.hidden = true;
    }
    if (leader && !c.wantLead) root.setAttribute("data-follow", this.following ? "on" : "paused");
    else if (c.leading) root.setAttribute("data-follow", "leading");
    else root.removeAttribute("data-follow");
    for (const b of this.leadButtons) {
      const on = c.leading;
      b.textContent = leadLabel(on, c.audience);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !c.connected;
    }
  }

  private showPill(text: string, button: string | null): void {
    this.pill.hidden = false;
    this.pillText.textContent = text;
    this.pillText.hidden = text === "";
    this.pillButton.hidden = button === null;
    if (button !== null) this.pillButton.textContent = button;
  }
}
