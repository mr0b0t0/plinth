// Words and numbers for the account pages: dates, quota, client types and scopes.
import type { ClientType, Scope } from "@plinth/shared";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "12 Nov 2026" in the reader's locale. */
export function formatDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** "12 Nov 2026, 14:05" in the reader's locale (for title attributes). */
export function formatDateTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/**
 * "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago"; a date after a week.
 * Future times (clock skew) read as "just now".
 */
export function formatRelative(iso: string, now: number = Date.now(), locale?: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < MINUTE) return "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), "day");
  return formatDate(iso, locale);
}

/** "12 of 100 artifacts". */
export function quotaText(count: number, limit: number): string {
  return `${count} of ${limit} ${limit === 1 ? "artifact" : "artifacts"}`;
}

/** "1 version", "3 versions". */
export function versionsText(n: number): string {
  return `${n} ${n === 1 ? "version" : "versions"}`;
}

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  claude: "Claude",
  codex: "Codex",
  other: "Other client",
};

/** What each token scope lets an agent do, in plain words. */
export const SCOPE_META: Record<Scope, { label: string; description: string }> = {
  "artifacts:read": {
    label: "Read artifacts",
    description: "See your artifacts, their versions and their content.",
  },
  "artifacts:write": {
    label: "Publish and manage artifacts",
    description: "Publish artifacts and new versions, restore versions, and change who can view.",
  },
  mentions: {
    label: "Answer mentions",
    description: "Read comments that mention it, and reply to them.",
  },
};

/** Label for a scope string, including ones this build does not know. */
export function scopeLabel(scope: string): string {
  return (SCOPE_META as Record<string, { label: string } | undefined>)[scope]?.label ?? scope;
}

/** Best guess at the client type from the name an OAuth client registered with. */
export function guessClientType(name: string | null | undefined): ClientType {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  return "other";
}

/**
 * The name a new connection gets unless the person changes it: the client's own name, made
 * distinct from `taken` (compared without case) by appending " 2", " 3", ... so mentions by label
 * stay unambiguous. Fits within `max` characters.
 */
export function defaultConnectionLabel(
  clientName: string | null | undefined,
  taken: Iterable<string>,
  max: number,
): string {
  const base = (clientName ?? "").trim().replace(/\s+/g, " ").slice(0, max).trim() || "Agent";
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${base.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** The MCP endpoint agents connect to. */
export function mcpUrl(appOrigin: string | null | undefined): string {
  const origin = appOrigin || (typeof window === "undefined" ? "" : window.location.origin);
  return `${origin.replace(/\/+$/, "")}/mcp`;
}
