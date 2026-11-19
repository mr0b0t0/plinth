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
// so keystrokes meant for the page never land in a comment.
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

const POSITIONS_WINDOW_MS = 1000;

export function usePageComments(opts: UsePageCommentsOptions): PageComments {
  const { frame, contentOrigin, opaque, enabled, items, blocked, win } = opts;
  const [positions, setPositions] = useState<Map<string, PinPosition>>(() => new Map());
  const channelRef = useRef<PageChannel | null>(null);
  const helloRef = useRef(false);
  const pendingRef = useRef<Set<string>>(new Set());
  const lastComposeRef = useRef(Number.NEGATIVE_INFINITY);
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY);
  const lastReopenRef = useRef(Number.NEGATIVE_INFINITY);
  const positionTimesRef = useRef<number[]>([]);

  const threads = useMemo(() => buildThreads(items ?? []), [items]);
  const payload = useMemo(() => pageThreadItems(threads), [threads]);
  const payloadKey = JSON.stringify(payload);
  // Latest values for the message handler, which is set up once per frame.
  const live = useRef({ enabled, blocked, payload, threads, opts });
  live.current = { enabled, blocked, payload, threads, opts };

  const now = useCallback(() => (live.current.opts.now ?? Date.now)(), []);

  useEffect(() => {
    helloRef.current = false;
    pendingRef.current = new Set();
    setPositions(new Map());
    if (!frame || !contentOrigin) return;
    const onMessage = (msg: PageFrameMessage) => {
      const cur = live.current;
      const doc = (cur.opts.win ?? window).document;
      // A request that would open the panel the person closed: at most one a second, compose and
      // open together. Taking the slot is the caller's job, once the request is accepted.
      const reopenRefused = (t: number) =>
        !cur.opts.panelOpen() &&
        t - lastReopenRef.current < PAGE_COMMENT_LIMITS.reopenMinIntervalMs;
      const takeReopen = (t: number) => {
        if (!cur.opts.panelOpen()) lastReopenRef.current = t;
      };
      switch (msg.type) {
        case "hello":
          helloRef.current = true;
          channel.post({ type: "welcome", available: cur.enabled });
          if (cur.enabled) channel.post({ type: "threads", items: cur.payload });
          return;
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
          if (!cur.enabled || !helloRef.current) return;
          const t = now();
          const recent = positionTimesRef.current.filter((x) => t - x < POSITIONS_WINDOW_MS);
          if (recent.length >= PAGE_COMMENT_LIMITS.positionsPerSecond) {
            positionTimesRef.current = recent;
            return;
          }
          positionTimesRef.current = [...recent, t];
          // Only threads the app told the page about, open and anchored.
          const known = new Set(cur.payload.filter((p) => p.status === "open").map((p) => p.id));
          const next = new Map<string, PinPosition>();
          for (const item of msg.items) if (known.has(item.id)) next.set(item.id, item);
          setPositions(next);
          return;
        }
      }
    };
    const channel = connectPageChannel(frame, contentOrigin, onMessage, { opaque, win });
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
