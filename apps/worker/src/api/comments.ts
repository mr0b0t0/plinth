// Comments, anchors, mention tasks and reply_comment over REST. Same services and policy as MCP.
import {
  API,
  claimMentionInput,
  createCommentInput,
  listMentionsInput,
  replyCommentInput,
  updateCommentInput,
} from "@plinth/shared";
import { Hono } from "hono";
import { decideFor, findArtifact } from "../services/artifacts.ts";
import { createComment, listComments, setCommentStatus } from "../services/comments.ts";
import { claimMention, listMentions, replyComment } from "../services/mentions.ts";
import { type AppEnv, parseBody, parseInput, serviceCtx } from "./context.ts";

export const commentsApi = new Hono<AppEnv>();

// GET /artifacts/:ref/comments (policy "view"): threaded, oldest first, with mention tasks.
commentsApi.get(API.comments, async (c) => {
  const ctx = serviceCtx(c);
  const items = await listComments(ctx, c.req.param("ref"));
  // Tell the panel up front whether this caller may comment, so nobody types into a box that
  // cannot work. The POST still enforces the policy.
  const artifact = await findArtifact(ctx, c.req.param("ref"));
  const decision = artifact ? await decideFor(ctx, artifact, "comment") : null;
  return c.json({
    items,
    can_comment: !!decision?.allow,
    signed_in: ctx.principal.kind !== "anonymous",
    // The owner and editors dismiss page requests; anyone else who sees one filed it (withdraw).
    can_moderate: decision?.role === "owner" || decision?.role === "editor",
  });
});

// POST /artifacts/:ref/comments (policy "comment"): a comment or a reply (parent_id).
commentsApi.post(API.comments, async (c) => {
  const input = await parseBody(c, createCommentInput);
  return c.json(await createComment(serviceCtx(c), c.req.param("ref"), input), 201);
});

// PATCH /comments/:id {status}: resolve or reopen the thread.
commentsApi.patch(API.comment, async (c) => {
  const { status } = await parseBody(c, updateCommentInput);
  return c.json(await setCommentStatus(serviceCtx(c), c.req.param("id"), status));
});

// POST /comments/:id/reply: reply_comment.
commentsApi.post(API.replyComment, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(replyCommentInput, { ...(body ?? {}), comment_id: c.req.param("id") });
  return c.json(await replyComment(serviceCtx(c), input), 201);
});

// GET /mentions?state=: list_mentions (agents with the mentions scope).
commentsApi.get(API.mentions, async (c) => {
  const { state } = parseInput(listMentionsInput, { state: c.req.query("state") || undefined });
  return c.json({ items: await listMentions(serviceCtx(c), state) });
});

// POST /mentions/:id/claim: claim_mention.
commentsApi.post(API.claimMention, async (c) => {
  const { task_id } = parseInput(claimMentionInput, { task_id: c.req.param("id") });
  return c.json(await claimMention(serviceCtx(c), task_id));
});
