-- Typed artifacts (docs/spec.md, Typed outputs). 'html': index.html is the hand-written page.
-- 'doc': content.md is Markdown, served inside Plinth's fixed renderer. Fixed at publish.
-- No CHECK constraint: SQLite cannot change one in place, and deck or sheet must not need a table
-- rebuild. The Worker validates the value against the type registry.
ALTER TABLE artifacts ADD COLUMN type TEXT NOT NULL DEFAULT 'html';
