-- Category sharing and personal categories (issue #42; docs/spec.md "Category sharing and personal
-- categories"; DECISIONS 2026-11-19).
--
-- An owner shares one category key with people. Filing an artifact under a shared category never
-- shares it: only the signed-in owner's review, bound to the share's id, makes a category grant
-- count for it (policy.ts categoryRoleOf). A collaborator keeps a personal category of their own
-- on an artifact shared with them, which nobody else sees.

-- The category's match key (shared categoryKey(): NFKC, lower case, whitespace, '-' and '_'
-- folded), written by the Worker next to `category` on every category write. NULL while category
-- is NULL, and on rows written before this migration until the owner's first share backfills
-- them. A NULL key never matches a share, so a row the backfill missed can only be pending.
ALTER TABLE artifacts ADD COLUMN category_key TEXT;
-- Bumped in SQL whenever category_key changes. A review carries it, so a move out and back
-- between the owner opening the review and confirming it is caught.
ALTER TABLE artifacts ADD COLUMN category_rev INTEGER NOT NULL DEFAULT 0;
-- The owner's review: 'shared' or 'private', made against the share category_review_share. Both
-- NULL = never reviewed (pending while the key is shared). Reset to NULL on every key change.
ALTER TABLE artifacts ADD COLUMN category_review TEXT
  CHECK (category_review IN ('shared', 'private'));
-- No foreign key on purpose: deleting a share resets these in the same batch, and a dangling id
-- never matches (share ids are random and never reused).
ALTER TABLE artifacts ADD COLUMN category_review_share TEXT
  CHECK ((category_review IS NULL) = (category_review_share IS NULL));
CREATE INDEX artifacts_owner_category_key ON artifacts(owner_id, category_key)
  WHERE deleted_at IS NULL AND category_key IS NOT NULL;
CREATE INDEX artifacts_category_review_share ON artifacts(category_review_share)
  WHERE category_review_share IS NOT NULL;

-- Optimistic-concurrency counter over the owner's share rows: every batch that inserts, deletes or
-- re-keys a category_shares row bumps it, and a rename guards every statement on it.
ALTER TABLE users ADD COLUMN category_share_rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE category_shares (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The shared key; the owner's own spelling is `name` (owner only, like artifacts.category).
  category_key TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- What the people it is shared with see (the portal heading); never the category name.
  title        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (owner_id, category_key)
);

CREATE TABLE category_grants (
  share_id   TEXT NOT NULL REFERENCES category_shares(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  -- Never editor: a category grant gives view or comment at most.
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'commenter')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (share_id, email)
);
CREATE INDEX category_grants_email ON category_grants(email);

-- Portal email codes: purpose 'viewer', artifact_id NULL, share_id set. A portal code never
-- matches an artifact's code query (artifact_id = ?) or the reverse, and its hash binds the share.
ALTER TABLE login_codes ADD COLUMN share_id TEXT REFERENCES category_shares(id) ON DELETE CASCADE;

-- A collaborator's own category on an artifact shared with them (issue #42): one per person and
-- artifact, shown to that person only, set in the app only. It goes with the artifact (delete,
-- takedown, erase) and with the person, and is removed when the person no longer holds a grant.
CREATE TABLE personal_categories (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, artifact_id)
);
CREATE INDEX personal_categories_artifact ON personal_categories(artifact_id);
