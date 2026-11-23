// The comments panel on the artifact page: threads, replies, resolve, Markdown, anchoring through
// the review-mode bridge (or, for a page that declares `comments`, anchors the page places itself
// through usePageComments), pins over the frame, and mention task status. The API decides every
// permission; the panel shows what the comments list says the caller may do, and still reacts to
// 401 / 403 on writes.
import { ArrowClockwiseIcon, XIcon } from "@phosphor-icons/react";
import {
  API,
  APP_ROUTES,
  type ClientType,
  type CommentInfo,
  isPageAnchor,
  type PageAnchor,
  route,
} from "@plinth/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { Link, useLocation } from "../../lib/router.tsx";
import {
  EmptyPlinth,
  EmptyState,
  IconButton,
  SegmentedControl,
  SkeletonText,
  Spinner,
  showToast,
  Tooltip,
} from "../ui/index.ts";
import { askTargetInText } from "./askTargets.ts";
import {
  type BridgeClient,
  connectBridge,
  type FrameMessage,
  type PickedAnchor,
  type PinPosition,
} from "./bridge.ts";
import { Composer } from "./Composer.tsx";
import "./comments.css";
import { buildThreads, type CommentFilter, filterThreads, highlightAnchors } from "./model.ts";
import { PinLayer } from "./PinLayer.tsx";
import { Thread } from "./Thread.tsx";
import type { PageCompose, PageComposeResult } from "./usePageComments.ts";

export interface CommentsPanelProps {
  artifactId: string;
  slug: string;
  version: number;
  /** The artifact iframe, for the review-mode bridge (anchoring). */
  frame: HTMLIFrameElement | null;
  /** Content origin of the artifact (postMessage target). */
  contentOrigin: string;
  /**
   * Opaque content isolation: the frame's documents have an opaque origin, so the bridge checks
   * the frame's window instead of an origin (see comments/bridge.ts).
   */
  opaque?: boolean;
  onClose: () => void;
  /** Told the number of open threads whenever the list loads (for the toggle's count). */
  onOpenCountChange?: (n: number) => void;
  /**
   * The page declares `comments` (gate.page_comments): it anchors its own comments. No bridge is
   * connected (none is injected) and there is no "Pin to an element"; pins come from the page.
   */
  pageOwnsAnchors?: boolean;
  /** The page's latest accepted compose request (usePageComments). */
  pageCompose?: PageCompose | null;
  /** Answer a page compose request: posted, closed (chip removed, panel closed) or busy. */
  onPageComposeSettled?: (req: string, result: PageComposeResult) => void;
  /** Where the page says its anchored threads are. */
  pagePositions?: Map<string, PinPosition>;
  /** Told the comments whenever the list loads (the page hears about anchored threads). */
  onItemsChange?: (items: CommentInfo[]) => void;
  /** Told the thread the person picked in the panel or by its pin. */
  onActiveChange?: (id: string) => void;
  /** The page asked to show a thread; `n` changes for every request. */
  pageOpen?: { id: string; n: number } | null;
  /**
   * A page request opened the panel: focus stays where it was when the panel mounts, as for every
   * page request (the person clicks or tabs into the panel).
   */
  openedByPage?: boolean;
  /**
   * Ask an agent (the gate's `ask`): who a request can go to, and whether the viewer is the owner
   * (for the names). Absent: this person may not ask, and the panel has no request mode.
   */
  ask?: { targets: ClientType[]; owner: boolean };
  /**
   * Ask an agent was chosen: the composer switches to request mode. `n` changes every time;
   * `opened`: the panel was opened for it, so it closes again once the request is sent.
   */
  request?: { n: number; anchor: PageAnchor | null; opened?: boolean } | null;
  /** Read the targets again after a request was refused because its agent went away. */
  onTargetsStale?: () => Promise<ClientType[] | null>;
  /**
   * The page is edited on it (always on for owners and editors): its frame is not in review mode,
   * so no bridge is connected, and "Point at something" asks the editing frame to pick a place
   * (`start`, `stop`). The place it named arrives as `picked`: `n` changes for each, and a null
   * anchor means the person cancelled in the frame (Esc).
   */
  framePick?: {
    start: () => boolean;
    stop: () => void;
    picked: { n: number; anchor: PageAnchor | null } | null;
  };
}

