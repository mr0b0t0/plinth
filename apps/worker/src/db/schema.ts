// Drizzle schema mirroring migrations/0001_init.sql. The SQL migrations are the source of truth for
// the database; keep this file in step with them (test/schema.test.ts checks the column lists).
import type { ArtifactType } from "@plinth/shared";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  artifactLimit: integer("artifact_limit"),
  emailVerifiedAt: text("email_verified_at"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  /**
   * migrations/0013: bumped by every batch that inserts, deletes or re-keys one of this person's
   * category shares; a category rename guards its batch on it.
   */
  categoryShareRev: integer("category_share_rev").notNull().default(0),
});

export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  clientType: text("client_type", { enum: ["claude", "codex", "other"] }).notNull(),
  kind: text("kind", { enum: ["token", "oauth"] }).notNull(),
  tokenHash: text("token_hash"),
  scopes: text("scopes").notNull(),
  oauthClientId: text("oauth_client_id"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  /** A personal access token limited to this one artifact (0012_bound_tokens); null: account-wide. */
  artifactId: text("artifact_id"),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  visibility: text("visibility", {
    enum: ["public", "unlisted", "password", "allowlist"],
  }).notNull(),
  passwordHash: text("password_hash"),
  accessEpoch: integer("access_epoch").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  takenDownAt: text("taken_down_at"),
  /** migrations/0004: the artifact type (packages/shared/src/artifactTypes.ts), fixed at publish. */
  type: text("type").$type<ArtifactType>().notNull().default("html"),
  /**
   * migrations/0009: the owner's category (docs/spec.md "Categories"), null = none. Owner-only
   * metadata, never versioned; toSummary hides it from everyone else (policy.seesOwnerMetadata).
   */
  category: text("category"),
  /**
   * migrations/0013 (docs/spec.md "Category sharing and personal categories"): the category's
   * match key (shared categoryKey), written next to `category`, null while uncategorised or not yet
   * backfilled; `categoryRev`, bumped on every key change; and the owner's review against a share.
   */
  categoryKey: text("category_key"),
  categoryRev: integer("category_rev").notNull().default(0),
  categoryReview: text("category_review", { enum: ["shared", "private"] }),
  categoryReviewShare: text("category_review_share"),
});

export const versions = sqliteTable("versions", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  number: integer("number").notNull(),
  r2Prefix: text("r2_prefix").notNull(),
  /** Logical bytes: what a viewer loads (source plus every asset, reused ones included). */
  sizeBytes: integer("size_bytes").notNull(),
  /**
   * Bytes this version wrote to storage (migrations/0006_stored_bytes.sql). NULL for a version
   * written before 0006, which stored a full copy: it counts as size_bytes.
   */
  storedBytes: integer("stored_bytes"),
  manifest: text("manifest").notNull(),
  createdByUser: text("created_by_user"),
  createdByConnection: text("created_by_connection"),
  note: text("note"),
  restoredFrom: integer("restored_from"),
  createdAt: text("created_at").notNull(),
  /** JSON Capabilities parsed from index.html (migrations/0005_shared_state.sql), or null. */
  capabilities: text("capabilities"),
  /** Thumbnail capture state (migrations/0008_thumbnails.sql): null, pending, ok or failed. */
  thumbnail: text("thumbnail", { enum: ["pending", "ok", "failed"] }),
  /** When the thumbnail state last changed (ISO 8601). */
  thumbnailAt: text("thumbnail_at"),
});

