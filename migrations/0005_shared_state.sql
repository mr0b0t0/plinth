-- Shared data: one fixed document store per artifact (docs/spec.md "Shared data and viewer identity").
-- Shared by every version of the artifact and not versioned itself.
ALTER TABLE versions ADD COLUMN capabilities TEXT;  -- JSON {"data":bool,"viewer":bool,"shared":[...]} or NULL

CREATE TABLE artifact_docs (
  artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  collection       TEXT NOT NULL,     -- ^[a-z][a-z0-9_-]{0,39}$
  doc_id           TEXT NOT NULL,     -- ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$; u_<24 hex> = personal
  data             TEXT NOT NULL,     -- JSON object as written (JSON.stringify of the parsed body)
  size_bytes       INTEGER NOT NULL,  -- UTF-8 bytes of collection + doc_id + data
  rev              INTEGER NOT NULL DEFAULT 1,
  created_by_email TEXT,              -- server-stamped; NULL only after erase-user
  created_by_role  TEXT CHECK (created_by_role IN ('owner','editor','commenter','viewer')),
  created_via      TEXT NOT NULL CHECK (created_via IN ('page','agent','app')),
  created_by_label TEXT,              -- agent connection label at write time
  created_at       TEXT NOT NULL,
  updated_by_email TEXT,
  updated_by_role  TEXT CHECK (updated_by_role IN ('owner','editor','commenter','viewer')),
  updated_via      TEXT NOT NULL CHECK (updated_via IN ('page','agent','app')),
  updated_by_label TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (artifact_id, collection, doc_id)
);
CREATE INDEX artifact_docs_order ON artifact_docs(artifact_id, collection, created_at, doc_id);
CREATE INDEX artifact_docs_created_by ON artifact_docs(created_by_email);
CREATE INDEX artifact_docs_updated_by ON artifact_docs(updated_by_email);

-- Exact totals (one-row quota checks) and a change counter the runtime polls.
CREATE TABLE artifact_data_usage (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  docs  INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  seq   INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER artifact_docs_ai AFTER INSERT ON artifact_docs BEGIN
  INSERT OR IGNORE INTO artifact_data_usage (artifact_id) VALUES (NEW.artifact_id);
  UPDATE artifact_data_usage SET docs = docs + 1, bytes = bytes + NEW.size_bytes, seq = seq + 1
   WHERE artifact_id = NEW.artifact_id;
END;
CREATE TRIGGER artifact_docs_au AFTER UPDATE ON artifact_docs BEGIN
  UPDATE artifact_data_usage SET bytes = bytes - OLD.size_bytes + NEW.size_bytes, seq = seq + 1
   WHERE artifact_id = NEW.artifact_id;
END;
CREATE TRIGGER artifact_docs_ad AFTER DELETE ON artifact_docs BEGIN
  UPDATE artifact_data_usage SET docs = docs - 1, bytes = bytes - OLD.size_bytes, seq = seq + 1
   WHERE artifact_id = OLD.artifact_id;
END;
