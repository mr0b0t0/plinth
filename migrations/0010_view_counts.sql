-- Aggregate open counts per artifact (docs/spec.md "Admin stats and view counts"). No viewer data
-- of any kind: no IP address, email, user, session or user agent. Erasing an artifact (or its
-- owner) removes its rows by cascade.
CREATE TABLE artifact_view_days (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- UTC
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (artifact_id, day)
) WITHOUT ROWID;

-- Opens on days older than the daily window (services/views.ts foldViewDays), one row per artifact.
CREATE TABLE artifact_view_totals (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  first_day TEXT NOT NULL CHECK (first_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) WITHOUT ROWID;
