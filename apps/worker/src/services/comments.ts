// Comments, anchors and the creation of mention tasks. REST endpoints and reply_comment call these;
// every function authorizes through policy.ts (via requireArtifact) before touching data.
//
// Comment bodies and anchors are untrusted text. They are stored exactly as given, returned as
// data, and never rendered to HTML on the server (the web app renders them with renderMarkdown).
// An anchor is an element (a selector) or a page anchor (`kind: "page"`, placed by the page's own
// code through plinth.comments); both are read back through the schema that admitted them.
//
// A thread whose root has kind `page_request` (docs/spec.md "Page requests") is visible only to the
// owner, editors and the person who filed it (policy.ts canSeeThread). Every path that reads or
// writes a thread checks it through requireThreadVisible: listing, replying by parent_id, loading
// one comment (reply_comment, resolve_comment and their REST mirrors). Anyone else gets the same
// "not found" as for a comment that does not exist.
import {
  type Anchor,
  anchorSchema,
  type ClientType,
  type CommentInfo,
  type CommentStatus,
  type EffectiveRole,
  MENTION_AGENT_NAMES,
  mentionHandle,
  parseMentions,
  RATE_LIMITS,
} from "@plinth/shared";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type ArtifactRow,
  agentConnections,
  type CommentRow,
  comments,
  type MentionTaskRow,
  mentionTasks,
  users,
} from "../db/schema.ts";
import { newId } from "../lib/crypto.ts";
import { notFound, unauthorized } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { callerEmails, canSeeThread } from "../policy.ts";
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
}

export async function loadComments(ctx: Ctx, where: SQL | undefined): Promise<LoadedComment[]> {
  const rows = await ctx.db
    .select({
      c: comments,
      userName: users.name,
      userEmail: users.email,
      connLabel: agentConnections.label,
    })
    .from(comments)
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

/** Display label for a comment's author: connection label, else name, else email. */
export function authorLabel(l: LoadedComment): string {
  return l.connLabel ?? l.userName ?? l.c.authorEmail ?? l.userEmail ?? "Unknown";
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
  if (!revealEmail && !l.connLabel && !l.userName) label = label.split("@")[0] || "Someone";
  return {
    id: c.id,
    artifact_id: c.artifactId,
    version_number: c.versionNumber,
    parent_id: c.parentId,
    author: {
      email: revealEmail ? c.authorEmail : null,
      connection_id: c.authorConnection,
      label,
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
    kind: c.kind,
    request_data: c.kind === "page_request" ? readRequestData(c.requestData) : null,
  };
}

/** A page request's stored data read back: a JSON object, or null for anything else. */
export function readRequestData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

/** The root of a comment's thread: the comment itself when it is a root. */
async function threadRoot(ctx: Ctx, c: CommentRow): Promise<CommentRow | null> {
  if (!c.parentId) return c;
  const root = await getCommentRow(ctx, c.parentId);
  return root && root.artifactId === c.artifactId ? root : null;
}

/**
 * Throw notFound(what) unless the caller may see this thread (policy.ts canSeeThread): a page
 * request is the owner's, editors' and its requester's only. Every comment read or write path
 * calls this.
 */
function requireThreadVisible(
  ctx: Ctx,
  role: EffectiveRole | null,
  root: CommentRow | null,
  what: "Comment" | "Parent comment",
): asserts root is CommentRow {
  const emails = callerEmails(ctx.principal, ctx.viewerEmail);
  if (!root || !canSeeThread(role, emails, { kind: root.kind, authorEmail: root.authorEmail })) {
    throw notFound(what);
  }
}

/**
 * Load a comment and require an action on its artifact. A comment on an artifact the caller cannot
 * see, or in a thread the caller may not see, is "not found", like the artifact itself.
 */
export async function requireComment(
  ctx: Ctx,
  id: string,
  action: "view" | "comment",
): Promise<{
  comment: CommentRow;
  artifact: ArtifactRow;
  role: EffectiveRole | null;
  root: CommentRow;
}> {
  const comment = await getCommentRow(ctx, id);
  if (!comment) throw notFound("Comment");
  const root = await threadRoot(ctx, comment);
  let allowed: { artifact: ArtifactRow; role: EffectiveRole | null };
  try {
    allowed = await requireArtifact(ctx, comment.artifactId, action);
  } catch (e) {
    // Someone who may view the artifact but not act on this thread learns nothing about a thread
    // they may not see: the same "not found" as for a missing comment, not a "forbidden".
    const seen = await requireArtifact(ctx, comment.artifactId, "view").catch(() => null);
    if (seen) requireThreadVisible(ctx, seen.role, root, "Comment");
    throw e;
  }
  requireThreadVisible(ctx, allowed.role, root, "Comment");
  return { comment, artifact: allowed.artifact, role: allowed.role, root };
}

// ---------- operations ----------

/**
 * All comments on an artifact, threaded: each root (oldest first) followed by its replies. Threads
 * the caller may not see (policy.ts canSeeThread: another person's page request) are left out
 * whole, root and replies. For an agent, the role is its user's and the emails are its user's own.
 */
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
  const emails = callerEmails(ctx.principal, ctx.viewerEmail);
  const out: CommentInfo[] = [];
  for (const root of roots) {
    if (!canSeeThread(role, emails, { kind: root.c.kind, authorEmail: root.c.authorEmail })) {
      continue;
    }
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
}

/** Create a comment or reply on an artifact (policy "comment"). Mentions may create tasks. */
export async function createComment(
  ctx: Ctx,
  ref: string,
  input: NewComment,
): Promise<CommentInfo> {
  const { artifact, role } = await requireArtifact(ctx, ref, "comment");
  return insertComment(ctx, artifact, role, input);
}

/**
 * Insert a comment on an artifact the caller is already allowed to comment on, with the caller's
 * role there. Used by createComment and by reply_comment. A reply into a thread the caller may not
 * see is "Parent comment not found", before any version check, rate limit or write.
 */
export async function insertComment(
  ctx: Ctx,
  artifact: ArtifactRow,
  role: EffectiveRole | null,
  input: NewComment,
): Promise<CommentInfo> {
  const author = authorOf(ctx);

  let parentId: string | null = null;
  if (input.parent_id) {
    const parent = await getCommentRow(ctx, input.parent_id);
    if (!parent || parent.artifactId !== artifact.id) throw notFound("Parent comment");
    requireThreadVisible(ctx, role, await threadRoot(ctx, parent), "Parent comment");
    // Threads are one level deep: a reply to a reply joins the root's thread.
    parentId = parent.parentId ?? parent.id;
  }

  const versionNumber = input.version_number ?? artifact.currentVersion;
  await requireVersion(ctx, artifact, versionNumber);

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
    kind: "comment",
    requestData: null,
  };
  const tasks = await mentionTasksFor(ctx, artifact, row);
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
 * - "@claude" and "@codex" target the owner's connections of that client type.
 * - "@<handle>" targets the artifact owner's non-revoked connection whose label normalizes to that
 *   handle (mentionHandle), leaving out tokens limited to one artifact (they never hold
 *   mentions). Agent names win over a label with the same handle; if several labels share a
 *   handle, the oldest connection is the target. Never another user's connections.
 * - Anything else stays plain text.
 */
async function mentionTasksFor(
  ctx: Ctx,
  artifact: ArtifactRow,
  comment: CommentRow,
): Promise<MentionTaskRow[]> {
  if (ctx.principal.kind === "agent") return [];
  const names = parseMentions(comment.body);
  if (names.length === 0) return [];
  const d = await decideFor(ctx, artifact, "mention");
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
  const owned = labelNames.length ? await ownerMentionConnections(ctx.db, artifact.ownerId) : [];
  const seenConnections = new Set<string>();
  for (const name of names) {
    const target = matchMentionTarget(name, owned);
    if (!target) continue;
    if (target.targetConnection) {
      if (seenConnections.has(target.targetConnection)) continue;
      seenConnections.add(target.targetConnection);
    }
    tasks.push({ ...base, id: newId(), ...target, targetLabel: `@${name}` });
  }
  return tasks;
}

/** Where a mention name points: an agent type, or one of the owner's connections. */
export interface MentionTarget {
  targetConnection: string | null;
  targetClientType: ClientType | null;
}

/**
 * The owner's connections a mention may name, oldest first: not revoked, and not limited to one
 * artifact (such a token never holds mentions, so it could never claim one).
 */
async function ownerMentionConnections(
  db: Db,
  ownerId: string,
): Promise<{ id: string; label: string }[]> {
  return db
    .select({ id: agentConnections.id, label: agentConnections.label })
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.userId, ownerId),
        isNull(agentConnections.revokedAt),
        isNull(agentConnections.artifactId),
      ),
    )
    .orderBy(asc(agentConnections.createdAt), sql`${agentConnections}.rowid`)
    .all();
}

