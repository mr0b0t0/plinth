// The html type's Worker hooks: its title is the page's <title>, its capabilities are what its
// declaration metas (plinth-capabilities and the rest, data.ts parseCapabilities) name, and a new
// version tells the page's live room, whose sockets reconnect through the gate when the room
// declaration changed.
import { LIMITS, parseCapabilities, serializeCapabilities } from "@plinth/shared";
import { notifyVersion } from "../../rooms/notify.ts";
import type { TypeHooks } from "../artifactTypes.ts";

/** The text of an HTML document's first <title> in its first 64 KB, entities decoded, or null. */
export function htmlTitle(text: string): string | null {
  const lower = text.slice(0, 64 * 1024).toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return null;
  const start = lower.indexOf(">", open);
  const end = lower.indexOf("</title", start + 1);
  if (start < 0 || end < 0) return null;
  const t = text
    .slice(start + 1, end)
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return t ? t.slice(0, LIMITS.maxTitleLength) : null;
}

/** What an HTML page declares (shared data, viewer, room), as versions.capabilities stores it. */
export function declaredCapabilities(text: string): string | null {
  const caps = parseCapabilities(text);
  return caps ? serializeCapabilities(caps) : null;
}

export const htmlHooks: TypeHooks = {
  title: htmlTitle,
  capabilities: declaredCapabilities,
  async afterCommit(ctx, v) {
    try {
      notifyVersion(ctx, v.result.id, v.result.version, v.capabilities);
    } catch {
      // Best effort; the room's alarm re-reads the declaration.
    }
    return v.result;
  },
};
