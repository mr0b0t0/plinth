// The afterCommit hook of every type people edit on its page (docs, decks and sheets, #36): a new
// version is merged under a doc's live draft in the artifact's room (rooms/doc.ts), or frozen for
// review; a sheet's or a deck's draft is reviewed, never merged: the people editing see the new
// version beside theirs and keep one. The agent that published it is told so once, with nothing to do.
import { liveRules, type PublishResult } from "@plinth/shared";
import { notifyDocVersion } from "../../rooms/notify.ts";
import type { CommittedVersion, TypeHooks } from "../artifactTypes.ts";
import type { Ctx } from "../context.ts";

/**
 * What live_draft says: a doc's edits are merged onto the new version or reviewed (#49's words);
 * every other type's are never merged, and the people editing keep one of the two versions.
 */
export function liveDraftWarning(noun: string, merges: boolean): string {
  return merges
    ? `People are editing this ${noun} on its page. Your version is published; their unsaved ` +
        "edits are merged onto it or reviewed by them. Nothing was overwritten. No action needed."
    : `People are editing this ${noun} on its page. Your version is published and is the ` +
        "current version. Their unsaved edits are not merged with it: they see your version " +
        "beside theirs and keep one. If they publish theirs, it becomes the next version and " +
        "yours stays in History. No action needed; do not wait or retry. Read it again before " +
        "your next change to it.";
}

/**
 * live_draft for an HTML deck published over a deck's page edits: an HTML deck is never edited on
 * its page, so their edits are neither merged nor shown beside it. They stay kept for the people
 * who made them, who publish them as the next version or discard them.
 */
export const HTML_DECK_LIVE_DRAFT =
  "People were editing this deck on its page. Your version is an HTML deck, which is never " +
  "edited on its page, so their unpublished edits are not merged into it and are not shown " +
  "beside it. They are kept for those people: if they publish them, their deck becomes the next " +
  "version and yours stays in History. No action needed; do not wait or retry. Read it again " +
  "before your next change to it.";

/** People are editing the artifact on its page: say so, once, with nothing for the agent to do. */
async function withLiveDraftWarning(
  ctx: Ctx,
  result: PublishResult,
  file: string,
  message: string,
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
        message,
      },
    ],
  };
}

/** The afterCommit hook of a live-editable type; `noun` names it in the warning ("doc"). */
export function liveAfterCommit(noun: string): NonNullable<TypeHooks["afterCommit"]> {
  return async (ctx: Ctx, v: CommittedVersion) => {
    if (!v.update) return v.result;
    // A doc's live draft is merged onto the new version, or frozen for review; a sheet's is
    // frozen for review unless the version changed nothing it holds (rooms/doc.ts).
    try {
      notifyDocVersion(ctx, v.result.id, v.result.version, v.sourceSha256);
    } catch {
      // Best effort; loading the draft rebases it onto the current version.
    }
    if (v.liveCheckpoint || v.restored) return v.result;
    const html = v.def.altSource !== undefined && v.sourcePath === v.def.altSource.path;
    return withLiveDraftWarning(
      ctx,
      v.result,
      v.sourcePath,
      html ? HTML_DECK_LIVE_DRAFT : liveDraftWarning(noun, liveRules(v.def.id)?.merge === "lines"),
    );
  };
}
