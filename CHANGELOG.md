# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

- The banner under every artifact links to Plinth's source code ("Hosted on Plinth, open
  source"). Self-hosters can remove the link with `SHOW_SOURCE_LINK=false`.
- **Big builds**: agents can publish a built site (a Vite `dist/` folder with hundreds of files)
  without merging chunks. The new MCP tool `start_upload` (and bearer-only `POST /api/v1/uploads`)
  mints a single-use, 30-minute upload ticket; one `curl` of a gzip tar to its `upload_url`
  publishes the folder or updates the artifact. Updates of an existing artifact require the
  `base_version` the agent read. Applies migration `0007_upload_tickets.sql`. The command works
  with macOS tar (it pipes `tar -cf -` through `gzip -c` and leaves out source maps), and the
  server also accepts the NUL padding bsdtar adds to `tar -czf -`. A bundle must arrive within 10
  minutes (a sender that goes quiet is cut off then); one whose connection drops while it is still
  being sent never commits and deletes its own files, revoking the connection that started it
  stops its commit, and an account at its storage quota cannot start one. A gzip body is inflated
  only as fast as it is read, so a small compressed body cannot fill the Worker's memory.
- **Lost answers**: a bundle whose connection drops after the whole folder was sent may still have
  published. The new `GET /api/v1/uploads/:id`, with the upload token only, says whether that
  upload committed (`used`), was ended by someone else's version (`dead`, the change was not
  saved) or published nothing (`open`); once it reads `open` after a lease ran out, that request
  can no longer commit. Agents ask it first; `start_upload` also names the artifact a new publish
  will create (`target.id`) for a `get_artifact` check, and its `next` and the skill say that a new
  version there may be a collaborator's. A retry never duplicates anything: the old
  `base_version` gets a conflict, a used upload answers `upload_used` with the url, and one upload
  never makes two artifacts. `plinth publish` and `plinth upload` check the upload (or read the
  artifact twice, for an inline update) after a lost answer and report the version they find
  instead of sending again; when they cannot tell (the status or the artifact cannot be read
  after a few tries, or the upload is still being processed after 30 seconds), they name the
  artifact id and upload id to check, `--json` prints `{"published": "unknown", ...}` with the
  update's `base_version`, and an update names the safe rerun with `--base-version`.