export const accessGrants = sqliteTable(
  "access_grants",
  {
    artifactId: text("artifact_id").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["viewer", "commenter", "editor"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.email] })],
);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  parentId: text("parent_id"),
  authorUserId: text("author_user_id"),
  authorEmail: text("author_email"),
  authorConnection: text("author_connection"),
  body: text("body").notNull(),
  anchor: text("anchor"),
  status: text("status", { enum: ["open", "resolved"] })
    .notNull()
    .default("open"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const mentionTasks = sqliteTable("mention_tasks", {
  id: text("id").primaryKey(),
  commentId: text("comment_id").notNull(),
  artifactId: text("artifact_id").notNull(),
  targetConnection: text("target_connection"),
  targetClientType: text("target_client_type", { enum: ["claude", "codex", "other"] }),
  targetLabel: text("target_label").notNull(),
  state: text("state", { enum: ["pending", "claimed", "done", "failed"] })
    .notNull()
    .default("pending"),
  claimedBy: text("claimed_by"),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
  resultVersion: integer("result_version"),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["user", "viewer"] }).notNull(),
  userId: text("user_id"),
  viewerEmail: text("viewer_email"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const loginCodes = sqliteTable("login_codes", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  purpose: text("purpose", { enum: ["login", "viewer"] }).notNull(),
  artifactId: text("artifact_id"),
  codeHash: text("code_hash").notNull(),
  linkTokenHash: text("link_token_hash"),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdAt: text("created_at").notNull(),
  /** migrations/0013: a portal code names its category share (artifact_id is then null). */
  shareId: text("share_id"),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  clientSecretHash: text("client_secret_hash"),
  createdAt: text("created_at").notNull(),
});

export const oauthRequests = sqliteTable("oauth_requests", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").notNull(),
  state: text("state"),
  resource: text("resource"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const oauthGrants = sqliteTable("oauth_grants", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  connectionId: text("connection_id").notNull(),
  codeHash: text("code_hash"),
  codeChallenge: text("code_challenge"),
  redirectUri: text("redirect_uri"),
  scope: text("scope").notNull(),
  resource: text("resource"),
  codeExpiresAt: text("code_expires_at"),
  codeUsedAt: text("code_used_at"),
  accessTokenHash: text("access_token_hash"),
  accessExpiresAt: text("access_expires_at"),
  refreshTokenHash: text("refresh_token_hash"),
  /** The refresh token this one replaced; presenting it again revokes the grant. */
  previousRefreshTokenHash: text("previous_refresh_token_hash"),
  refreshExpiresAt: text("refresh_expires_at"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  reason: text("reason").notNull(),
  reporterEmail: text("reporter_email"),
  state: text("state", { enum: ["open", "actioned", "dismissed"] })
    .notNull()
    .default("open"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
  decidedBy: text("decided_by"),
});

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export const usedNonces = sqliteTable("used_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});

export const devOutbox = sqliteTable("dev_outbox", {
  id: text("id").primaryKey(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

// Shared data (migrations/0005_shared_state.sql). The usage table is kept exact by SQLite
// triggers on artifact_docs; never write its docs or bytes columns directly.
const dataRole = ["owner", "editor", "commenter", "viewer"] as const;
const dataVia = ["page", "agent", "app"] as const;

export const artifactDocs = sqliteTable(
  "artifact_docs",
  {
    artifactId: text("artifact_id").notNull(),
    collection: text("collection").notNull(),
    docId: text("doc_id").notNull(),
    data: text("data").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    rev: integer("rev").notNull().default(1),
    createdByEmail: text("created_by_email"),
    createdByRole: text("created_by_role", { enum: dataRole }),
    createdVia: text("created_via", { enum: dataVia }).notNull(),
    createdByLabel: text("created_by_label"),
    createdAt: text("created_at").notNull(),
    updatedByEmail: text("updated_by_email"),
    updatedByRole: text("updated_by_role", { enum: dataRole }),
    updatedVia: text("updated_via", { enum: dataVia }).notNull(),
    updatedByLabel: text("updated_by_label"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.collection, t.docId] })],
);

export const artifactDataUsage = sqliteTable("artifact_data_usage", {
  artifactId: text("artifact_id").primaryKey(),
  docs: integer("docs").notNull().default(0),
  bytes: integer("bytes").notNull().default(0),
  seq: integer("seq").notNull().default(0),
});

// Open counts (migrations/0010_view_counts.sql): one number per artifact per UTC day, and the
// folded total of days older than the daily window. No viewer data of any kind.
export const artifactViewDays = sqliteTable(
  "artifact_view_days",
  {
    artifactId: text("artifact_id").notNull(),
    /** UTC day, YYYY-MM-DD. */
    day: text("day").notNull(),
    views: integer("views").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.day] })],
);

export const artifactViewTotals = sqliteTable("artifact_view_totals", {
  artifactId: text("artifact_id").primaryKey(),
  views: integer("views").notNull().default(0),
  /** The earliest UTC day folded into this total, YYYY-MM-DD. */
  firstDay: text("first_day").notNull(),
});

// Live page edits of a doc (migrations/0011_live_drafts.sql, #36): one unsaved draft per artifact,
// written by the artifact's room in a guarded flush. Never a version.
export const liveDrafts = sqliteTable("live_drafts", {
  artifactId: text("artifact_id").primaryKey(),
  baseVersion: integer("base_version").notNull(),
  content: text("content").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  rev: integer("rev").notNull(),
  /** Set while a merge onto this version needs review. */
  conflictVersion: integer("conflict_version"),
  updatedByUser: text("updated_by_user"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Category sharing (migrations/0013_category_sharing.sql): an owner's share of one category key, and
// the people on it. Filing never shares: policy.ts categoryRoleOf counts a grant only for an
// artifact the owner reviewed into this very share.
export const categoryShares = sqliteTable("category_shares", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  categoryKey: text("category_key").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const categoryGrants = sqliteTable(
  "category_grants",
  {
    shareId: text("share_id").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["viewer", "commenter"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.email] })],
);

// A collaborator's own category on an artifact shared with them (issue #42), seen by them only.
export const personalCategories = sqliteTable(
  "personal_categories",
  {
    userId: text("user_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    category: text("category").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.artifactId] })],
);

// Files people add to a page (migrations/0014_artifact_files.sql). Bytes live in R2 at
// artifacts/<artifact_id>/files/<id>. artifact_file_usage is kept by triggers on artifact_files;
// never write its files or bytes columns directly.
export const artifactFiles = sqliteTable("artifact_files", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  r2Key: text("r2_key").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  state: text("state", { enum: ["pending", "ready", "deleting"] }).notNull(),
  parts: integer("parts").notNull(),
  partsDone: integer("parts_done").notNull().default(0),
  partEtags: text("part_etags"),
  multipartId: text("multipart_id"),
  createdByEmail: text("created_by_email"),
  createdByRole: text("created_by_role", { enum: dataRole }),
  createdVia: text("created_via", { enum: ["page"] }).notNull(),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  expiresAt: integer("expires_at").notNull(),
  claimedAt: integer("claimed_at"),
});

export const artifactFileUsage = sqliteTable("artifact_file_usage", {
  artifactId: text("artifact_id").primaryKey(),
  files: integer("files").notNull().default(0),
  bytes: integer("bytes").notNull().default(0),
  seq: integer("seq").notNull().default(0),
});

export type CategoryShareRow = typeof categoryShares.$inferSelect;
export type LiveDraftRow = typeof liveDrafts.$inferSelect;
export type ArtifactDocRow = typeof artifactDocs.$inferSelect;
export type ArtifactDataUsageRow = typeof artifactDataUsage.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type VersionRow = typeof versions.$inferSelect;
export type ConnectionRow = typeof agentConnections.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type MentionTaskRow = typeof mentionTasks.$inferSelect;
export type GrantRow = typeof accessGrants.$inferSelect;
