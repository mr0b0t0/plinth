-- Artifact stats (docs/spec.md "Artifact stats"): one row per counted open, with who opened it, so
-- an owner can see who opened what, when and which version. Replaces the daily counts of
-- 0010_view_counts.sql; artifact_view_totals stays as the all-time count of opens the log no longer
-- keeps (services/views.ts foldOpens, after VIEW_LOG_RETENTION_DAYS).
--
-- viewer_kind: 'user' (signed in: user_id), 'email' (confirmed an allowlisted email by code, no
-- account: email), 'anonymous' (link, public or password visitor: visitor, a random id from the
-- browser's content cookie) or 'unknown' (counted before this table existed, or the person was
-- erased since). No IP address or user agent is ever stored. Erasing the artifact (or its owner)
-- removes its rows by cascade; erasing a viewer turns their rows into 'unknown' (admin erase-user),
-- and deleting a user row clears user_id.
CREATE TABLE artifact_opens (
  id INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER CHECK (version IS NULL OR version >= 1), -- the version shown; NULL if not known
  opened_at TEXT NOT NULL CHECK (opened_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'), -- UTC ISO 8601
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('user', 'email', 'anonymous', 'unknown')),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  visitor TEXT,
  role TEXT CHECK (role IS NULL OR role IN ('editor', 'commenter', 'viewer', 'public', 'link', 'password')),
  CHECK (user_id IS NULL OR viewer_kind = 'user'),
  CHECK ((email IS NOT NULL) = (viewer_kind = 'email')),
  CHECK (visitor IS NULL OR viewer_kind = 'anonymous')
);

-- One artifact's opens over a window (the owner's stats, the summary, the fold per artifact).
CREATE INDEX artifact_opens_artifact_time ON artifact_opens (artifact_id, opened_at);
-- The instance trend (admin stats) and the retention fold.
CREATE INDEX artifact_opens_time ON artifact_opens (opened_at);
-- Finding one person's opens (erase-user).
CREATE INDEX artifact_opens_user ON artifact_opens (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX artifact_opens_email ON artifact_opens (email) WHERE email IS NOT NULL;

-- Keep the daily trends: each day's count becomes that many 'unknown' opens at 00:00 UTC that day,
-- with no version, viewer or role, since none was recorded.
INSERT INTO artifact_opens (artifact_id, opened_at, viewer_kind)
WITH RECURSIVE n(artifact_id, day, left_over) AS (
  SELECT artifact_id, day, views FROM artifact_view_days WHERE views > 0
  UNION ALL
  SELECT artifact_id, day, left_over - 1 FROM n WHERE left_over > 1
)
SELECT artifact_id, day || 'T00:00:00.000Z', 'unknown' FROM n;

DROP TABLE artifact_view_days;