- `plinth publish --id --base-version N` exits 0 without sending anything in exactly two cases, and
  prints which: the current version is N+1 and equals the folder ("already published as vN+1",
  `--json` `"outcome": "already_published"`), or it is N and equals the folder ("nothing to
  publish", `"outcome": "nothing_to_publish"`). The current version N with other files publishes as
  usual. Everything else exits 3 as a conflict, including N+2 or later whose files equal the folder
  (before, any later version that matched the folder exited 0).
- Upload tickets: a new-artifact upload's reserved id counts toward `MAX_ARTIFACTS_PER_USER` while
  the upload is live, so `start_upload` (and an inline publish) answers `quota_exceeded` with
  `reserved_uploads`, `reserved_until` and `next` once artifacts plus open uploads reach the limit;
  an upload that expires unused releases its id, which never becomes an artifact. Minting keeps its
  own limit (`MAX_PUBLISHES_PER_HOUR` per user per hour). `GET /api/v1/uploads/:id` stays readable
  for 24 hours after the upload expires, then answers the same 404 as a missing upload. It also
  answers 404 once the connection that started the upload is revoked (or the `ADMIN_TOKEN` rotates),
  and both upload routes refuse an address with 429 after 60 misses in an hour; the hourly
  cron and the opportunistic sweep delete tickets after that window (instead of after 7 days, on
  about 2% of mints). An upload ended by a takedown reports `state: "taken_down"` and is never
  to be resent; an upload whose commit failed for any reason other than a version conflict (for
  example `attempt_expired`) keeps that reason and its `next`.
- Local, tunnel and Docker instances (which run no cron) clear what interrupted uploads left:
  minting an upload ticket or posting a bundle starts a small sweep (at most 20 attempts, once a
  minute per Worker isolate) on every instance.
- An update, restore or bundle that started before an admin takedown can no longer commit after
  it, and answers `forbidden` with `reason: "taken_down"` (a bundle's upload is no longer reported
  as ended by someone else's version). Files an upload was still writing when its artifact was
  deleted, taken down or erased are deleted instead of staying in storage, even when the upload's
  request dies before it cleans up: the sweep deletes them once the upload can no longer run.
- **Upgrading**:
  - Apply migrations `0006_stored_bytes.sql` and `0007_upload_tickets.sql` before deploying the
    Worker (`plinth deploy` does; by hand, `wrangler d1 migrations apply` first).
  - Storage is forward-only. A Worker older than this release still starts against the new schema
    and serves versions written in full, but answers 404 for files a version reuses, fails to
    update or restore those artifacts ("Missing stored file"), counts storage by logical size, and
    ignores `staging_attempts` (its own interrupted publishes leave files only `sweep-orphans`
    finds). Roll forward, never back.
  - Your own wrangler config needs the `enable_request_signal` compatibility flag and the hourly
    cron trigger `"triggers": { "crons": ["0 * * * *"] }`, which deletes what interrupted
    publishes leave. A `wrangler.<env>.jsonc` written by `scripts/setup.mjs` before 0.4.0 has
    neither: re-run setup (it adds both to an existing config and moves its `compatibility_date`
    up to the release's when that is later) or add them by hand. `plinth deploy` takes both from
    the release; `plinth start`, `pnpm local:start` and the Docker image add them to an existing
    instance's config on start. From a checkout, deploy with
    `pnpm --filter @plinth/worker run deploy:production` (or `deploy:staging`): it runs
    `check-config` on that config and refuses one that lacks either before it runs
    `wrangler deploy`. The documented update runs `check-config` before the migrations too, in one `&&` list, so a
    refused config stops it before the migrations.
    `pnpm build` only prints a warning line for a stale `wrangler.<env>.jsonc` and still builds.
    On Workers Free the cron counts toward the account's 5 Cron Triggers. See
    [docs/deploy-checklist.md](docs/deploy-checklist.md#6-upgrading-and-rolling-back).
- **Reuse by hash**: an asset can be sent as `{path, sha256}` to reuse a file of the artifact's
  current version, so an update sends and stores only what changed. `get_artifact` and
  `GET /api/v1/artifacts/:ref` list each asset's `sha256`. Restores and updates that keep the
  assets no longer copy them. The storage quota counts stored bytes, so a reused file counts once.
  Applies migration `0006_stored_bytes.sql`.
- **Forward-only storage change**: from this release a version's new files are written under a
  `v<n>.<nonce>/` prefix and reused files stay where they were first stored (see **Upgrading**).
- Publishes commit last: files go to storage before the version row, in one database transaction
  with the base-version, artifact-count and storage checks, so an interrupted publish no longer
  leaves a broken version or a false conflict. An hourly scheduled sweep removes the files an
  interrupted publish left behind; `admin sweep-orphans` remains for older leftovers.
- Publish results list `warnings` (missing files, root-absolute URLs, hosts outside the CDN
  allowlist, `http:` URLs, module builds on opaque-isolation instances) and `stored` (files
  written and reused). `not_scanned` is only a note that the reference check stopped at its 8 MB
  budget or did not re-read files reused unchanged by `{path, sha256}`; the CLI prints it as a
  note, and agents are told it needs no action.
- The per-version limits are settings: `MAX_VERSION_BYTES` (default raised from 25 MB to 50 MB,
  at most 64 MB) and `MAX_ASSETS_PER_VERSION` (default raised from 200 to 511, at most 900), with
  `PLINTH_` equivalents in Docker. `GET /api/v1/config` returns the instance's limits and CDN
  allowlist. Limit errors name the largest files and say what to do next.
- Artifact files load faster on repeat views: strong ETags from the file's hash, 304s without a
  storage read, and immutable caching for the files of versioned URLs (always `private`, never at
  the edge).
- **CLI**: `plinth login`, `logout`, `whoami`, `publish <dir>` and `upload <dir>` publish a build
  folder from any machine, with no checkout and no wrangler. `publish --id` stores only the files
  that changed (it sends just those when they fit in one request of about 24 MB, otherwise the
  whole folder as one compressed upload), verifies the result by hash and exits 3 on a conflict. Every request sends a
  `User-Agent: plinth-cli/<version>`, and a Cloudflare edge block (`error code: 1010`) gets a
  message pointing at the deploy checklist.
- Admin: `sweep-orphans` now requires `--older-than-minutes` of at least 45 (an upload ticket can
  commit for 30 minutes), and `erase-artifact` also deletes the upload ticket that published the
  artifact. Workers Free guidance is lowered to `MAX_VERSION_BYTES=1048576`: Free cannot
  reliably publish multi-megabyte versions.
- Claude Code install guidance puts the Plinth plugin first on the hosted instance and labels the
  bare `claude mcp add` "tools only"; on a self-hosted or local instance its own server comes
  first, and the plugin needs `PLINTH_URL`. Agent plugin 0.6.0: the skill explains built sites and
  big pages, reuse by hash and instance limits.
- The deploy checklist gives the edge rule for API clients (Browser Integrity Check blocks
  `Python-urllib` with `error code: 1010`), Free-plan limits and the rollback note.

## 0.3.0 (2026-11-14)

- **Shared data**: a page that declares `<meta name="plinth-capabilities" content="data viewer">`
  can keep JSON documents shared by everyone who opens it (polls, sign-up sheets, trackers) through
  `window.plinth` from `/__plinth/runtime.js`, and learn who is viewing. Only the owner and people
  the artifact is shared with can write; link viewers read. Agents read and write the data with the
  new MCP tools `list_artifact_data` and `write_artifact_data`. Off with `ALLOW_SHARED_DATA=false`,
  and always off under `CONTENT_ISOLATION=opaque`. Applies migration `0005_shared_state.sql`.
- The content cookie on artifact subdomains is now `__Host-plinth_content`: open artifact frames
  reload through the gate once after upgrading.
- The privacy notice covers what people enter on shared pages and how long it is kept.
- Agent plugin 0.5.0: the skill explains shared data.

## 0.2.0 (2026-11-14)

- A new artifact type, **doc**: agents publish Markdown (`publish_artifact` with `type: "doc"`)
  and Plinth renders it as a readable document with headings, tables, code, images, light and dark
  themes and a print stylesheet ("Print or save as PDF"). Edit, compare and restore work as for
  pages. Applies migration `0004_typed_artifacts.sql`.
- Agent plugin 0.4.0: the skill explains when to publish a doc instead of an HTML page.
- Agents that fetch a Plinth link now learn what it is: every app page carries a short note for
  agents (the MCP server, how to read the artifact, install commands, docs). Artifacts anyone with
  the link may open add their title, version and a plain-text source at `/a/<slug>/source`. New
  `/llms.txt`, MCP server card (`/mcp/server-card`, `/.well-known/mcp.json`) and `/robots.txt`;
  unknown `/.well-known/` paths and missing files now answer 404 instead of the app.

## 0.1.1 (2026-11-14)

- `npx @mr0b0t0/plinth deploy` deploys Plinth to your own Cloudflare account in one command
  (database, bucket, secrets, migrations, the Worker); rerun it to redeploy or upgrade.
- A Docker image, `ghcr.io/mr0b0t0/plinth` (linux/amd64 and linux/arm64): localhost only, behind
  your own reverse proxy, or through a Cloudflare Tunnel, with data in a `/data` volume.
- The terms of use, privacy notice and acceptable use policy are final, plain-language pages built
  from the new `OPERATOR_*` settings. Admin commands `erase-user` and `erase-artifact` erase data
  on request.
- The artifact page follows new versions live, without reloading when comments open.
- The agent plugin can watch for new @mentions and bring them into Claude Code sessions.
- Hints printed by the CLI say `npx @mr0b0t0/plinth …` when it runs through npx.

## 0.1.0 (2026-11-14)

- First release of the npm CLI: `npx @mr0b0t0/plinth init` runs a localhost-only instance on your
  computer (agents connect with OAuth), and `init --tunnel` makes it reachable through a Cloudflare
  Tunnel.
