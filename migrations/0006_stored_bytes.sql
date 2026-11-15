-- Reuse by hash (docs/spec.md): a version may reference objects an earlier version of the same
-- artifact stored, so the bytes it adds to storage can be less than its logical size.
ALTER TABLE versions ADD COLUMN stored_bytes INTEGER;  -- NULL = legacy full copy, counts size_bytes