/** How often to look for new comments and mention progress while the panel is open. */
export const POLL_MS = 15_000;

type Blocked = "signin" | "forbidden" | null;

const FILTERS: { value: CommentFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The anchor as the comments API takes it: a page anchor as validated, or an element. */
function anchorBody(anchor: PickedAnchor | PageAnchor) {
  if (isPageAnchor(anchor)) return anchor;
  return {
    selector: anchor.selector,
    ...(anchor.text ? { text: anchor.text } : {}),
    x: anchor.x,
    y: anchor.y,
  };
}

const NO_POSITIONS = new Map<string, PinPosition>();

export function CommentsPanel({
  artifactId,
  slug,
  version,
  frame,
  contentOrigin,
  opaque = false,
  onClose,
  onOpenCountChange,
  pageOwnsAnchors = false,
  pageCompose = null,
  onPageComposeSettled,
  pagePositions,
  onItemsChange,
  onActiveChange,
  pageOpen = null,
  openedByPage = false,
  ask,
  request = null,
  onTargetsStale,
  framePick,
}: CommentsPanelProps) {
  const { pathname, search } = useLocation();
  const [items, setItems] = useState<CommentInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CommentFilter>("open");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, PinPosition>>(() => new Map());
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<PickedAnchor | PageAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [announcement, setAnnouncement] = useState("");
  // Ask an agent: the composer in request mode, the agents it can go to, and the one chosen.
  const [requesting, setRequesting] = useState(false);
  const [targets, setTargets] = useState<ClientType[]>(ask?.targets ?? []);
  const [requestTo, setRequestTo] = useState<ClientType | null>(ask?.targets[0] ?? null);
  const askKey = ask?.targets.join(" ") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: askKey stands for ask.targets
  useEffect(() => {
    const next = ask?.targets ?? [];
    setTargets(next);
    setRequestTo((t) => (t && next.includes(t) ? t : (next[0] ?? null)));
  }, [askKey]);

  const panelRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bridgeRef = useRef<BridgeClient | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const loadingRef = useRef(false);
  const pickingRef = useRef(false);
  // The thread to scroll to once it is rendered, and whether focus moves to it (not for a page's
  // request to show it).
  const focusThreadRef = useRef<{ id: string; focus: boolean } | null>(null);
  pickingRef.current = picking;

  const ref = artifactId || slug;
  const commentsPath = route(API.comments, { ref });
  const threads = useMemo(() => buildThreads(items ?? []), [items]);
  const visible = useMemo(() => filterThreads(threads, filter), [threads, filter]);
  const openCount = useMemo(
    () => threads.filter((t) => t.root.status === "open").length,
    [threads],
  );
  const onCountRef = useRef(onOpenCountChange);
  onCountRef.current = onOpenCountChange;
  useEffect(() => {
    if (items) onCountRef.current?.(openCount);
  }, [items, openCount]);
  const onItemsRef = useRef(onItemsChange);
  onItemsRef.current = onItemsChange;
  useEffect(() => {
    if (items) onItemsRef.current?.(items);
  }, [items]);
  const anchors = useMemo(() => highlightAnchors(threads), [threads]);
  const anchorsKey = useMemo(() => JSON.stringify(anchors), [anchors]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  const announce = useCallback((text: string) => {
    // Clear first so the same words are announced again.
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  // ---------- loading and polling ----------

  const load = useCallback(
    async (opts: { manual?: boolean } = {}) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (opts.manual) setRefreshing(true);
      try {
        const res = await api<{ items: CommentInfo[]; can_comment?: boolean; signed_in?: boolean }>(
          commentsPath,
        );
        // Say up front when this person cannot comment, instead of after they typed something.
        if (res.can_comment === false) setBlocked(res.signed_in ? "forbidden" : "signin");
        const seen = seenRef.current;
        if (seen) {
          const fresh = res.items.filter((c) => !seen.has(c.id));
          if (fresh.length > 0) announce(`${plural(fresh.length, "new comment", "new comments")}`);
          else if (opts.manual) announce("No new comments");
        }
        seenRef.current = new Set(res.items.map((c) => c.id));
        setItems(res.items);
        setLoadError(null);
      } catch (e) {
        setLoadError(
          e instanceof ApiRequestError && e.status === 404
            ? "Comments are not available for this artifact."
            : "Comments could not be loaded.",
        );
      } finally {
        loadingRef.current = false;
        if (opts.manual) setRefreshing(false);
      }
    },
    [commentsPath, announce],
  );

  useEffect(() => {
    seenRef.current = null;
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // ---------- bridge ----------

  // An editing frame picks for itself (framePick); the latest handlers, for the callbacks below.
  const pickInFrame = framePick !== undefined;
  const framePickRef = useRef(framePick);
  framePickRef.current = framePick;
  useEffect(() => {
    // A page that anchors its own comments has no bridge (the gate never asks for review mode),
    // and neither has a page edited on it (its frame is never reloaded into review mode).
    if (!frame || !contentOrigin || pageOwnsAnchors || pickInFrame) return;
    const handlers = {
      onMessage(msg: FrameMessage) {
        if (msg.type === "ready") {
          // The frame (re)loaded: it lost the anchors and any pick mode.
          client.post({ type: "highlight", anchors: anchorsRef.current });
          if (pickingRef.current) client.post({ type: "pick:start" });
        } else if (msg.type === "pick") {
          // Only a pick we asked for. Anything else is ignored.
          if (!pickingRef.current) return;
          setPicking(false);
          setAnchor(msg.anchor);
          requestAnimationFrame(() => composerRef.current?.focus());
        } else if (msg.type === "positions") {
          const known = new Set(anchorsRef.current.map((a) => a.id));
          const next = new Map<string, PinPosition>();
          for (const item of msg.items) if (known.has(item.id)) next.set(item.id, item);
          setPositions(next);
        }
      },
    };
    const client = connectBridge(frame, contentOrigin, handlers, { opaque });
    bridgeRef.current = client;
    return () => {
      client.post({ type: "pick:stop" });
      client.post({ type: "highlight", anchors: [] });
      client.destroy();
      if (bridgeRef.current === client) bridgeRef.current = null;
    };
  }, [frame, contentOrigin, opaque, pageOwnsAnchors, pickInFrame]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: anchorsKey stands for anchors
  useEffect(() => {
    bridgeRef.current?.post({ type: "highlight", anchors: anchorsRef.current });
  }, [anchorsKey, frame, contentOrigin, opaque]);

  const startPick = () => {
    const inFrame = framePickRef.current;
    if (inFrame ? !inFrame.start() : !bridgeRef.current?.post({ type: "pick:start" })) return;
    setPicking(true);
  };
  const cancelPick = useCallback(() => {
    framePickRef.current?.stop();
    bridgeRef.current?.post({ type: "pick:stop" });
    setPicking(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // The editing frame named the place picked (or the person cancelled there): taken once each.
  const pickedRef = useRef<number | null>(framePick?.picked?.n ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per pick (`n`)
  useEffect(() => {
    const p = framePick?.picked;
    if (!p || pickedRef.current === p.n) return;
    pickedRef.current = p.n;
    if (!pickingRef.current) return;
    setPicking(false);
    if (p.anchor) {
      settlePage({ status: "closed" });
      setAnchor(p.anchor);
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [framePick?.picked?.n]);
  // The frame stops picking when the panel closes, or editing ends meanwhile.
  useEffect(() => {
    if (!picking || !pickInFrame) return;
    const inFrame = framePickRef.current;
    return () => inFrame?.stop();
  }, [picking, pickInFrame]);

  // Escape anywhere in the app cancels picking (focus may be outside the panel by then).
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelPick();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [picking, cancelPick]);

  // ---------- focus ----------

  // The panel takes focus when the person opened it, never when a page request did.
  const openedByPageRef = useRef(openedByPage);
  useEffect(() => {
    if (openedByPageRef.current) return;
    const el = headingRef.current;
    try {
      el?.focus({ preventScroll: true });
    } catch {
      el?.focus();
    }
  }, []);

  // After a pin click, scroll to its thread and move focus there once it is rendered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the list re-renders
  useEffect(() => {
    const target = focusThreadRef.current;
    if (!target) return;
    const el = panelRef.current?.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(target.id)}"]`,
    );
    if (!el) return;
    focusThreadRef.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!target.focus) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [visible, activeId]);

  // The person picked a thread (in the list or by its pin): the page may pan to it
  // (usePageComments sends `focus`), every time, even when it was already the active one.
  const onActiveRef = useRef(onActiveChange);
  onActiveRef.current = onActiveChange;
  const activate = useCallback((id: string) => {
    setActiveId(id);
    onActiveRef.current?.(id);
  }, []);

  const onPinClick = (id: string) => {
    if (!visible.some((t) => t.root.id === id)) setFilter("open");
    focusThreadRef.current = { id, focus: true };
    activate(id);
  };

  // ---------- comments from the page ----------

  // The page asked to show a thread: show it whatever the filter, then as a pin click, except that
  // focus stays where it was. A request that opened the panel arrives before the list has loaded,
  // so it waits for the list (once).
  const pageOpenDoneRef = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per request (`n`) and list
  useEffect(() => {
    if (!pageOpen || items === null || pageOpenDoneRef.current === pageOpen.n) return;
    pageOpenDoneRef.current = pageOpen.n;
    const t = threads.find((x) => x.root.id === pageOpen.id);
    if (!t) return;
    setFilter((f) => (f === "all" || f === t.root.status ? f : "all"));
    focusThreadRef.current = { id: pageOpen.id, focus: false };
    activate(pageOpen.id);
  }, [pageOpen?.n, items === null]);

  // A page compose request whose anchor (or unanchored composer) the panel holds, answered once.
  const pageReqRef = useRef<string | null>(null);
  const onSettledRef = useRef(onPageComposeSettled);
  onSettledRef.current = onPageComposeSettled;
  const settlePage = useCallback((result: PageComposeResult) => {
    const req = pageReqRef.current;
    if (!req) return;
    pageReqRef.current = null;
    onSettledRef.current?.(req, result);
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Another version is shown now (a live update, or the person picked one), or the page started or
  // stopped anchoring its own comments. A pin placed on the old page may mean nothing on this one,
  // so it is removed (the draft stays) and a page request it answered ends `closed`. Picking ends
  // too when the page now anchors its own comments: it has no bridge to pick with. This runs
  // before a new page request is taken (the effect below), so it never clears a fresh one.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const shownRef = useRef({ version, pageOwnsAnchors });
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per version or declaration
  useEffect(() => {
    const prev = shownRef.current;
    shownRef.current = { version, pageOwnsAnchors };
    if (prev.version === version && prev.pageOwnsAnchors === pageOwnsAnchors) return;
    if (pageOwnsAnchors) setPicking(false);
    if (!anchorRef.current && !pageReqRef.current) return;
    if (anchorRef.current) announce("The pin was removed: the page changed.");
    setAnchor(null);
    settlePage({ status: "closed" });
  }, [version, pageOwnsAnchors]);
  // Whether this person can comment is never told to the page, not even by timing: a request
  // from someone who cannot comment (the panel says "Sign in to comment") is held like any other,
  // and ends `closed` when the panel closes or a later request replaces it, as for a commenter
  // who has not written anything. Only writing (`busy`) or posting (`posted`) tells it more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per request (`req`)
  useEffect(() => {
    if (!pageCompose || pageReqRef.current === pageCompose.req) return;
    const { req } = pageCompose;
    // Someone is writing a comment: the page changes nothing.
    if (draftRef.current.trim()) {
      onSettledRef.current?.(req, { status: "busy" });
      return;
    }
    // An earlier page request that nobody wrote for yet is replaced.
    settlePage({ status: "closed" });
    pageReqRef.current = req;
    setPicking(false);
    setAnchor(pageCompose.anchor);
    // Focus stays where it was: the person clicks or tabs into the composer. Moving it there
    // while someone types in the page would send the rest of their keystrokes (and a Ctrl+Enter)
    // into a comment they never meant to write. Screen readers hear that the page asked.
    announce("The page asked for a comment.");
  }, [pageCompose?.req]);
  // Closing the panel ends it too. Deferred, so the effect re-run of React's strict mode (a
  // cleanup and a run again, on the same panel) does not end a request the panel still holds.
  const unmountRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(unmountRef.current);
    return () => {
      unmountRef.current = window.setTimeout(() => settlePage({ status: "closed" }), 0);
    };
  }, [settlePage]);
  const removeAnchor = () => {
    setAnchor(null);
    settlePage({ status: "closed" });
    composerRef.current?.focus();
  };

  // Ask an agent was chosen (once per request): request mode, with the place it named, if any.
  const requestDoneRef = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per request (`n`)
  useEffect(() => {
    if (!request || !ask || requestDoneRef.current === request.n) return;
    requestDoneRef.current = request.n;
    setRequesting(true);
    if (request.anchor) {
      settlePage({ status: "closed" });
      setPicking(false);
      setAnchor(request.anchor);
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [request?.n]);

  // ---------- writes ----------

  const writeError = (e: unknown): string | undefined => {
    if (e instanceof ApiRequestError) {
      if (e.status === 401) {
        setBlocked("signin");
        return undefined;
      }
      if (e.status === 403) {
        setBlocked("forbidden");
        return undefined;
      }
      if (e.status === 429) return "You are commenting too fast. Try again in a while.";
      if (
        e.status === 400 &&
        (e.details as { reason?: string } | undefined)?.reason === "no_agent"
      ) {
        // The agent was disconnected since the panel learned of it: read the targets again.
        void onTargetsStale?.().then((next) => {
          if (!next) return;
          setTargets(next);
          setRequestTo((t) => (t && next.includes(t) ? t : (next[0] ?? null)));
        });
        return "That agent was disconnected. Pick another, or post as a comment.";
      }
      if (e.status === 400) return e.message;
    }
    return "That did not work. Try again.";
  };

  const afterWrite = (c: CommentInfo) => {
    seenRef.current?.add(c.id);
    setItems((prev) => (prev ? [...prev.filter((p) => p.id !== c.id), c] : [c]));
    void load();
  };

  const mentionSummary = (c: CommentInfo) =>
    c.mentions.length > 0 ? ` ${c.mentions.map((m) => `${m.target} ${m.state}`).join(", ")}.` : "";

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setComposeError(undefined);
    // A request goes to the agent chosen; with no agent to take it, it is a plain comment.
    const to = requesting && targets.length > 0 ? requestTo : null;
    try {
      const created = await api<CommentInfo>(commentsPath, {
        method: "POST",
        body: {
          body,
          version_number: version,
          ...(anchor ? { anchor: anchorBody(anchor) } : {}),
          ...(to ? { request_to: to } : {}),
        },
      });
      setDraft("");
      setAnchor(null);
      setRequesting(false);
      settlePage({ status: "posted", id: created.id });
      if (requesting) {
        // A request is confirmed the way the Ask dialog confirms it: one toast. A panel opened
        // for the request closes with it.
        showToast({
          title: to
            ? `Request sent to ${askTargetInText(to, ask?.owner === true)}`
            : "Posted as a comment",
          tone: "success",
        });
        if (request?.opened) {
          onClose();
          return;
        }
      }
      if (filter === "resolved") setFilter("open");
      focusThreadRef.current = { id: created.id, focus: true };
      setActiveId(created.id);
      afterWrite(created);
      if (!requesting) announce(`Comment posted.${mentionSummary(created)}`);
    } catch (e) {
      setComposeError(writeError(e));
    } finally {
      setSending(false);
    }
  };

  const reply = async (rootId: string, body: string): Promise<boolean> => {
    try {
      const created = await api<CommentInfo>(commentsPath, {
        method: "POST",
        body: { body, parent_id: rootId, version_number: version },
      });
      afterWrite(created);
      announce(`Reply posted.${mentionSummary(created)}`);
      return true;
    } catch (e) {
      const msg = writeError(e);
      if (msg) announce(msg);
      return false;
    }
  };

  const setStatus = async (rootId: string, status: "open" | "resolved") => {
    try {
      const updated = await api<CommentInfo>(route(API.comment, { id: rootId }), {
        method: "PATCH",
        body: { status },
      });
      setItems((prev) => prev?.map((c) => (c.id === updated.id ? { ...c, status } : c)) ?? prev);
      announce(status === "resolved" ? "Thread resolved" : "Thread reopened");
      void load();
    } catch (e) {
      const msg = writeError(e);
      if (msg) announce(msg);
    }
  };

  // ---------- render ----------

  const next = pathname + (search.toString() ? `?${search.toString()}` : "");
  const loginHref = `${APP_ROUTES.login}?next=${encodeURIComponent(next)}`;
  // Ask an agent with no thread to show: the panel is just the request form, under its title.
  const requestOnly =
    requesting &&
    !picking &&
    !loadError &&
    (items === null || (filter === "open" && visible.length === 0));
  const emptyText: Record<CommentFilter, string> = {
    open: threads.length > 0 ? "No open comments." : "No comments yet.",
    resolved: "No resolved comments.",
    all: "No comments yet.",
  };

  return (
    <>
      <section
        ref={panelRef}
        className="cm-panel"
        aria-label="Comments"
        data-picking={picking || undefined}
        data-request-only={requestOnly || undefined}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          if (picking) cancelPick();
          else onClose();
        }}
      >
        <header className="cm-head">
          <div className="cm-head__row">
            <h2 ref={headingRef} tabIndex={-1} className="cm-head__title">
              {requestOnly ? "Ask an agent" : "Comments"}
            </h2>
            {items && !requestOnly && (
              <span className="cm-count" data-testid="comments-count">
                {openCount}
                <span className="visually-hidden"> open</span>
              </span>
            )}
            <span className="cm-head__tools">
              {!requestOnly && (
                <Tooltip content="Refresh comments">
                  <IconButton
                    size="sm"
                    icon={ArrowClockwiseIcon}
                    label="Refresh comments"
                    loading={refreshing}
                    onClick={() => void load({ manual: true })}
                  />
                </Tooltip>
              )}
              <Tooltip content="Close comments">
                <IconButton size="sm" icon={XIcon} label="Close comments" onClick={onClose} />
              </Tooltip>
            </span>
          </div>
          {!requestOnly && (
            <SegmentedControl
              label="Show comments"
              size="sm"
              options={FILTERS}
              value={filter}
              onChange={setFilter}
              className="cm-filter"
            />
          )}
        </header>

        <div
          className="cm-list"
          hidden={requestOnly}
          aria-busy={items === null && !loadError ? true : undefined}
        >
          {requestOnly ? null : loadError && items === null ? (
            <p className="cm-note cm-note--error" role="alert">
              {loadError}
            </p>
          ) : items === null ? (
            <div className="cm-loading">
              <Spinner size={16} label="Loading comments" />
              <SkeletonText lines={3} />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              className="cm-empty"
              headingLevel={3}
              art={<EmptyPlinth size={64} />}
              title={emptyText[filter]}
              description={
                filter === "open" && threads.length === 0 && !blocked && !requesting
                  ? pageOwnsAnchors
                    ? "Start the conversation below, or mention @claude or @codex to ask the owner's agent for a change."
                    : "Start the conversation below. Pin a comment to an element, or mention @claude or @codex to ask the owner's agent for a change."
                  : undefined
              }
            />
          ) : (
            <ol className="cm-threads">
              {visible.map((t) => (
                <li key={t.root.id}>
                  <Thread
                    thread={t}
                    slug={slug}
                    version={version}
                    active={t.root.id === activeId}
                    readOnly={blocked !== null}
                    onActivate={activate}
                    onReply={reply}
                    onSetStatus={setStatus}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="cm-foot">
          {blocked === "signin" ? (
            <p className="cm-note">
              <Link to={loginHref}>Sign in to comment</Link>
            </p>
          ) : blocked === "forbidden" ? (
            <p className="cm-note">You can view this artifact but not comment on it</p>
          ) : (
            <Composer
              value={draft}
              onChange={setDraft}
              anchor={anchor}
              onRemoveAnchor={removeAnchor}
              picking={picking}
              canPin={!!frame && !!contentOrigin}
              onStartPick={pageOwnsAnchors ? undefined : startPick}
              onCancelPick={cancelPick}
              onSubmit={() => void submit()}
              sending={sending}
              error={composeError}
              textareaRef={composerRef}
              request={
                requesting && ask
                  ? {
                      targets,
                      to: requestTo,
                      onTo: setRequestTo,
                      owner: ask.owner,
                    }
                  : undefined
              }
            />
          )}
        </footer>

        <div className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </div>
      </section>
      <PinLayer
        frame={frame}
        threads={threads}
        positions={pageOwnsAnchors ? (pagePositions ?? NO_POSITIONS) : positions}
        activeId={activeId}
        panelRef={panelRef}
        onPinClick={onPinClick}
      />
    </>
  );
}
