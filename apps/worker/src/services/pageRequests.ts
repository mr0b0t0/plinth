// Page requests (docs/spec.md "Page requests"): what the content endpoint at
// /__plinth/api/v1/requests does once its caller checks, pass and policy steps passed
// (content/requests.ts). A request is a root comment of kind `page_request` with exactly one
// mention task, so the owner's agent picks it up through list_mentions and claim_mention and
// answers with reply_comment. Filing never goes through insertComment: a request's body is not
// parsed for @names (its one target is `to`), and it does not count toward the comment rate.
//
// What the page reads back is decided per row by policy.ts: pageSeesRequest for each request and
// pageSeesAnswer for each reply. The SQL mirrors both, and joins neither users nor
// agent_connections, so no author of anything can reach the page even by mistake. Bodies and data
// are untrusted and never logged.
import {
  type Capabilities,
  type MentionState,
  PAGE_REQUEST_LIMITS,
  type PageRequest,
  type PageRequestAnswer,
  type PageRequestInput,
  requestTarget,
} from "@plinth/shared";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import {
  type PageClaim,
  type PageRequestAccess,
  pageSeesAnswer,
  pageSeesRequest,
} from "../policy.ts";
import { readRequestData, resolveMentionTarget } from "./comments.ts";

const HOUR_S = 3600;

/** The artifact a request is filed on, read with its current version's declaration. */
export interface RequestTarget {
  id: string;
  ownerId: string;
  currentVersion: number;
  accessEpoch: number;
  caps: Capabilities | null;
}

/** A request's root comment as the service reads it. */
export interface RequestRootRow {
  id: string;
  artifactId: string;
  parentId: string | null;
  kind: "comment" | "page_request";
  authorEmail: string | null;
  body: string;
  requestData: string | null;
  versionNumber: number;
  status: "open" | "resolved";
  createdAt: string;
}

/** A reply in a request's thread: only what pageSeesAnswer needs and what the page may get. */
export interface ReplyRow {
  parentId: string;
  body: string;
  createdAt: string;
  authorConnection: string | null;
  authorUserId: string | null;
}

interface TaskRow {
  comment_id: string;
  target_label: string;
  state: MentionState;
  result_version: number | null;
  completed_at: string | null;
}

/** Pure, exported for tests: the rows the policy lets this page see (pageSeesRequest). */
export function ownRequestsOf(
  rows: readonly RequestRootRow[],
  access: PageRequestAccess,
  claim: PageClaim | null,
  artifactId: string,
): RequestRootRow[] {
  return rows.filter((r) => pageSeesRequest(access, claim, artifactId, r));
}

/**
 * Pure, exported for tests: the answers the requester's page may see (pageSeesAnswer), oldest
 * first, the newest PAGE_REQUEST_LIMITS.answers of them, as `{ body, created_at }` and nothing else.
 */
export function answersOf(replies: readonly ReplyRow[], ownerId: string): PageRequestAnswer[] {
  const seen = replies
    .filter((r) => pageSeesAnswer(ownerId, r))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return seen
    .slice(Math.max(0, seen.length - PAGE_REQUEST_LIMITS.answers))
    .map(({ body, createdAt }) => ({ body, created_at: createdAt }));
}

const limited = (reason: string, retryAfter: number) =>
  new ApiError("rate_limited", "Too many requests from this page. Try again later.", {
    reason,
    retry_after: retryAfter,
  });

/**
 * File one request for the page's viewer (the claim). Refused unless `access.file` (defence in
 * depth: the route already checked). Rate limits come before any write; the target is resolved by
 * the mention rules; one guarded batch then writes the root comment and its task only while the
 * artifact is live, at the pass's access epoch, and under both open-request caps.
 */
