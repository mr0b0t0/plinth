// Comments from the page, app side: the channel to the artifact frame (pageChannel.ts) and the
// rules for what the page may ask. Mounted by the viewer stage, so it works while the comments
// panel is closed.
//
// The page may open the composer with an anchor (compose), ask to show a thread (open) and report
// where its anchors are (positions). It never posts a comment or fills in its text: the person
// writes and posts it, through the panel and the comments API with the person's own session.
// Every page request is a hint the app may refuse: compose is accepted at most once a second,
// only after the page said hello, only while the tab is visible and no dialog is open, and is
// answered exactly once (`composed`) whatever happens to it. `open` obeys the same visibility and
// dialog rules, and a request that would open a closed panel (compose or open) is accepted at
// most once a second. No page request moves focus: the person clicks or tabs into the composer,
// so keystrokes meant for the page never land in a comment. `hello` is answered at most once a
// second (each answer carries the thread list), and position reports are coalesced to 20 a second
// before they are parsed (pageChannel.ts). Positions reach React state only while the panel is
// open, the only time pins are drawn; the latest one is kept for when it opens.
import {
  type CommentInfo,
  PAGE_COMMENT_LIMITS,
  type PageAnchor,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PinPosition } from "./bridge.ts";
import { buildThreads, pageThreadItems } from "./model.ts";
import { connectPageChannel, type PageChannel, type PageFrameMessage } from "./pageChannel.ts";
import { type ReopenGate, reopenGate } from "./reopenGate.ts";

export type PageComposeResult =
  | { status: "posted"; id: string }
  | { status: "closed" }
  | { status: "busy" };

export interface PageCompose {
  req: string;
  anchor: PageAnchor | null;
}

export interface UsePageCommentsOptions {
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  opaque: boolean;
  /** The gate says the current version declares `comments` (gate.page_comments). */
  enabled: boolean;
  /** The artifact's comments (from the panel while open, else from the closed-panel fetch). */
  items: CommentInfo[] | null;
  /** A dialog is open (Share): compose and open requests are refused. */
  blocked: boolean;
  /** Whether the comments panel is open now (read when a request arrives). */
  panelOpen: () => boolean;
  /**
   * The pins are drawn (the panel is open). While false, position reports are kept aside instead
   * of re-rendering the stage, and the latest is shown when it turns true. Default true.
   */
  showPins?: boolean;
  /** An accepted compose request: open the panel with this anchor. */
  onCompose: (request: PageCompose) => void;
  /** The page asked to show this thread (a known root). */
  onOpenThread: (id: string) => void;
  /** The app window (injectable for tests). */
  win?: Window;
  /** The clock (injectable for tests). */
  now?: () => number;
}

export interface PageComments {
  /** Where the page says its anchored threads are, for the pins. */
  positions: Map<string, PinPosition>;
  /** The person picked this thread in the panel or clicked its pin: tell the page. */
  focus: (id: string) => void;
  /** Answer an accepted compose request, once. Unknown or answered requests are ignored. */
  settle: (req: string, result: PageComposeResult) => void;
}

/** `hello` is answered at most this often: each answer carries the whole thread list. */
const HELLO_MIN_INTERVAL_MS = 1000;
const NO_POSITIONS = new Map<string, PinPosition>();

