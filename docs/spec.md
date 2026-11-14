# Plinth: Project Spec

As of 2026-11-13 · German

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
- Open source, and cheap enough to self-host on Cloudflare's free tier.

**Non-goals for v1**

- Per-artifact server code. Artifacts are static HTML plus assets; the only server behaviour a
  page can reach is Plinth's fixed shared-data service (see
  [Shared data and viewer identity](#shared-data-and-viewer-identity)).
- Real-time multiplayer editing.
- Visual (click on the page) editing. Code editing only at first.
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
  d1[("D1 database<br/>Users, versions, permissions, comments, mention queue")]
  r2[("R2 storage<br/>Artifact files, one folder per version")]
  agents --> mcp
  publishers --> app
  viewers --> content
  worker --> d1
  worker --> r2
```

The content domain is the security boundary. User HTML never runs on the domain that holds login
sessions, and each artifact gets its own subdomain so artifacts cannot read each other's data.
Metadata goes to D1 and files to R2; nothing else needs to be provisioned.

## Data model

Metadata lives in D1 (SQLite). Artifact files live in R2 under `artifacts/<artifact_id>/v<n>/`.

| Table | Key fields | Notes |
| --- | --- | --- |
| `users` | id, email, name, auth provider, created_at | One row per person who signs in |
| `agent_connections` | id, user_id, label, client type, token hash, last_used_at | One per connected agent, e.g. "Work Claude". Revocable individually |
| `artifacts` | id, owner_id, slug, title, current_version, visibility, password hash, created_at | `visibility` is public, unlisted, password or allowlist |
| `versions` | id, artifact_id, number, R2 key, size, created_by (user or agent), note, created_at | Immutable. A restore creates a new row |
| `access_grants` | artifact_id, email, role | Role is viewer, commenter or editor. Used for allowlists and collaborators |
| `comments` | id, artifact_id, version, parent_id, author, body, mentions, status | Threaded. `status` is open or resolved |
| `mention_tasks` | id, comment_id, target agent, state, claimed_by, result_version | The queue agents read. State is pending, claimed, done or failed |
| `sessions` | id, user or viewer email, expires_at | Login and viewer sessions |
| `reports` | id, artifact_id, reason, reporter, state | Abuse reports |

**Shared data** ([below](#shared-data-and-viewer-identity), migration `0003_shared_state.sql`)
adds one column and two tables:

| Table or column | Key fields | Notes |
| --- | --- | --- |
| `versions.capabilities` | JSON `{ data, viewer, shared }` or NULL | What the version's `index.html` declares, parsed at publish. NULL for versions that declare nothing and for versions published before the column |
| `artifact_docs` | artifact_id, collection, doc_id, data, size_bytes, rev, created_by_email/role/via/label, created_at, updated_by_email/role/via/label, updated_at | One JSON document. Key (artifact_id, collection, doc_id). Shared by every version of the artifact and not versioned. Stamps come from the server. `via` is page, agent or app |
| `artifact_data_usage` | artifact_id, docs, bytes, seq | Exact totals per artifact kept by SQLite triggers on `artifact_docs`, for one-row quota checks. `seq` grows on every change and is what pages poll |

## Auth and permissions

There are three separate kinds of auth, and each has its own mechanism.

**Publishers (people).** Sign in with an email magic link, sent through SendGrid or Resend
depending on configuration. GitHub and Google sign-in can be added later. Sessions are cookies
scoped to the app domain only.

**Agents.** The MCP endpoint is an OAuth 2.1 server with dynamic client registration, so connecting
from Claude or Codex is a "connect" click followed by a consent screen. Each connection gets its own
token and label. Personal access tokens are the fallback for clients without OAuth support and for
CI.

**Viewers.** Set per artifact:

| Visibility | Who can open it |
| --- | --- |
| Public | Anyone. May be listed on the owner's profile |
| Unlisted | Anyone with the link |
| Password | Anyone with the link and the password |
| Allowlist | Only listed emails, confirmed by a one-time code or magic link |

Owners can also grant a listed email the commenter or editor role. Access to the artifact itself is
enforced by the Worker on the content domain using a short-lived signed token, so the app's login
cookie never reaches user HTML.

## MCP interface

One remote MCP server over streamable HTTP at `/mcp`. All tools act as the connected user.

| Tool | Purpose |
| --- | --- |
| `publish_artifact(title, html, assets?, visibility?)` | Create an artifact. Returns its id and URL. Private by default (`allowlist` with nobody added) |
| `update_artifact(id, html, assets?, note?)` | Publish a new version of an existing artifact |
| `get_artifact(id, version?)` | Read metadata and HTML, so an agent can edit from the current state |
| `list_artifacts(query?)` | List the user's artifacts |
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

**Agent experience (decided 2026-11-14).** Plinth should feel the same in every harness (Claude,
Claude Code, Codex, ChatGPT, Gemini CLI, Cursor, VS Code), with Claude's artifact experience as the
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

A plain REST API mirrors these tools for scripts and CI. Size limits for v1: 5 MB of HTML and 25 MB
in total per version.

## Features

### Version history

- Every publish, edit or restore writes a new immutable version to R2 and a row in `versions`.
- The artifact page shows the list: number, author (person or agent label), note, date.
- Any version has a permanent URL (`/a/<slug>/v/3`). The bare URL always serves the current one.
- Two versions can be compared as a source diff or side by side as rendered pages.
- Restoring v2 publishes its content as the next version, so history is never rewritten.

### Editing

- v1: a code editor (Monaco) with live preview in a sandboxed frame. Saving creates a new version
  with an optional note.
- Editors are the owner plus anyone granted the editor role.
- If the current version changed while someone was editing, the save is rejected and they see a
  diff to merge. No silent overwrites.
- Later: visual editing of text directly on the rendered page.

### Comments and agent mentions

Comments are threaded and can be pinned to an element on the page. Mentioning an agent (`@claude`,
`@codex`, or a connection label) creates a task. Two delivery modes:

| Mode | How it works | Who pays for tokens | When |
| --- | --- | --- | --- |
| Pull | The task waits in a queue. The owner's agent reads it through `list_mentions` in a session or on a schedule, publishes a new version and replies. In Claude Code the plugin's mention watcher (its own `mentions`-only connection) polls every 30 seconds and wakes open sessions when a request arrives | The user's own Claude or Codex subscription | v1 |
| Push | The platform calls the Anthropic or OpenAI API as soon as the mention is posted, with the artifact, the thread and a scoped token | The user's own API key, or a paid plan on the hosted instance | Later |

Rules for both modes: only the owner's connected agents can be mentioned, only commenters and
editors can mention them, and an agent's change is always a new version that anyone can revert.

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
  edit. The declaration is parsed at publish into `versions.capabilities`; the current version's
  declaration governs, also for old version URLs. Dropping the tag switches the page API off and
  keeps the data.
- **Writers.** Only identified viewers write: the owner and people with a grant on the artifact
  (viewer, commenter or editor, confirmed by sign-in or email code). Anonymous link viewers
  (unlisted, password, public) read but never write. Every write is stamped by the server with the
  writer's email, role and channel (`page`, `agent`, `app`); a page cannot spoof it. A document can
  be changed by its creator, the owner and editors, or by any writer in a declared shared
  collection; a personal document (`~me`, id `u_` + a per-artifact hash of the email) only by its
  person, with the owner and editors able to moderate.
- **Viewer identity.** The gate seals `{ email, role }` (AES-GCM, key derived from
  `TOKEN_SIGNING_KEY`) into the enter token, and the content host copies it into the per-artifact
  content cookie. Only identified viewers get a claim; everyone else is anonymous to the page.
  `window.plinth.viewer` is `{ id, email, role }` or null; `email` is set only when the page
  declares `viewer`, and `id` is opaque and different on every artifact. The app tells the viewer
  in one line under the bar what the page saves and whether it can see who they are.
- **Concurrency.** Page writes are last-writer-wins unless they pass `ifRev`; `update(fn)` reads,
  applies and retries on conflict. Every agent op needs `if_rev`. Data is not versioned and is not
  part of diffs or restores.
- **Live updates.** No push: `onSnapshot` polls a one-row change counter every 15 s while the tab
  is visible (at least 10 s), and refetches when it moves.
- **Limits** (env vars): `ALLOW_SHARED_DATA` (on), `DATA_MAX_DOCS_PER_ARTIFACT` (1000),
  `DATA_MAX_BYTES_PER_ARTIFACT` (1 MiB), `DATA_MAX_BYTES_PER_USER` (16 MiB across an owner's
  artifacts), `DATA_MAX_DOC_BYTES` (16 KiB), `DATA_WRITES_PER_VIEWER_PER_HOUR` (300) and
  `DATA_WRITES_PER_ARTIFACT_PER_HOUR` (2000). Fixed: 50 collections per artifact, nesting depth 16,
  200 documents per page, 50 ops per agent call.
- **Lifecycle.** Data is deleted with the artifact and wiped on takedown, scrubbed of a person on
  `erase-user`, and kept across new versions and restores. Any grant, visibility or password change
  bumps the access epoch and ends existing content cookies and their claims, as before. The owner
  can delete all shared data from the Share dialog.
- **Opaque isolation.** Under `CONTENT_ISOLATION=opaque` and the staging path fallback there are no
  cookies, so shared data and identity are unavailable; `plinth.ready` resolves
  `{ available: false, reason: "opaque_isolation" }` without a request.
- **Agents.** `list_artifact_data` and `write_artifact_data` (MCP) and REST mirrors under
  `/api/v1/artifacts/:ref/data` for the owner and editors. Viewer-written data is untrusted input,
  and the tool descriptions say so.

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
- **Shared data is guarded on the content host.** The data API accepts only same-origin `fetch`
  requests from the artifact's own page (a custom `x-plinth-data` header, fetch metadata, an exact
  `Origin`, JSON bodies, no CORS), because every framed artifact shares one partitioned cookie jar.
  Only identified viewers write, stamps come from the server, quotas and write rate limits apply,
  and agents treat every document as untrusted input. Details in `docs/security.md`.
- **Tokens.** Stored hashed, shown once, revocable per connection, with last-used timestamps.
- **Quotas and rate limits.** Each account is limited to 100 artifacts by default, set by an
  environment variable with a per-account override. Storage and publishes per hour are capped too.
  Rate limits on password attempts and email codes.
- **Phishing and malware.** New accounts start with unlisted and allowlist visibility only. Public
  visibility unlocks after email verification and a short account age. Every artifact page carries
  a "report" link and a banner naming the platform, and reported artifacts can be taken down
  quickly.
- **Hosted instance paperwork.** Terms of use, a privacy notice and an acceptable use policy:
  short, final, plain-language pages built from the instance's `OPERATOR_*` settings (operator
  name, address, registration or VAT number, one contact address), since the operator is a host
  under EU rules (DSA, GDPR). An instance without an operator publishes only the acceptable use
  policy. Erasure on request is done with the admin commands `erase-user` and `erase-artifact`.

## Open source and hosting model

- **One repo, two deployments.** Aconite operates the hosted instance, which runs the same code as
  a self-hosted one. Hosted-only parts (billing, moderation tooling) sit behind configuration flags.
- **Self-hosting.** A "Deploy to Cloudflare" button plus a setup script that creates the R2 bucket,
  the D1 database and the secrets. A single-user mode skips sign-up for everyone but one address (an extra admin token for scripts is optional).
- **Local hosting.** The same Worker can run on the owner's machine under `wrangler dev`, with D1
  and R2 on local disk and a named Cloudflare Tunnel on two owned domains for access
  (`setup.mjs --tunnel`, `pnpm local:start`). Production settings and the full security model
  apply. Links work only while the machine is on, and Cloudflare sees traffic in transit. Guide:
  `docs/local-hosting.md`; design: `docs/superpowers/specs/2026-11-14-local-tunnel-hosting-design.md`.
- **npm CLI.** `npx @mr0b0t0/plinth` (package `packages/cli`) runs a local instance without
  cloning the repo. It ships the prebuilt Worker, web app and migrations, and shares its setup and
  start logic with the repo scripts (`apps/worker/scripts/instance.mjs`). Two modes:
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
9. **Later.** Typed outputs (docs, sheets, decks), push agents with bring-your-own key, team
   workspaces, paid plans, visual editing, custom domains.

## Decisions

| Decision | Outcome |
| --- | --- |
| License | MIT |
| Operator of the hosted instance | Aconite Software & Investments, Lda. |
| Sign-in | Email magic link only for now. Email goes through a small adapter chosen by an environment variable, with SendGrid and Resend both supported. The hosted instance uses Aconite's existing SendGrid account |
| Quota | 100 artifacts per account by default. Set by an environment variable, with a per-account override |
| What an artifact may load | Same rules as Claude's artifact platform. Scripts inline or from an allowlist of public CDNs (cdnjs, jsDelivr, unpkg, Tailwind, jQuery, Plotly). Styles inline or Google Fonts. Images from the artifact's own files or data URIs. `fetch`, XHR and WebSocket calls to other hosts are blocked. The page runs in a sandboxed frame |
| Typed outputs | In scope, modelled as on Claude: a type is a renderer page plus a content format, and an artifact made from a type stores content files instead of hand-written HTML. Plain HTML ships first; docs, sheets and decks follow as types |

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
