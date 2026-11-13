-- Plinth v1 schema. Timestamps are ISO-8601 UTC strings (sortable as text).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  artifact_limit INTEGER,              -- per-user override of MAX_ARTIFACTS_PER_USER
  email_verified_at TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK (client_type IN ('claude', 'codex', 'other')),
  kind TEXT NOT NULL CHECK (kind IN ('token', 'oauth')),
  token_hash TEXT UNIQUE,              -- personal access tokens only; OAuth tokens live in oauth_grants
  scopes TEXT NOT NULL,                -- space-separated
  oauth_client_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX agent_connections_user ON agent_connections(user_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,                 -- DNS label, also the content subdomain
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'password', 'allowlist')),
  password_hash TEXT,
  access_epoch INTEGER NOT NULL DEFAULT 1, -- bumped on any visibility, password or grant change
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  taken_down_at TEXT
);
CREATE INDEX artifacts_owner ON artifacts(owner_id, deleted_at);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  r2_prefix TEXT NOT NULL,             -- artifacts/<artifact_id>/v<n>/
  size_bytes INTEGER NOT NULL,
  manifest TEXT NOT NULL,              -- JSON: [{path, size_bytes, content_type}] including index.html
  created_by_user TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_connection TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  note TEXT,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, number)
);

CREATE TABLE access_grants (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, email)
);
CREATE INDEX access_grants_email ON access_grants(email);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_email TEXT,
  author_connection TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor TEXT,                         -- JSON, nullable
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX comments_artifact ON comments(artifact_id, created_at);

CREATE TABLE mention_tasks (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  target_connection TEXT REFERENCES agent_connections(id) ON DELETE CASCADE,
  target_client_type TEXT CHECK (target_client_type IN ('claude', 'codex', 'other')),
  target_label TEXT NOT NULL,          -- what was written: "@claude", "@work-claude"
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
  claimed_by TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  claimed_at TEXT,
  completed_at TEXT,
  result_version INTEGER,
  created_at TEXT NOT NULL,
  CHECK (target_connection IS NOT NULL OR target_client_type IS NOT NULL)
);
CREATE INDEX mention_tasks_artifact ON mention_tasks(artifact_id, state);
CREATE INDEX mention_tasks_comment ON mention_tasks(comment_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- SHA-256 of the cookie value
  kind TEXT NOT NULL CHECK (kind IN ('user', 'viewer')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  viewer_email TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'viewer')),
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,             -- six-digit code, hashed with a pepper
  link_token_hash TEXT UNIQUE,         -- magic link token, hashed
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX login_codes_email ON login_codes(email, purpose, created_at);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                 -- client_id
  client_name TEXT,
  redirect_uris TEXT NOT NULL,         -- JSON array
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_secret_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,                 -- pending authorization request shown on the consent page
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  code_challenge TEXT,
  redirect_uri TEXT,
  scope TEXT NOT NULL,
  resource TEXT,
  code_expires_at TEXT,
  code_used_at TEXT,
  access_token_hash TEXT UNIQUE,
  access_expires_at TEXT,
  refresh_token_hash TEXT UNIQUE,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX oauth_grants_connection ON oauth_grants(connection_id);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  reporter_email TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'actioned', 'dismissed')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX reports_state ON reports(state, created_at);

-- Fixed-window counters for rate limits and quotas per hour.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,       -- unix seconds
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Single-use nonces (viewer tokens).
CREATE TABLE used_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL          -- unix seconds
);

-- Development only: emails sent by the console provider, so local tests can read codes.
CREATE TABLE dev_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
