// The doc type's Worker hooks: Markdown, never a whole HTML document; its title is the first
// "# " heading; it declares no capabilities; assets are images. A new version of a doc that people
// are editing on its page is merged under their live draft (rooms/doc.ts), and the agent is told
// so once, with nothing to do.
import { LIMITS, type PublishResult } from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import { notifyDocVersion } from "../../rooms/notify.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import type { Ctx } from "../context.ts";

/** A whole HTML document sent where Markdown (or another typed format) belongs. */
export const HTML_DOCUMENT_RE = /^\s*(<!doctype html|<html[\s>])/i;

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

/** People are editing the doc on its page: say so, once, with nothing for the agent to do. */
async function withLiveDraftWarning(
  ctx: Ctx,
  result: PublishResult,
  file: string,
): Promise<PublishResult> {
  let row: unknown = null;
  try {
    row = await ctx.env.DB.prepare("SELECT 1 AS one FROM live_drafts WHERE artifact_id = ?1")
      .bind(result.id)
      .first();
  } catch {
    return result;
  }
  if (!row) return result;
  return {
    ...result,
    warnings: [
      ...result.warnings,
      {
        code: "live_draft",
        file,
        message:
          "People are editing this doc on its page. Your version is published; their unsaved " +
          "edits are merged onto it or reviewed by them. Nothing was overwritten. No action needed.",
      },
    ],
  };
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
  async afterCommit(ctx, v) {
    if (!v.update) return v.result;
    // A doc's live draft is merged onto the new version, or frozen for review (rooms/doc.ts).
    try {
      notifyDocVersion(ctx, v.result.id, v.result.version, v.sourceSha256);
    } catch {
      // Best effort; loading the draft rebases it onto the current version.
    }
    if (v.liveCheckpoint || v.restored) return v.result;
    return withLiveDraftWarning(ctx, v.result, v.def.sourcePath);
  },
};
