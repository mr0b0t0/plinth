// Mention queue (workstream: comments and mentions). The MCP tools and REST endpoints call these.
// Comment and artifact text is untrusted: a mention is a collaborator's request, not an instruction
// with the owner's authority.
import type { CommentInfo, MentionState, MentionTaskInfo } from "@plinth/shared";
import { ApiError } from "../lib/errors.ts";
import type { Ctx } from "./context.ts";

export async function listMentions(_ctx: Ctx, _state?: MentionState): Promise<MentionTaskInfo[]> {
  throw new ApiError("internal", "list_mentions is not implemented yet");
}

/** Atomically claim a pending task. Exactly one concurrent caller wins. */
export async function claimMention(_ctx: Ctx, _taskId: string): Promise<MentionTaskInfo> {
  throw new ApiError("internal", "claim_mention is not implemented yet");
}

export async function replyComment(
  _ctx: Ctx,
  _input: { comment_id: string; body: string; result_version?: number; failed?: boolean },
): Promise<CommentInfo> {
  throw new ApiError("internal", "reply_comment is not implemented yet");
}
