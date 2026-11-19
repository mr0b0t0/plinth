-- Page requests (docs/spec.md "Page requests"): a page that declares `requests` files work for the
-- owner's agent. Each request is a root comment of kind 'page_request' with exactly one mention
-- task; the queue, claims and replies are the mention queue's.
ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'
  CHECK (kind IN ('comment', 'page_request'));
-- The JSON object the page attached (at most 8 KiB, nesting 16), page requests only. Untrusted.
ALTER TABLE comments ADD COLUMN request_data TEXT;
-- The requester's own list, per-requester open counts, and erase-user by email.
CREATE INDEX comments_page_requests ON comments (artifact_id, author_email, created_at)
  WHERE kind = 'page_request';
