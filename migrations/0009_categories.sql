-- Categories (docs/spec.md "Categories"; DECISIONS 2026-11-18): the owner's own grouping of their
-- artifacts, usually the repo or project an agent published from. At most one per artifact; NULL =
-- no category. Artifact metadata, never versioned, shown only to the owner. No CHECK constraint:
-- the Worker validates and normalises the text (packages/shared/src/categories.ts).
ALTER TABLE artifacts ADD COLUMN category TEXT;
-- start_upload's category, applied when the ticket commits (NULL = none given). Erased with the ticket.
ALTER TABLE upload_tickets ADD COLUMN category TEXT;
-- The owner's category names with counts (list_artifacts, GET /categories) and the filter.
CREATE INDEX artifacts_owner_category ON artifacts(owner_id, category)
  WHERE deleted_at IS NULL AND category IS NOT NULL;
