// Live views (docs/spec.md "Live views"): the artifact page holds one receive-only WebSocket on the
// app host (GET /api/v1/view/:id/watch, subprotocol plinth.view.v1) while the gate says `watch`,
// and learns of a new version, or of a change to the page's shared data, as it happens. The socket
// carries only version numbers and change signals; on a `version` the page re-reads its own gate,
// exactly as its poll does, and on `data` it tells the frame's runtime to re-read its data through
// the shared-data API. Each signal waits a random time up to the room's `spread_ms`, so a large
// audience does not ask at once. The gate poll stays as a slow backstop; without the socket
// (refused, full, dropped, no WebSocket) the page polls as before.
import {
  API,
  LIVE_VIEW_LIMITS,
  ROOM_CLOSE,
  readViewWatchFrame,
  route,
  VIEW_MESSAGE_SOURCE,
  VIEW_MESSAGE_VERSION,
  VIEW_WATCH_PROTOCOL,
  type ViewFrameMessage,
  type ViewGate,
} from "@plinth/shared";
import { useEffect, useRef, useState } from "react";
import { targetOriginFor } from "../comments/frameGuard.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** off: no socket (not offered, or a hidden tab); open: signals are pushed; fallback: polling. */
export type LiveViewStatus = "off" | "connecting" | "open" | "fallback";

export interface LiveViewHandlers {
  /** A version newer than the one on view exists: re-read the gate now. */
  onVersion: (n: number) => void;
  /** The page's shared data changed (or the socket just opened): the frame re-reads it. */
  onData: () => void;
  /** Access changed (a sharing change): re-read the gate, which may now refuse. */
  onAccessChanged: () => void;
  /** The artifact was deleted or taken down. */
  onGone: () => void;
  onStatus: (status: LiveViewStatus) => void;
  /** The current version as the page knows it. */
  current: () => number;
}

