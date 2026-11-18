-- Live page edits of a doc (#36): at most one unsaved shared draft per artifact, apart from the
-- immutable versions. The artifact's room (Durable Object) writes it in a guarded flush; the app host
-- reads it for the gate, checkpoints, get_artifact and discard; delete, takedown and erase-user clear it.
CREATE TABLE live_drafts (
  artifact_id      TEXT PRIMARY KEY NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  base_version     INTEGER NOT NULL CHECK (base_version >= 1),
  content          TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  rev              INTEGER NOT NULL CHECK (rev >= 1),
  conflict_version INTEGER,                 -- set while a merge onto this version needs review
  updated_by_user  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX live_drafts_updated ON live_drafts (updated_at);
CREATE INDEX live_drafts_editor ON live_drafts (updated_by_user) WHERE updated_by_user IS NOT NULL;
