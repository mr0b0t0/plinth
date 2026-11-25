// Mention queue (pull mode). The MCP tools list_mentions, claim_mention and reply_comment and their
// REST mirrors call these. Comment and artifact text is untrusted: a mention is a collaborator's
// request, not an instruction with the owner's authority.
import { type CommentInfo, type MentionState, type MentionTaskInfo, TTL } from "@plinth/shared";
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import {
  accessGrants,
  agentConnections,
  artifacts,
  categoryGrants,
  categoryShares,
  comments,
  mentionTasks,
  users,
} from "../db/schema.ts";
import { ApiError, notFound, unauthorized } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { canActOnMention, grantedRole, type Principal } from "../policy.ts";
import { factsOf, requireVersion } from "./artifacts.ts";
import { authorLabel, insertComment, readAnchor, requireComment } from "./comments.ts";
import type { Ctx } from "./context.ts";
import { deliveryOf } from "./mentionWatches.ts";

type AgentPrincipal = Extract<Principal, { kind: "agent" }>;

const MAX_LISTED = 100;

/** Mention tasks are read and claimed by agent connections with the "mentions" scope only. */
function requireMentionAgent(ctx: Ctx): AgentPrincipal {
  const p = ctx.principal;
  if (p.kind === "anonymous") throw unauthorized();
  if (p.kind !== "agent") {
    throw new ApiError("forbidden", "Mention tasks are read by agent connections, not people");
  }
  if (!p.scopes.has("mentions")) {
    throw new ApiError("forbidden", "This token lacks the mentions scope");
  }
  return p;
}

/** Tasks this agent may see: on its user's live artifacts, addressed to it. */
function visibleTo(p: AgentPrincipal): SQL | undefined {
  const byType = and(
    isNull(mentionTasks.targetConnection),
    eq(mentionTasks.targetClientType, p.clientType),
  );
  return and(
    eq(artifacts.ownerId, p.userId),
    isNull(artifacts.deletedAt),
    isNull(artifacts.takenDownAt),
    p.connectionId ? or(eq(mentionTasks.targetConnection, p.connectionId), byType) : byType,
  );
}

async function loadTasks(ctx: Ctx, p: AgentPrincipal, where: SQL | undefined, limit: number) {
  const rows = await ctx.db
    .select({
      t: mentionTasks,
      a: artifacts,
      artifactSlug: artifacts.slug,
      artifactTitle: artifacts.title,
      ownerId: artifacts.ownerId,
      c: comments,
      userName: users.name,
      userEmail: users.email,
      connLabel: agentConnections.label,
      grantRole: accessGrants.role,
      shareId: categoryShares.id,
      shareOwnerId: categoryShares.ownerId,
      shareKey: categoryShares.categoryKey,
      categoryRole: categoryGrants.role,
    })
    .from(mentionTasks)
    .innerJoin(artifacts, eq(artifacts.id, mentionTasks.artifactId))
    .innerJoin(comments, eq(comments.id, mentionTasks.commentId))
    .leftJoin(users, eq(users.id, comments.authorUserId))
    .leftJoin(agentConnections, eq(agentConnections.id, comments.authorConnection))
    .leftJoin(
      accessGrants,
      and(
        eq(accessGrants.artifactId, mentionTasks.artifactId),
        eq(accessGrants.email, comments.authorEmail),
      ),
    )
    // The author's grant on the current share of the artifact's category: policy.ts grantedRole
    // decides below whether it counts for this artifact.
    .leftJoin(
      categoryShares,
      and(
        eq(categoryShares.ownerId, artifacts.ownerId),
        eq(categoryShares.categoryKey, artifacts.categoryKey),
      ),
    )
    .leftJoin(
      categoryGrants,
      and(
        eq(categoryGrants.shareId, categoryShares.id),
        eq(categoryGrants.email, comments.authorEmail),
      ),
    )
    .where(and(visibleTo(p), where))
    .orderBy(asc(mentionTasks.createdAt), sql`${mentionTasks}.rowid`)
    .limit(limit)
    .all();
  // The SQL filter mirrors the policy; the policy module still has the final word.
  return rows
    .filter((r) => canActOnMention(p, r.t, r.ownerId))
    .map(
      (r): MentionTaskInfo => ({
        id: r.t.id,
        comment_id: r.t.commentId,
        artifact_id: r.t.artifactId,
        artifact_slug: r.artifactSlug,
        artifact_title: r.artifactTitle,
        state: r.t.state,
        target: r.t.targetLabel,
        comment_body: r.c.body,
        comment_author: authorLabel(r),
        comment_author_email: r.c.authorConnection
          ? null
          : (r.c.authorEmail ?? r.userEmail ?? null),
        comment_author_role:
          r.c.authorUserId && r.c.authorUserId === r.ownerId
            ? "owner"
            : grantedRole(factsOf(r.a), {
                grantRole: r.grantRole ?? null,
                categoryGrant:
                  r.shareId && r.shareOwnerId && r.shareKey && r.categoryRole
                    ? {
                        shareId: r.shareId,
                        shareOwnerId: r.shareOwnerId,
                        shareKey: r.shareKey,
                        role: r.categoryRole,
                      }
                    : null,
                categorySharing: ctx.config.allowCategorySharing,
                passwordPassed: false,
              }),
        anchor: readAnchor(r.c.anchor),
        version_number: r.c.versionNumber,
        delivery: deliveryOf(r.t),
        claimed_by: r.t.claimedBy,
        claimed_at: r.t.claimedAt,
        result_version: r.t.resultVersion,
        created_at: r.t.createdAt,
      }),
    );
}

