// Comments, anchors and the creation of mention tasks. REST endpoints and reply_comment call these;
// every function authorizes through policy.ts (via requireArtifact) before touching data.
//
// Comment bodies and anchors are untrusted text. They are stored exactly as given, returned as
// data, and never rendered to HTML on the server (the web app renders them with renderMarkdown).
// An anchor is an element (a selector) or a page anchor (`kind: "page"`, placed by the page's own
// code through plinth.comments); both are read back through the schema that admitted them.
import {
  type Anchor,
  anchorSchema,
  CLIENT_TYPES,
  type ClientType,
  type CommentInfo,
  type CommentStatus,
  MENTION_AGENT_NAMES,
  mentionHandle,
  pageDisplayName,
  parseMentions,
  RATE_LIMITS,
  REQUEST_TARGET_LABELS,
} from "@plinth/shared";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { parseScopes } from "../auth/principal.ts";
import type { Db } from "../db/client.ts";
import {
  type ArtifactRow,
  agentConnections,
  artifacts,
  type CommentRow,
  comments,
  type MentionTaskRow,
  mentionTasks,
  users,
} from "../db/schema.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError, notFound, unauthorized } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { type Decision, takesRequests } from "../policy.ts";
import { decideFor, requireArtifact, requireVersion } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

// ---------- authors ----------

interface AuthorFields {
  authorUserId: string | null;
  authorEmail: string | null;
  authorConnection: string | null;
}

/** Who is writing. Anonymous principals (including password-pass viewers) cannot comment. */
function authorOf(ctx: Ctx): AuthorFields {
  const p = ctx.principal;
  switch (p.kind) {
    case "user":
      return { authorUserId: p.userId, authorEmail: p.email, authorConnection: null };
    case "agent":
      return { authorUserId: p.userId, authorEmail: p.email, authorConnection: p.connectionId };
    case "viewer":
      return { authorUserId: null, authorEmail: p.email, authorConnection: null };
    case "anonymous":
      throw unauthorized();
  }
}

/** Comments per hour, per account (an agent counts against its user) or per confirmed email. */
async function enforceCommentRate(ctx: Ctx): Promise<void> {
  const p = ctx.principal;
  const key =
    p.kind === "user" || p.kind === "agent"
      ? `comment:u:${p.userId}`
      : p.kind === "viewer"
        ? `comment:e:${p.email}`
        : null;
  if (!key) throw unauthorized();
  await enforce(
    ctx.env.DB,
    key,
    RATE_LIMITS.commentsPerUserPerHour,
    3600,
    `Comment limit reached (${RATE_LIMITS.commentsPerUserPerHour} per hour)`,
  );
}

// ---------- shaping ----------

export interface LoadedComment {
  c: CommentRow;
  userName: string | null;
  userEmail: string | null;
  connLabel: string | null;
  /** The artifact's owner, so the author's ownership comes from ids, never from the label. */
  ownerId: string | null;
}

export async function loadComments(ctx: Ctx, where: SQL | undefined): Promise<LoadedComment[]> {
  const rows = await ctx.db
    .select({
      c: comments,
      userName: users.name,
      userEmail: users.email,
      connLabel: agentConnections.label,
      ownerId: artifacts.ownerId,
    })
    .from(comments)
    .leftJoin(artifacts, eq(artifacts.id, comments.artifactId))
    .leftJoin(users, eq(users.id, comments.authorUserId))
    .leftJoin(agentConnections, eq(agentConnections.id, comments.authorConnection))
    .where(where)
    .orderBy(asc(comments.createdAt), sql`${comments}.rowid`)
    .all();
  return rows;
}

async function tasksFor(ctx: Ctx, commentIds: string[]): Promise<Map<string, MentionTaskRow[]>> {
  const by = new Map<string, MentionTaskRow[]>();
  if (commentIds.length === 0) return by;
  // D1 caps bound parameters per statement; chunk to stay well under it.
  for (let i = 0; i < commentIds.length; i += 90) {
    const rows = await ctx.db
      .select()
      .from(mentionTasks)
      .where(inArray(mentionTasks.commentId, commentIds.slice(i, i + 90)))
      .orderBy(asc(mentionTasks.createdAt), sql`${mentionTasks}.rowid`)
      .all();
    for (const t of rows) {
      const list = by.get(t.commentId) ?? [];
      list.push(t);
      by.set(t.commentId, list);
    }
  }
  return by;
}

