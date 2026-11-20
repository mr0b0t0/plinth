// Words and numbers for the account pages: dates, quota, client types, scopes and mention handles.
import {
  type ClientType,
  MENTION_AGENT_NAMES,
  mentionHandle,
  parseMentions,
  type Scope,
} from "@plinth/shared";

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

/**
 * The short form for dense columns: "now", "5m", "3h", "2d" within a week, then "Nov 2" (with
 * the year when it is not this year). Future times (clock skew) read as "now".
 */
export function formatRelativeShort(
  iso: string,
  now: number = Date.now(),
  locale?: string,
): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
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

/** A connection as far as mention routing cares (ConnectionInfo has every field). */
export interface MentionCandidate {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  /** Limited to one artifact: such a token never holds mentions, so it is never a target. */
  artifact?: unknown;
}

/**
 * How a comment reaches a connection with this label (docs/agents.md "Several agents on one
 * artifact"). The server routes `@claude` and `@codex` to every connection of that client type,
 * and `@<handle>` to the owner's oldest live connection whose label normalizes to the handle
 * (mentionHandle), never to a token limited to one artifact.
 *
 * - `handle`: `@<handle>` reaches it; `also` is `claude` or `codex` when that name reaches it too.
 * - `agent_name`: the label becomes `claude` or `codex`, which always mean the client type;
 *   `reached` says whether this connection is of that type.
 * - `shadowed`: an older live connection (`by`, its label) has the same handle and gets it.
 * - `none`: no mention can name it (no letter or digit to start the handle with).
 * - `artifact_only`: a token limited to one artifact, which never answers mentions.
 * - `no_mentions`: routed, but it lacks the `mentions` scope, so it cannot pick requests up.
 */
export type MentionReach =
  | { kind: "handle"; handle: string; also?: string }
  | { kind: "agent_name"; handle: string; reached: boolean }
  | { kind: "shadowed"; handle: string; by: string }
  | { kind: "none" }
  | { kind: "artifact_only" }
  | { kind: "no_mentions" };

export function mentionReach(
  label: string,
  others: readonly MentionCandidate[],
  self: {
    /** Absent for a connection that does not exist yet (the new-token dialog, consent). */
    id?: string;
    created_at?: string;
    client_type: ClientType;
    artifact?: unknown;
    scopes?: readonly string[];
  },
): MentionReach {
  if (self.artifact) return { kind: "artifact_only" };
  if (self.scopes && !self.scopes.includes("mentions")) return { kind: "no_mentions" };
  const handle = mentionHandle(label);
  // The server matches what parseMentions reads out of "@handle"; anything else is unreachable.
  if (!handle || parseMentions(`@${handle}`)[0] !== handle) return { kind: "none" };
  const agentType = MENTION_AGENT_NAMES[handle];
  if (agentType) return { kind: "agent_name", handle, reached: agentType === self.client_type };
  const created = self.created_at;
  let first: MentionCandidate | undefined;
  for (const o of others) {
    if (o.id === self.id || o.revoked_at !== null || o.artifact) continue;
    if (mentionHandle(o.label) !== handle) continue;
    if (created !== undefined && !(o.created_at < created)) continue;
    if (!first || o.created_at < first.created_at) first = o;
  }
  if (first) return { kind: "shadowed", handle, by: first.label };
  const also = Object.keys(MENTION_AGENT_NAMES).find(
    (n) => MENTION_AGENT_NAMES[n] === self.client_type,
  );
  return also ? { kind: "handle", handle, also } : { kind: "handle", handle };
}

/** A mention cannot reach the connection by its name: the row and the name field warn. */
export function mentionReachWarns(reach: MentionReach): boolean {
  return (
    reach.kind === "shadowed" ||
    reach.kind === "none" ||
    (reach.kind === "agent_name" && !reach.reached)
  );
}

/**
 * One short sentence for the name hints and the row's warning, or null when there is nothing to
 * add: a token limited to one artifact, or one without the `mentions` scope, already shows that
 * in its row (the artifact, the permissions) and in the dialog (the checkboxes).
 */
export function mentionReachText(reach: MentionReach): string | null {
  switch (reach.kind) {
    case "handle":
      return `Mention as @${reach.handle}${reach.also ? ` or @${reach.also}` : ""}.`;
    case "agent_name": {
      const type = CLIENT_TYPE_LABEL[MENTION_AGENT_NAMES[reach.handle] ?? "other"];
      return reach.reached
        ? `Mention as @${reach.handle}, with your other ${type} connections.`
        : `@${reach.handle} means your ${type} connections. Pick another name.`;
    }
    case "shadowed":
      return `@${reach.handle} reaches “${reach.by}” instead. Rename one of them.`;
    case "none":
      return "Cannot be mentioned: start the name with a letter or digit.";
    case "artifact_only":
    case "no_mentions":
      return null;
  }
}

/** The MCP endpoint agents connect to. */
export function mcpUrl(appOrigin: string | null | undefined): string {
  const origin = appOrigin || (typeof window === "undefined" ? "" : window.location.origin);
  return `${origin.replace(/\/+$/, "")}/mcp`;
}
