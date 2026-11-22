-- Where an artifact is edited (docs/spec.md "Published from code"): 'code' when its publisher said
-- the artifact's source lives in code (a repository the CLI or the GitHub Action publishes from,
-- or an agent's `editing: "code"`), so the next publish from there is the whole next version,
-- without what people changed on the page; NULL = on the page (the default). Set by a publish or update that carries `editing`
-- and kept until one says otherwise; never versioned. Owners and editors are told about it in edit
-- mode; it changes no permission.
ALTER TABLE artifacts ADD COLUMN editing TEXT CHECK (editing IN ('code'));
-- start_upload's `editing`, applied when the ticket commits: 'code' or 'page', NULL = none given.
-- Erased with the ticket.
ALTER TABLE upload_tickets ADD COLUMN editing TEXT CHECK (editing IN ('code', 'page'));