export function usePageComments(opts: UsePageCommentsOptions): PageComments {
  const { frame, contentOrigin, opaque, enabled, items, blocked, win } = opts;
  const showPins = opts.showPins !== false;
  const [positions, setPositions] = useState<Map<string, PinPosition>>(NO_POSITIONS);
  const channelRef = useRef<PageChannel | null>(null);
  const helloRef = useRef(false);
  const lastHelloRef = useRef(Number.NEGATIVE_INFINITY);
  const pendingRef = useRef<Set<string>>(new Set());
  const lastComposeRef = useRef(Number.NEGATIVE_INFINITY);
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY);
  const reopenRef = useRef<ReopenGate>(reopenGate());
  // The latest reported positions, whether or not they are shown yet.
  const latestPositionsRef = useRef<Map<string, PinPosition>>(NO_POSITIONS);
  const showPinsRef = useRef(showPins);
  showPinsRef.current = showPins;

  const threads = useMemo(() => buildThreads(items ?? []), [items]);
  const payload = useMemo(() => pageThreadItems(threads), [threads]);
  const payloadKey = useMemo(() => JSON.stringify(payload), [payload]);
  // Latest values for the message handler, which is set up once per frame.
  const live = useRef({ enabled, blocked, payload, threads, opts });
  live.current = { enabled, blocked, payload, threads, opts };

  const now = useCallback(() => (live.current.opts.now ?? Date.now)(), []);

  // The panel opened: show the latest positions the page reported while it was closed.
  useEffect(() => {
    if (showPins) setPositions(latestPositionsRef.current);
  }, [showPins]);

  useEffect(() => {
    helloRef.current = false;
    lastHelloRef.current = Number.NEGATIVE_INFINITY;
    pendingRef.current = new Set();
    latestPositionsRef.current = NO_POSITIONS;
    setPositions(NO_POSITIONS);
    if (!frame || !contentOrigin) return;
    const onMessage = (msg: PageFrameMessage) => {
      const cur = live.current;
      const doc = (cur.opts.win ?? window).document;
      // A request that would open the panel the person closed: at most one a second, compose and
      // open together. Taking the slot is the caller's job, once the request is accepted.
      const reopenRefused = (t: number) => reopenRef.current.refused(t, !cur.opts.panelOpen());
      const takeReopen = (t: number) => reopenRef.current.take(t, !cur.opts.panelOpen());
      switch (msg.type) {
        case "hello": {
          // The runtime says hello again only while unanswered, once a second: one answer a
          // second is enough for it, and bounds what a page that floods hellos makes the app send.
          const t = now();
          if (t - lastHelloRef.current < HELLO_MIN_INTERVAL_MS) return;
          lastHelloRef.current = t;
          helloRef.current = true;
          channel.post({ type: "welcome", available: cur.enabled });
          if (cur.enabled) channel.post({ type: "threads", items: cur.payload });
          return;
        }
        case "compose": {
          const refuse = () => channel.post({ type: "composed", req: msg.req, status: "closed" });
          if (!cur.enabled || !helloRef.current || cur.blocked) return void refuse();
          if (doc.visibilityState !== "visible") return void refuse();
          if (pendingRef.current.has(msg.req)) return;
          const t = now();
          if (t - lastComposeRef.current < PAGE_COMMENT_LIMITS.composeMinIntervalMs) {
            return void refuse();
          }
          if (reopenRefused(t)) return void refuse();
          lastComposeRef.current = t;
          takeReopen(t);
          pendingRef.current.add(msg.req);
          cur.opts.onCompose({ req: msg.req, anchor: msg.anchor });
          return;
        }
        case "open": {
          if (!cur.enabled || !helloRef.current || cur.blocked) return;
          if (doc.visibilityState !== "visible") return;
          if (!cur.threads.some((th) => th.root.id === msg.id)) return;
          const t = now();
          if (t - lastOpenRef.current < PAGE_COMMENT_LIMITS.openMinIntervalMs) return;
          if (reopenRefused(t)) return;
          lastOpenRef.current = t;
          takeReopen(t);
          cur.opts.onOpenThread(msg.id);
          return;
        }
        case "positions": {
          // Already at most 20 a second, the latest kept (pageChannel.ts).
          if (!cur.enabled || !helloRef.current) return;
          // Only threads the app told the page about, open and anchored.
          const known = new Set(cur.payload.filter((p) => p.status === "open").map((p) => p.id));
          const next = new Map<string, PinPosition>();
          for (const item of msg.items) if (known.has(item.id)) next.set(item.id, item);
          latestPositionsRef.current = next;
          if (showPinsRef.current) setPositions(next);
          return;
        }
      }
    };
    const channel = connectPageChannel(frame, contentOrigin, onMessage, { opaque, win, now });
    channelRef.current = channel;
    return () => {
      // Anything still open is answered: the frame is going away or the page changed.
      for (const req of pendingRef.current) {
        channel.post({ type: "composed", req, status: "closed" });
      }
      pendingRef.current = new Set();
      channel.destroy();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [frame, contentOrigin, opaque, win, now]);

  // The anchored threads changed: tell the page (only after it said hello).
  // biome-ignore lint/correctness/useExhaustiveDependencies: payloadKey stands for payload
  useEffect(() => {
    if (!enabled || !helloRef.current) return;
    channelRef.current?.post({ type: "threads", items: live.current.payload });
  }, [payloadKey, enabled]);

  const focus = useCallback(
    (id: string) => {
      if (!enabled || !helloRef.current) return;
      if (!live.current.payload.some((p) => p.id === id && p.anchor.kind === "page")) return;
      channelRef.current?.post({ type: "focus", id });
    },
    [enabled],
  );

  const settle = useCallback((req: string, result: PageComposeResult) => {
    if (!pendingRef.current.delete(req)) return;
    channelRef.current?.post({ type: "composed", req, ...result });
  }, []);

  return { positions, focus, settle };
}

export interface StagePageCommentsOptions {
  gate: Extract<ViewGate, { status: "ok" }>;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  opaque: boolean;
  items: CommentInfo[] | null;
  /** A dialog is open over the stage. */
  blocked: boolean;
  commentsOpen: boolean;
  /** Open the comments panel (it is closed). */
  openComments: () => void;
}

/** What the viewer stage hands the comments panel for comments from the page. */
export interface StagePageComments {
  pageOwnsAnchors: boolean;
  pageCompose: PageCompose | null;
  onPageComposeSettled: (req: string, result: PageComposeResult) => void;
  pagePositions: Map<string, PinPosition>;
  onActiveChange: (id: string) => void;
  pageOpen: { id: string; n: number } | null;
  /** A page request opened the panel: it must not take focus when it mounts. */
  openedByPage: boolean;
}

/**
 * The viewer stage's side of comments from the page: the channel, plus the panel state a page
 * request sets (open the panel with an anchor, show a thread). Its result is spread into the
 * panel's props.
 */
export function useStagePageComments(o: StagePageCommentsOptions): StagePageComments {
  const enabled = o.gate.page_comments === true && o.gate.artifact.type === "html";
  const [pageCompose, setPageCompose] = useState<PageCompose | null>(null);
  const [pageOpen, setPageOpen] = useState<{ id: string; n: number } | null>(null);
  const [openedByPage, setOpenedByPage] = useState(false);
  const openRef = useRef(o.commentsOpen);
  openRef.current = o.commentsOpen;
  const openComments = o.openComments;
  const ensureOpen = useCallback(() => {
    if (openRef.current) return;
    openRef.current = true;
    setOpenedByPage(true);
    openComments();
  }, [openComments]);
  const panelOpen = useCallback(() => openRef.current, []);
  const page = usePageComments({
    frame: o.frame,
    contentOrigin: o.contentOrigin,
    opaque: o.opaque,
    enabled,
    items: o.items,
    blocked: o.blocked,
    panelOpen,
    showPins: o.commentsOpen,
    onCompose: (request) => {
      setPageCompose(request);
      ensureOpen();
    },
    onOpenThread: (id) => {
      setPageOpen((p) => ({ id, n: (p?.n ?? 0) + 1 }));
      ensureOpen();
    },
  });
  const { settle } = page;
  const onPageComposeSettled = useCallback(
    (req: string, result: PageComposeResult) => {
      settle(req, result);
      setPageCompose((p) => (p?.req === req ? null : p));
    },
    [settle],
  );
  // A request to show a thread is for the panel that is open now, not for a later one.
  // Likewise whether a page request opened it: the person opening it later moves focus as usual.
  useEffect(() => {
    if (o.commentsOpen) return;
    setPageOpen(null);
    setOpenedByPage(false);
  }, [o.commentsOpen]);
  return {
    pageOwnsAnchors: enabled,
    pageCompose,
    onPageComposeSettled,
    pagePositions: page.positions,
    onActiveChange: page.focus,
    pageOpen,
    openedByPage,
  };
}
