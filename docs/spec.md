# Plinth: Project Spec

As of 2026-11-13

Local copy of [Plinth: Project Spec](https://claude.ai/artifact/ALCnNY6VEnyHMDSjjjiCQc) (doc rev 26).
This file is the source of truth in the repo. When the spec changes, update this file in the same
commit as the code that follows it.

## Summary

Plinth is an open-source, multi-user platform where AI agents (Claude, Codex, any MCP client)
publish HTML artifacts to a neutral home, and owners control who can view them.

It solves two problems with built-in artifact hosting. Artifacts are locked to the account and
organization that made them, so a work account's artifacts are invisible from a personal one. And
sharing with people who do not use the same AI product is limited or blocked.

The platform runs on Cloudflare (Workers, R2, D1). The same codebase serves two deployments: a
hosted instance anyone can sign up to, and a self-hosted copy on the operator's own Cloudflare
account.

## Goals and non-goals

**Goals**

- Any MCP-capable agent can publish and update an artifact with one tool call.
- One account can connect several agents (work Claude, personal Claude, Codex) and see all
  artifacts in one place.
- Owners choose who can view each artifact: public, anyone with the link, password, or an email
  allowlist.
- Viewers need no AI account. At most they confirm an email address.
- Every publish is a version. Old versions stay readable and restorable.
- People can edit an artifact in the browser and ask an agent for changes by commenting on it.
- Invited people can work on a page together live, and owners and editors can edit a doc on its
  page together.
- Open source, and cheap enough to self-host on Cloudflare's free tier.

**Non-goals for v1**

- Per-artifact server code. Artifacts are static HTML plus assets; the only server behaviour a
  page can reach is Plinth's fixed shared-data service (see
  [Shared data and viewer identity](#shared-data-and-viewer-identity)) and its live room at
  `/__plinth/room/` (see [Live rooms](#live-rooms)).
- Character-level co-editing (OT or CRDT), and live editing of HTML artifacts' text (pages build
  their own multiplayer with [live rooms](#live-rooms)).
- On-page editing of HTML artifacts (docs are edited on the page; HTML in the source editor).
- Importing artifacts automatically from Claude or ChatGPT accounts. Agents push; the platform does
  not pull.
- Team workspaces and billing. Planned, but after the core works.

## Users and core use cases

| Who | What they do |
| --- | --- |
| Publisher | Signs in, connects one or more agents, publishes artifacts, sets who can view each one |
| Viewer | Opens a link. Depending on the artifact, sees it directly, enters a password, or confirms an allowlisted email |
| Collaborator | A viewer the owner has given comment or edit rights |
| Agent | Claude, Codex or another MCP client acting for a publisher: publishes, updates, reads comments, replies |
| Self-hoster | Deploys the repo to their own Cloudflare account and runs a private instance |
| Local host | Runs an instance on their own machine, with all data on their disk, reachable through a Cloudflare Tunnel |

The three flows that must work well:

1. **Cross-account access.** Work Claude publishes an artifact. The owner opens it later from any
   device or account, because it lives under their platform login.
2. **Sharing outside the AI product.** The owner sends a link to a client who has no Claude
   account. The client opens it after an email check.
3. **Change by comment.** A collaborator comments "@claude make the chart bigger". The owner's
   agent picks up the request, publishes a new version and replies in the thread.

## Architecture

One Cloudflare Worker handles everything, routed by hostname: the MCP endpoint for agents, the app
for publishers, and a separate content domain for the artifacts themselves.

```mermaid
flowchart TB
  agents["Agents<br/>Claude, Codex, any MCP client"]
  publishers["Publishers<br/>Browser: dashboard and editor"]
  viewers["Viewers<br/>Browser: a shared link"]
  subgraph worker["Cloudflare Worker (one codebase, hosted or self-hosted)"]
    mcp["MCP endpoint<br/>OAuth per agent connection<br/>Publish, update, mentions"]
    app["App domain<br/>Sign-in, dashboard, editor<br/>Comments and sharing"]
    content["Content domain<br/>One subdomain per artifact<br/>Access check, strict CSP"]
  end
  rooms["Live rooms (optional)<br/>One Durable Object per artifact<br/>Presence and broadcast"]
  d1[("D1 database<br/>Users, versions, permissions, comments, mention queue")]
  r2[("R2 storage<br/>Artifact files, one folder per version<br/>Unchanged files reused by hash")]
  agents --> mcp
  publishers --> app
  viewers --> content
  content --> rooms
  worker --> d1
  worker --> r2
```

The content domain is the security boundary. User HTML never runs on the domain that holds login
sessions, and each artifact gets its own subdomain so artifacts cannot read each other's data.
Metadata goes to D1 and files to R2; nothing else needs to be provisioned. The same Worker also
defines one SQLite-backed Durable Object class, `ArtifactRoom` (binding `ROOMS`), for
[live rooms](#live-rooms): an object per artifact, created only when someone opens that artifact's
room, keeping no tables. A deploy without the binding runs with rooms off.

## Data model

Metadata lives in D1 (SQLite). Artifact files live in R2 under `artifacts/<artifact_id>/`: a
version's new files under its own prefix (`v<n>.<nonce>/` since 0.4.0, where `<nonce>` is 12
random characters per write attempt; `v<n>/` for versions written earlier), and files it shares
with an earlier version of the same artifact stay where they were first stored ([Big builds and
reuse by hash](#big-builds-and-reuse-by-hash)). The row's `r2_prefix` is authoritative.

| Table | Key fields | Notes |
| --- | --- | --- |
| `users` | id, email, name, auth provider, created_at | One row per person who signs in |
| `agent_connections` | id, user_id, label, client type, token hash, last_used_at, artifact_id | One per connected agent, e.g. "Work Claude". Revocable individually. `artifact_id` is NULL, or the one artifact a personal access token is limited to |
| `artifacts` | id, owner_id, slug, title, type, current_version, visibility, password hash, category, created_at | `visibility` is public, unlisted, password or allowlist. `type` is `html` (a hand-written `index.html`), `doc` (Markdown in `content.md`), `slides` (a deck's Markdown in `slides.md`) or `design_system` (JSON in `system.json`), fixed at publish. `category` is the owner's own grouping (NULL = none), shown only to the owner |
| `versions` | id, artifact_id, number, r2_prefix, size_bytes, stored_bytes, manifest, created_by (user or agent), note, created_at | Immutable, and written only once its files are in R2 (commit last). A restore creates a new row. `size_bytes` is what a viewer loads; `stored_bytes` is what this version added to R2 (NULL for versions written before 0.4.0, which count `size_bytes`). Each manifest entry has `path`, `size_bytes`, `content_type`, a server-computed `sha256` (absent on files stored before 0.4.0) and, for a reused file, a server-written `stored_at` (`v<m>[.<nonce>]/<path>`, relative to `artifacts/<artifact_id>/`, never returned by the API) |
| `access_grants` | artifact_id, email, role | Role is viewer, commenter or editor. Used for allowlists and collaborators |
| `comments` | id, artifact_id, version, parent_id, author, body, mentions, status | Threaded. `status` is open or resolved |
| `mention_tasks` | id, comment_id, target agent, state, claimed_by, result_version | The queue agents read. State is pending, claimed, done or failed |
| `sessions` | id, user or viewer email, expires_at | Login and viewer sessions |
| `reports` | id, artifact_id, reason, reporter, state | Abuse reports |

**Shared data** ([below](#shared-data-and-viewer-identity), migration `0005_shared_state.sql`)
adds one column and two tables:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `versions.capabilities` | JSON `{ data, viewer, shared }` or NULL | What the version's `index.html` declares, parsed at publish. NULL for versions that declare nothing and for versions published before the column |
| `artifact_docs` | artifact_id, collection, doc_id, data, size_bytes, rev, created_by_email/role/via/label, created_at, updated_by_email/role/via/label, updated_at | One JSON document. Key (artifact_id, collection, doc_id). Shared by every version of the artifact and not versioned. Stamps come from the server. `via` is page, agent or app |
| `artifact_data_usage` | artifact_id, docs, bytes, seq | Exact totals per artifact kept by SQLite triggers on `artifact_docs`, for one-row quota checks. `seq` grows on every change and is what pages poll |

**Big builds** ([below](#big-builds-and-reuse-by-hash), migrations `0006_stored_bytes.sql` and
`0007_upload_tickets.sql`) add one column and one table:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `versions.stored_bytes` | integer or NULL | Bytes this version wrote to R2. The storage quota sums `coalesce(stored_bytes, size_bytes)` |
| `upload_tickets` | id, token_hash, user_id, credential (`connection` or `admin`), connection_id or admin_token_hash, scopes, mode (`publish` or `update`), artifact_id, artifact_type, title, category, note, base_version, state (`open`, `used`, `dead`), attempts, receiving_claim, receiving_until, result_artifact_id, result_version, reserved_artifact_id (unique), dead_reason (`conflict` or `taken_down`, on a dead ticket), created_at, expires_at, used_at | One single-use upload ticket from `start_upload`. The token is stored as its SHA-256. A publish-mode ticket reserves its artifact id at mint (`reserved_artifact_id`, returned as `target.id`), and its commit creates the artifact with exactly that id; no other ticket can hold that id, and only that ticket's bundle can create it. While the ticket is live (open, unexpired, attempts left, minting credential still valid) the reservation counts toward the owner's artifact limit for new reservations and inline publishes; once it expires unused the id is released and never becomes an artifact. Only the id is reserved, not a slug (the commit picks the slug). `open -> used` happens in the same D1 batch that commits the version. The receiving lease limits concurrency and is the bundle's deadline (10 minutes). A row is deleted once `TTL.uploadStatusMs` (24 hours) has passed since it expired, by the hourly cron and by the opportunistic sweep; erasing an artifact or a user deletes its tickets |

**Categories** (migration `0009_categories.sql`) add one nullable column to `artifacts` and one
to `upload_tickets`, plus a partial index `artifacts_owner_category` on (owner_id, category) over
live, categorised rows. A category is a free-text name for the project, repo or client an artifact
belongs to: at most one per artifact, no tags and no categories table, so a category exists while at
least one live artifact uses it. It is artifact metadata, never versioned, and returned only to the
owner (`category` is null for everyone else). The Worker validates and normalises the text
(`packages/shared/src/categories.ts`); the columns have no CHECK constraint.

**View counts** (migration `0010_view_counts.sql`) adds two tables. They hold aggregate numbers
only: no IP address, email, user, session or user agent. Both cascade from `artifacts`, so
erasing an artifact or its owner removes them (see
[Admin stats and view counts](#admin-stats-and-view-counts)):

| Table | Key fields | Notes |
| --- | --- | --- |
| `artifact_view_days` | artifact_id, day (UTC, `YYYY-MM-DD`), views | One row per artifact per UTC day it was opened. Key (artifact_id, day), `WITHOUT ROWID`, no secondary index, so a counted open writes one row |
| `artifact_view_totals` | artifact_id, views, first_day | Opens on days older than the daily window, folded into one row per artifact; `first_day` is the earliest day folded in |

**Live rooms and on-page doc editing** (issue #36, migration `0011_live_drafts.sql`) add one table
and two fields to the stored declaration:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `versions.capabilities` | adds `room`, `roomOpen` | Written only when the page declares `room` (`<meta name="plinth-capabilities" content="room">`, open topics from `<meta name="plinth-room-open">`), so every other declaration is stored exactly as before. A row without them reads as no room. `room` is not shared data: a page that declares only `room` has none |
| `live_drafts` | artifact_id (key), base_version, content, size_bytes, rev, conflict_version, updated_by_user, created_at, updated_at | At most one unsaved page draft per doc, apart from its immutable versions, and never a version itself. Written by the artifact's room in a guarded flush that cannot bring back a deleted or taken-down artifact, never moves `rev` backwards and keeps at most 20 drafts per owner. A row exists only while the draft differs from `base_version`, or while `conflict_version` (a version published meanwhile that changed the same lines) waits for review. Content follows the doc limits (1 MB, 50,000 lines). Deleted with the artifact and on takedown; `updated_by_user` is cleared on `erase-user`; untouched rows are deleted after `LIVE_DRAFT_RETENTION_DAYS` |

Settings (env vars): `ALLOW_ROOMS` (on), `ROOM_MAX_CONNECTIONS_PER_ARTIFACT` (50, from 2 to 1000),
`ROOM_MAX_MESSAGE_BYTES` (8192, from 512 to 65536), `ROOM_MESSAGES_PER_SECOND` (20 per connection,
from 1 to 100, burst twice that), `ALLOW_LIVE_EDITING` (on), `LIVE_CHECKPOINT_IDLE_S` (120; 0 for
explicit saves only, otherwise from 30 to 3600), `LIVE_AUTO_CHECKPOINT_MIN_S` (600, at least the
idle time), `LIVE_DRAFT_FLUSH_S` (5, from 2 to 60) and `LIVE_DRAFT_RETENTION_DAYS` (30, from 1 to
365). Fixed: presence of 400 bytes per room, 3 rooms per connection, 8 sockets per viewer and 20
connects per viewer per minute; a doc-socket frame of 64 KiB; a lease idle for 60 s may be taken
over.

**Comments from the page** ([below](#comments-from-the-page-decided-2026-11-19), no migration) add
one field to the stored declaration and a second kind of comment anchor:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `versions.capabilities` | adds `comments` | Written only when the page declares `comments`, so every other declaration is stored exactly as before. A row without it reads as no page comments. `comments` is neither shared data nor a room |
| `comments.anchor` | JSON: an element anchor `{ selector, text?, x?, y? }`, or a page anchor `{ kind: "page", key, x?, y?, text?, data? }` | Element anchors are stored without `kind`, as before. Both kinds are read back through the anchor schema; a stored value no schema allows reads as no anchor |

**Bound tokens** (issue #51, migration `0012_bound_tokens.sql`) add one column:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `agent_connections.artifact_id` | artifact id or NULL | The one artifact a personal access token is limited to ([Publishing from CI](#publishing-from-ci-decided-2026-11-19)). NULL is an account-wide token or an OAuth connection; a CHECK refuses it on an OAuth row. Set at creation and never changed: to change the limit, revoke the token and make another. Deleting or taking down the artifact revokes its bound tokens in the same batch; erasing the artifact (or its owner) removes them (`ON DELETE CASCADE`, never `SET NULL`, so a bound token can never become an account-wide one). A partial index covers bound rows |

## Auth and permissions

There are three separate kinds of auth, and each has its own mechanism.

**Publishers (people).** Sign in with an email magic link, sent through SendGrid or Resend
depending on configuration. GitHub and Google sign-in can be added later. Sessions are cookies
scoped to the app domain only.

**Agents.** The MCP endpoint is an OAuth 2.1 server with dynamic client registration, so connecting
from Claude or Codex is a "connect" click followed by a consent screen. Each connection gets its own
token and label. Personal access tokens are the fallback for clients without OAuth support and for
CI.

A personal access token can be limited to one artifact (for CI: [Publishing from
CI](#publishing-from-ci-decided-2026-11-19)). It always holds `artifacts:read` and may hold
`artifacts:write`, never `mentions`. It may view that artifact (as its person may, with the person's
current rights) and publish new versions of it, and nothing else: no new artifacts, no other
artifact (404 for every action, whatever its scopes), no sharing, title, category, restore, delete,
comments (reading or writing them), shared data, view counts or mentions (403 `token_bound` on its
own artifact while it may view it; once its person may not, every action answers as viewing does).
It is never the target of an `@<label>` mention. It does not see the artifact's category, its
shared-data usage or the owner's category names; it does see the version list and `live_draft`
metadata, as an editor's agent does, but sees the people only as a link viewer does: the owner by
name, with no id or email, and each version's author by name or the address's local part, with no
ids, even when the token is the owner's. Only the artifact's owner or an editor can make one. The limit
never widens; deleting or taking down the artifact revokes it, and removing the person's grant stops
it.

**Viewers.** Set per artifact:

| Visibility | Who can open it |
| --- | --- |
| Public | Anyone. May be listed on the owner's profile |
| Unlisted | Anyone with the link |
| Password | Anyone with the link and the password |
| Allowlist | Only listed emails (and the owner), confirmed by a one-time code or magic link |

Owners can also grant a listed email the commenter or editor role. Access to the artifact itself is
enforced by the Worker on the content domain using a short-lived signed token, so the app's login
cookie never reaches user HTML.

## MCP interface

One remote MCP server over streamable HTTP at `/mcp`. All tools act as the connected user.

| Tool | Purpose |
| --- | --- |
| `publish_artifact(title, html \| type+content, assets?, visibility?, category?)` | Create an artifact. Returns its id and URL, `warnings` and `stored` (and `category`, the stored name, when one was given). Private by default (`allowlist` with nobody added). `type: "doc"` with Markdown in `content` makes a document, `type: "slides"` a deck |
| `update_artifact(id, html \| content, assets?, base_version?, note?, category?)` | Publish a new version of an existing artifact, in the source field its type takes. An asset may be `{path, sha256}` to reuse a file of the current version. `category` is owner only. Returns `warnings` and `stored` |
| `start_upload(id?, base_version?, type?, title?, note?, category?)` | For a build folder or a large page: mint a single-use, 30-minute upload ticket for one new artifact, or for one update of `id` (then `base_version` is required). The result has `upload_url`, `upload_token`, `target` (with `id`: the artifact updated, or the one the publish will create), `commands.curl` (and `commands.npx` on release builds), the instance's `limits` and `content_isolation` |
| `get_artifact(id, version?)` | Read metadata, `type`, the source (`html` for a page, `content` for a doc, a deck or a design system, and `source_path`) and each asset's `sha256`, so an agent can edit from the current state. An HTML page that names its design system also gets `design_system` (see [Design systems](#design-systems-decided-2026-11-19)) |
| `list_artifacts(query?, category?, type?, limit?)` | List the user's artifacts and their own category names (`limit: 0` returns only the names). `type` filters by artifact type, for example `design_system` |
| `list_versions(id)` | Version history with notes and authors |
| `restore_version(id, version)` | Make an old version current by publishing it as a new one |
| `set_visibility(id, visibility, emails?, password?)` | Change who can view |
| `list_mentions(state?)` | Pending requests addressed to this agent |
| `claim_mention(task_id)` | Lock a request so two agents do not both act on it |
| `reply_comment(comment_id, body, result_version?)` | Answer in the thread and mark the task done |
| `list_comments(id)` | Every comment thread on an artifact, for addressing feedback |
| `resolve_comment(comment_id, resolved?)` | Resolve or reopen a thread |
| `list_artifact_data(id, collection?, doc_id?, limit?, cursor?)` | Read an artifact's shared data (owner or editor): a summary, one page of a collection, or one document. Every result is marked untrusted |
| `write_artifact_data(id, ops)` | Change shared data (owner or editor): 1 to 50 `set`/`delete` ops, each with a required `if_rev`, each succeeding or failing on its own |
| `get_design_system(id, version?, include?, components?)` | Read a design system (type `design_system`) the user can open, to build another artifact with it: tokens resolved to values, one CSS block of custom properties for light and dark, Google Fonts links, guidelines and component examples. Read-only; every text field is untrusted |
| `preview_artifact(id, version?)` | App-only (MCP Apps `visibility: ["app"]`, read-only): a single-use, 60-second link that shows one version the caller can view in an MCP host's frame. Called by Plinth's preview page, not by agents |

**In-chat previews (decided 2026-11-16).** `publish_artifact`, `update_artifact` and
`restore_version` carry `_meta.ui.resourceUri: "ui://plinth/preview.html"` (MCP Apps, SEP-1865), so
hosts that support it show the published version under the tool call. The resource is a fixed page
Plinth wrote; it may frame `<scheme>://*.<CONTENT_HOST>` only. Each render asks `preview_artifact`
for a fresh link, so no link appears in a result the model reads. The link becomes a preview pass
on the content host: no identity, no shared data, one version, 10 minutes, and the only pass whose responses
omit `frame-ancestors` (see `docs/security.md#in-chat-previews`). Not offered under the staging path
fallback.

**Agent experience (decided 2026-11-14).** Plinth should feel the same in every harness (Claude,
Claude Code, Codex, ChatGPT, Gemini CLI, Cursor, VS Code, and T3 Code through the Claude Code and
Codex it runs), with Claude's artifact experience as the
reference: finished pages (real title, light and dark themes, phone width, pinned allowlisted
scripts), private by default so agents publish without asking and hand over the link, new versions
at the same link, and a feedback loop through comments. The MCP server's instructions and tool
descriptions carry the core rules to every client; the `plinth-artifacts` skill carries the full
ones as a plugin, extension, rule file or uploaded skill. All per-harness packages are generated by
`pnpm integrations` from the harness registry (`packages/shared/src/harnesses.ts`) and the skill
(`integrations/skill/`). Runtime capabilities (shared state, viewer identity) were left out of
that work and came later as one fixed service per artifact: see
[Shared data and viewer identity](#shared-data-and-viewer-identity). Guide: `docs/agents.md`; design:
`docs/superpowers/specs/2026-11-14-agent-experience-design.md`.

**Shared data for agents (decided 2026-11-14).** `get_artifact` also returns `capabilities` (what
the returned version declares) and `data_usage` (`{ docs, bytes }`, or null when there is none or
the caller is below editor), so an agent sees there is data before it edits the page. Data
survives `update_artifact` and restores. Only the owner clears all data, in the app or over REST;
agents have no bulk delete.

**Agent discovery (decided 2026-11-14).** An agent handed a Plinth link learns from the page it
fetches what Plinth is and how to read the artifact. Every SPA page on the app host carries a
plain-text note for agents inside `<div id="root">` (hidden by a stylesheet, replaced when the app
mounts): the MCP endpoint and OAuth discovery, `get_artifact` with the link's id, the plugin and
client install commands, `/llms.txt`, the docs and the repository. On `/a/...` and `/open/...`
pages, access is decided by the policy module for an anonymous viewer, ignoring cookies: when an
anonymous viewer could open the artifact (unlisted, or public), the note and the page title give
its title (marked as untrusted text), its current version and a link to `GET /a/<slug>/source`,
which returns the main HTML document (a doc's Markdown) as sandboxed `text/plain` (`?version=<n>`, rate-limited per
IP, `no-store`). Private, password, deleted, taken-down and missing artifacts get one generic note
and `404` from the source endpoint, identical in every case. `/a/...` pages send
`X-Robots-Tag: noindex, nofollow` except a public artifact on an instance with public visibility
on. The app host also serves `/llms.txt` (built from config, with every MCP tool), an MCP Server
Card (SEP-2127) at `/mcp/server-card` (also at `/.well-known/mcp.json` and
`/.well-known/mcp/server-card.json`, listed in `/.well-known/ai-catalog.json`) and `/robots.txt`;
other `/.well-known/` paths and missing files answer `404` instead of the SPA. Guide:
`docs/agents.md#agent-discovery`; design:
`docs/superpowers/specs/2026-11-14-agent-discovery-design.md`.

A plain REST API mirrors these tools for scripts and CI (`POST /api/v1/uploads` mirrors
`start_upload` and takes a bearer token only; `GET /api/v1/artifacts?query=&category=` mirrors
`list_artifacts` and returns `{ items, categories }`). Beyond the tools, `PATCH /api/v1/artifacts/:ref`
sets the title or the category (owner), `GET /api/v1/categories` lists the caller's own category
names, and `POST /api/v1/categories/rename` renames, merges or clears one (signed-in session only).
`GET /api/v1/artifacts/:ref/design-system?version=&include=&components=` mirrors `get_design_system`,
and `GET /api/v1/artifacts?type=` filters the list by type.
`POST /api/v1/connections` (people only) takes an optional `artifact` (id or slug) to limit the new
token to it; every `ConnectionInfo` carries `artifact` (`{ id, slug, title }` for a bound token,
with slug and title null once the person may no longer view it; null otherwise), and
`GET /api/v1/me` returns `connection` for a bearer caller (`{ id, label, bound, artifact }`; the
artifact only while the person may view it) and null for a session; for a token limited to one
artifact it returns only `id` (the person's) and `connection`, none of the account fields. Size
limits: 5 MB of HTML (1 MB of Markdown for a doc, and 1 MB and 500 slides for a deck), and per
version a total size and a file count set by the operator with `MAX_VERSION_BYTES` (default 50 MB,
at most 64 MB) and `MAX_ASSETS_PER_VERSION` (default 511, at most 900). A JSON request body may be
up to 40 MB. `GET /api/v1/config` returns the instance's limits.

**Typed outputs (decided 2026-11-14).** The first type is `doc`: an agent sends Markdown in
`content` and Plinth renders it as a finished page (reading typography, heading anchors, tables,
code, images from the artifact's own files, light and dark, phone width, a print stylesheet for
Print to PDF). A doc version stores `content.md` and its images. Its page is a fixed Plinth shell
that embeds the Markdown as escaped JSON and loads Plinth's renderer from the artifact's own origin
under `/__plinth/types/doc/`, in every isolation mode; no per-artifact server code, and the CDN
allowlist is unchanged. Raw HTML in the Markdown shows as text, links pass an allowlist and open in
a new tab, and the shell's CSP (header and a meta copy, so the editor preview gets it too) allows
only `script-src 'self'`; a doc's other files run no script. The type is fixed at publish
(`artifacts.type`, default `html`); versions, `base_version` conflicts and restore work as for HTML.
The editor edits the Markdown with a live preview and history diffs `content.md`. Owners and
editors can also edit a doc on its rendered page ([Editing](#editing)): for them, on the current
version while rooms and live editing are on, the shell's payload carries `live: "room"` and the
renderer connects the doc socket; every other shell is byte for byte as before. The second type
is `slides` (decided 2026-11-19, [Slides](#slides-decided-2026-11-19)): Markdown with a line `---`
between slides, stored as `slides.md`, rendered as a deck by the same kind of fixed renderer.
The third is `design_system` (decided 2026-11-19): design tokens, guidelines and components as
JSON, which agents read with `get_design_system` to build other pages; see
[Design systems](#design-systems-decided-2026-11-19). Sheets join the same type registry
(`packages/shared/src/artifactTypes.ts`) later; no .docx or .pptx export yet. Design:
`docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md`.

## Features

### Version history

- Every publish, edit or restore writes a new immutable version: its new files to R2, then a row
  in `versions`. Files it shares with the current version are referenced, not copied.
- The artifact page shows the list: number, author (person or agent label), note, date.
- Any version has a permanent URL (`/a/<slug>/v/3`). The bare URL always serves the current one.
- Two versions can be compared as a source diff or side by side as rendered pages.
- Restoring v2 publishes its content as the next version, so history is never rewritten.

### Thumbnails and link previews

- After a version commits, the Worker asks Cloudflare Browser Rendering (a `BROWSER` binding the
  operator adds) to open that exact version on its content origin with a one-time enter token
  that carries no identity, so the page sees a signed-out viewer. It stores a 1200x630 JPEG at
  `artifacts/<id>/thumbs/v<n>.jpg`. The capture runs after the response (`waitUntil`) and never
  delays a publish; at most two run at once, a failed one is retried after a day, and a reader
  that finds none starts one, which backfills older versions. Migration `0008_thumbnails.sql`
  adds `versions.thumbnail` and `thumbnail_at` to coordinate this.
- Dashboard cards show the current version's thumbnail from
  `GET /api/v1/artifacts/:ref/thumbnail`, which uses the same access check as reading the
  artifact (`thumbnail_url` on summaries; null when the instance takes none). The initials
  placeholder stays until the image loads.
- Link previews: `/a/...` pages carry Open Graph and Twitter tags. Unfurlers fetch without
  credentials, so they get what a signed-out visitor may see: an artifact anyone with the link
  can open (unlisted, or public) gets its title and, once captured, `og:image` from
  `/a/<slug>/og.jpg`, which runs the same anonymous check. Private, password, deleted, taken-down
  and missing artifacts all get one generic card ("Plinth artifact") with no image.
- Thumbnails live under the artifact's root, so a delete removes them; a taken-down artifact's
  thumbnails are never served. `THUMBNAILS=false`, or no `BROWSER` binding, turns the feature off:
  cards keep the placeholder and previews have no image.

### Admin stats and view counts

Plinth counts how often each artifact is opened, as one number per artifact per UTC day. It never
records who opened it.

- **Where an open is counted.** At the content host's one-time `/__plinth/enter` exchange, never
  at the gate: the app polls the gate, and previews, history and agents call it too. When the gate
  answers `ok` for a normal open of the live page, it seals a signed one-bit `w` flag into the enter
  token. Enter records an open only after every existing check passed (signature, artifact,
  access epoch, takedown, nonce), and only when all of these hold: the pass is a view pass, the
  token carries `w`, `VIEW_COUNTS` is on, the request has `Sec-Fetch-Dest: iframe`, the user agent
  does not look like a bot, and the browser's view pass for that artifact (if any) is not already
  marked counted. The response (status, `Location`, cookie attributes, CSP) is the same whether or
  not it counted.
- **Not counted.** The owner's own opens, agents (verifying a publish), an admin without a role
  (even on a public page), review mode, explicit versions (history, compare, `/a/:slug/v/:n`),
  Plinth's own paths (`/__plinth/`, such as the editor preview), thumbnail captures and in-chat
  previews (their tokens refuse `w`), replayed or expired tokens, requests without
  `Sec-Fetch-Dest: iframe` (curl, scripts) and self-declared bots and headless browsers (a bot
  token such as `Googlebot/` or `Slackbot`, or a `+https://` contact URL; a bare "bot" in a phone
  model does not count as one). Link
  unfurlers never run the app, so they never reach the gate or enter. Editors, commenters,
  allowlist and password viewers, link visitors and deep links to normal paths count.
- **Dedupe.** At most once per browser per artifact per content pass: a sliding 12 hours, reset by
  an access-epoch change (any grant, visibility or password change), so the same browser can count
  again sooner after one. A counted enter marks the content cookie it sets with one signed bit
  (`w`), and every later view enter at that epoch carries the mark forward, counted or not, so an
  editor who moves between the editor preview, history and the live page counts once, and an
  uncounted pass (the preview, history, review mode) never stops a later live open from counting.
  There is no new cookie, storage or identifier. Browsers that drop partitioned cookies count
  every open, so counts are "opens", indicative, never unique people.
- **Storage.** One D1 upsert per counted open into `artifact_view_days`, written after the
  response (`waitUntil`). A failed write never fails the open. The hourly cron, at 03 UTC, folds
  days older than 90 into `artifact_view_totals` in one transaction, so the daily table stays
  bounded and all-time totals survive. Instances without a cron (local, tunnel, Docker) keep their
  daily rows, and every total stays correct.
- **`VIEW_COUNTS`** (default on) turns recording off. Stored counts are kept, and the fold still
  runs.
- **Owners see their own counts.** The Share dialog shows "Opened N times in the last 30 days · N
  since <first counted day>" ("No opens counted yet." before the first one: opens from before the
  instance began counting are not known), and `GET /api/v1/artifacts/:ref/views` returns the last
  7 and 30 days, a 30-day daily series, the total and `since`, the first day with a counted open. It goes through the policy action `views`: the owner only (an
  agent needs `artifacts:read`); editors, viewers and an admin without a role are denied, and a
  taken-down artifact answers `taken_down`. Counts are not in `ArtifactSummary`, MCP or anything
  the app host answers without signing in.
- **Admins see instance aggregates.** `/admin/stats` (`GET /api/v1/admin/stats?days=7|30|90`,
  default 30) is for the signed-in people whose email is in `ADMIN_EMAIL`; everyone else, agents
  included, gets the same 404. It shows people, live artifacts by visibility and taken down,
  versions and agent versions, storage, shared data, agent connections by client (and how many
  were used in the window, including any revoked since), open reports and opens, with daily series
  over the window (UTC days, zero-filled). Tiles whose figure covers the window say so in their
  label. It names no artifact,
  owner or viewer and has no top-N list, so it is no way around "admins view only reported
  artifacts". Storage, artifact, version and shared-data totals count live artifacts only (as
  the quota does); opens of deleted and taken-down artifacts stay in the view totals until a hard
  erase, and the daily series count activity, including artifacts deleted since.

### Editing

- v1: a code editor (Monaco) with live preview in a sandboxed frame. Saving creates a new version
  with an optional note.
- Editors are the owner plus anyone granted the editor role.
- If the current version changed while someone was editing, the save is rejected and they see a
  diff to merge. No silent overwrites.

**On-page doc editing** (decided 2026-11-18, issue #36). Owners and editors edit a doc right on its
rendered page, and the other editors with the page open see the changes as they are typed. HTML
artifacts are edited in the source editor only: page scripts share the frame's origin and could
forge edits that the editor's session would then save.

- **Who.** Owners and editors signed in to an account (policy action `live_edit`). An editor
  confirmed by code without an account watches the edits and is asked to sign in. Commenters and
  viewers see versions only. Agents never edit live: they publish versions.
- **Concurrency.** The doc's room (its Durable Object, see [Live rooms](#live-rooms)) is the only
  place edits are ordered. Clicking a block takes a **lease**: an exclusive line range the room
  enforces, so two people never edit the same lines. Each edit replaces the leased range whole, so
  no transform is needed. Every edit bumps the draft's `rev` and goes to every editor; a client
  that misses one (or sees a new `gen` after the room reloaded) asks for the draft again. A lease
  idle for 60 s can be taken over.
- **Drafts are not versions.** The draft is one `live_drafts` row per doc, written by the room at
  most every `LIVE_DRAFT_FLUSH_S` (and on release, when the last editor leaves, and before a save).
  It never moves backwards, never comes back after a delete or takedown, and an owner keeps at most
  20. A draft back at its base is deleted.
- **Checkpoints.** Save (Cmd/Ctrl+S), Done, or an autosave after `LIVE_CHECKPOINT_IDLE_S` of quiet
  (from the client that made the last edit, while it is editing; no sooner than
  `LIVE_AUTO_CHECKPOINT_MIN_S` after the current version, whoever made it, and an autosave asked
  for sooner is tried again once that time has passed) turn the
  draft into the next version, through the ordinary publish path with the draft's `base_version`
  and the note "Edited on the page". A draft equal to its base writes nothing. Checkpoints count
  toward `MAX_PUBLISHES_PER_HOUR`; at the limit the draft stays. Edits made while a save runs are
  kept on top of the new version.
- **Versions from elsewhere.** When an agent, the source editor or a restore publishes a version
  while a draft exists, the draft is merged onto it line by line when the two changed different
  lines (the editors see "v5 was published; your edits were kept"). When they changed the same or
  adjacent lines, the draft is frozen and an editor reviews the two side by side; nothing is
  overwritten either way. `get_artifact` tells agents a draft exists (metadata only) and
  `update_artifact` warns `live_draft`.
- **Modes.** "room" with live rooms on; "solo" under origin isolation without rooms (edit on the
  page alone, Save makes a version; the tab keeps a copy, and after a reload offers to save it as
  a version or discard it); under opaque isolation and the path fallback, docs are edited in the
  source editor only. `ALLOW_LIVE_EDITING=false` turns it off.
- **On the page.** An Edit toggle in the artifact bar (the menu's source editor item becomes "Edit
  source") turns edit mode on; a strip under the bar says what is happening and who else is
  editing, with Save version, Discard and Done. A block opens as a plain text field holding its
  Markdown; blocks other people hold show their email and their text as it arrives. Owners and
  editors who are not editing see one line when unsaved page edits exist, when someone is editing,
  or when a version needs review. Edit mode and comment review mode exclude each other. Draft text
  never reaches the app page in room mode; in solo mode the frame hands it over only to be saved.
- **REST.** `GET /api/v1/artifacts/:ref/live`, `GET .../live/draft` (the draft text, to review a
  conflict), `POST .../live/checkpoint` and `DELETE .../live/draft?rev=n` (discard), for the
  signed-in app only; not mirrored to MCP.

### Categories (decided 2026-11-18)

Owners publish many artifacts for different projects, so each artifact can carry one category: a
short name for the project, repo or client it belongs to. It is the owner's private organisation:
`category` is null for every caller but the owner, and no anonymous surface, upload status, email
or log carries it.

- **Agents set it.** `publish_artifact`, `start_upload`, `POST /api/v1/artifacts` and
  `POST /api/v1/uploads` take `category`, usually the repo or project the agent works in. On
  `update_artifact`, `PUT /api/v1/artifacts/:ref` and `start_upload` with an `id` it is owner
  only: an editor's request that carries it is refused with 403 (`reason: "owner_only"`) before
  any write, upload or rate-limit hit. Leaving it out keeps the current one; agents cannot clear
  it over MCP.
- **Reuse, not near-duplicates.** `list_artifacts` and `GET /api/v1/artifacts` always return
  `categories`, the caller's own names with counts (most-used first, at most 500, whatever the
  filters; `limit: 0` returns only them), and agents reuse one. Every write also normalises the
  name (NFC, every whitespace run, line breaks included, collapsed to one space, trimmed) and
  refuses it when it is empty, over 60 characters, holds control or invisible characters, or is
  made only of spaces, `-` and `_`. It then snaps it onto the
  owner's existing spelling when the two match ignoring case, whitespace, `-` and `_` (`.` and `/`
  are kept). The result echoes the stored name. The `category` filter matches the same way and
  covers the caller's own artifacts only.
- **Not a version.** On an update the category commits in the version's batch, behind the same
  `base_version` guard; a stale or failed commit changes neither. A category-only change creates
  no version and leaves `updated_at` alone, so filing artifacts never reorders the dashboard; a
  title change still bumps it.
- **The owner changes it.** `PATCH /api/v1/artifacts/:ref` with `{ title?, category? }` (the
  `manage` action, owner only, taken-down artifacts included) sets one artifact's category, and
  `category: null` clears it; a body with neither is 400. `GET /api/v1/categories` returns the
  caller's own names with counts, for a session or a token with `artifacts:read`.
  `POST /api/v1/categories/rename` with `{ from, to }` moves every live artifact of the caller's
  whose category matches `from` (by key) to `to`, which snaps onto another of their names (a
  merge); `to: null` clears it. It answers `{ updated, category }`, changes only the caller's own
  rows (and the caller's open upload tickets carrying that name), leaves `updated_at` alone, and
  takes a signed-in session only (CSRF and exact `Origin`): agents and bearer tokens get 403, and
  there is no MCP tool for it.
- **In the app.** The dashboard has a Category menu beside All / Mine / Shared (kept in
  `?category=`, an empty value meaning no category; hidden under Shared), a category badge on the
  owner's rows and cards, a Rename category dialog (rename, merge or remove) and "Move to
  category…" in the row menu, which opens the Category section of the artifact's Settings.
- **CLI and skill.** `plinth publish --category C` sets it on a new publish or, for the owner, on
  an update (`--id`); the CLI never infers it. The agent skill (plugin 0.12.0) tells agents to set
  it from the repo or project on a new publish, reuse a name from `categories`, and leave it out on
  updates.

### Comments and agent mentions

Comments are threaded and can be pinned to an element on the page. Mentioning an agent (`@claude`,
`@codex`, or a connection label) creates a task. Two delivery modes:

| Mode | How it works | Who pays for tokens | When |
| --- | --- | --- | --- |
| Pull | The task waits in a queue. The owner's agent reads it through `list_mentions` in a session or on a schedule, publishes a new version and replies. In Claude Code the plugin's mention watcher (its own `mentions`-only connection) polls every 30 seconds and wakes open sessions when a request arrives | The user's own Claude or Codex subscription | v1 |
| Push | The platform calls the Anthropic or OpenAI API as soon as the mention is posted, with the artifact, the thread and a scoped token | The user's own API key, or a paid plan on the hosted instance | Later |

Rules for both modes: only the owner's connected agents can be mentioned, only commenters and
editors can mention them, and an agent's change is always a new version that anyone can revert.

A page that declares `comments` places its own anchors instead (a point on a canvas, a slide, a
node in a diagram): it opens the composer, and the person writes and posts the comment. See
[Comments from the page](#comments-from-the-page-decided-2026-11-19). Agents read either kind of
anchor in `list_comments` and in mention tasks, as untrusted data like the comment text.

### Shared data and viewer identity

Decided 2026-11-14 (issue #1). Design:
`docs/superpowers/specs/2026-11-14-shared-state-design.md`.

- **Target use.** Polls, sign-up sheets and trackers among invited people. Not app-like prototypes
  open to anyone with the link, and not public forms.
- **The page stays static.** Plinth adds one fixed, generic service per artifact: collections of
  JSON documents, shared by every version, served on the artifact's own content origin at
  `/__plinth/api/v1/`, plus a runtime script at `/__plinth/runtime.js` that defines
  `window.plinth` (`ready`, `viewer`, `canWrite`, `db.collection(name)` with `list`, `all`, `get`,
  `add`, `set`, `update`, `delete`, `mine`, `setMine`, `deleteMine`, `onSnapshot`). The CSP's
  `connect-src 'self'` already allows it: no CSP change, no CORS, no app cookies on the content
  host.
- **Declaration.** A page opts in with `<meta name="plinth-capabilities" content="data viewer">`
  (`data`: the store; `viewer`: the page may learn who is viewing and who wrote each document),
  and optionally `<meta name="plinth-data-shared" content="tasks">` for collections any writer may
  edit. `viewer` without `data` declares nothing (the viewer is learned through the data API). The
  declaration is parsed at publish into `versions.capabilities`; the current version's
  declaration governs, also for old version URLs. Dropping the tag switches the page API off and
  keeps the data. The same tag also takes `room` ([live rooms](#live-rooms)) and `comments`
  ([comments from the page](#comments-from-the-page-decided-2026-11-19)), neither of which is shared
  data.
- **Writers.** Only identified viewers write: the owner and people with a grant on the artifact
  (viewer, commenter or editor, confirmed by sign-in or email code). Anonymous link viewers
  (unlisted, password, public) read but never write. Every write is stamped by the server with the
  writer's email, role and channel (`page`, `agent`, `app`); a page cannot spoof it. A document can
  be changed by its creator, the owner and editors, or by any writer in a declared shared
  collection; a personal document (`~me`, id `u_` + a per-artifact hash of the email) only by its
  person, with the owner and editors able to moderate.
- **Viewer identity.** The gate seals `{ email, role }` (AES-GCM, key derived from
  `TOKEN_SIGNING_KEY`) into the enter token, and the content host copies it into the per-artifact
  content cookie (`__Host-` prefixed, so a sibling artifact cannot toss in someone else's; a
  request whose valid passes disagree on who is viewing has none). Only identified viewers get a
  claim, and only while shared data or [live rooms](#live-rooms) are active; everyone else is
  anonymous to the page.
  `window.plinth.viewer` is `{ id, email, role }` or null; `email` is set only when the page
  declares `viewer`, and `id` is opaque and different on every artifact. The app tells the viewer
  in one line under the bar what the page saves and whether it can see who they are.
- **Concurrency.** Page writes are last-writer-wins unless they pass `ifRev`; `update(fn)` reads,
  applies and retries on conflict. Every agent op needs `if_rev`. A document's `rev` is one past
  the artifact's change counter, so revs grow across the artifact and a document deleted and
  created again never repeats one. Data is not versioned and is not part of diffs or restores.
- **Live updates.** No push for data: `onSnapshot` polls a one-row change counter every 15 s while
  the tab is visible (at least 10 s), and refetches when it moves, at once after the page's own
  write. A page that also declares `room` can push its own moments (a note being dragged, "note 3
  saved, refetch it") to the people who have it open; see [Live rooms](#live-rooms). The poll is
  unchanged.
- **Limits** (env vars): `ALLOW_SHARED_DATA` (on), `DATA_MAX_DOCS_PER_ARTIFACT` (1000),
  `DATA_MAX_BYTES_PER_ARTIFACT` (1 MiB), `DATA_MAX_BYTES_PER_USER` (16 MiB across an owner's
  artifacts), `DATA_MAX_DOC_BYTES` (16 KiB), `DATA_WRITES_PER_VIEWER_PER_HOUR` (300) and
  `DATA_WRITES_PER_ARTIFACT_PER_HOUR` (2000). Fixed: 50 collections per artifact, nesting depth 16,
  200 documents per page, 50 ops per agent call.
- **Lifecycle.** Data is deleted with the artifact and wiped on takedown (a write already in flight
  cannot bring it back), scrubbed of a person on
  `erase-user`, and kept across new versions and restores. Any grant, visibility or password change
  bumps the access epoch and ends existing content cookies and their claims, as before. The owner
  can delete all shared data from the Share dialog.
- **Opaque isolation.** Under `CONTENT_ISOLATION=opaque` there are no cookies, so shared data and
  identity are unavailable; `plinth.ready` resolves `{ available: false, reason:
  "opaque_isolation" }` without a request. Under the staging path fallback (always opaque) the
  page lives at `APP_HOST/__content/<id>/`, so `/__plinth/runtime.js` resolves to the app host and
  does not load: `window.plinth` is undefined, and pages guard with `window.plinth?.`.
- **Agents.** `list_artifact_data` and `write_artifact_data` (MCP) and REST mirrors under
  `/api/v1/artifacts/:ref/data` for the owner and editors. Viewer-written data is untrusted input,
  and the tool descriptions say so.

### Live rooms

Decided 2026-11-18 (issue #36). Presence and broadcast among the people who have one artifact
open: live cursors, who is here, a note moving while it is dragged. Nothing in a room persists;
durable state belongs in [shared data](#shared-data-and-viewer-identity), which is also where a
late joiner reads it. Plinth's own on-page doc editing is the room's first use.

- **Declaration.** A page opts in with `room` in `<meta name="plinth-capabilities">` (for example
  `content="data viewer room"`), and may list topics commenters may emit too with
  `<meta name="plinth-room-open" content="cursor note.move">` (`*` opens all; at most 16, each
  `^[a-z][a-z0-9_.:-]{0,39}$`). `room` is not shared data: a page that declares only `room` has no
  store. The current version's declaration governs, as for data.
- **Page API.** `window.plinth.room` in `/__plinth/runtime.js`: `ready` (resolves `{ available,
  reason, you, canEmit(topic) }`, never rejects), `presence(patch)` (a shallow merge of the
  sender's state, `null` values delete, `presence(null)` clears; coalesced to 10 per second, 400
  bytes), `onPeers(fn)`, `emit(topic, data)` (never echoed to the sender), `on(topic | "*", fn)`,
  `onStatus(fn)`, `join(name)` for a sub-room on the same socket (3 at most, `main` by default)
  and `leave()`. Nothing connects until first use. Messages may drop, and order holds only per
  sender. Every peer is stamped by the server: `id` is random per socket, `viewer` the per-artifact
  `u_` id, and `role` and `email` appear only when the page also declares `viewer`. Such a page
  shows each identified viewer's email to the page and to the others in the room, so the viewer
  gets one line under the bar saying so, with or without shared data. Room traffic is untrusted
  input and presence is never authority.
- **Who joins.** Identified viewers only (the owner and people with a grant, signed in or confirmed
  by code). Anonymous link viewers, in-chat previews and thumbnail captures never join in v1.
  Owners and editors emit any topic, commenters only the open topics, and viewers never emit, even
  an open topic (as Claude's artifact `room` capability, which never lets a plain viewer emit).
  Viewers still join, set presence and receive; `canEmit(topic)` and the availability check's
  `can_emit` (`all`, `open` or `none`) say which applies. Agents never join a room.
- **Transport.** One WebSocket per page to its own origin, `wss://<id>.<CONTENT_HOST>/__plinth/room/v1/page`,
  served by the artifact's Durable Object with the Hibernation API. The handshake is checked in
  order: method, exact `Origin`, fetch metadata, the `plinth.room.v1` subprotocol, rooms active,
  the artifact, the content pass with its identity claim at the current epoch, the kind the path
  names (after the pass, so a caller without one learns nothing about the declaration), and policy
  (`roomAccess` in `policy.ts`); see [docs/security.md](security.md#live-rooms).
  `GET /__plinth/api/v1/room` (behind the data API's caller checks) tells the runtime first
  whether it may join and why not (`disabled`, `not_configured`, `opaque_isolation`,
  `not_declared`, `preview`, `not_identified`, `expired`). The CSP's `connect-src` names the
  artifact's own `wss:` origin while rooms are active, and nothing else.
- **Lifecycle.** A sharing change (grant, visibility, password) ends the socket (close code 4401),
  as it ends the content cookie; a takedown or delete closes everything (4404); a version that
  changes what the page declares about rooms makes its sockets reconnect (4410). The Worker tells
  the room after each change, and while sockets are open the room re-checks D1 every 60 s and
  closes sockets whose pass expired. A tab hidden for 60 s closes its socket and reconnects when
  shown; reconnects back off from 1 to 30 s.
- **Limits.** The `ROOM_*` env vars under [Data model](#data-model) settings, behind
  `ALLOW_ROOMS` (on); a socket over the message rate gets errors, then is closed.
- **Availability.** Only with origin isolation and the `ROOMS` binding. Under opaque isolation (and
  the path fallback) `room.ready` resolves `{ available: false, reason: "opaque_isolation" }`
  without a request. A page should work alone when the room is unavailable.

### Who is viewing: names and the people list (decided 2026-11-19)

A page that may see who is viewing also sees each person's display name, and a page whose owner
and editors need to see who has access can list them. The access list is never a visit log and
never a directory.

- **Display names.** `users.name` is the person's display name, set in the app ("Your name…" in
  the account menu) or with `PATCH /api/v1/me`. On write it is stored NFC with whitespace runs
  collapsed and trimmed, at most 100 characters, with no `@`, no character whose compatibility
  (NFKC) form is `@` (U+FE6B, U+FF20, which render as one) and no control, format (bidi,
  zero-width) or separator characters; an empty name clears it. Pages, rooms and agents get it
  cleaned on every read (refused characters and every form of `@` dropped, at most 64 code points, `null` when
  nothing is left), so names stored before these rules comply too. People confirmed by code
  without an account have no name. A name is display text, never authority: `role` stays
  server-derived beside it.
- **Read live, never sealed.** The name is read from `users` by the identity email (the owner's
  own, or the one holding the grant) whenever a response needs it. It is not in the content pass or
  stored with shared data, so a rename shows on the next read (in a room, on the next connect) and
  `erase-user` removes it everywhere.
- **Where a page sees it.** Exactly where it sees an email, under the same rule (`viewer` declared,
  reader identified): `plinth.viewer` is `{ id, email, name, role }`; document authors
  (`createdBy`, `updatedBy`) are `{ email, name, role, via }`; room peers, event senders and
  `room.ready.you` carry `name` beside `email`. Link viewers, previews and captures see none.
- **People list.** `people` in `<meta name="plinth-capabilities">` (`content="data viewer
  people"`) lets the owner and editors list everyone the artifact is shared with: the owner, then
  every grant by email, each with its `u_` id, email, name and role. It counts only with `data` and
  `viewer` and declares nothing on its own; it is stored in `versions.capabilities` only when
  declared, so every other declaration is stored as before. `GET /__plinth/api/v1/people?q=&limit=`
  returns `{ people, total }` (`limit` 1 to 201; `q`, at most 100 characters, keeps people whose
  name or email contains every term) and `GET /__plinth/api/v1/people/<u_id>` one person, or 404
  when the id is nobody with access now. Each entry has `you` on the reader's own row. The
  runtime adds `plinth.canListPeople` (from the session's `can_list_people`) and
  `plinth.people.list({ q, limit })` and `plinth.people.get(id)`. Commenters, viewers, link
  viewers, previews and captures are refused (`forbidden`, or `unavailable` with `not_identified`,
  `not_declared`, `preview`, `disabled` or `opaque_isolation`); reads are limited to 600 per hour
  per reader per artifact. The routes are entries of the shared-data route table, so the data API's
  ten checks run first (see [docs/security.md](security.md#the-people-list)). Search runs only over
  that one list: nothing takes an arbitrary email or name and says whether it has an account.
- **Names on the access list.** The owner types every grant's address and its holder is not told,
  so an access list (the people list for the page, agents and REST, and the owner's sharing
  settings) shows a grant holder's name only once that person has taken part in the artifact:
  written a comment, a shared-data entry or a version of it, each of which already shows their name
  to the people who can read the list. The owner's name and the reader's own row are always shown.
  Until then the entry has `name: null`, exactly like an address with no account, and `q` does not
  match the name, so adding addresses never tells the owner which have an account or what they are
  called (`policy.ts accessListShowsName`).
- **Telling the viewer.** The gate's `people` block (`name`, `list`) adds to the line under the
  bar: the name the page sees beside the email, and, on a page that declares `people`, "The owner
  and editors can see everyone this page is shared with", shown to every identified viewer since
  their address is on the list.
- **Agents and REST.** No new MCP tool. Document authors gain `name` for owners' and editors'
  agents on any page, beside the `viewer_id` that already tells whose a `u_` document is (only its
  person can create it). The access list reaches agents only where the page offers it: when the
  current version declares `data viewer people` and shared data is on (`policy.ts
  peopleListOffered`, the same answer the page route and the notice use), `list_artifact_data`
  without a collection also returns `people` (`{ viewer_id, email, name, role }`, the same list),
  and `GET /api/v1/artifacts/:ref/people?q=` mirrors it (policy action `people`: owners and
  editors, `artifacts:read`; 403 `feature_disabled` with the reason otherwise). Without the
  declaration only the owner sees the access list, in the sharing settings, as before; the owner's
  `GET /api/v1/artifacts/:ref/sharing` gains `name` on each grant under the rule above. Names are
  untrusted for agents and the tool descriptions say so.
- **Availability.** With shared data: under opaque isolation, or with `ALLOW_SHARED_DATA` off, the
  people routes refuse and the session reports `can_list_people: false`. Names follow identity
  claims (`ALLOW_SHARED_DATA` or `ALLOW_ROOMS`). There is no switch of its own: the list is opt-in
  per page and shown only to the people who already run the page.
### Comments from the page (decided 2026-11-19)

A page whose things have no stable element (a point on a `<canvas>`, a WebGL scene, a slide, a node
in a pan-and-zoom diagram) can take comments on them: its own code opens Plinth's comment composer
with an anchor it chose, and learns which threads are anchored where, so it can draw its own
markers and tell Plinth where to draw its pins.

- **Declaration.** `comments` in `<meta name="plinth-capabilities">` (for example
  `content="comments"`), HTML artifacts only. It is neither shared data nor a room: a page that
  declares only `comments` has no store and no room. The current version's declaration governs, as
  for data and rooms, and the viewer gate says so with `page_comments: true`.
- **Page API.** `window.plinth.comments` in `/__plinth/runtime.js`. Nothing is sent until the page
  first uses it.
  - `ready` resolves `{ available, reason }` and never rejects. The reasons are `not_framed` (a
    direct content link, a thumbnail capture), `no_app` (no answer from Plinth within 3 s: an
    in-chat preview, the editor preview, history compare, or an old app) and `not_declared`.
  - `compose(anchor?)` opens the composer, with an anchor or none, and resolves
    `{ status: "posted", id }`, `{ status: "closed" }` or `{ status: "busy" }`. It rejects with
    `unavailable`, or with `invalid` when the anchor breaks the limits (checked in the page). An
    optional field set to `undefined` counts as absent. Each request settles when the app answers
    it: a later `compose` does not end an earlier one, since the app may refuse the later one and
    keep the earlier anchor in the composer (an accepted later request replaces an earlier one
    that nobody wrote for, which then settles `closed`).
  - `onThreads(fn)` gets the page-anchored threads, oldest first: `{ id, pin, status, anchor }`,
    resolved ones included, as frozen copies, and is called at once with the latest list.
  - `locate(fn)` says where an anchor is now, as a point `{ x, y }` or a box
    `{ left, top, width, height }` in the frame's viewport, or null. Without it Plinth draws no pin
    for page anchors.
  - `refresh()` runs `locate` again after the page moved things (coalesced, at most 20 a second).
  - `open(id)` shows a thread in the panel.
  - `onFocus(fn)` hears when the person picks a page-anchored thread in the panel or by its pin.
- **The person posts.** A page never posts a comment and cannot fill in its text: the person writes
  it and presses Comment, through the comments API with their own session, rate limit and role. A
  link viewer still sees "Sign in to comment". So page code cannot turn into mention tasks under a
  collaborator's name. The page learns `posted` only after a comment was posted and `busy` only
  while someone writes one. A request from a viewer who cannot comment is held like any other and
  ends `closed` only when the panel closes or a later request replaces it, as for a commenter who
  has written nothing, so neither the answer nor its timing says whether the viewer can comment.
  No page request moves focus: the panel opens, or shows the thread, with focus where it was, and
  the person clicks or tabs into the composer. Keystrokes meant for the page never land in a
  comment, and where focus goes says nothing about the viewer's role.
- **No comment text in the frame.** Plinth tells the page thread ids, pin numbers, status and
  anchors (a page anchor's key, coordinates and data, or an element's selector) and request ids.
  Never comment bodies, authors, emails, roles, mention state, an anchor's label or an element's
  text excerpt. A page anchor's key, coordinates and data are written by the page's code or by any
  commenter (the comments API takes page anchors from anyone who may comment), so they are
  untrusted input for the page too: render them as text, never as HTML.
- **Page anchors.** `{ kind: "page", key, x?, y?, text?, data? }`: `key` names what the page anchors
  to in its own terms (`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`), `x` and `y` are page coordinates
  (finite, within ±10⁹), `text` is a label of at most 120 characters for the composer's chip, and
  `data` holds at most 16 flat page-defined fields (keys `^[A-Za-z][A-Za-z0-9_]{0,31}$`; strings of
  at most 200 characters, finite numbers, booleans or null; 1 KiB as JSON). The schema is strict:
  anything that says `kind: "page"` is a valid page anchor or is refused. Element anchors keep their
  shape and are stored without `kind`. The server accepts page anchors on any comment its author may
  post, with or without the declaration, as it accepts element anchors outside review mode; both
  are untrusted data.
- **No review-mode reload.** For a declaring page the app does not enter review mode: opening the
  panel does not reload the frame, so a canvas, a zoom level or form input survives, and the gate
  ignores `review` (so `?comments` deep links stay reload-free too). The bridge is not injected, the
  runtime positions element anchors itself, and "Pin to an element" is hidden.
- **Limits in the app.** At most one compose a second is accepted, only after the page said hello,
  while the tab is visible and no dialog is open; a compose while someone is writing is `busy` and
  leaves the draft and its anchor alone. `open` is refused while the tab is hidden or a dialog is
  open. A request that would open a closed panel, compose or `open`, is accepted at most once a
  second, the two together. No page request moves focus. At most 4 `open` and 20 position reports
  a second, and 500 threads. A page can at worst reopen a panel the person closed, once a second;
  the report link covers a page that abuses it.
- **Availability.** Origin and opaque isolation alike: the app identifies the frame by its window
  (and, under origin isolation, its exact origin) and posts to it with the exact content origin, or
  `"*"` under opaque isolation, which is safe because the messages hold nothing the framed document
  may not see. The runtime posts only to `window.parent` at the instance's app origin and listens
  only to it. Not under the staging path fallback, where `/__plinth/runtime.js` does not load.
- **Agents.** No new tool. `list_comments`, `list_mentions` and the REST comment routes return page
  anchors with `kind: "page"`; agents read `key`, `x`, `y` and `data` to find what a thread is
  about, and treat every anchor as untrusted.
- **Settings.** None: the feature adds no server behaviour, cost or quota beyond the comment API's.
### Design systems (decided 2026-11-19)

A design system is a reference artifact that later work is built on: design tokens, components with
live previews, and guidelines. Agents read it before they make a page, so the pages a person asks
for look the same. It is the fourth artifact type, `design_system`, beside `html`, `doc` and
`slides`.

- **Format.** One JSON file, `system.json`, in format `plinth.design-system/1`: `name`,
  `description` (Markdown), `prefix` (CSS variables are `--<prefix>-<path>`, default `ds`), `fonts`
  (a Google Fonts `css2` URL, or a font file among the version's assets), `tokens` (a subset of the
  W3C Design Tokens Community Group format, 2025.10: groups, `$value`, `$type` set on the token or
  inherited from its group, `$description`, `$deprecated`, and aliases such as
  `{color.brand.500}`), `themes.dark` (overrides of existing tokens, `$value` only), `guidelines`
  (Markdown), `css` (shared by every component) and `components` (each with HTML examples and its
  own CSS). Token types: color, dimension, fontFamily, fontWeight, duration, cubicBezier, number,
  shadow, typography and border. Unknown keys are refused, so typos fail loudly. Limits: 1 MB of
  JSON, 2,000 tokens nested at most 8 deep, alias chains of 16, 200 components of 1 to 20 examples
  (20 KB of HTML each), 200 KB of guidelines, 100 KB of shared CSS. Assets are images and fonts.
- **Validation.** One parser (`packages/shared/src/designSystem.ts`) serves the Worker, the
  renderer and the editor. A publish, update or bundle that does not parse is refused with
  `invalid_input` and up to 50 problems, each with its path into the JSON. Every string that
  reaches CSS passes one value grammar (no `;`, braces, angle brackets, backslash, `@`, quotes or
  line breaks; no `url(`, `expression(` or comments; at most 256 characters), font family names are
  quoted by Plinth, and the `css` blocks may not hold `<` or `@import`, because the compiled CSS is
  copied into other pages. Non-fatal problems are publish warnings: `ds_inert_markup` (an example
  holds script, a handler, a form, a frame or a meta), `ds_missing_font`, `ds_no_dark_theme` and
  `ds_deprecated_alias`. They count toward the publish's cap of 50 warnings with the reference
  warnings. Restore copies stored files without checking them again, as for docs.
- **Typography.** A typography token compiles to one variable per part
  (`--<prefix>-<path>-font-size` and so on) and a `font` shorthand that reads them. When
  `themes.dark` adds a part the light value lacks, or leaves one out, the part's variable is still
  set in both themes, to `normal` where that theme has no value (what its shorthand resets the part
  to), so neither theme's shorthand reads a variable the other alone defines.
- **The site.** A fixed Plinth renderer on the artifact's own origin (`/__plinth/types/design_system/`,
  `script-src 'self'`, like a doc) shows the overview and guidelines, the tokens by kind (colors,
  typography, spacing and sizes, radii, shadows, motion, others) with light and dark samples, CSS
  variable names and copy buttons, and every component with live previews in light, dark or both at
  360 px, 768 px or full width, beside its HTML and CSS. Guidelines, descriptions and usage follow
  the doc type's Markdown rules. The site's own chrome uses Plinth's neutral styles; the design
  system's tokens and CSS apply only to samples and previews. Navigation is by hash
  (`#tokens/color`, `#components/button`).
- **Previews.** Each example renders in its own `srcdoc` frame with `sandbox="allow-same-origin"`
  and nothing else, so no script runs in it whatever the markup holds, and nothing in it submits,
  opens popups or navigates the page. The frame inherits the shell's CSP. The example HTML also
  passes an allowlist sanitizer (no script, handlers, frames, forms, links out, or outside URLs).
  Under opaque isolation the frames inherit the sandbox and are opaque too. Previews that need
  script are not supported; states are shown with classes.
- **Reading one from an agent.** `get_design_system` and its REST mirror read a design system as
  the caller, through the policy module with the `view` action: the owner, people it is shared with,
  and anyone with the link when it is unlisted or public (agents never pass a password). An artifact
  of another type is refused only after the access decision, so a caller who cannot view it gets the
  same 404 as for a missing id. The result has `css` (a `:root` block, then the dark theme for
  `prefers-color-scheme: dark` unless the page set `data-theme="light"`, and for
  `data-theme="dark"`), `font_links`, `fonts` (with `portable: false` for the design system's own
  font files, which another artifact cannot load), `tokens` with resolved light and dark values,
  `guidelines`, `component_css` and `components`; `include` and `components` trim it. A stored
  version that no longer parses returns its `problems`. Every result says `untrusted: true`.
- **Building on one.** Pages cannot load another artifact's files: the agent copies the CSS it uses
  into the page it publishes, and names the design system in the page's head with
  `<meta name="plinth-design-system" content="<id>@<version>">`. On publish the server checks that
  reference once, as the publisher: `design_system_outdated` when a newer version exists, and one
  `design_system_unavailable` message for every other case (missing, deleted, not viewable, taken
  down, another type). `get_artifact` on such a page returns
  `design_system: { id, title, version, current_version }` when the caller may view the design
  system, or `null`; pages without the meta get no field. The meta is read from the first 256 KB
  before `<body>` in one forward pass, as a browser would read the tag: comments are skipped (an
  unclosed comment or tag runs to the end, so nothing after it counts), and a page that never
  mentions `plinth-design-system` is not scanned at all.
- **In the app.** The source editor holds the JSON with Monaco's JSON language and the format's
  JSON Schema, shows the parser's problems under the editor and keeps Save off until there are
  none. The dashboard shows a "Design system" badge and a "Design systems" filter when there is
  one. The artifact menu's "Copy for an agent" copies a line with the design system's link and id,
  never its title.
- **Not in v1.** No runtime loading across artifacts (it would need CSP sources for other artifact
  origins and a content pass for two artifacts), no script in previews, no on-page or live editing,
  no themes other than `dark`, and no copying of font or image files between artifacts.
### Slides (decided 2026-11-19)

A presentation is a deck: the agent writes Markdown, Plinth renders fixed slides. It is the second
[typed output](#mcp-interface), after docs, and works like one: `publish_artifact` and
`update_artifact` take `type: "slides"` with the Markdown in `content`, a version stores
`slides.md` and its images, and versions, `base_version` conflicts, restore, history and the
source editor work as for docs. A deck is not edited on its page.

- **Source format.** A line that is exactly `---` (outside fenced code) separates slides; the split
  happens before Markdown, so `---` under a line of text is never a heading. Optional front matter
  when line 1 is `---` and a closing `---` follows within 20 lines of `key: value` lines: `aspect`
  (`16:9`, the default, or `4:3`), `theme` (`auto`, `light`, `dark`), `paginate` (`true` or
  `false`) and `footer` (plain text, at most 120 characters). The first line of a slide starting
  `Note:` or `Notes:` starts its speaker notes, up to the next slide (`\Note:` is a literal
  paragraph). Lines `|||` split a slide into 2 or 3 columns under what comes before the first one.
  `#N` links to slide N. Otherwise the doc's Markdown rules apply unchanged: raw HTML shows as text,
  links pass the allowlist, images are the deck's own files or inline raster `data:` URLs. Limits:
  1 MB of Markdown, at least 1 and at most 500 slides, images only as assets. The parser is one
  module (`packages/shared/src/slides.ts`) for the Worker and the renderer.
- **Look.** Every slide is laid out on a fixed canvas, 1280x720 or 1024x768 CSS pixels, and scaled
  to fit, so text wraps the same everywhere. Layouts come from content: a title slide (one `#`
  heading and up to two short lines), a section slide (one `##` heading), an image slide (one
  image, with or without a heading), columns, and the default. Text that does not fit shrinks in
  steps to 55%; a slide that still overflows is marked in presenter view and the overview. Light,
  dark or `auto` (the viewer's scheme on screen, light in print), system fonts, slide numbers and
  the footer.
- **Viewing.** Keys (arrows, Page Up and Down, Space, Home, End, a number then Enter), clicks or
  taps on the outer thirds, swipes and `#N` links page the deck; `o` shows every slide stacked (the
  overview), which is also what phones in portrait, review mode (so comment pins anchor to every
  slide) and the editor preview show. The app keeps the slide in its URL fragment (`#slide=N`,
  never sent to the server), so a reload or a shared link opens the same slide, and a newer
  version's frame is sent back to it.
- **Presenting.** Present (in the bar) puts the app's own frame full screen; the frame gets no
  fullscreen permission of its own, and presenter view stays presenter view when it goes full
  screen. Presenter view (in the menu, or `s`) shows, inside the frame,
  the current slide, the next one, the notes, an elapsed timer with pause and reset, the clock and
  the slide count. The frame tells the app each view it switches to, so the app's presenter strip,
  the paused version swap and the audience window follow the deck however presenter view was
  opened or left (the menu, the strip's Exit, `s`, Escape or the frame's own controls). Review mode
  keeps the overview whatever asks for another view. "Audience window" opens a second app window that follows the presenter's slide
  through a `BroadcastChannel` on the app origin in the same browser, in every isolation mode; only
  slide numbers cross it. While the deck is full screen or in presenter view, a newer version does
  not replace the frame: the strip says it was published and Show loads it on the same slide, and
  the deck catches up when presenting ends. A permanent version link (`/a/<slug>/v/<n>`) stays on
  its version: its strip never offers a newer one, and its audience window opens that same version.
- **Printing.** "Print or save as PDF" prints one slide per page at the deck's size (an `@page`
  size in inches); "Print with speaker notes" prints a handout with each slide over its notes. The
  frame prints itself, after its images have decoded. Browsers that ignore `@page` sizes print on
  their own paper size, one slide per page.
- **Speaker notes are not secret.** Anyone who can open the deck can read them (presenter view,
  the handout, the source). Agents treat deck text, notes included, as untrusted data.
- **Warnings.** A publish lists `slides_setting`, `slide_empty`, `slide_dense` and `missing_file`
  for the deck (see [Big builds](#big-builds-and-reuse-by-hash), "Publish warnings"); they never
  block. A deck with no slide or more than 500 is refused with a fix-it message. A warning that
  quotes deck text writes its control characters as `\uXXXX`, as every publish warning that quotes
  a caller's file does.
- **Uploads and the CLI.** `start_upload` with `type: "slides"` (or the `id` of a deck) takes a
  folder with `slides.md` and its images at its top. The Plinth CLI publishes such a folder as a
  deck (`plinth publish <dir>`), updates one with the Markdown in `content` (`--id`), and sends one
  with `plinth upload`, the `commands.npx` that `start_upload` returns.
- **Security.** Deck Markdown and notes are rendered only on the artifact's content origin. The app
  and the frame exchange only slide numbers, counts, view names and booleans (renderer protocol
  version 1: `goto`, `view` and `print { notes }` from the app; `ready`, `position`, `view` and
  `fullscreen` from the frame); see [docs/security.md](security.md#typed-artifacts).
- **Not in this slice.** `.pptx` export and following a presenter over a live room come later;
  transitions, builds, custom themes and fonts, math, diagrams and video are not planned for
  slides.

### Publishing from CI (decided 2026-11-19)

Issue #51. A pipeline (a coverage report, a benchmark page, docs previews, a nightly report)
publishes each run as the next version of one artifact, so the link stays the same and history
keeps every run. Guide: `docs/ci.md`.

- **The GitHub Action** lives in this repository at `publish/` and is used as
  `mr0b0t0/plinth/publish@v<release>`. It is versioned by the release tags (`v<CLI version>`,
  immutable); there is no moving major tag, and `pnpm release` moves the pins in the docs and the
  app. It is a JavaScript action (`node24`) that imports the CLI client from the same commit
  (`packages/cli/bin/client`, no dependencies and no build), so a tag or SHA pin pins everything and
  nothing is fetched from a registry at run time. Linux and macOS runners.
- **Inputs**: `token` (a secret), `path` (a build folder, or one `.html`/`.md` file), `id`, `url`
  (the instance, hosted by default), `title` and `category` (a new artifact only), `note`,
  `link-run`, `base-version`, `include-maps`, `dry-run`, `fail-on-warnings`, `summary`. **Outputs**:
  `id`, `slug`, `version`, `url`, `version-url`, `compare-url`, `outcome` (`published`,
  `nothing_to_publish`, `already_published`, `dry_run`, `conflict`, `unknown` or `error`),
  `current-version` (on a conflict), `verified`, `warnings` and `json` (the CLI's `--json`). The
  step's exit code is the CLI's (3 on a conflict, never retried); `fail-on-warnings` turns a
  published run with warnings into 1. `not_scanned` and `live_draft` need no action: they get no
  annotation and are not counted by `warnings` or `fail-on-warnings`. On a conflict the summary
  says to re-run when the step has no `base-version` (someone published while it was sending), and
  to check what changed and set `base-version` to the current version when it has one (a re-run
  with the same one stops the same way).
- **Which artifact.** `id`, else the artifact the token is limited to, else a new private
  artifact (the summary then says to add `id:`). A token limited to one artifact with an `id` that
  names another artifact fails with exit 2 before anything is sent, and so does `base-version`
  with no artifact to update.
- **Outcome unknown.** When the answer to a sent build is lost, the summary and the error name the
  safe re-run: with `base-version` set to the version the build was sent against, which sends
  nothing if the build landed. It never says a plain re-run is safe: without `base-version` a
  re-run publishes the build again, and without `id` it creates another artifact.
- **Version note.** By default `<commit subject> (<short sha>)` (the push's head commit, else the
  pull request title, else the checkout's last commit, else `<workflow> #<run number>`), at most
  500 characters (UTF-16 code units, as the server counts them, never splitting a character),
  keeping the SHA. `note: "-"` sends none. `link-run: true` appends the run's URL;
  it is off by default because the note, like the token's label, is shown to everyone who can
  view the artifact's history.
- **Untrusted text.** Everything the client prints runs between `::stop-commands::<random>` and
  `::<random>::`, so no server message, warning, title or path is read as a workflow command;
  annotations escape their text, the job summary escapes Markdown and HTML, and outputs are written
  with random heredoc delimiters. Outputs (above all `json`, which carries the title) are untrusted
  for the workflow too: `docs/ci.md` passes them to scripts through `env:`. The token is masked and
  reaches the client only in its environment, never in argv, outputs or the summary.
- **Tokens limited to one artifact** ([Auth and permissions](#auth-and-permissions)) are the
  recommended credential: the artifact's Settings page has **Publish from CI**, which makes one and
  shows the workflow step with the id filled in. The Connections page can make one too ("Limit to
  one artifact"), and lists a bound token as "Only <title>".
- **Other CI and cron** use the CLI with an exact version (`npx @mr0b0t0/plinth@<version>
  publish`), with `PLINTH_TOKEN` (and `PLINTH_URL`) from the environment.

### Big builds and reuse by hash

Decided 2026-11-15. Agents publish built sites (a Vite or similar `dist/` folder with hundreds of
files) and big pages without merging chunks, and an update stores only what changed. Guides:
`docs/agents.md#large-builds`, `docs/mcp.md`, `docs/security.md`.

- **Reuse by sha256, inside one artifact.** An asset may be sent as `{path, sha256}` (lowercase hex
  SHA-256 of the bytes) instead of its content. The server reuses the bytes of the current version's
  file with that hash, under the new path and content type, and records where the object is stored
  (`stored_at`). A hash the current version does not have is refused with `missing_paths`; content
  sent with a `sha256` that does not match is refused. Sent content whose hash matches a current
  file is reused too, so a bundle stores only changed files. Hashes never match across artifacts.
  An update without `assets` keeps every current asset, and a restore references the old
  version's files; neither copies an asset. `stored_at` always names the object's first location,
  never a chain, and is confined to the artifact's own prefix on every read (`STORED_AT_RE`,
  `ASSET_PATH_RE`, a version number no higher than the reading version). R2 objects are never
  deleted one version at a time; deleting or erasing the artifact removes all of them.
- **Commit last.** A version's objects go to R2 first, under a prefix unique to the write attempt
  (`v<n>.<nonce>/`). Then one guarded D1 batch inserts the artifact row (a new artifact), inserts
  the version row, advances `current_version` and, for an upload, marks the ticket `used`. The
  batch checks the base version, the artifact count, the storage quota and the ticket inside the
  transaction, so all of it applies or none of it does. When the batch fails with an ambiguous
  error (anything but a UNIQUE violation), the commit reads back whether its version row exists:
  if it does, the publish succeeded; if that cannot be read, the attempt's objects are kept; only
  when the row is known to be absent are they deleted. Every attempt records its prefix in
  `staging_attempts` (prefix, artifact id, start time) before its first put; the batch requires
  that row, unclaimed and younger than the sweep threshold, and deletes it. Whatever deletes an
  attempt's objects claims its row first (an `UPDATE ... RETURNING` that moves `started_at` below
  every cutoff) and deletes the row only once the objects are gone, so a failure in between leaves
  the claimed row for the next sweep. An abort claims the row, deletes the prefix, then the row.
  With no row to claim it looks for a version naming the prefix: one there (a commit batch D1
  applied after reporting an error) keeps the objects; none means the row was lost (an
  attempt from before tombstones, whose row a delete, takedown or erase removed), so the abort
  parks a fresh row and deletes the objects like any other. A
  killed request can leave only unreferenced objects under its own prefix, with its row. An hourly
  cron trigger (`0 * * * *`) sweeps them: it claims at most 50 rows older than the ticket's
  lifetime plus 15 minutes (and rows claimed more than 10 minutes earlier, longest-claimed first)
  and deletes the objects only of rows it claimed and no version names (by `r2_prefix` or a
  `stored_at`). Minting an upload ticket and posting a bundle also start a sweep of at most 20 rows
  after the response (at most once per Worker isolate per minute), so an instance with no cron
  (`wrangler dev`: local, tunnel, Docker) clears them too; D1 runs each claim as one statement, so
  sweeps that overlap never take the same row. Because the
  commit needs the row unclaimed, a commit after a claim is refused with a retryable `conflict`
  (`reason: "attempt_expired"`) whatever the committer's clock, and a claim after a commit finds
  nothing. Deleting, taking down or erasing an artifact parks its rows as tombstones in the same
  batch (or statement list): no sweep takes one until the ticket's lifetime plus 15 minutes have
  passed, so whatever an attempt that is still running puts afterwards stays under its row, and its
  own abort or that later sweep deletes it. A delete's and an erase's files go with the root; a
  takedown deletes the attempts' files after its batch and keeps the rows. The version
  insert also requires the artifact not to be taken down, so an update or restore that passed its
  edit check before a takedown never commits after it (`forbidden`, `reason: "taken_down"`, also
  when the takedown came after the attempt's first put). `sweep-orphans` (an admin command) stays for
  objects no row names, such as those written before 0.4.0. A version row left by the pre-0.4.0 order (row first) that blocks a number
  is cleared when it is above `current_version` and more than 10 minutes old. Manifest entries
  from older releases whose paths the current `ASSET_PATH_RE` refuses (such as `a//b.js`, which
  the content host never served) are dropped on carry-forward and restore.
- **Quota.** The per-account storage limit (`MAX_STORAGE_BYTES_PER_USER`) counts stored bytes, so a
  reused file counts once.
- **Publish warnings.** Every publish, update and bundle result lists `warnings` (advisory, never
  blocking, at most 50): `missing_file` (a relative reference not in the version),
  `root_absolute` (`/assets/x.js`, which loads the current version's file from an old version),
  `blocked_host` (outside the CSP's allowlist), `insecure_url` (`http:`), `opaque_module` (module
  scripts, `crossorigin` links and fonts, which fail under `CONTENT_ISOLATION=opaque`) and
  `slides_setting`, `slide_empty` and `slide_dense` (a deck's ignored setting or column marker, an
  empty slide, a slide that will be shrunk to fit; a deck's `missing_file` names an image its
  Markdown shows that the version does not hold, its path resolved as the browser does: before any
  `?` or `#`, percent-decoded, `.` and `..` segments applied, an `<angle bracket>` destination read
  whole) and
  `not_scanned` (a note, not something to fix: the reference check reads at most 2 MB per file and
  8 MB per publish, so every big build gets it; an inline update also gets it for text files reused
  by `{path, sha256}` or carried forward, whose bytes were not sent and so were not re-checked). The result's `stored` reports files, `written`,
  `reused` and bytes. Agents verify a publish by comparing `get_artifact`'s asset hashes.
- **Out-of-band upload.** `start_upload` (MCP) or bearer-only `POST /api/v1/uploads` mints a
  ticket: single use, 30 minutes, at most 5 attempts, bound to its connection (or, in single-user
  mode, to the hash of `ADMIN_TOKEN`), to one target, and for an update to the base version the
  caller states. `POST /api/v1/uploads/:id/bundle` takes only `Authorization: Bearer plinth_up_...`
  (no cookies, no CORS) and a tar, optionally gzip, which the request itself commits. NUL padding
  after the gzip member (what bsdtar writes for `tar -czf -` to a pipe) is accepted;
  `commands.curl` pipes `tar -cf -` through `gzip -c` anyway, leaves out source maps and sets
  `COPYFILE_DISABLE=1`. The tar is
  streamed one entry at a time through a bounded reader (checksums, a typeflag allowlist, no links
  or devices, no duplicate or reserved paths, caps on raw and inflated bytes, per file (25 MB), per
  version and per entry metadata), into the same stager and commit as an inline publish. The
  reader allocates a file only once it fits the 16 MB in-flight budget beside the running puts, so
  a bundle holds at most max(16 MB, 25 MB) of file bytes at once, plus kept scan text (8 MB) and
  the source (5 MB). A gzip body is fed to the decompressor only as the reader reads (in 1-8 KB
  slices sized to inflate to about 1 MB; at most about 8.4 MB, 8 KB at the deflate maximum of
  1032:1, for the first slice after the data starts compressing better), so unread inflated bytes
  stay bounded whatever the body inflates to. The decompressor is read BYOB, so a read that does
  not fill its buffer shows it is drained; pacing needs a timer turn only after a full read. A
  source candidate under the top directory that is over the source limit is not held until the
  end: it is written like any file and refused at the end if it turns out to be the source. The
  bundle must arrive within its 10-minute receiving lease (`upload_too_slow` otherwise, also when
  the sender goes quiet mid-file). Before streaming it checks the owner's storage quota, and its
  puts stop at the room left. When the client disconnects, the request's abort signal hands the
  deletion of the attempt's files and the release of the lease to `waitUntil`. Abort and commit
  exclude each other: the commit takes a point of no abort synchronously before its first await,
  and an abort after it deletes nothing, so a version that commits is always whole. (Whether the
  runtime fires the signal once the whole body has been read is an implementation detail, recorded
  in DECISIONS.md and the deploy checklist, not a promise.) The principal and edit
  rights are checked again once every file is written (after the last puts settle, right before
  the commit), and the commit batch requires the minting connection to be unrevoked. A folder
  prefix is stripped only when every kept entry is under it. A version conflict (no `reason`, or
  `reason: "conflict"`) and a takedown of the artifact end the ticket, and it keeps which one
  (`dead_reason`); every other error keeps its own `reason` and `next` and leaves the ticket open
  for its remaining attempts. One bundle per user streams at a time. Minting has its own limit,
  `MAX_PUBLISHES_PER_HOUR` tickets per user per hour (the `upload:` bucket, shared by `start_upload`
  and `POST /api/v1/uploads`), which spends no publish; the bundle request counts toward the
  publish limit (`MAX_PUBLISHES_PER_HOUR`), and bundle requests are limited to twice that. Each
  live publish-mode ticket (one whose minting connection or ADMIN_TOKEN is still valid) counts
  toward `MAX_ARTIFACTS_PER_USER` (artifacts plus live reservations), so minting, and an inline
  publish, is refused with `quota_exceeded` (`reserved_uploads`, `reserved_until`, `next`) once
  they reach it; a bundle is held back by the artifact count only, never by any ticket's
  reservation, so of two tickets that raced past the mint check the first bundle commits. The token is
  never in a URL and `commands.curl` keeps it out of curl's arguments.
- **Lost responses.** What is guaranteed: a client that disconnects while the bundle is still being
  sent never commits, because the tar is incomplete (tests: "a body that ends mid-file commits
  nothing" and "a client disconnect deletes the attempt's files" in
  `apps/worker/test/uploads.test.ts`). What is not: a client that disconnects, or times out, after
  the whole body has been read may find that the request committed anyway. So a client whose
  bundle request ends without its JSON answer (a curl error, a timeout, a body that is not JSON)
  does not retry blindly. It asks the upload first (`GET /api/v1/uploads/:id`, below): `used` means
  this upload committed, `dead` that someone else published first and the change was not saved,
  `taken_down` that the artifact was taken down and nothing was published (nothing to resend),
  `open`, `expired` or `exhausted` that nothing was published. Only when that cannot be read does
  it call `get_artifact`: for an update with the artifact's id, for a new publish with `target.id`,
  which `start_upload` reserves for that ticket (the commit creates the artifact with exactly that
  id; `not_found` means nothing was published). A new version of an existing artifact may be a
  collaborator's, so it compares the files with what it sent before calling it its own. When
  nothing was published, it calls `start_upload` again with the same `base_version`. Retrying is
  safe in every case: a retry against the old `base_version` after a commit gets the usual version
  conflict (at mint, or on the bundle of a ticket minted earlier), never a second version;
  re-running the same `commands.curl` with a used ticket answers `upload_used` with the version and
  url and commits nothing; and in publish mode one ticket never creates a second artifact.
  `GET /api/v1/uploads/:id` with the upload token (and nothing else) answers whether the upload
  committed: `state` (`open`, `receiving`, `used`, `dead`, `taken_down`, `expired`, `exhausted`),
  `id`, `version` and `url` once used, the ticket's `expires_at` and `receiving_until`, and
  `next`; never a file, title or note. It counts no attempt and takes no lease. The token is read
  from the `Authorization` header only (a `?token=` query is ignored, so it gets the 401 of no
  token). A missing ticket, a wrong token, another ticket's token and a token whose minting
  credential is no longer live (a revoked connection, a rotated `ADMIN_TOKEN`) all get the same 404.
  Because this route and the bundle route run before authentication, each such miss counts against
  the caller's address (`RATE_LIMITS.uploadMissesPerIpPerHour`, 60 an hour); an address over it gets
  429 on both routes before any ticket is looked up. The
  status stays readable for `TTL.uploadStatusMs` (24 hours) after the ticket expires, used or not,
  so a commit that landed near the 30-minute deadline can still be confirmed; past that it is the
  same 404. `taken_down` means the artifact was taken down: nothing was published and nothing is
  to be resent. It reads the ticket and
  D1's clock in one statement, and a bundle's commit batch requires that request's receiving lease
  to be unexpired by the same clock, so once the status reads `open` after a lease ran out, that
  request can no longer commit (it fails with `upload_too_slow`). The Plinth CLI uses it:
  `plinth publish` and `plinth upload` read the upload's status after a lost bundle answer (tried
  again a few times over about five seconds when the read itself fails; and `plinth publish --id`
  reads the artifact after a lost inline answer), report the version they find, exit 3 when a
  conflict ended the upload, and never send the bundle again. When the status cannot be read, the
  message (and `--json`: `{"published": "unknown", "id", "upload_id"}`) names the artifact id to
  check, the reserved one for a new publish.
- **Serving cost.** The content host keeps an in-isolate cache (8 MB) of immutable version rows and
  their parsed manifests; it still reads the artifact row and checks access on every request. Under
  `CONTENT_ISOLATION=origin`, a file with a sha256 gets the strong ETag `"sha256-<hex>"`, and a
  matching `If-None-Match` is answered `304` after every access check and without touching R2.
  Non-HTML files of an explicitly versioned URL (`/__plinth/v/<n>/...`) are sent
  `Cache-Control: private, max-age=31536000, immutable`; HTML and current-version paths stay
  `private, no-cache`. Nothing is `public` or cached at the edge. Opaque isolation keeps the old
  caching.
- **Publish CLI.** The npm package `@mr0b0t0/plinth` gains client commands that need neither a
  checkout nor wrangler: `plinth login|logout|whoami [--url O]`, `plinth publish <dir|file.html|file.md> [--id REF]
  [--title T] [--category C] [--note N] [--base-version N] [--include-maps] [--dry-run] [--json]`
  and `plinth
  upload <dir> --to <upload_url>` (token from `PLINTH_UPLOAD_TOKEN` only). One `.html` or `.htm`
  file is published as `index.html`, one `.md` file as a doc's `content.md` (a link to a file is
  refused). Without `--id`, a `PLINTH_TOKEN` limited to one artifact (`GET /me`) publishes that
  artifact's next version (`--title` and `--category` are then ignored, with a note), and
  `whoami` names the artifact. With `--json`, every failure also prints one object on stdout:
  `{ ok: false, exit_code, outcome: "conflict" | "usage" | "error", message, current_version? }`;
  the result object carries the artifact's `title` from the read-back. Exit codes: 0 ok, 1
  error, 2 usage, 3 conflict (never retried). With `--id` and `--base-version N`, `publish` exits 0
  without sending in exactly two cases and prints which: the current version is N+1 and its files
  equal the folder (already published, by an earlier run whose answer was lost), or it is N and its
  files equal the folder (nothing to publish). N with other files publishes as usual; every other
  case (N+1 with other files, N+2 or later whatever its files, a base past the current version)
  is a conflict, exit 3. The origin is `--url`, then `--name`/`--home` (a
  local instance), then `PLINTH_URL`, then the single local instance, then the hosted instance,
  and is printed. `plinth login` signs in with OAuth as the connection "Plinth CLI" (scopes
  `artifacts:read artifacts:write`), stored in `~/.config/plinth/cli-<host>.json` (mode 0600).
  `PLINTH_TOKEN` is used only for the origin it belongs to (`PLINTH_URL`, or the hosted instance
  when that is unset). `publish` walks the folder (refusing symlinks, skipping dotfiles and source
  maps), sends a small update inline with `{path, sha256}` for unchanged files and anything larger
  as a gzip tar through an upload ticket, then re-reads the artifact and compares hashes. Every
  request sends `User-Agent: plinth-cli/<version>` and refuses redirects.
- **Limits are configuration.** `MAX_VERSION_BYTES` and `MAX_ASSETS_PER_VERSION` (above) are env
  vars with hard ceilings; limit errors are `ApiError`s with `limit`, `count`, `largest` and a
  `next` the caller can act on.
- **Forward-only.** Migration 0006 and the new key layout cannot be rolled back past 0.4.0 without
  breaking artifacts updated since (`docs/deploy-checklist.md#6-upgrading-and-rolling-back`).

## Security and abuse

Hosting HTML written by strangers is the main risk in this project. These are requirements, not
options.

- **Separate content domain.** Artifacts are served from a different registrable domain than the
  app, with each artifact on its own subdomain (`<id>.<content-domain>`). One artifact cannot read
  another's storage or the app's cookies. A subdomain listed on the Public Suffix List counts as a
  registrable domain of its own; the hosted instance relies on that (below). The one exception is
  **opaque content isolation** (`CONTENT_ISOLATION=opaque`): every artifact response then carries
  a CSP `sandbox` without `allow-same-origin`, so artifact documents have an opaque origin with no
  cookies or storage, and production may run with the content host on the app's registrable domain.
  It is a stopgap, with residual risks listed in `docs/security.md`.
- **App cookies are `__Host-` cookies.** Host-only, `Secure`, `Path=/`, so no other host on a
  shared parent domain can set or overwrite them.
- **Locked-down responses.** A Content Security Policy on every artifact response, no app cookies
  on the content domain, and the editor preview runs in a sandboxed iframe.
- **Comment text is untrusted input for agents.** A mention is a request from a collaborator, not
  an instruction with the owner's authority. The MCP tool descriptions say so, and agent tokens used
  for mentions are scoped to that one artifact.
- **Pages never write comments.** A page that declares `comments` can open the composer with its
  own anchor, but only the person posts, and the frame is never told comment text, authors or
  roles. Page anchors are untrusted data like the comment text.
- **Shared data is guarded on the content host.** The data API accepts only same-origin `fetch`
  requests from the artifact's own page (a custom `x-plinth-data` header, fetch metadata, an exact
  `Origin`, JSON bodies, no CORS), because every framed artifact shares one partitioned cookie jar.
  Only identified viewers write, stamps come from the server, quotas and write rate limits apply,
  and agents treat every document as untrusted input. Details in `docs/security.md`.
- **Names are display text; the people list is the access list.** Display names have no `@` (nor
  the small and fullwidth forms that render as one) and no control or invisible characters, and
  never stand for a role. A page sees them only where it sees an email. Only the owner and editors
  (and their agents) list who has access, on a page that declares `people`, and every identified
  viewer is told; there is no visit log and no directory search. An access list names a grant
  holder only once they have taken part in the artifact, so the addresses an owner adds never
  reveal which have an account.
- **Tokens.** Stored hashed, shown once, revocable per connection, with last-used timestamps.
- **Tokens for CI can be limited to one artifact.** The limit is checked inside the policy's
  `decide` before the scope, so a leaked CI secret can read and update one artifact and nothing
  else; the GitHub Action keeps server and artifact text from being read as workflow commands
  ([Publishing from CI](#publishing-from-ci-decided-2026-11-19)).
- **Open counts are aggregates.** One number per artifact per UTC day, never who opened it, shown
  only to the artifact's owner and, summed over the instance, to admins.
- **Quotas and rate limits.** Each account is limited to 100 artifacts by default, set by an
  environment variable with a per-account override. Storage and publishes per hour are capped too.
  Rate limits on password attempts and email codes.
- **Phishing and malware.** New accounts start with unlisted and allowlist visibility only. Public
  visibility unlocks after email verification and a short account age. Every artifact page carries
  a "report" link and a banner naming the platform, and reported artifacts can be taken down
  quickly. The banner also links to Plinth's source repository unless the operator turns that
  off (`SHOW_SOURCE_LINK`). It sits in the app's page around the frame, so the artifact's own
  HTML is never changed.
- **Hosted instance paperwork.** Terms of use, a privacy notice and an acceptable use policy:
  short, final, plain-language pages built from the instance's `OPERATOR_*` settings (operator
  name, address, registration or VAT number, one contact address), since the operator is a host
  under EU rules (DSA, GDPR). An instance without an operator publishes only the acceptable use
  policy. Erasure on request is done with the admin commands `erase-user` and `erase-artifact`.

## Open source and hosting model

- **One repo, two deployments.** Aconite operates the hosted instance, which runs the same code as
  a self-hosted one. Hosted-only parts (billing, moderation tooling) sit behind configuration flags.
- **Self-hosting.** A "Deploy to Cloudflare" button plus a setup script that creates the R2 bucket,
  the D1 database and the secrets, and `npx @mr0b0t0/plinth deploy`, which does the same and
  deploys the prebuilt Worker in one command (*Cloudflare* below). A single-user mode skips sign-up for everyone but one address (an extra admin token for scripts is optional).
- **Local hosting.** The same Worker can run on the owner's machine under `wrangler dev`, with D1
  and R2 on local disk and a named Cloudflare Tunnel on two owned domains for access
  (`setup.mjs --tunnel`, `pnpm local:start`). Production settings and the full security model
  apply. Links work only while the machine is on, and Cloudflare sees traffic in transit. Guide:
  `docs/local-hosting.md`; design: `docs/superpowers/specs/2026-11-14-local-tunnel-hosting-design.md`.
- **npm CLI.** `npx @mr0b0t0/plinth` (package `packages/cli`) runs a local instance, or deploys to
  the user's Cloudflare account, without cloning the repo. It ships the prebuilt Worker, web app
  and migrations, and shares its setup, start and deploy logic with the repo scripts
  (`apps/worker/scripts/instance.mjs`, `deploy.mjs`). Three modes:
  - *Localhost-only* (`plinth init --email ...`): one account, this computer only, no domain and no
    Cloudflare account. The app answers at `127.0.0.1:<port>` and artifacts at
    `<id>.localhost:<port>`; browsers and Node resolve `*.localhost` to the loopback address and
    treat each name as its own origin, so the isolation model holds without a domain, and no
    `*.localhost` page can set or read cookies for the app's IP address. It runs with
    `ENVIRONMENT=development` (which the Worker allows on localhost hosts only), the development
    helpers off, single-user mode and the console email provider. Local agents (Claude Code, Codex,
    Cursor, VS Code) connect with OAuth like everywhere else; there is no admin token. The app is on
    `127.0.0.1` because MCP clients allow OAuth over plain http only to `localhost`, `127.0.0.1` or
    `::1` (Claude Code refuses a token endpoint on `app.localhost`). Hosted clients cannot reach it.
  - *Tunnel* (`plinth init --tunnel ...`): the local-hosting setup above, without a checkout.
  - *Cloudflare* (`plinth deploy --app-host ... --content-host ... --email-provider ...`): the
    self-hosted production deployment, without a checkout. It logs in with wrangler (or uses
    `CLOUDFLARE_API_TOKEN`), checks the account and both zones, creates the D1 database, the R2
    bucket and the secrets if missing, applies the migrations, deploys and checks `/healthz`. The
    content zone's proxied wildcard record is created with an API token, or printed for the user
    to add; existing DNS records are never changed. Settings are saved under
    `<home>/<name>/cloudflare/`, so a rerun with no flags redeploys them, and a newer package
    version upgrades the same way (migrations first). It applies the same host checks as the
    Worker and refuses the console email provider outside single-user mode.
- **Agent plugin.** `integrations/plugin/` is one plugin folder for Claude Code and for Codex and
  ChatGPT (the portable `plugin.json` + `mcp.json` format): the `plinth` MCP server (hosted instance
  by default; Claude Code reads `PLINTH_URL` to point it elsewhere) and a `plinth-artifacts` skill
  that teaches agents what an artifact may contain, the update and conflict rules, the mention
  workflow, and that artifact and comment text is untrusted. Marketplaces at
  `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. MCP stays the only
  protocol: the plugin adds install convenience and guidance, not new capabilities.
- **License.** MIT.
- **Naming.** The product name must not contain "Claude" or "Codex". "Works with Claude and Codex"
  in descriptions is fine.
- **Stack.** TypeScript, Hono on Workers, D1 with Drizzle, R2, a small React front end, Monaco for
  the editor.

## Costs

A personal or small instance runs at $0 per month on Cloudflare's free tier, and a busy hosted
instance starts at $5 per month. Prices as checked on 13 November 2026.

| Item | Free allowance | Paid |
| --- | --- | --- |
| Workers ([pricing](https://workers.cloudflare.com/pricing/.md)) | 100k requests per day, 10 ms CPU per request | $5 per month flat, includes 10M requests |
| R2 storage ([pricing](https://www.cloudflare.com/developer-platform/r2/)) | 10 GB | $0.015 per GB-month, no egress fees |
| D1 database ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) | 5M rows read and 100k rows written per day, 5 GB storage, 500 MB per database | Includes 25B rows read and 50M rows written per month and 5 GB storage, then $0.001 per million rows read, $1.00 per million rows written and $0.75 per GB-month; 10 GB per database |
| Two domains (app and content) | None | Roughly $10 to $15 each per year (approximate) |
| Email for magic links and one-time codes. The hosted instance uses Aconite's existing SendGrid plan at no added cost; Resend figures shown for self-hosters ([pricing](https://www.sequenzy.com/pricing/resend)) | 3,000 emails per month, 100 per day | $20 per month for 50,000 emails |

Shared data runs on the same Worker and D1 allowances (D1 rows are estimates from the query plan):

| Operation | Worker requests | D1 rows read | D1 rows written |
| --- | --- | --- | --- |
| Load of a data page | +3 (runtime script, session, first list) | about 2 + documents listed | 0 |
| `onSnapshot` poll | 1 per 15 s per visible tab (about 5,760 a day) | 1 | 0 |
| Write | 1 | about 4 + the owner's artifacts with data | about 4 (2 rate-limit rows, the document, usage by trigger) |
| Gate with an identity claim | 0 | +1 | 0 |

Open counts run on the same allowances:

| Operation | Worker requests | D1 rows read | D1 rows written |
| --- | --- | --- | --- |
| Counted open (enter) | 0 extra | about 1 | 1, on top of the existing `used_nonces` row |
| Uncounted enter | 0 | 0 | 0 |
| Daily fold (cron, 03 UTC) | 0 | the rows older than 90 days, plus the totals rows they touch | about 1 per folded row, plus deletes |
| Owner opens the Share dialog | 1 | ≤ 92 | 0 |
| Admin stats page load | 1 | the users, artifacts, versions, connections, data-usage and reports rows, plus view rows in the window | 0 |

At the free tier's 100k rows written a day, an instance can take about 50k counted opens a day,
with their nonce writes, before any other writes. `VIEW_COUNTS=off` removes the extra write.

Live rooms run on Durable Objects (SQLite-backed classes only on the Workers Free plan). Free:
100k requests and 13,000 GB-s of duration per day. Workers Paid includes 1M requests and 400k GB-s
a month, then $0.15 per million requests and $12.50 per million GB-s. Each WebSocket connect is one
request and incoming messages bill at 20 to 1; outgoing messages and the auto-answered keep-alive
are free, and a hibernating room accrues no duration. A room stores nothing.

| Operation | Durable Object requests | D1 rows read | D1 rows written |
| --- | --- | --- | --- |
| Room check and connect | 1 (plus 2 Worker requests) | 2 | 0 |
| Page message sent | 1/20 | 0 | 0 |
| Re-check while sockets are open | 60 per hour per room | 1 each | 0 |
| Sharing change, takedown, delete or a changed declaration | 1 notify call (only for artifacts that can have a room) | 1 | 0 |
| Doc page edit (sent at most 4 times a second per typist) | 1/20 | 0 | 0 |
| Doc draft flush | 0 | 0 | at most 1 per `LIVE_DRAFT_FLUSH_S` per doc (720 an hour at the default 5 s) |
| Doc checkpoint (a saved version) | 2 calls | as an update | as an update |
| Doc version published from outside | 1 notify call | 0 | 0 |

For example, four people moving cursors at 10 updates a second send about 40 messages a second:
about 7,200 billed requests and 450 GB-s an hour, so the free allowance carries about 13 such hours
a day by requests and 28 by duration. Two people typing in a doc send at most 8 edits a second:
about 1,440 billed requests and at most 720 D1 rows written an hour, against 100k D1 rows written a
day on the free plan. Past the allowance, sockets fail and pages work alone;
`ALLOW_ROOMS=false` turns rooms off.

Not included: push-mode agent calls, which bill to the user's API key or a paid plan. Vercel was
considered and set aside: its free plan is non-commercial only, so the floor is about $20 per month
([overview](https://costbench.com/software/developer-tools/vercel/)).

## Roadmap

Each milestone is usable on its own. Milestone 1 already solves the original cross-account problem
for a single user.

1. **Single-user core.** Worker, R2, D1. Publish and update over MCP with a personal token.
   Unlisted and password links. Versions stored from day one.
2. **Accounts and safe serving.** Sign-in, OAuth for agent connections, per-artifact subdomains on
   the content domain, CSP, quotas.
3. **Sharing.** Email allowlists with magic-link viewing, roles, a dashboard listing artifacts and
   connections.
4. **Version history UI.** Version list, permanent version URLs, diff, restore.
5. **Comments and pull mentions.** Threads, element pins, the mention queue and its MCP tools.
6. **Editor.** Monaco with live preview and conflict handling.
7. **Open-source launch.** Deploy button, setup script, docs, license, contribution guide.
8. **Hosted public instance.** Public visibility, report and takedown flow, terms and privacy
   pages.
9. **Later.** Typed outputs: docs done (2026-11-14), slides and design systems done (2026-11-19); sheets later. Push agents with
   bring-your-own key, team workspaces, paid plans, custom domains. Tags beside the category, a
   group-by-category view, and personal categories for artifacts shared with you. Tokens limited
   to a category (declined for now: a category is owner text that is renamed and merged, so the
   limit would move under the token, and such a token could still create artifacts; tokens limited
   to one artifact cover CI).

## Decisions

| Decision | Outcome |
| --- | --- |
| License | MIT |
| Operator of the hosted instance | Aconite Software & Investments, Lda. |
| Sign-in | Email magic link only for now. Email goes through a small adapter chosen by an environment variable, with SendGrid and Resend both supported. The hosted instance uses Aconite's existing SendGrid account |
| Quota | 100 artifacts per account by default. Set by an environment variable, with a per-account override |
| What an artifact may load | Same rules as Claude's artifact platform. Scripts inline or from an allowlist of public CDNs (cdnjs, jsDelivr, unpkg, Tailwind, jQuery, Plotly). Styles inline or Google Fonts. Images from the artifact's own files or data URIs. `fetch`, XHR and WebSocket calls to other hosts are blocked. The page runs in a sandboxed frame |
| Typed outputs | In scope, modelled as on Claude: a type is a renderer page plus a content format, and an artifact made from a type stores content files instead of hand-written HTML. Plain HTML ships first; docs, sheets and decks follow as types. Docs shipped 2026-11-14 (Markdown in `content.md`, rendered by a fixed Plinth renderer on the artifact's origin); decks shipped 2026-11-19 (`slides`, Markdown in `slides.md`); design systems 2026-11-19 (JSON in `system.json`, a reference site, and `get_design_system` for agents building other pages); sheets next |

The CDN allowlist is a configuration value, so a self-hoster can tighten or extend it.

**Content domain (decided 2026-11-14, replacing the 2026-11-13 choice)**

- The hosted instance serves artifacts from `<id>.plinthusercontent.com`
  (`CONTENT_HOST=plinthusercontent.com`, `CONTENT_ISOLATION=origin`), a domain registered only for
  artifact content. It is a different registrable domain from `aconite.io`, so artifacts are
  cross-site to the app and to Aconite's other services without waiting for a Public Suffix List
  entry, and Cloudflare's free Universal SSL covers `*.plinthusercontent.com`.
- The earlier choice, `plinth-usercontent.aconite.io`, needed a PSL entry before it could run in
  origin mode and a paid Advanced Certificate for the second-level wildcard. It is no longer used.
- A content host that is a subdomain of the app's domain stays possible for self-hosters: it needs
  a PSL entry that the pinned `tldts` knows, or `CONTENT_ISOLATION=opaque` (artifacts then have no
  cookies, `localStorage`, IndexedDB or service workers and cannot `fetch` their own files; editor
  preview and comment pins keep working). Production refuses it otherwise.
- `plinthusercontent.com` should still go on the PSL (private section), so that artifacts are
  separate sites from each other, not only from the app.