/** Requests addressed to this agent on its user's artifacts. Oldest first. */
export async function listMentions(
  ctx: Ctx,
  state: MentionState = "pending",
): Promise<MentionTaskInfo[]> {
  const p = requireMentionAgent(ctx);
  return loadTasks(ctx, p, eq(mentionTasks.state, state), MAX_LISTED);
}

/**
 * Atomically claim a pending task. Exactly one concurrent caller wins: the state check and the
 * write are one UPDATE, so SQLite serializes them. Everyone else gets a conflict. A task this agent
 * cannot act on is "not found", whether or not it exists.
 */
export async function claimMention(ctx: Ctx, taskId: string): Promise<MentionTaskInfo> {
  const p = requireMentionAgent(ctx);
  const [task] = await loadTasks(ctx, p, eq(mentionTasks.id, taskId), 1);
  if (!task) throw notFound("Mention task");
  if (!p.connectionId) {
    throw new ApiError("forbidden", "Only an agent connection can claim a mention task");
  }
  const won = await ctx.db
    .update(mentionTasks)
    .set({ state: "claimed", claimedBy: p.connectionId, claimedAt: nowIso() })
    .where(
      and(
        eq(mentionTasks.id, taskId),
        // Pending, or claimed long ago by an agent that never finished (it may have crashed).
        or(
          eq(mentionTasks.state, "pending"),
          and(
            eq(mentionTasks.state, "claimed"),
            lt(mentionTasks.claimedAt, new Date(Date.now() - TTL.mentionClaimMs).toISOString()),
          ),
        ),
      ),
    )
    .returning({ id: mentionTasks.id })
    .get();
  if (!won) {
    const now = await ctx.db
      .select({ state: mentionTasks.state, claimedBy: mentionTasks.claimedBy })
      .from(mentionTasks)
      .where(eq(mentionTasks.id, taskId))
      .get();
    throw new ApiError("conflict", `This task is already ${now?.state ?? "gone"}`, {
      state: now?.state ?? null,
      claimed_by: now?.claimedBy ?? null,
    });
  }
  const [claimed] = await loadTasks(ctx, p, eq(mentionTasks.id, taskId), 1);
  if (!claimed) throw notFound("Mention task");
  return claimed;
}

export interface ReplyInput {
  comment_id: string;
  body: string;
  result_version?: number;
  failed?: boolean;
}

/**
 * Reply in a comment's thread (policy "comment" on its artifact). If the calling connection holds a
 * claimed task on that comment, the reply completes it: result_version (an existing version newer
 * than the comment's) marks it done, failed=true marks it failed. Without a claimed task the reply
 * is just a comment, and result_version or failed is refused.
 */
export async function replyComment(ctx: Ctx, input: ReplyInput): Promise<CommentInfo> {
  const { comment, artifact } = await requireComment(ctx, input.comment_id, "comment");
  const resultVersion = input.result_version;
  const failed = input.failed === true;
  if (resultVersion !== undefined && failed) {
    throw new ApiError("invalid_input", "Pass result_version or failed, not both");
  }

  const p = ctx.principal;
  const claimed =
    p.kind === "agent" && p.connectionId
      ? await ctx.db
          .select({ id: mentionTasks.id })
          .from(mentionTasks)
          .where(
            and(
              eq(mentionTasks.commentId, comment.id),
              eq(mentionTasks.state, "claimed"),
              eq(mentionTasks.claimedBy, p.connectionId),
            ),
          )
          .all()
      : [];

  if ((resultVersion !== undefined || failed) && claimed.length === 0) {
    throw new ApiError(
      "conflict",
      "No mention task on this comment is claimed by this connection; claim it with claim_mention first",
    );
  }
  if (resultVersion !== undefined) {
    if (resultVersion <= comment.versionNumber) {
      throw new ApiError(
        "invalid_input",
        `result_version must be a version newer than the comment's (v${comment.versionNumber})`,
      );
    }
    await requireVersion(ctx, artifact, resultVersion);
  }

  const reply = await insertComment(ctx, artifact, {
    body: input.body,
    parent_id: comment.id,
    version_number: resultVersion,
  });

  if (claimed.length > 0 && (resultVersion !== undefined || failed) && p.kind === "agent") {
    await ctx.db
      .update(mentionTasks)
      .set({
        state: failed ? "failed" : "done",
        resultVersion: resultVersion ?? null,
        completedAt: nowIso(),
      })
      .where(
        and(
          inArray(
            mentionTasks.id,
            claimed.map((t) => t.id),
          ),
          eq(mentionTasks.state, "claimed"),
          eq(mentionTasks.claimedBy, p.connectionId ?? ""),
        ),
      )
      .run();
  }
  return reply;
}
