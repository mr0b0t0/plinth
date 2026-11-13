// Parse @mentions out of comment text. Shared so the app can highlight what the server will queue.
// The server is the authority on which mentions become tasks (see apps/worker comments service).

/** A mention token: @name, where name is letters, digits, "-", "_" or "." (no trailing "."). */
const MENTION_RE = /(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,79})/g;

/** Lowercased mention names in order of first appearance, without duplicates. */
export function parseMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const name = (m[2] ?? "").replace(/\.+$/, "").toLowerCase();
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