/**
 * Display label for a comment's author: connection label, else name (cleaned on every read,
 * displayName.ts pageDisplayName, so a name stored before the rules shows cleaned too), else email.
 */
export function authorLabel(l: LoadedComment): string {
  return l.connLabel ?? pageDisplayName(l.userName) ?? l.c.authorEmail ?? l.userEmail ?? "Unknown";
}

/**
 * A stored anchor read back: an element or a page anchor, checked against the same schema that
 * admitted it. Anything else (junk JSON, a shape no schema allows) reads as no anchor.
 */
export function readAnchor(raw: string | null): Anchor | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = anchorSchema.safeParse(v);
  return parsed.success ? (parsed.data as Anchor) : null;
}

/**
 * Shape one comment. People without a role on the artifact (link viewers) do not see commenters'
 * email addresses: they get the person's name, or the part of the address before the "@".
 */
function toInfo(l: LoadedComment, tasks: MentionTaskRow[], revealEmail: boolean): CommentInfo {
  const { c } = l;
  let label = authorLabel(l);
  if (!revealEmail && !l.connLabel && !pageDisplayName(l.userName)) {
    label = label.split("@")[0] || "Someone";
  }
  return {
    id: c.id,
    artifact_id: c.artifactId,
    version_number: c.versionNumber,
    parent_id: c.parentId,
    author: {
      email: revealEmail ? c.authorEmail : null,
      connection_id: c.authorConnection,
      label,
      is_owner: c.authorUserId !== null && c.authorUserId === l.ownerId,
    },
    body: c.body,
    anchor: readAnchor(c.anchor),
    status: c.status,
    created_at: c.createdAt,
    mentions: tasks.map((t) => ({
      task_id: t.id,
      target: t.targetLabel,
      state: t.state,
      result_version: t.resultVersion,
    })),
  };
}

export async function commentInfo(ctx: Ctx, id: string, revealEmail = true): Promise<CommentInfo> {
  const [row] = await loadComments(ctx, eq(comments.id, id));
  if (!row) throw notFound("Comment");
  const tasks = await tasksFor(ctx, [id]);
  return toInfo(row, tasks.get(id) ?? [], revealEmail);
}

// ---------- loading ----------

export async function getCommentRow(ctx: Ctx, id: string): Promise<CommentRow | null> {
  return (await ctx.db.select().from(comments).where(eq(comments.id, id)).get()) ?? null;
}

/**
 * Load a comment and require an action on its artifact. A comment on an artifact the caller cannot
 * see is "not found", like the artifact itself.
 */
export async function requireComment(
  ctx: Ctx,
  id: string,
  action: "view" | "comment",
): Promise<{ comment: CommentRow; artifact: ArtifactRow }> {
  const comment = await getCommentRow(ctx, id);
  if (!comment) throw notFound("Comment");
  const { artifact } = await requireArtifact(ctx, comment.artifactId, action);
  return { comment, artifact };
}

// ---------- operations ----------

/** All comments on an artifact, threaded: each root (oldest first) followed by its replies. */
export async function listComments(ctx: Ctx, ref: string): Promise<CommentInfo[]> {
  const { artifact, role } = await requireArtifact(ctx, ref, "comments_read");
  const rows = await loadComments(ctx, eq(comments.artifactId, artifact.id));
  const tasks = await tasksFor(
    ctx,
    rows.map((r) => r.c.id),
  );
  const revealEmail = role !== null;
  const replies = new Map<string, LoadedComment[]>();
  const roots: LoadedComment[] = [];
  for (const r of rows) {
    if (r.c.parentId) {
      const list = replies.get(r.c.parentId) ?? [];
      list.push(r);
      replies.set(r.c.parentId, list);
    } else {
      roots.push(r);
    }
  }
  const out: CommentInfo[] = [];
  for (const root of roots) {
    out.push(toInfo(root, tasks.get(root.c.id) ?? [], revealEmail));
    for (const r of replies.get(root.c.id) ?? []) {
      out.push(toInfo(r, tasks.get(r.c.id) ?? [], revealEmail));
    }
  }
  return out;
}

export interface NewComment {
  body: string;
  parent_id?: string;
  version_number?: number;
  anchor?: Anchor;
  /** The client type this new thread is a request to (root comments only), as "@claude" in it. */
  request_to?: ClientType;
}

