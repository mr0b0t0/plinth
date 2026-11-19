// Following the presenter (docs/spec.md "Slides", docs/security.md#live-rooms): a deck's `slides`
// channel in the artifact's room. Plinth's own code, like the doc channel: no page script runs on a
// deck's origin, and the channel carries slide numbers and nothing else.
//
// Rules it keeps:
// - Only a socket with the `present` right (owners and editors, stamped by the gate from policy.ts
//   slidesRoomAccess) may send `start`, `goto` or `stop`. Everyone else may send nothing but the
//   text `ping`; anything else is `forbidden` and counts against the socket's rate.
// - The last socket to `start` leads, and every socket, the new leader included, gets its `at`.
//   A `goto` from any other socket is `not_leading`.
// - Positions carry the leading socket's random id, never an email, a role or a viewer id.
// - Nothing is stored: a presenter's position lives in its own hibernation attachment, so a late
//   joiner's welcome carries it, and when the leader leaves the next presenter (the latest other
//   `start`) leads, or everyone gets `stopped`.
// - The leading presenter alone gets `audience`: how many other people (distinct viewer ids, its
//   own excluded) have the deck open on this channel. Watchers learn nothing about each other.
import type { RoomSlidesRight, SlidesClientFrame, SlidesServerFrame } from "@plinth/shared";

/** What the channel reads and writes on a socket's attachment. */
export interface SlidesSocketState {
  /** Random per socket (`s_…`); the only thing other sockets learn about it. */
  id: string;
  /** The per-artifact `u_` viewer id: counts the audience, never sent. */
  viewer: string;
  slides?: RoomSlidesRight;
  /** Set while this socket presents: its slide, and when it started (the latest leads). */
  presenting?: { slide: number; since: number } | null;
}

export interface SlidesHost<S extends SlidesSocketState> {
  /** The open `k:slides` sockets this room has not closed, with their state. */
  sockets(): { ws: WebSocket; s: S }[];
  send(ws: WebSocket, frame: SlidesServerFrame): void;
  /** Store a socket's state in its attachment; false when it does not fit. */
  save(ws: WebSocket, s: S): boolean;
}

/** What `message` did: the room counts a refused frame against the socket's rate. */
export type SlidesOutcome = "ok" | "refused";

export class SlidesChannel<S extends SlidesSocketState> {
  constructor(private readonly host: SlidesHost<S>) {}

  /**
   * The leading presenter: the presenting socket with the latest `since` (then the larger id),
   * leaving out `except` (a socket that is closing, which the platform may still list).
   */
  leader(except: WebSocket | null = null): { ws: WebSocket; s: S } | null {
    let best: { ws: WebSocket; s: S } | null = null;
    for (const c of this.host.sockets()) {
      if (c.ws === except || !c.s.presenting || c.s.slides !== "present") continue;
      if (!best || beats(c.s, best.s)) best = c;
    }
    return best;
  }

  /** A new socket: its welcome, with the leader's position; the leader learns the audience. */
  welcome(ws: WebSocket, s: S): void {
    const lead = this.leader();
    this.host.send(ws, {
      t: "welcome",
      v: 1,
      you: { id: s.id, present: s.slides === "present" },
      at: lead?.s.presenting ? { slide: lead.s.presenting.slide, by: lead.s.id } : null,
    });
    this.tellAudience(lead, null);
  }

  message(ws: WebSocket, s: S, f: SlidesClientFrame | null, now: number): SlidesOutcome {
    if (s.slides !== "present") {
      this.host.send(ws, { t: "error", code: "forbidden" });
      return "refused";
    }
    if (!f) {
      this.host.send(ws, { t: "error", code: "invalid" });
      return "refused";
    }
    switch (f.t) {
      case "start": {
        // Strictly after every other start, so the newest presenter always leads.
        let since = now;
        for (const c of this.host.sockets()) {
          const p = c.s.presenting;
          if (p && c.ws !== ws && p.since >= since) since = p.since + 1;
        }
        const was = s.presenting ?? null;
        s.presenting = { slide: f.slide, since };
        if (!this.host.save(ws, s)) {
          s.presenting = was;
          this.host.send(ws, { t: "error", code: "invalid" });
          return "refused";
        }
        // Everyone, the new leader included: its own `at` confirms that it leads.
        this.broadcastAt({ ws, s }, null);
        this.tellAudience({ ws, s }, null);
        return "ok";
      }
      case "goto": {
        const lead = this.leader();
        if (!lead || lead.ws !== ws || !s.presenting) {
          this.host.send(ws, { t: "error", code: "not_leading" });
          return "ok";
        }
        if (s.presenting.slide === f.slide) return "ok";
        s.presenting = { slide: f.slide, since: s.presenting.since };
        this.host.save(ws, s);
        this.broadcastAt({ ws, s }, ws);
        return "ok";
      }
      case "stop": {
        if (!s.presenting) return "ok";
        const wasLeader = this.leader()?.ws === ws;
        s.presenting = null;
        this.host.save(ws, s);
        // The one who stopped hears the next leader too: it follows now.
        if (wasLeader) this.handOver(null, ws);
        return "ok";
      }
    }
  }

  /**
   * A socket left (closed by the client or by the room). A leader hands over to the next
   * presenter, or everyone gets `stopped`; otherwise the leader learns the new audience. The
   * leaving socket is left out by hand, whether or not the platform still lists it.
   */
  left(ws: WebSocket, s: S): void {
    const next = this.leader(ws);
    const wasLeader = s.slides === "present" && !!s.presenting && (!next || beats(s, next.s));
    if (wasLeader) this.handOver(ws, ws);
    else this.tellAudience(next, ws);
  }

  /**
   * After the leader stopped or left: the next presenter's position, or `stopped`, to every socket
   * but `except`. `gone` (the old leader) never leads or counts.
   */
  private handOver(except: WebSocket | null, gone: WebSocket): void {
    const next = this.leader(gone);
    if (next?.s.presenting) {
      this.broadcastAt(next, except);
      this.tellAudience(next, gone === except ? gone : null);
      return;
    }
    for (const c of this.host.sockets()) {
      if (c.ws !== except) this.host.send(c.ws, { t: "stopped" });
    }
  }

  /** `at` from `lead` to every socket but `except`. */
  private broadcastAt(lead: { ws: WebSocket; s: S }, except: WebSocket | null): void {
    const p = lead.s.presenting;
    if (!p) return;
    for (const c of this.host.sockets()) {
      if (c.ws !== except) this.host.send(c.ws, { t: "at", slide: p.slide, by: lead.s.id });
    }
  }

  /** How many other people have the deck open, to the leader only; `gone` is not counted. */
  private tellAudience(lead: { ws: WebSocket; s: S } | null, gone: WebSocket | null): void {
    if (!lead) return;
    this.host.send(lead.ws, { t: "audience", n: this.audience(lead.s.viewer, gone) });
  }

  /** Distinct viewer ids on the channel, leaving out the leader's own and `gone`'s socket. */
  audience(leaderViewer: string, gone: WebSocket | null = null): number {
    const viewers = new Set<string>();
    for (const c of this.host.sockets()) {
      if (c.ws !== gone && c.s.viewer !== leaderViewer) viewers.add(c.s.viewer);
    }
    return viewers.size;
  }
}

/** Whether presenter `a` started after `b` (on a tie, the larger socket id), so `a` leads. */
function beats(a: SlidesSocketState, b: SlidesSocketState): boolean {
  const x = a.presenting?.since ?? -1;
  const y = b.presenting?.since ?? -1;
  return x > y || (x === y && a.id > b.id);
}
