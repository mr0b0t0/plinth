-- Files people add to a page (docs/spec.md "Files people add to a page"): raster images, PDFs,
-- video and audio uploaded from a page that declares `files`. The bytes live in R2 at
-- artifacts/<artifact_id>/files/<id>, under the artifact's own root; these rows are their only
-- index. Not versioned: every row is stamped by the server with who uploaded it.
CREATE TABLE artifact_files (
  id               TEXT PRIMARY KEY NOT NULL,          -- 20 random [a-z0-9] (FILE_ID_RE)
  artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  r2_key           TEXT NOT NULL,                      -- server-built, never from input
  name             TEXT NOT NULL,                      -- sanitized display name; untrusted
  content_type     TEXT NOT NULL CHECK (content_type IN (
                     'image/png','image/jpeg','image/gif','image/webp','image/avif',
                     'application/pdf','video/mp4','video/webm',
                     'audio/mpeg','audio/mp4','audio/ogg','audio/wav')),
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 1),
  state            TEXT NOT NULL CHECK (state IN ('pending','ready','deleting')),
  parts            INTEGER NOT NULL CHECK (parts >= 1),  -- expected part count
  parts_done       INTEGER NOT NULL DEFAULT 0,
  part_etags       TEXT,                     -- JSON array while pending (multipart only)
  multipart_id     TEXT,                     -- R2 uploadId while pending (multipart only)
  created_by_email TEXT,                     -- server-stamped; NULL after erase-user
  created_by_role  TEXT CHECK (created_by_role IN ('owner','editor','commenter','viewer')),
  created_via      TEXT NOT NULL CHECK (created_via IN ('page')),
  created_at       TEXT NOT NULL,
  completed_at     TEXT,                     -- when the last part landed (state ready)
  expires_at       INTEGER NOT NULL,         -- ms; the deadline of a pending upload
  claimed_at       INTEGER                   -- ms; when a sweep or a delete claimed a tombstone
);
CREATE INDEX artifact_files_list ON artifact_files(artifact_id, state, created_at, id);
CREATE INDEX artifact_files_uploader ON artifact_files(artifact_id, created_by_email);
CREATE INDEX artifact_files_sweep ON artifact_files(state, expires_at);
CREATE INDEX artifact_files_created_by ON artifact_files(created_by_email);

-- Exact totals for one-row quota checks, and a change counter the runtime polls. A row counts while
-- pending (its bytes are reserved) or ready; a tombstone (state 'deleting') counts nothing.
CREATE TABLE artifact_file_usage (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  seq   INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER artifact_files_ai AFTER INSERT ON artifact_files WHEN NEW.state != 'deleting' BEGIN
  INSERT OR IGNORE INTO artifact_file_usage (artifact_id) VALUES (NEW.artifact_id);
  UPDATE artifact_file_usage SET files = files + 1, bytes = bytes + NEW.size_bytes
   WHERE artifact_id = NEW.artifact_id;
END;
CREATE TRIGGER artifact_files_au_state AFTER UPDATE OF state ON artifact_files
  WHEN OLD.state != NEW.state BEGIN
  UPDATE artifact_file_usage SET
     files = files - (CASE WHEN NEW.state = 'deleting' THEN 1 ELSE 0 END),
     bytes = bytes - (CASE WHEN NEW.state = 'deleting' THEN OLD.size_bytes ELSE 0 END),
     seq = seq + 1
   WHERE artifact_id = NEW.artifact_id;
END;
CREATE TRIGGER artifact_files_ad AFTER DELETE ON artifact_files WHEN OLD.state != 'deleting' BEGIN
  UPDATE artifact_file_usage SET files = files - 1, bytes = bytes - OLD.size_bytes, seq = seq + 1
   WHERE artifact_id = OLD.artifact_id;
END;
