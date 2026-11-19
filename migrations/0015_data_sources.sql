-- Data sources and provenance (docs/spec.md "Live data from the owner's agents"). A source
-- describes where a page's figures come from; documents an owner's agent writes with `source` carry
-- a copy of its label and connector. Plinth stores no credential and never fetches: agents push.
-- A source counts as confirmed only while confirmed_hash = config_hash, which only the signed-in
-- owner can make true (POST /api/v1/artifacts/:ref/sources/:source/confirm, session + CSRF).
-- This migration holds the feature's whole schema; data_refresh_tasks is the queue a later change
-- fills (nothing writes it yet).
CREATE TABLE data_sources (
  artifact_id        TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source_id          TEXT NOT NULL,                -- ^[a-z][a-z0-9_-]{0,39}$
  label              TEXT NOT NULL,                -- <= 60, display text ("Open issues"); untrusted
  connector          TEXT NOT NULL,                -- <= 60, display text ("Linear"); untrusted
  recipe             TEXT NOT NULL,                -- <= 1000, untrusted request text; owner only
  collection         TEXT NOT NULL,                -- stamps with this source land only here
  every_minutes      INTEGER,                      -- NULL: no schedule
  requestable_by     TEXT NOT NULL DEFAULT 'editor'
                     CHECK (requestable_by IN ('owner','editor','commenter','viewer')),
  -- Whose agents it belongs to. The client type is always stored (copied from the pinned
  -- connection when pinned), so removing a connection never leaves a row without a target.
  target_client_type TEXT NOT NULL CHECK (target_client_type IN ('claude','codex','other')),
  target_connection  TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  pin_lost_at        TEXT,                         -- the pinned connection was revoked
  -- The owner's confirmation: hex SHA-256 (first 32 characters) of the canonical JSON of label,
  -- connector, recipe, collection, every_minutes, requestable_by, target_client_type and
  -- target_connection (packages/shared/src/dataSources.ts canonicalSourceConfig).
  config_hash        TEXT NOT NULL,
  confirmed_hash     TEXT,                         -- NULL or stale: awaiting the owner
  confirmed_at       TEXT,
  last_fetched_at    TEXT,                         -- newest fetched_at stamped with this source
  last_finished_at   TEXT,
  last_outcome       TEXT CHECK (last_outcome IN ('done','failed')),
  last_error         TEXT,                         -- <= 300, redacted; owner only
  created_by_connection TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (artifact_id, source_id)
);
CREATE INDEX data_sources_schedule ON data_sources(every_minutes) WHERE every_minutes IS NOT NULL;
CREATE INDEX data_sources_target ON data_sources(target_connection) WHERE target_connection IS NOT NULL;

CREATE TABLE data_refresh_tasks (
  id                 TEXT PRIMARY KEY,
  artifact_id        TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source_id          TEXT NOT NULL,
  config_hash        TEXT NOT NULL,                -- the confirmed config it was created under
  reason             TEXT NOT NULL CHECK (reason IN ('request','schedule')),
  requested_by_email TEXT,                         -- server-stamped; NULL for schedule, after erase-user
  requested_by_role  TEXT CHECK (requested_by_role IN ('owner','editor','commenter','viewer')),
  requested_via      TEXT NOT NULL CHECK (requested_via IN ('page','app','agent','schedule')),
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','done','failed','expired')),
  claimed_by         TEXT REFERENCES agent_connections(id) ON DELETE SET NULL,
  claimed_at         TEXT,
  finished_at        TEXT,
  result_version     INTEGER,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  FOREIGN KEY (artifact_id, source_id) REFERENCES data_sources(artifact_id, source_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX data_refresh_open ON data_refresh_tasks(artifact_id, source_id)
  WHERE state IN ('pending','claimed');
CREATE INDEX data_refresh_state ON data_refresh_tasks(state, created_at);
CREATE INDEX data_refresh_requested_by ON data_refresh_tasks(requested_by_email);

-- Provenance per document. Set only by an owner's agent write carrying `source`; every other write
-- (page, app, an agent write without `source`) sets them all to NULL in the same statement, so a
-- stamp always describes the data it sits on. They count in neither size_bytes nor the quotas.
ALTER TABLE artifact_docs ADD COLUMN source_id TEXT;
ALTER TABLE artifact_docs ADD COLUMN source_label TEXT;      -- copied at write time
ALTER TABLE artifact_docs ADD COLUMN source_connector TEXT;  -- copied at write time
ALTER TABLE artifact_docs ADD COLUMN source_ref TEXT;        -- <= 300, sanitised
ALTER TABLE artifact_docs ADD COLUMN fetched_at TEXT;        -- agent-reported, bounds-checked
-- The connection that wrote the stamp: an audit value with no foreign key, so deleting a connection
-- never updates artifact_docs (which would move every page's change counter). Never sent to pages.
ALTER TABLE artifact_docs ADD COLUMN source_connection TEXT;
