// The doc type's Worker hooks: Markdown, never a whole HTML document; its title is the first
// "# " heading; it declares no capabilities; assets are images. A new version of a doc that people
// are editing on its page is merged under their live draft (rooms/doc.ts), or reviewed by them when
// it overlaps, and the agent is told so once, with nothing to do.
import { HTML_DOCUMENT_RE, LIMITS } from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import { liveAfterCommit } from "./live.ts";

/** The first non-empty "# " heading in the first 200 lines, or null. */
export function markdownTitle(text: string): string | null {
  for (const line of text.split("\n", 200)) {
    if (line.startsWith("# ")) {
      const t = line.slice(2).trim();
      if (t) return t.slice(0, LIMITS.maxTitleLength);
    }
  }
  return null;
}

export const docHooks: TypeHooks = {
  title: markdownTitle,
  capabilities: () => null,
  validate(def, text) {
    if (HTML_DOCUMENT_RE.test(text)) {
      throw new ApiError(
        "invalid_input",
        `content for type ${def.id} is ${def.sourceLabel}. To publish HTML, use type "html" and the html field.`,
        { type: def.id, field: "content" },
      );
    }
  },
  assetRule: "A doc's assets are images (png, jpg, gif, webp, avif, svg)",
  afterCommit: liveAfterCommit("doc"),
};