/** The mention rules on one name: agent names win, then the oldest connection with that handle. */
function matchMentionTarget(
  name: string,
  owned: readonly { id: string; label: string }[],
): MentionTarget | null {
  const clientType = MENTION_AGENT_NAMES[name];
  if (clientType) return { targetConnection: null, targetClientType: clientType };
  const conn = owned.find((c) => mentionHandle(c.label) === name);
  return conn ? { targetConnection: conn.id, targetClientType: null } : null;
}

/**
 * Resolve one mention name for an artifact's owner, by exactly the rules a comment's @mention
 * follows (mentionTasksFor): `claude` and `codex` target the owner's connections of that client
 * type; anything else the owner's oldest connection whose label normalizes to it, never another
 * user's. Null when nothing matches (an unknown or revoked handle). Page requests use it.
 */
export async function resolveMentionTarget(
  db: Db,
  ownerId: string,
  name: string,
): Promise<MentionTarget | null> {
  if (MENTION_AGENT_NAMES[name]) return matchMentionTarget(name, []);
  return matchMentionTarget(name, await ownerMentionConnections(db, ownerId));
}

/**
 * Resolve or reopen a thread (policy "comment"). Status lives on the thread's root comment.
 * Resolving a page request (dismissing or withdrawing it) also ends its open task as `failed`, in
 * the same batch; reopening never revives a failed task. A comment's mention tasks are left alone.
 */
export async function setCommentStatus(
  ctx: Ctx,
  id: string,
  status: CommentStatus,
): Promise<CommentInfo> {
  const { root } = await requireComment(ctx, id, "comment");
  const now = nowIso();
  const update = ctx.db
    .update(comments)
    .set({ status, resolvedAt: status === "resolved" ? now : null })
    .where(eq(comments.id, root.id));
  if (root.kind === "page_request" && status === "resolved") {
    await ctx.db.batch([
      update,
      ctx.db
        .update(mentionTasks)
        .set({ state: "failed", completedAt: now })
        .where(
          and(
            eq(mentionTasks.commentId, root.id),
            inArray(mentionTasks.state, ["pending", "claimed"]),
          ),
        ),
    ]);
  } else {
    await update.run();
  }
  return commentInfo(ctx, root.id);
}
