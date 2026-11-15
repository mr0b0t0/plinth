-- Thumbnails (docs/spec.md "Thumbnails and link previews"): a screenshot of each version, taken by
-- Browser Rendering after the version commits and stored in R2 at
-- artifacts/<artifact_id>/thumbs/v<number>.jpg. These columns only coordinate the capture:
-- NULL = never tried; 'pending' = one capture is running (claimed at thumbnail_at);
-- 'ok' = the object exists; 'failed' = the last capture failed at thumbnail_at (retried later).
ALTER TABLE versions ADD COLUMN thumbnail TEXT CHECK (thumbnail IN ('pending', 'ok', 'failed'));
ALTER TABLE versions ADD COLUMN thumbnail_at TEXT;
CREATE INDEX versions_thumbnail_pending ON versions(thumbnail, thumbnail_at)
  WHERE thumbnail = 'pending';
