-- Mention wake-ups (docs/spec.md "Mention wake-ups"). A watch is an agent session waiting for
-- requests: an MCP task an agent started with watch_mentions (kind 'task', polled with tasks/get),
-- or a session on the user's computer that the mention relay listens for (kind 'relay', polled
-- through /api/v1/mention-watches/poll). A pending mention is offered to one live watch at a time;
-- that watch's session is woken and claims it with claim_mention.
CREATE TABLE mention_watches (
  id TEXT PRIMARY KEY,                 -- the MCP task id, or the relay watch id (random, unguessable)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The connection that started it: the agent's own (task) or the relay's (relay). A revoked
  -- connection's watches stop at once (they are read through it); a deleted one's go with it.
  connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'relay')),
  -- One artifact (always for a task), or NULL for every artifact of the user (a relay only).
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
  -- Whose mentions it hears: @claude, @codex or @agent:other (and, for a task, the mentions of its
  -- own connection's label).
  client_type TEXT NOT NULL CHECK (client_type IN ('claude', 'codex', 'other')),
  status TEXT NOT NULL DEFAULT 'working'
    CHECK (status IN ('working', 'completed', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,          -- the last poll; a watch silent for MENTION_WATCH.liveMs is not live
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  -- A completed task's result: JSON {"kind":"offers","task_ids":[...]} or {"kind":"ended"}.
  result TEXT
);
CREATE INDEX mention_watches_user ON mention_watches(user_id, status, artifact_id);
CREATE INDEX mention_watches_connection ON mention_watches(connection_id, status);

-- The offer a pending mention is under: the watch whose session was woken for it, until when, how
-- many offers it has had and which watches had them (JSON array of ids), so no session is woken
-- twice for one mention and no mention wakes sessions forever.
ALTER TABLE mention_tasks ADD COLUMN offered_to TEXT;
ALTER TABLE mention_tasks ADD COLUMN offered_until TEXT;
ALTER TABLE mention_tasks ADD COLUMN offer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mention_tasks ADD COLUMN offered_watches TEXT NOT NULL DEFAULT '[]';
CREATE INDEX mention_tasks_pending ON mention_tasks(state, artifact_id);