interface Deps {
  WebSocket?: typeof WebSocket;
  random?: () => number;
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

/** The watch socket's URL on the app's own host. */
export function watchUrl(loc: Pick<Location, "protocol" | "host">, artifactId: string): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/api/v1${route(API.viewWatch, { ref: artifactId })}`;
}

/** Close codes after which the page polls for a while before trying the socket again. */
const REFUSED: ReadonlySet<number> = new Set([
  ROOM_CLOSE.full,
  ROOM_CLOSE.rate,
  ROOM_CLOSE.invalid,
  ROOM_CLOSE.forbidden,
]);

/** One page's watch socket: connects, reconnects, pings, and closes while the tab is hidden. */
export class LiveViewConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private hiddenClosed = false;
  private failures = 0;
  private status: LiveViewStatus = "off";
  private readonly timers = new Map<"ping" | "retry" | "hidden" | "version" | "data", number>();
  private pendingVersion = 0;
  private readonly Ws: typeof WebSocket | undefined;
  private readonly random: () => number;
  private readonly doc: NonNullable<Deps["doc"]>;

  constructor(
    private readonly url: string,
    private readonly on: LiveViewHandlers,
    deps: Deps = {},
  ) {
    // `WebSocket: undefined` given on purpose means none (tests); left out, the browser's.
    this.Ws =
      "WebSocket" in deps
        ? deps.WebSocket
        : typeof WebSocket === "undefined"
          ? undefined
          : WebSocket;
    this.random = deps.random ?? Math.random;
    this.doc = deps.doc ?? document;
  }

  start(): void {
    if (!this.Ws) {
      this.setStatus("fallback");
      return;
    }
    this.doc.addEventListener("visibilitychange", this.onVisibility);
    if (this.doc.visibilityState === "visible") this.connect();
    else this.hiddenClosed = true;
  }

  stop(): void {
    this.stopped = true;
    this.doc.removeEventListener("visibilitychange", this.onVisibility);
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.close();
  }

  private setStatus(s: LiveViewStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.on.onStatus(s);
  }

  private later(key: "ping" | "retry" | "hidden" | "version" | "data", ms: number, fn: () => void) {
    this.clear(key);
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
  }

  private clear(key: "ping" | "retry" | "hidden" | "version" | "data"): void {
    const t = this.timers.get(key);
    if (t !== undefined) window.clearTimeout(t);
    this.timers.delete(key);
  }

  private close(): void {
    const ws = this.ws;
    this.ws = null;
    this.clear("ping");
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // Already closing.
    }
  }

  private connect(): void {
    if (this.stopped || !this.Ws || this.ws) return;
    this.clear("retry");
    // While it reconnects after a failure the page keeps polling (fallback).
    if (this.status !== "fallback") this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new this.Ws(this.url, VIEW_WATCH_PROTOCOL);
    } catch {
      this.failed();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => this.message(e.data);
    ws.onclose = (e) => this.closed(ws, e.code, e.reason);
  }

  private ping = (): void => {
    try {
      this.ws?.send("ping");
    } catch {
      // Closing; its close handler reconnects.
    }
    this.later("ping", LIVE_VIEW_LIMITS.pingIntervalS * 1000, this.ping);
  };

  private message(raw: unknown): void {
    const f = readViewWatchFrame(raw);
    if (!f) return;
    if (f.t === "welcome") {
      this.failures = 0;
      this.setStatus("open");
      this.later("ping", LIVE_VIEW_LIMITS.pingIntervalS * 1000, this.ping);
      // A version published while disconnected; then the frame re-reads its data once.
      if (f.version > this.on.current()) this.on.onVersion(f.version);
      this.on.onData();
      return;
    }
    if (f.t === "version") {
      if (f.version <= this.on.current()) return;
      // While one is pending, later ones join it.
      this.pendingVersion = Math.max(this.pendingVersion, f.version);
      if (this.timers.has("version")) return;
      this.spread("version", f.spread_ms, () => {
        const n = this.pendingVersion;
        this.pendingVersion = 0;
        if (n > this.on.current()) this.on.onVersion(n);
      });
      return;
    }
    if (this.timers.has("data")) return;
    this.spread("data", f.spread_ms, () => this.on.onData());
  }

  /**
   * Act after random(0, spread_ms). A small audience (a spread under spreadAtOnceMs) acts at
   * once: a few requests at the same moment are no load to spread.
   */
  private spread(key: "version" | "data", spreadMs: number, fn: () => void): void {
    if (spreadMs < LIVE_VIEW_LIMITS.spreadAtOnceMs) {
      fn();
      return;
    }
    this.later(key, Math.floor(this.random() * spreadMs), fn);
  }

  private closed(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clear("ping");
    if (this.stopped) return;
    if (code === ROOM_CLOSE.gone) {
      this.stopped = true;
      this.setStatus("off");
      this.on.onGone();
      return;
    }
    if (code === ROOM_CLOSE.unauthorized) {
      // The socket's lifetime ended: reconnect, which re-authorizes. Otherwise access changed:
      // the page re-reads its gate first, which may now refuse (and then this connection stops).
      this.setStatus("fallback");
      if (reason !== "expired") this.on.onAccessChanged();
      this.later("retry", this.backoff(), () => this.connect());
      return;
    }
    if (REFUSED.has(code)) {
      this.setStatus("fallback");
      this.later("retry", LIVE_VIEW_LIMITS.refusedRetryS * 1000, () => this.connect());
      return;
    }
    this.failed();
  }

  /** A dropped or refused handshake (the browser cannot tell which): poll, and back off. */
  private failed(): void {
    this.ws = null;
    this.setStatus("fallback");
    this.later("retry", this.backoff(), () => this.connect());
  }

  /** The next reconnect delay, with jitter; after the list is used up, the refused-retry pace. */
  private backoff(): number {
    const steps = LIVE_VIEW_LIMITS.backoffS;
    const i = this.failures++;
    const s = i < steps.length ? (steps[i] ?? 30) : LIVE_VIEW_LIMITS.refusedRetryS;
    return Math.round(s * 1000 * (0.75 + this.random() * 0.5));
  }

  private onVisibility = (): void => {
    if (this.stopped) return;
    if (this.doc.visibilityState === "visible") {
      this.clear("hidden");
      if (this.hiddenClosed) {
        this.hiddenClosed = false;
        this.failures = 0;
        this.connect();
      }
      return;
    }
    this.later("hidden", LIVE_VIEW_LIMITS.hiddenCloseS * 1000, () => {
      this.hiddenClosed = true;
      this.clear("retry");
      this.close();
      this.setStatus("off");
    });
  };
}

/**
 * The page's watch socket while `gate` offers one (`gate.watch`). Reconnects when the artifact
 * changes, or when a new gate shows shared data the socket was opened without (the room grants
 * the data right only at the handshake). Returns the socket's status.
 */
export function useLiveView(opts: {
  gate: OkGate | null;
  onVersion: (n: number) => void;
  onData: () => void;
  onAccessChanged: () => void;
  onGone: () => void;
}): LiveViewStatus {
  const [status, setStatus] = useState<LiveViewStatus>("off");
  const latest = useRef(opts);
  latest.current = opts;
  const id = opts.gate?.watch ? opts.gate.artifact.id : null;
  const withData = opts.gate?.data !== undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a gate that gains `data` reconnects
  useEffect(() => {
    if (!id) return;
    const conn = new LiveViewConnection(watchUrl(window.location, id), {
      onVersion: (n) => latest.current.onVersion(n),
      onData: () => latest.current.onData(),
      onAccessChanged: () => latest.current.onAccessChanged(),
      onGone: () => latest.current.onGone(),
      onStatus: setStatus,
      current: () => latest.current.gate?.artifact.current_version ?? 0,
    });
    conn.start();
    return () => {
      conn.stop();
      setStatus("off");
    };
  }, [id, withData]);

  return id ? status : "off";
}

/** The message that tells the frame's runtime something, built only for an exact origin. */
export function viewFrameMessage(
  m: { type: "data" } | { type: "push"; on: boolean },
): ViewFrameMessage {
  return { source: VIEW_MESSAGE_SOURCE, v: VIEW_MESSAGE_VERSION, ...m };
}

/**
 * Hands live-view signals to the artifact frame's runtime (runtime/live.ts): `data` each time
 * `dataTick` moves, and `push` (whether signals are pushed) on every change and every frame load.
 * Only under origin isolation with shared data available, and only at the exact content origin,
 * never "*": under opaque isolation there is no shared data, so nothing is posted.
 */
export function useLiveDataRelay(opts: {
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  enabled: boolean;
  pushed: boolean;
  dataTick: number;
}): void {
  const { frame, contentOrigin, enabled, pushed, dataTick } = opts;
  const target = enabled ? targetOriginFor(contentOrigin, false) : null;

  const post = (m: ViewFrameMessage) => {
    if (!frame || !target) return;
    try {
      frame.contentWindow?.postMessage(m, target);
    } catch {
      // The frame is navigating; the next load posts again.
    }
  };
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => {
    if (!frame || !target) return;
    const onLoad = () => postRef.current(viewFrameMessage({ type: "push", on: pushed }));
    onLoad();
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [frame, target, pushed]);

  const seen = useRef(dataTick);
  useEffect(() => {
    if (seen.current === dataTick) return;
    seen.current = dataTick;
    postRef.current(viewFrameMessage({ type: "data" }));
  }, [dataTick]);
}
