// The afterCommit hook of every type people edit on its page (docs and sheets, #36): a new version
// is merged under a doc's live draft in the artifact's room (rooms/doc.ts), or frozen for review;
// a sheet's draft is never merged, only frozen for review. The agent that published it is told so
// once, with nothing to do.
import { liveRules, type PublishResult } from "@plinth/shared";
import { notifyDocVersion } from "../../rooms/notify.ts";
import type { CommittedVersion, TypeHooks } from "../artifactTypes.ts";
import type { Ctx } from "../context.ts";

/** People are editing the artifact on its page: say so, once, with nothing for the agent to do. */
async function withLiveDraftWarning(
  ctx: Ctx,
  result: PublishResult,
  file: string,
  noun: string,
  merges: boolean,
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
          `People are editing this ${noun} on its page. Your version is published; their unsaved ` +
          (merges
            ? "edits are merged onto it or reviewed by them. "
            : "edits are kept, and they review them beside your version and choose to publish " +
              "them in its place or discard them. ") +
          "Nothing was overwritten. No action needed.",
      },
    ],
  };
}

/** The afterCommit hook of a live-editable type; `noun` names it in the warning ("doc"). */
export function liveAfterCommit(noun: string): NonNullable<TypeHooks["afterCommit"]> {
  return async (ctx: Ctx, v: CommittedVersion) => {
    if (!v.update) return v.result;
    // A doc's live draft is merged onto the new version, or frozen for review; a sheet's is
    // frozen for review (rooms/doc.ts).
    try {
      notifyDocVersion(ctx, v.result.id, v.result.version, v.sourceSha256);
    } catch {
      // Best effort; loading the draft rebases it onto the current version.
    }
    if (v.liveCheckpoint || v.restored) return v.result;
    return withLiveDraftWarning(
      ctx,
      v.result,
      v.def.sourcePath,
      noun,
      liveRules(v.def.id)?.merge !== false,
    );
  };
}
