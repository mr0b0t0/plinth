// The afterCommit hook of every type people edit on its page (docs and sheets, #36): a new version
// is merged under the live draft in the artifact's room (rooms/doc.ts), or frozen for review, and
// the agent that published it is told so once, with nothing to do.
import type { PublishResult } from "@plinth/shared";
import { notifyDocVersion } from "../../rooms/notify.ts";
import type { CommittedVersion, TypeHooks } from "../artifactTypes.ts";
import type { Ctx } from "../context.ts";

/** People are editing the artifact on its page: say so, once, with nothing for the agent to do. */
async function withLiveDraftWarning(
  ctx: Ctx,
  result: PublishResult,
  file: string,
  noun: string,
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
          "edits are merged onto it or reviewed by them. Nothing was overwritten. No action needed.",
      },
    ],
  };
}

/** The afterCommit hook of a live-editable type; `noun` names it in the warning ("doc"). */
export function liveAfterCommit(noun: string): NonNullable<TypeHooks["afterCommit"]> {
  return async (ctx: Ctx, v: CommittedVersion) => {
    if (!v.update) return v.result;
    // The live draft is merged onto the new version, or frozen for review (rooms/doc.ts).
    try {
      notifyDocVersion(ctx, v.result.id, v.result.version, v.sourceSha256);
    } catch {
      // Best effort; loading the draft rebases it onto the current version.
    }
    if (v.liveCheckpoint || v.restored) return v.result;
    return withLiveDraftWarning(ctx, v.result, v.def.sourcePath, noun);
  };
}