export async function fileRequest(
  d1: D1Database,
  config: Config,
  target: RequestTarget,
  claim: PageClaim,
  access: PageRequestAccess,
  input: PageRequestInput,
): Promise<PageRequest> {
  if (!access.file) {
    throw new ApiError(
      "forbidden",
      "Only people who can comment can send requests from this page",
      {
        reason: "cannot_file",
      },
    );
  }
  // 1. Rate limits, per requester on this artifact and per artifact. Keys that name the email are
  // scrubbed by erase-user's delete of rate_limits rows that contain it.
  const lim = config.pageRequests;
  const mine = await hit(d1, `req:v:${target.id}:${claim.email}`, lim.perViewerPerHour, HOUR_S);
  if (!mine.allowed) throw limited("per_viewer", mine.retryAfter);
  const all = await hit(d1, `req:a:${target.id}`, lim.perArtifactPerHour, HOUR_S);
  if (!all.allowed) throw limited("per_artifact", all.retryAfter);

  // 2. The target: the call's `to`, else the page's plinth-requests-to. Never a default agent.
  const name = input.to ?? requestTarget(target.caps);
  if (!name) {
    throw new ApiError(
      "invalid_input",
      "Name who the request is for: pass `to`, or declare plinth-requests-to",
      {
        reason: "no_target",
      },
    );
  }
  const resolved = await resolveMentionTarget(getDb(d1), target.ownerId, name);
  if (!resolved) {
    throw new ApiError("invalid_input", `No agent of the owner answers to @${name}`, {
      reason: "unknown_agent",
    });
  }

  // 3. The guarded insert.
  const authorUserId =
    claim.role === "owner"
      ? target.ownerId
      : ((
          await d1
            .prepare("SELECT id FROM users WHERE email = ?1")
            .bind(claim.email)
            .first<{ id: string }>()
        )?.id ?? null);
  const id = newId();
  const now = nowIso();
  const data = input.data === undefined ? null : JSON.stringify(input.data);
  const label = `@${name}`;
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO comments (id, artifact_id, version_number, parent_id, author_user_id,
                               author_email, author_connection, body, anchor, status, created_at,
                               kind, request_data)
         SELECT ?1, a.id, a.current_version, NULL, ?3, ?4, NULL, ?5, NULL, 'open', ?6,
                'page_request', ?7
           FROM artifacts a
          WHERE a.id = ?2 AND a.deleted_at IS NULL AND a.taken_down_at IS NULL
            AND a.access_epoch = ?8
            AND (SELECT count(*) FROM mention_tasks t JOIN comments c ON c.id = t.comment_id
                  WHERE t.artifact_id = a.id AND c.kind = 'page_request'
                    AND t.state IN ('pending', 'claimed')) < ?9
            AND (SELECT count(*) FROM mention_tasks t JOIN comments c ON c.id = t.comment_id
                  WHERE t.artifact_id = a.id AND c.kind = 'page_request' AND c.author_email = ?4
                    AND t.state IN ('pending', 'claimed')) < ?10`,
      )
      .bind(
        id,
        target.id,
        authorUserId,
        claim.email,
        input.body,
        now,
        data,
        target.accessEpoch,
        lim.maxOpenPerArtifact,
        PAGE_REQUEST_LIMITS.maxOpenPerRequester,
      ),
    d1
      .prepare(
        `INSERT INTO mention_tasks (id, comment_id, artifact_id, target_connection,
                                    target_client_type, target_label, state, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7
          WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?2)`,
      )
      .bind(
        newId(),
        id,
        target.id,
        resolved.targetConnection,
        resolved.targetClientType,
        label,
        now,
      ),
  ]);
  if (!inserted?.meta.changes) throw await whyNotFiled(d1, target, claim, config);
  const version =
    (
      await d1
        .prepare("SELECT version_number FROM comments WHERE id = ?1")
        .bind(id)
        .first<{ version_number: number }>()
    )?.version_number ?? target.currentVersion;
  return {
    id,
    state: "pending",
    resolved: false,
    to: label,
    body: input.body,
    data: input.data ?? null,
    version,
    result_version: null,
    created_at: now,
    completed_at: null,
    answers: [],
  };
}

/** Which guard of the insert failed: gone (404), a sharing change (401), or a cap (429). */
async function whyNotFiled(
  d1: D1Database,
  target: RequestTarget,
  claim: PageClaim,
  config: Config,
): Promise<ApiError> {
  const a = await d1
    .prepare("SELECT access_epoch, taken_down_at, deleted_at FROM artifacts WHERE id = ?1")
    .bind(target.id)
    .first<{ access_epoch: number; taken_down_at: string | null; deleted_at: string | null }>();
  if (!a || a.deleted_at || a.taken_down_at) return new ApiError("not_found", "Not found");
  if (a.access_epoch !== target.accessEpoch) {
    return new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }
  const open = await d1
    .prepare(
      `SELECT count(*) AS n,
              sum(CASE WHEN c.author_email = ?2 THEN 1 ELSE 0 END) AS mine
         FROM mention_tasks t JOIN comments c ON c.id = t.comment_id
        WHERE t.artifact_id = ?1 AND c.kind = 'page_request' AND t.state IN ('pending', 'claimed')`,
    )
    .bind(target.id, claim.email)
    .first<{ n: number; mine: number | null }>();
  const retry = PAGE_REQUEST_LIMITS.openRetryAfterS;
  if ((open?.mine ?? 0) >= PAGE_REQUEST_LIMITS.maxOpenPerRequester) {
    return limited("open_requester", retry);
  }
  if ((open?.n ?? 0) >= config.pageRequests.maxOpenPerArtifact) {
    return limited("open_artifact", retry);
  }
  // The caps moved again between the two reads: still a cap.
  return limited("open_artifact", retry);
}

const ROOT_COLUMNS = `id, artifact_id AS artifactId, parent_id AS parentId, kind,
  author_email AS authorEmail, body, request_data AS requestData, version_number AS versionNumber,
  status, created_at AS createdAt`;

/**
 * The caller's own requests on this artifact, newest first, at most PAGE_REQUEST_LIMITS.listed,
 * each with its task's state and the owner's agents' answers.
 */
export async function listOwnRequests(
  d1: D1Database,
  target: RequestTarget,
  claim: PageClaim,
  access: PageRequestAccess,
): Promise<PageRequest[]> {
  if (!access.readOwn) return [];
  // Mirrors pageSeesRequest; the policy has the final word (ownRequestsOf).
  const { results } = await d1
    .prepare(
      `SELECT ${ROOT_COLUMNS} FROM comments
        WHERE artifact_id = ?1 AND kind = 'page_request' AND parent_id IS NULL AND author_email = ?2
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?3`,
    )
    .bind(target.id, claim.email, PAGE_REQUEST_LIMITS.listed)
    .all<RequestRootRow>();
  return shape(d1, target, ownRequestsOf(results, access, claim, target.id));
}

/** One of the caller's own requests, or null (also for anything that is not one: the same 404). */
export async function getOwnRequest(
  d1: D1Database,
  target: RequestTarget,
  claim: PageClaim,
  access: PageRequestAccess,
  id: string,
): Promise<PageRequest | null> {
  if (!access.readOwn) return null;
  const row = await d1
    .prepare(`SELECT ${ROOT_COLUMNS} FROM comments WHERE id = ?1 AND artifact_id = ?2`)
    .bind(id, target.id)
    .first<RequestRootRow>();
  if (!row || !pageSeesRequest(access, claim, target.id, row)) return null;
  const [one] = await shape(d1, target, [row]);
  return one ?? null;
}

/** Requests as the page sees them: their task, and the answers pageSeesAnswer lets through. */
async function shape(
  d1: D1Database,
  target: RequestTarget,
  roots: readonly RequestRootRow[],
): Promise<PageRequest[]> {
  if (roots.length === 0) return [];
  const ids = roots.map((r) => r.id);
  const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
  const [tasks, replies] = await Promise.all([
    d1
      .prepare(
        `SELECT comment_id, target_label, state, result_version, completed_at
           FROM mention_tasks WHERE artifact_id = ?1 AND comment_id IN (${marks})
          ORDER BY created_at, rowid`,
      )
      .bind(target.id, ...ids)
      .all<TaskRow>(),
    // Mirrors pageSeesAnswer: only replies written by an agent connection of the owner. No email,
    // name or label column is selected, and no table that holds one is joined.
    d1
      .prepare(
        `SELECT parent_id AS parentId, body, created_at AS createdAt,
                author_connection AS authorConnection, author_user_id AS authorUserId
           FROM comments
          WHERE artifact_id = ?1 AND parent_id IN (${marks})
            AND author_connection IS NOT NULL AND author_user_id = ?${ids.length + 2}
          ORDER BY created_at, rowid`,
      )
      .bind(target.id, ...ids, target.ownerId)
      .all<ReplyRow>(),
  ]);
  const taskOf = new Map<string, TaskRow>();
  for (const t of tasks.results) if (!taskOf.has(t.comment_id)) taskOf.set(t.comment_id, t);
  const repliesOf = new Map<string, ReplyRow[]>();
  for (const r of replies.results) {
    const list = repliesOf.get(r.parentId) ?? [];
    list.push(r);
    repliesOf.set(r.parentId, list);
  }
  return roots.map((r) => {
    const t = taskOf.get(r.id);
    return {
      id: r.id,
      state: t?.state ?? "failed",
      resolved: r.status === "resolved",
      to: t?.target_label ?? "",
      body: r.body,
      data: readRequestData(r.requestData),
      version: r.versionNumber,
      result_version: t?.result_version ?? null,
      created_at: r.createdAt,
      completed_at: t?.completed_at ?? null,
      answers: answersOf(repliesOf.get(r.id) ?? [], target.ownerId),
    };
  });
}