/** Create a comment or reply on an artifact (policy "comment"). Mentions may create tasks. */
export async function createComment(
  ctx: Ctx,
  ref: string,
  input: NewComment,
): Promise<CommentInfo> {
  const { artifact } = await requireArtifact(ctx, ref, "comment");
  return insertComment(ctx, artifact, input);
}

/**
 * Insert a comment on an artifact the caller is already allowed to comment on. Used by
 * createComment and by reply_comment.
 */
export async function insertComment(
  ctx: Ctx,
  artifact: ArtifactRow,
  input: NewComment,
): Promise<CommentInfo> {
  const author = authorOf(ctx);

  // `request_to` starts a thread; a reply reaches an agent by mentioning it.
  if (input.request_to && input.parent_id) {
    throw new ApiError("invalid_input", "request_to starts a new thread; leave it out of a reply", {
      field: "request_to",
      reason: "reply",
    });
  }

  let parentId: string | null = null;
  if (input.parent_id) {
    const parent = await getCommentRow(ctx, input.parent_id);
    if (!parent || parent.artifactId !== artifact.id) throw notFound("Parent comment");
    // Threads are one level deep: a reply to a reply joins the root's thread.
    parentId = parent.parentId ?? parent.id;
  }

  const versionNumber = input.version_number ?? artifact.currentVersion;
  await requireVersion(ctx, artifact, versionNumber);

  // A request no agent can take is refused before it counts against the comment limit.
  const mention = input.request_to
    ? await checkRequest(ctx, artifact, input.request_to)
    : undefined;

  await enforceCommentRate(ctx);

  const row: CommentRow = {
    id: newId(),
    artifactId: artifact.id,
    versionNumber,
    parentId,
    ...author,
    body: input.body,
    anchor: input.anchor ? JSON.stringify(input.anchor) : null,
    status: "open",
    createdAt: nowIso(),
    resolvedAt: null,
  };
  const tasks = await mentionTasksFor(ctx, artifact, row, input.request_to, mention);
  const insert = ctx.db.insert(comments).values(row);
  if (tasks.length > 0) {
    // One batch: the comment and its tasks are written together or not at all.
    await ctx.db.batch([insert, ctx.db.insert(mentionTasks).values(tasks)]);
  } else {
    await insert.run();
  }
  return commentInfo(ctx, row.id);
}

/**
 * The mention tasks a new comment creates (pull mode).
 *
 * - Only people allowed to "mention" (owner, editors, commenters) create tasks.
 * - Comments written by an agent connection never create tasks. An agent's reply often quotes the
 *   request it answers, and agents act with the owner's authority, so letting them mention would
 *   allow reply loops between agents and would let untrusted comment text, repeated by an agent,
 *   turn into a request that looks like it came from the owner.
 * - "@claude", "@codex" and "@agent:other" (every other client) target the owner's connections of
 *   that client type.
 * - "@<handle>" targets the artifact owner's non-revoked connection whose label normalizes to that
 *   handle (mentionHandle), leaving out tokens limited to one artifact and connections without
 *   the `mentions` scope (neither could claim the task). Agent names win over a label with the
 *   same handle; if several labels share a handle, the oldest connection is the target. Never
 *   another user's connections.
 * - Anything else stays plain text.
 * - `requestTo` (an older way to ask, still taken) targets the owner's connections of that client
 *   type, as "@claude" does, once: a client type the body already names gets no second task.
 *   checkRequest has already refused one that no connection can take, before the comment limit
 *   counted it. An agent's `requestTo` creates no task, like its @mentions.
 */
