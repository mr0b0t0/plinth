-- Design systems other artifacts use (docs/spec.md "Design systems" and "Copying files from
-- another artifact").
--
-- users.default_design_system: the id of the design system the person chose as their default, or
-- NULL. One per person, so only one can be the default; it names one of their own artifacts of
-- type design_system (services/designSystems.ts checks it when it is set), and a delete of that
-- artifact clears it. No foreign key: an artifact row is soft-deleted, never removed at once.
--
-- upload_tickets.copy_files: the copy_files start_upload was given, as JSON (the shared
-- copyFilesSchema), or NULL. Authorized again, as the ticket's principal, when the bundle commits.
ALTER TABLE users ADD COLUMN default_design_system TEXT;
ALTER TABLE upload_tickets ADD COLUMN copy_files TEXT;
