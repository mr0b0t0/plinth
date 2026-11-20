-- A personal access token limited to one artifact (issue #51, docs/spec.md "Publishing from CI").
-- NULL is the account-wide token it always was. Never set for an OAuth connection (the CHECK), and
-- never changed after insert: a bound token cannot become an account-wide one, so ON DELETE is
-- CASCADE, never SET NULL. Deleting or taking down the artifact revokes its bound tokens
-- (services/cleanup.ts); erasing it removes them.
ALTER TABLE agent_connections ADD COLUMN artifact_id TEXT
  REFERENCES artifacts(id) ON DELETE CASCADE
  CHECK (artifact_id IS NULL OR kind = 'token');
CREATE INDEX agent_connections_artifact ON agent_connections (artifact_id)
  WHERE artifact_id IS NOT NULL;