async function mentionTasksFor(
  ctx: Ctx,
  artifact: ArtifactRow,
  comment: CommentRow,
  requestTo?: ClientType,
  mention?: Decision,
): Promise<MentionTaskRow[]> {
  if (ctx.principal.kind === "agent") return [];
  const names = parseMentions(comment.body);
  if (names.length === 0 && !requestTo) return [];
  const d = mention ?? (await decideFor(ctx, artifact, "mention"));
  if (!d.allow) return [];

  const base = {
    commentId: comment.id,
    artifactId: artifact.id,
    state: "pending" as const,
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
    resultVersion: null,
    createdAt: comment.createdAt,
  };
  const tasks: MentionTaskRow[] = [];
  const labelNames = names.filter((n) => !MENTION_AGENT_NAMES[n]);
  const owned = labelNames.length
    ? (
        await ctx.db
          .select({
            id: agentConnections.id,
            label: agentConnections.label,
            scopes: agentConnections.scopes,
          })
          .from(agentConnections)
          .where(
            and(
              eq(agentConnections.userId, artifact.ownerId),
              isNull(agentConnections.revokedAt),
              // A token limited to one artifact never holds mentions, so it could never claim one.
              isNull(agentConnections.artifactId),
            ),
          )
          .orderBy(asc(agentConnections.createdAt), sql`${agentConnections}.rowid`)
          .all()
      )
        // Nor could a connection without the mentions scope: it never takes a handle, so a newer
        // one with the same handle that can answer gets the task.
        .filter((c) => parseScopes(c.scopes).has("mentions"))
    : [];
  const seenConnections = new Set<string>();
  for (const name of names) {
    const clientType = MENTION_AGENT_NAMES[name];
    if (clientType) {
      tasks.push({
        ...base,
        id: newId(),
        targetConnection: null,
        targetClientType: clientType,
        targetLabel: `@${name}`,
      });
      continue;
    }
    const conn = owned.find((c) => mentionHandle(c.label) === name);
    if (!conn || seenConnections.has(conn.id)) continue;
    seenConnections.add(conn.id);
    tasks.push({
      ...base,
      id: newId(),
      targetConnection: conn.id,
      targetClientType: null,
      targetLabel: `@${name}`,
    });
  }
  if (
    requestTo &&
    !tasks.some((t) => t.targetConnection === null && t.targetClientType === requestTo)
  ) {
    tasks.unshift({
      ...base,
      id: newId(),
      targetConnection: null,
      targetClientType: requestTo,
      targetLabel: REQUEST_TARGET_LABELS[requestTo],
    });
  }
  return tasks;
}

/**
 * A comment's `request_to`, checked before anything is counted or written: the
 * person needs the mention right (else `forbidden`), and the owner a connection of that client
 * type that can take requests (policy.ts takesRequests; else `invalid_input`, reason `no_agent`),
 * so a request is never shown as sent to an agent that cannot receive it. The `mention` decision,
 * for the tasks; undefined for an agent, whose `request_to` creates no task.
 */
async function checkRequest(
  ctx: Ctx,
  artifact: ArtifactRow,
  requestTo: ClientType,
): Promise<Decision | undefined> {
  if (ctx.principal.kind === "agent") return undefined;
  const d = await decideFor(ctx, artifact, "mention");
  if (!d.allow) throw new ApiError("forbidden", "You cannot ask the owner's agents here");
  if (!(await requestTargets(ctx.db, artifact.ownerId)).includes(requestTo)) {
    throw new ApiError(
      "invalid_input",
      "The owner has no agent of that kind connected to take requests",
      { field: "request_to", reason: "no_agent" },
    );
  }
  return d;
}

/**
 * Which agents a mention can reach on this owner's artifacts (the gate's `ask`): the client types
 * of the owner's connections that can take requests (policy.ts takesRequests), in CLIENT_TYPES order. Only the
 * types leave this function, never a label or an id.
 */
export async function requestTargets(db: Db, ownerId: string): Promise<ClientType[]> {
  const rows = await db
    .select({
      clientType: agentConnections.clientType,
      revokedAt: agentConnections.revokedAt,
      artifactId: agentConnections.artifactId,
      scopes: agentConnections.scopes,
    })
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.userId, ownerId),
        isNull(agentConnections.revokedAt),
        isNull(agentConnections.artifactId),
      ),
    )
    .all();
  const types = new Set(
    rows
      .filter((r) => takesRequests({ ...r, scopes: parseScopes(r.scopes) }))
      .map((r) => r.clientType),
  );
  return CLIENT_TYPES.filter((t) => types.has(t));
}

/** Resolve or reopen a thread (policy "comment"). Status lives on the thread's root comment. */
export async function setCommentStatus(
  ctx: Ctx,
  id: string,
  status: CommentStatus,
): Promise<CommentInfo> {
  const { comment } = await requireComment(ctx, id, "comment");
  const rootId = comment.parentId ?? comment.id;
  await ctx.db
    .update(comments)
    .set({ status, resolvedAt: status === "resolved" ? nowIso() : null })
    .where(eq(comments.id, rootId))
    .run();
  return commentInfo(ctx, rootId);
}
