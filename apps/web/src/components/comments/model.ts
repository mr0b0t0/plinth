// Pure helpers for the comments panel: threads, filters, pin numbers, dates, @ suggestions.
import type { CommentInfo } from "@plinth/shared";

export type CommentFilter = "open" | "resolved" | "all";

export interface Thread {
  root: CommentInfo;
  replies: CommentInfo[];
  /** 1-based pin number when the root is anchored, else null. Stable across filters. */
  pin: number | null;
}

/**
 * Group the API's flat list into threads, oldest first. The API already orders each root before
 * its replies; replies whose root is missing are dropped (it cannot happen, but never crash).
 */
export function buildThreads(items: CommentInfo[]): Thread[] {
  const roots: Thread[] = [];
  const byId = new Map<string, Thread>();
  for (const c of items) {
    if (!c.parent_id) {
      const t: Thread = { root: c, replies: [], pin: null };
      roots.push(t);
      byId.set(c.id, t);
    }
  }
  for (const c of items) {
    if (c.parent_id) byId.get(c.parent_id)?.replies.push(c);
  }
  roots.sort((a, b) => a.root.created_at.localeCompare(b.root.created_at));
  let n = 0;
  for (const t of roots) {
    if (t.root.anchor) {
      n += 1;
      t.pin = n;
    }
  }
  return roots;
}

export function filterThreads(threads: Thread[], filter: CommentFilter): Thread[] {
  if (filter === "all") return threads;
  return threads.filter((t) => t.root.status === filter);
}

/** Anchors to highlight in the frame: open, anchored threads. */
export function highlightAnchors(threads: Thread[]): { id: string; selector: string }[] {
  return threads
    .filter((t) => t.root.status === "open" && t.root.anchor?.selector)
    .map((t) => ({ id: t.root.id, selector: t.root.anchor?.selector ?? "" }));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === "minute") {
      return rtf.format(Math.round(diff / secs), unit);
    }
  }
  return "just now";
}

/** Full timestamp for the tooltip: "13 Nov 2026, 14:05". */
export function fullTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(t));
}

/** Agents a comment can mention by name. Connection labels also work, but the server decides. */
export const MENTION_SUGGESTIONS = ["claude", "codex"] as const;

/**
 * The @-token being typed just before the caret, if any: same token rule as parseMentions.
 * Returns where the "@" is and the partial name after it.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]{0,80})$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export function mentionOptions(query: string): string[] {
  const q = query.toLowerCase();
  return MENTION_SUGGESTIONS.filter((n) => n.startsWith(q) && n !== q);
}

/** Replace the @-token at `start` (up to the caret) with "@name ". */
export function applyMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const insert = `@${name} `;
  const next = text.slice(0, start) + insert + text.slice(caret).replace(/^ /, "");
  return { text: next, caret: start + insert.length };
}

/** Plain-text excerpt for an anchor chip. */
export function excerpt(text: string | undefined, max = 60): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "an element";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
