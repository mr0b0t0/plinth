// Drizzle schema mirroring migrations/0001_init.sql. The SQL migrations are the source of truth for
// the database; keep this file in step with them (test/schema.test.ts checks the column lists).
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  artifactLimit: integer("artifact_limit"),
  emailVerifiedAt: text("email_verified_at"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
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
});

export const versions = sqliteTable("versions", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  number: integer("number").notNull(),
  r2Prefix: text("r2_prefix").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  manifest: text("manifest").notNull(),
  createdByUser: text("created_by_user"),
  createdByConnection: text("created_by_connection"),
  note: text("note"),
  restoredFrom: integer("restored_from"),
  createdAt: text("created_at").notNull(),
  /** JSON Capabilities parsed from index.html (migrations/0003_shared_state.sql), or null. */
  capabilities: text("capabilities"),
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

// Shared data (migrations/0003_shared_state.sql). The usage table is kept exact by SQLite
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

export type ArtifactDocRow = typeof artifactDocs.$inferSelect;
export type ArtifactDataUsageRow = typeof artifactDataUsage.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type VersionRow = typeof versions.$inferSelect;
export type ConnectionRow = typeof agentConnections.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type MentionTaskRow = typeof mentionTasks.$inferSelect;
export type GrantRow = typeof accessGrants.$inferSelect;
