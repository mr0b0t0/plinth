-- Out-of-band uploads (start_upload): a single-use ticket for one publish or one update of one
-- artifact with a stated base. The bundle request commits the version and consumes the ticket in
-- the same D1 batch. Accessed through raw SQL (services/uploads.ts). A row is deleted once
-- TTL.uploadStatusMs (24 hours) has passed since it expired (services/attempts.ts).
CREATE TABLE upload_tickets (
  id TEXT PRIMARY KEY,                       -- newId()
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of plinth_up_<43 b64url>
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential TEXT NOT NULL CHECK (credential IN ('connection','admin')),
  connection_id TEXT REFERENCES agent_connections(id) ON DELETE CASCADE,
  admin_token_hash TEXT,                     -- SHA-256 of ADMIN_TOKEN at mint (single-user mode)
  scopes TEXT NOT NULL,                      -- space-separated, at mint
  mode TEXT NOT NULL CHECK (mode IN ('publish','update')),
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,   -- update: target; publish: NULL
  artifact_type TEXT NOT NULL,
  title TEXT, note TEXT, base_version INTEGER,
  state TEXT NOT NULL CHECK (state IN ('open','used','dead')),
  dead_reason TEXT CHECK (dead_reason IN ('conflict','taken_down')), -- why a dead ticket ended
  attempts INTEGER NOT NULL DEFAULT 0,
  receiving_claim TEXT, receiving_until TEXT, -- concurrency lease only, never decides the commit
  result_artifact_id TEXT, result_version INTEGER,
  reserved_artifact_id TEXT,                 -- publish: the id its commit creates (target.id); update: NULL
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
  CHECK ((credential = 'connection') = (connection_id IS NOT NULL)),
  CHECK ((credential = 'admin') = (admin_token_hash IS NOT NULL)),
  CHECK ((mode = 'update') = (artifact_id IS NOT NULL AND base_version IS NOT NULL)),
  CHECK (dead_reason IS NULL OR state = 'dead')
);
CREATE INDEX upload_tickets_user ON upload_tickets(user_id, created_at);
CREATE INDEX upload_tickets_receiving ON upload_tickets(user_id, receiving_until);
CREATE INDEX upload_tickets_expires ON upload_tickets(expires_at);
-- No two tickets ever hold the same reserved artifact id.
CREATE UNIQUE INDEX upload_tickets_reserved ON upload_tickets(reserved_artifact_id)
  WHERE reserved_artifact_id IS NOT NULL;

-- One row per attempt at writing a version (services/stage.ts, services/attempts.ts): its R2
-- prefix artifacts/<id>/v<n>.<nonce>/, inserted before the attempt's first put. The commit batch
-- deletes it (and needs it: no row, no commit), an abort deletes the prefix and then the row, and
-- the hourly scheduled sweep claims rows older than the ticket lifetime plus a margin and deletes
-- their objects. No foreign key: a first publish's artifact row arrives with its commit.
CREATE TABLE staging_attempts (
  prefix TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX staging_attempts_started ON staging_attempts(started_at);
