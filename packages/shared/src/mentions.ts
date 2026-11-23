// Parse @mentions out of comment text. Shared so the app can highlight what the server will queue.
// The server is the authority on which mentions become tasks (see apps/worker comments service).

/**
 * A mention token: @name, where name is letters, digits, "-", "_" or "." (no trailing "."). One
 * name also takes a ":": `@agent:other` (OTHER_AGENT_MENTION), read only after "agent" and only as
 * a whole word. No connection's handle can hold a ":" (mentionHandle), so it never reads as a
 * mention of a connection labelled "Agent".
 */
const MENTION_RE = /(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,79})(:other\b)?/gi;

/** The mention of the owner's agents that are not Claude or Codex (ChatGPT, Cursor, Gemini…). */
export const OTHER_AGENT_MENTION = "agent:other";

/**
 * The name a mention token stands for, lowercased and without trailing dots: `name` is the part
 * before any ":", `other` the ":other" after it, if the token had one. Returns the name and how
 * many characters of the token it covers after the "@" (trailing dots, and a ":other" after any
 * name but "agent", are not part of it).
 */
export function mentionName(name: string, other?: string): { name: string; length: number } {
  const handle = name.replace(/\.+$/, "");
  if (other && handle.length === name.length && handle.toLowerCase() === "agent") {
    return { name: OTHER_AGENT_MENTION, length: name.length + other.length };
  }
  return { name: handle.toLowerCase(), length: handle.length };
}

/** Lowercased mention names in order of first appearance, without duplicates. */
export function parseMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const { name } = mentionName(m[2] ?? "", m[3]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Normalize a connection label for matching against a mention: lowercase, spaces to "-". */
export function mentionHandle(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "");
}
