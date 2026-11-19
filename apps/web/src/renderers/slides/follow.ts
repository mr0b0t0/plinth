// Following the presenter (docs/spec.md "Slides"): the deck's side of the room's `slides` channel
// (apps/worker/src/rooms/slides.ts). The shell's payload says `follow: "present"` for an owner or
// editor and `follow: "watch"` for everyone else identified; without it nothing here runs.
//
// FollowClient is the socket: it connects to /__plinth/room/v1/slides on the deck's own origin,
// validates every server frame by hand, pings every 30 s, backs off 1, 2, 5, 10 then 30 s, closes
// after 60 s in a hidden tab (unless it leads) and reconnects when shown, and stops for good on 4401
// (access changed) and 4404 (gone). A presenter that was leading takes the lead again after a
// reconnect, unless someone else leads by then.
//
// Follow is the deck's side: it moves the deck to the leader's slide while following, pauses when
// the person pages by hand ("Back to the presenter (slide 7)"), and, for a presenter, sends `start`,
// `goto` on every change and `stop`. Only slide numbers go in and out; every element is made with
// createElement and textContent.
import {
  parseSlidesServerFrame,
  ROOM_CLOSE,
  ROOM_PATH_PREFIX,
  ROOM_PROTOCOL,
  type SlidesPosition,
  type SlidesServerFrame,
} from "@plinth/shared";
import type { DeckController } from "./nav.ts";

// ROOM_LIMITS' backoffS, hiddenCloseS and pingIntervalS, repeated here (as the doc socket does) so
// the deck's bundle never carries room.ts and its zod schemas; follow.test.ts pins them equal.
export const FOLLOW_BACKOFF_S = [1, 2, 5, 10, 30] as const;
export const FOLLOW_HIDDEN_CLOSE_MS = 60_000;
export const FOLLOW_PING_MS = 30_000;

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

  /** Lead the others from `slide`. */
  lead(slide: number): void {
    this.slide = slide;
    this.wantLead = true;
    this.takenOver = false;
    this.send({ t: "start", slide });
    this.opts.changed();
  }

  /** Stop leading. */
  unlead(): void {
    this.wantLead = false;
    this.audience = 0;
    this.send({ t: "stop" });
    this.opts.changed();
  }

  /** The deck moved to `slide`: the others follow while this socket leads. */
  moved(slide: number): void {
    this.slide = slide;
    if (this.leading) this.send({ t: "goto", slide });
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (this.ping) clearInterval(this.ping);
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
        if (!this.ws || this.leading) return;
        this.pausedHidden = true;
        const ws = this.ws;
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
          // Back after a reconnect: lead again, unless someone else leads now.
          if (f.at === null && f.you.present) this.send({ t: "start", slide: this.slide });
          else {
            this.wantLead = false;
            this.takenOver = f.at !== null;
          }
        }
        break;
      }
      case "at": {
        const mine = f.by === this.you?.id;
        if (!mine && this.wantLead && this.at?.by === this.you?.id) {
          // Another presenter started after this one: it leads now, and this one stops for good,
          // so the room never hands the lead back to it unasked.
          this.wantLead = false;
          this.takenOver = true;
          this.audience = 0;
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
          this.wantLead = false;
          this.takenOver = true;
          this.audience = 0;
          this.send({ t: "stop" });
        } else if (f.code === "forbidden") {
          this.wantLead = false;
          this.audience = 0;
        }
        break;
    }
    this.opts.changed();
  }
}

// ---------- the deck's side ----------

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface FollowOptions {
  win: Window;
  root: HTMLElement;
  deck: DeckController;
  right: "present" | "watch";
  /** For tests: makes the socket. */
  connect?: FollowClientOptions["connect"];
  random?: () => number;
}

/** The text of a presenter's Lead viewers toggle. */
export function leadLabel(leading: boolean, audience: number): string {
  if (!leading) return "Lead viewers";
  return audience === 1 ? "Leading · 1 following" : `Leading · ${audience} following`;
}

/**
 * Following and leading for one deck. `pill` is the follower's status (shown while someone else
 * leads, or after access changed); `leadButton()` makes a Lead viewers toggle for the controls and
 * one for presenter view, kept in step.
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
  private readonly unwatch: () => void;

  constructor(private readonly o: FollowOptions) {
    const doc = o.win.document;
    this.pill = el(doc, "div", "plinth-slides__follow");
    this.pill.setAttribute("role", "status");
    this.pill.dataset.plinthControl = "";
    this.pill.hidden = true;
    this.pillText = el(doc, "span", "plinth-slides__follow-text");
    this.pillButton = el(doc, "button", "plinth-slides__btn");
    this.pillButton.type = "button";
    this.pillButton.addEventListener("click", () => this.togglePause());
    this.pill.append(this.pillText, this.pillButton);
    this.client = new FollowClient({
      win: o.win,
      changed: () => this.sync(),
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

  private togglePause(): void {
    this.following = !this.following;
    this.sync();
  }

  /** The deck changed slide, by the person, the app or the leader. */
  private moved(n: number): void {
    if (this.applying) return;
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
    const c = this.client;
    const leader = c.leader;
    if (!leader) this.following = true;
    if (leader && this.following && !c.wantLead && this.o.deck.current !== leader.slide) {
      this.applying = true;
      try {
        this.o.deck.go(leader.slide);
      } finally {
        this.applying = false;
      }
    }
    const root = this.o.root;
    if (c.ended === "unauthorized") {
      this.showPill("Your access changed. Reload to keep following.", null);
    } else if (leader && !c.wantLead) {
      if (this.following) this.showPill("Following the presenter", "Stop");
      else this.showPill("", `Back to the presenter (slide ${leader.slide})`);
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
