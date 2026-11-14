// The comments panel on the artifact page: threads, replies, resolve, Markdown, anchoring through
// the review-mode bridge, pins over the frame, and mention task status. The API decides every
// permission; the panel shows what the comments list says the caller may do, and still reacts to
// 401 / 403 on writes.
import { ArrowClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, type CommentInfo, route } from "@plinth/shared";
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
  Tooltip,
} from "../ui/index.ts";
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

export function CommentsPanel({
  artifactId,
  slug,
  version,
  frame,
  contentOrigin,
  opaque = false,
  onClose,
  onOpenCountChange,
}: CommentsPanelProps) {
  const { pathname, search } = useLocation();
  const [items, setItems] = useState<CommentInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CommentFilter>("open");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, PinPosition>>(() => new Map());
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<PickedAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [announcement, setAnnouncement] = useState("");

  const panelRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bridgeRef = useRef<BridgeClient | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const loadingRef = useRef(false);
  const pickingRef = useRef(false);
  const focusThreadRef = useRef<string | null>(null);
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
  const anchors = useMemo(() => highlightAnchors(threads), [threads]);
  const anchorsKey = JSON.stringify(anchors);
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

  useEffect(() => {
    if (!frame || !contentOrigin) return;
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
  }, [frame, contentOrigin, opaque]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: anchorsKey stands for anchors
  useEffect(() => {
    bridgeRef.current?.post({ type: "highlight", anchors: anchorsRef.current });
  }, [anchorsKey, frame, contentOrigin, opaque]);

  const startPick = () => {
    if (!bridgeRef.current?.post({ type: "pick:start" })) return;
    setPicking(true);
  };
  const cancelPick = useCallback(() => {
    bridgeRef.current?.post({ type: "pick:stop" });
    setPicking(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

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

  useEffect(() => {
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
    const id = focusThreadRef.current;
    if (!id) return;
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`);
    if (!el) return;
    focusThreadRef.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [visible, activeId]);

  const onPinClick = (id: string) => {
    if (!visible.some((t) => t.root.id === id)) setFilter("open");
    focusThreadRef.current = id;
    setActiveId(id);
  };

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
    try {
      const created = await api<CommentInfo>(commentsPath, {
        method: "POST",
        body: {
          body,
          version_number: version,
          ...(anchor
            ? {
                anchor: {
                  selector: anchor.selector,
                  ...(anchor.text ? { text: anchor.text } : {}),
                  x: anchor.x,
                  y: anchor.y,
                },
              }
            : {}),
        },
      });
      setDraft("");
      setAnchor(null);
      if (filter === "resolved") setFilter("open");
      focusThreadRef.current = created.id;
      setActiveId(created.id);
      afterWrite(created);
      announce(`Comment posted.${mentionSummary(created)}`);
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
              Comments
            </h2>
            {items && (
              <span className="cm-count" data-testid="comments-count">
                {openCount}
                <span className="visually-hidden"> open</span>
              </span>
            )}
            <span className="cm-head__tools">
              <Tooltip content="Refresh comments">
                <IconButton
                  size="sm"
                  icon={ArrowClockwiseIcon}
                  label="Refresh comments"
                  loading={refreshing}
                  onClick={() => void load({ manual: true })}
                />
              </Tooltip>
              <Tooltip content="Close comments">
                <IconButton size="sm" icon={XIcon} label="Close comments" onClick={onClose} />
              </Tooltip>
            </span>
          </div>
          <SegmentedControl
            label="Show comments"
            size="sm"
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            className="cm-filter"
          />
        </header>

        <div className="cm-list" aria-busy={items === null && !loadError ? true : undefined}>
          {loadError && items === null ? (
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
                filter === "open" && threads.length === 0 && !blocked
                  ? "Start the conversation below. Pin a comment to an element, or mention @claude or @codex to ask the owner's agent for a change."
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
                    onActivate={setActiveId}
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
              onRemoveAnchor={() => {
                setAnchor(null);
                composerRef.current?.focus();
              }}
              picking={picking}
              canPin={!!frame && !!contentOrigin}
              onStartPick={startPick}
              onCancelPick={cancelPick}
              onSubmit={() => void submit()}
              sending={sending}
              error={composeError}
              textareaRef={composerRef}
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
        positions={positions}
        activeId={activeId}
        panelRef={panelRef}
        onPinClick={onPinClick}
      />
    </>
  );
}
