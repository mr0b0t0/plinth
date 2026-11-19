# Self-hosting Plinth

Plinth runs as one Cloudflare Worker with one D1 database and one R2 bucket. A personal instance
fits Cloudflare's free tier. This guide covers the two modes, deploying with one command from npm,
every setting, deploying from a checkout of the repo, and connecting agents. The step-by-step DNS
and email work is in [deploy-checklist.md](deploy-checklist.md).

## What you need

- A Cloudflare account. `plinth deploy` logs you in with wrangler the first time (from a checkout:
  `pnpm --filter @plinth/worker exec wrangler login`).
- Two domains on that account (zones):
  - an **app host** for sign-in, the dashboard, the API and `/mcp`, e.g. `plinth.example.com`;
  - a **content host** on a *different registrable domain*, e.g. `example-usercontent.net`. Each
    artifact is served from `<artifact_id>.<content host>`. In production Plinth refuses to start
    if the two hosts share a registrable domain. A subdomain of your own domain works once it is on
    the Public Suffix List (see [deploy-checklist.md](deploy-checklist.md#the-content-domain)), or
    before that with `CONTENT_ISOLATION=opaque`, which costs artifacts their browser storage (see
    [security.md](security.md#opaque-content-isolation)).
- For multi-user mode: a SendGrid or Resend account with a verified sending domain.
- Node 22.12+ on the machine you deploy from (macOS or Linux), and pnpm 10 for the checkout path.

## Choose a mode

**Multi-user (default).** People sign in with an email magic link or six-digit code. Each person
connects their own agents and owns their own artifacts. Needs an email provider. Someone an
artifact or a category is shared with by email signs in the same way when they confirm the code
at its gate: that creates their account if they have none.

**Single-user.** For one person. Set `SINGLE_USER_MODE=true` and exactly one `ADMIN_EMAIL`. Agents
connect with OAuth as on any instance. Optionally set a secret `ADMIN_TOKEN` of at least 32
characters: agents and scripts can then also send it as a bearer token and act as `ADMIN_EMAIL`. The web app still signs that one address in by email code. In
single-user mode production accepts `EMAIL_PROVIDER=console`, which writes the code to the Worker
log instead of sending mail; read it with `wrangler tail`. Use a real provider if the log is shared
with anyone else. People you share an artifact with by email still confirm their address by code,
but get a 7-day viewer session instead of an account, since only `ADMIN_EMAIL` may sign in.

**On your own machine.** Either mode can also run on your computer instead of Cloudflare Workers,
with D1 and R2 on local disk and a Cloudflare Tunnel for access:
`node scripts/setup.mjs --tunnel`, then `pnpm local:start`. See
[local-hosting.md](local-hosting.md).

## Deploy with one command

The npm package `@mr0b0t0/plinth` ships the built Worker, web app and migrations, so this needs no
checkout and no build:

```sh
export RESEND_API_KEY=...        # or SENDGRID_API_KEY
npx @mr0b0t0/plinth deploy --app-host plinth.example.com --content-host example-usercontent.net \
  --email-provider resend --admin-email you@example.com
```

It:

1. checks the Cloudflare login (with no `CLOUDFLARE_API_TOKEN` and no wrangler login, it runs
   `wrangler login` in a terminal), the account and that both zones are on it. If the login reaches
   several accounts, set `CLOUDFLARE_ACCOUNT_ID`;
2. makes sure the content zone has the proxied wildcard record artifact pages need (`A` `*` →
   `192.0.2.0`, see [deploy-checklist.md](deploy-checklist.md#content-host-a-wildcard-route-plus-a-wildcard-dns-record)).
   With `CLOUDFLARE_API_TOKEN` set it creates the record if missing; with the wrangler login, which
   cannot edit DNS, it prints the record to add. It never changes or deletes a record, and stops if
   a wildcard record exists that is not proxied;
3. creates the D1 database and the R2 bucket if they do not exist (`plinth` and `plinth-files`;
   `--name work` gives `plinth-work` and `plinth-work-files`);
4. saves the settings to `~/.plinth/<name>/cloudflare/deploy.json` and writes the Worker config
   next to it, pointing at the installed package;
5. generates `SESSION_SECRET` and `TOKEN_SIGNING_KEY` (and `ADMIN_TOKEN` with `--single-user`, shown
   once) and stores them with `wrangler secret put`, piping each value on stdin; stores
   `RESEND_API_KEY` or `SENDGRID_API_KEY` from your shell;
6. applies the migrations to the remote database, runs `wrangler deploy` (the app host becomes a
   Workers custom domain, so Cloudflare creates its DNS record and certificate), and checks
   `https://<app host>/healthz`. A new custom domain's certificate can take a few minutes; the
   deploy still succeeds and `npx @mr0b0t0/plinth status --cloudflare` checks again later.

It ends with the commands that connect Claude Code, Codex and the other agents. For Claude Code,
that is the Plinth plugin set to your instance
(`claude plugin install plinth@plinth --config instance_url=https://<app host>`). For Codex, it is
your instance's server under the name `plinth`, which replaces the plugin's hosted server
([agents.md](agents.md#claude-code)). A plugin installed from Anthropic's plugin directory or
OpenAI's works with your instance the same way: set the Claude Code plugin's Plinth instance option,
or add your server as `plinth` in Codex. ChatGPT connects from OpenAI's servers to the instance its
listing names, the hosted one, so add your instance there as a custom connector instead, if it is
reachable from the internet.

Flags: `--app-host`, `--content-host`, `--email-provider sendgrid|resend|console` (console only
with `--single-user`), `--email-from`, `--admin-email`, `--single-user` or `--multi-user`,
`--content-isolation origin|opaque` (as in the setup script below), `--operator-name`,
`--operator-email`, `--operator-address`, `--operator-registration` (the `OPERATOR_*` settings),
`--name`, `--home`, `--rotate-secrets` and `--dry-run`, which prints every command and the generated
config without contacting Cloudflare.

**API token.** Instead of the wrangler login you can export `CLOUDFLARE_API_TOKEN`, which wrangler
uses for every step. Give it Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit; Zone:
Workers Routes Edit, DNS Edit and Zone Read, on both zones.

**Redeploy and upgrade.** Run `npx @mr0b0t0/plinth deploy` with no flags to deploy the saved
settings again, and `npx @mr0b0t0/plinth@latest deploy` to upgrade: it applies the new version's
migrations before deploying its Worker. Flags given on a later run change the saved settings; an
empty value (`--operator-address ""`) clears an optional one. The Worker config is rewritten on
every run; to set other variables from the table below, such as `MAX_ARTIFACTS_PER_USER` or
`ALLOW_PUBLIC_VISIBILITY`, add them under `vars` in `deploy.json` and rerun.

## Settings

Plain settings are `vars` in the Worker config (`apps/worker/wrangler.jsonc`, the per-environment
copy the setup script writes, or `vars` in `deploy.json` for `plinth deploy`). Secrets are set with `wrangler secret put` and never go in the config.
Booleans accept `true`, `1`, `yes` or `on`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENVIRONMENT` | `production` | `development`, `staging` or `production`. Production refuses unsafe settings (below) |
| `APP_HOST` | none (required) | Host and optional port of the app: sign-in, dashboard, API, `/mcp` |
| `CONTENT_HOST` | none (required) | Host for artifact content. Must differ from `APP_HOST`, not be a subdomain of it, and not be its parent. In production it must be a different registrable domain, or a subdomain listed on the Public Suffix List (see [deploy-checklist.md](deploy-checklist.md#the-content-domain)), unless `CONTENT_ISOLATION=opaque` |
| `CONTENT_ISOLATION` | `origin` | `origin` or `opaque`. `origin`: each artifact is its own origin with its own storage. `opaque`: every content response adds a CSP `sandbox` without `allow-same-origin`, so artifacts get an opaque origin: no cookies, `localStorage`, IndexedDB or service workers, and no `fetch` of their own files (load data with `<script>` or inline it). Editor preview and comment pins keep working; editing docs and sheets on their page is off (they are edited in the source editor). Required to run production with `APP_HOST` and `CONTENT_HOST` on one registrable domain, e.g. while the content host's Public Suffix List entry is pending; switch back to `origin` once it ships. See [security.md](security.md#opaque-content-isolation) for what it does not protect. `STAGING_CONTENT_FALLBACK` always behaves as `opaque` |
| `PUBLIC_SCHEME` | `https` | `http` only for local development. Production requires `https` |
| `EMAIL_PROVIDER` | `console` | `sendgrid`, `resend` or `console`. `console` logs sign-in links and codes; production refuses it unless in single-user mode |
| `EMAIL_FROM` | `Plinth <noreply@<APP_HOST>>` | Sender address. Must be on a domain verified with your provider |
| `MAX_ARTIFACTS_PER_USER` | `100` | Artifact quota per account. A per-user override lives in `users.artifact_limit` |
| `MAX_PUBLISHES_PER_HOUR` | `60` | Publishes and new versions per user per hour. Uploads (`start_upload`) are limited to the same number per hour, and upload requests to twice it |
| `MAX_VERSION_BYTES` | `52428800` (50 MB) | Source plus assets of one version, uncompressed, reused files included: what a viewer loads. `1048576` to `67108864` (64 MB). An upload's body may be this plus 8 MB of tar overhead. On Workers Free set `1048576`: Free cannot reliably publish multi-megabyte versions ([deploy-checklist.md](deploy-checklist.md#version-limits-and-the-workers-plan)) |
| `MAX_ASSETS_PER_VERSION` | `511` | Asset files in one version, besides the main document. `1` to `900`. On Workers Free set a small value, for example `20` |
| `MAX_STORAGE_BYTES_PER_USER` | `1073741824` (1 GiB) | Bytes stored per account across all versions of its artifacts. A file a version reuses from an earlier version of the same artifact is stored, and counted, once |
| `CDN_ALLOWLIST` | cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, cdn.tailwindcss.com, code.jquery.com, cdn.plot.ly | Script hosts artifacts may load from, comma or space separated. Empty means the default list |
| `SINGLE_USER_MODE` | `false` | One-person instance; needs exactly one `ADMIN_EMAIL`. Only that address signs in: people an artifact is shared with confirm their email by code and get a viewer session, not an account. Off, a confirmed code signs the person in and creates their account if they have none |
| `OPERATOR_NAME` | empty | Who runs the instance, named in its terms of use and privacy notice. With `OPERATOR_EMAIL`, the instance publishes both pages; without, only the acceptable use policy (right for a personal instance) |
| `OPERATOR_EMAIL` | empty | The one published contact address (questions, privacy, reports, authorities). A monitored inbox |
| `OPERATOR_ADDRESS` | empty | Registered address, shown in the terms and privacy notice |
| `OPERATOR_REGISTRATION` | empty | Company registration or VAT number, as it should read, e.g. `VAT PT516696696` |
| `OPERATOR_HOSTING` | `Cloudflare` | The hosting provider the privacy notice names as a processor |
| `ADMIN_EMAIL` | empty | Instance admins (comma separated): they see the report queue and can take artifacts down. In single-user mode, exactly one address: the owner |
| `ALLOW_PUBLIC_VISIBILITY` | `false` | Allows `public` visibility. Even then an account needs a verified email and a minimum age |
| `PUBLIC_MIN_ACCOUNT_AGE_HOURS` | `72` | Account age before `public` unlocks |
| `ALLOW_SHARED_DATA` | `true` | Lets pages that declare it keep shared data (polls, sign-up sheets, trackers among invited people) and learn who is viewing; see [security.md](security.md#shared-data-api). Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off. Off: no identity claims, pages report shared data as unavailable, and MCP and REST writes are refused while reads still work, so owners can export. Always off under `CONTENT_ISOLATION=opaque`. Whiteboards keep their board in shared data, so while it is off (or under opaque isolation) publishing a whiteboard is refused and `GET /api/v1/config` lists `whiteboard` as unavailable; existing boards then show read-only and empty |
| `SHOW_SOURCE_LINK` | `true` | Adds "open source", a link to Plinth's GitHub repository, to the banner under every artifact. Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off. The banner belongs to the app's page around the frame: the artifact's own HTML is never changed. Off keeps the banner and its report link |
| `THUMBNAILS` | `true` | Takes a screenshot of each version for dashboard cards and link previews (`og:image`). Only works with a Browser Rendering binding, which you add to your own wrangler config: `"browser": { "binding": "BROWSER" }`. Without it, or with any other value than `true`, `1`, `yes` or `on`, cards keep their placeholder and link previews have no image. Browser Rendering is billed by Cloudflare per browser hour; local, tunnel and Docker instances run without it |
| `VIEW_COUNTS` | `true` | Counts how often each artifact is opened, per UTC day, for the owner's Share dialog and the admin Stats page. Stores one number per artifact per day: no IP addresses, user agents or viewer identities. The owner's own opens, previews, thumbnails, agents and admins reviewing are not counted. Counts start when the instance gets this feature (migration `0010_view_counts.sql`); earlier opens are not known. Each counted open costs one D1 row written. Any value other than `true`, `1`, `yes` or `on` turns it off; stored counts stay |
| `DATA_MAX_DOCS_PER_ARTIFACT` | `1000` | Shared-data documents per artifact |
| `DATA_MAX_BYTES_PER_ARTIFACT` | `1048576` (1 MiB) | Shared-data bytes per artifact. At least `DATA_MAX_DOC_BYTES` |
| `DATA_MAX_BYTES_PER_USER` | `16777216` (16 MiB) | Shared-data bytes across all of one owner's artifacts (checked before each write, so concurrent writers may pass it by a request or two). At least `DATA_MAX_BYTES_PER_ARTIFACT`. D1 has a hard database size limit, so keep this modest |
| `DATA_MAX_DOC_BYTES` | `16384` (16 KiB) | Size of one shared-data document, `1024` to `65536` |
| `DATA_WRITES_PER_VIEWER_PER_HOUR` | `300` | Shared-data writes per writer per artifact (page, agent and app writes, deletes included). At least 1 |
| `DATA_WRITES_PER_ARTIFACT_PER_HOUR` | `2000` | Shared-data writes per artifact by all writers together. At least 1 |
| `ALLOW_ROOMS` | `true` | Live rooms: pages that declare `room` show who is here and share moments live among invited people (`plinth.room`), and doc editors see each other's page edits as they type. Needs the `ROOMS` Durable Object binding, which every config Plinth generates carries ([deploy-checklist.md](deploy-checklist.md#live-rooms)), and `CONTENT_ISOLATION=origin`. Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off: pages then get `room.ready` with `available: false` and work alone, and doc editors edit on their own and save from the page. Whiteboards keep saving without it; only their live cursors and drags stop |
| `ROOM_MAX_CONNECTIONS_PER_ARTIFACT` | `50` | Open sockets on one artifact's room, `2` to `1000` |
| `ROOM_MAX_MESSAGE_BYTES` | `8192` | One message a page sends to its room, `512` to `65536` |
| `ROOM_MESSAGES_PER_SECOND` | `20` | Messages per connection per second, with bursts of twice that, `1` to `100`. A socket that keeps going over is closed |
| `ALLOW_LIVE_EDITING` | `true` | Owners and editors with an account edit a doc or a sheet right on its page; their changes are kept as a draft and become versions when published, and a version published meanwhile that is not combined with them is reviewed whole, beside them, in the page ([spec](spec.md#editing)). Empty keeps it on; any other value turns it off, leaving the source editor. Never under `CONTENT_ISOLATION=opaque`. `GET /api/v1/config` reports the mode in effect as `inline_editing` (`room`, `solo` or null) |
| `LIVE_CHECKPOINT_IDLE_S` | `120` | Seconds without page edits before the unsaved edits are saved as a version on their own. `0` saves only when someone saves; otherwise `30` to `3600` |
| `LIVE_AUTO_CHECKPOINT_MIN_S` | `600` (or the idle time, when longer) | Least seconds between the current version (saved, autosaved, or published by an agent) and an automatic one, at least `LIVE_CHECKPOINT_IDLE_S`. An autosave asked for sooner waits and is tried again then, while someone is still editing the page. Saved versions count toward `MAX_PUBLISHES_PER_HOUR` |
| `LIVE_DRAFT_FLUSH_S` | `5` | How often, at most, the room writes unsaved page edits to D1, `2` to `60`. A Worker restart can lose up to this much typing, which editors' pages send again |
| `LIVE_DRAFT_RETENTION_DAYS` | `30` | Unsaved page edits nobody touched for this long are deleted, `1` to `365` |
| `ALLOW_DICTATION` | `false` | Dictation run by the app: pages that declare `dictation` receive the words an identified viewer speaks, after a click in the page and the viewer's consent, recognized by the browser's own speech service (Chrome sends the audio to Google, Edge to Microsoft, Safari to Apple). Only `true`, `1`, `yes` or `on` turns it on; only with `CONTENT_ISOLATION=origin`. On, the app's `Permissions-Policy` allows the microphone to the app's own origin; artifact frames never get it ([security.md](security.md#dictation-and-text-to-speech)). The privacy notice describes it while it is on; an operator with a notice of their own should do the same |
| `ALLOW_CATEGORY_SHARING` | `true` | Owners may share a category with people, who see the artifacts the owner reviews into it on a portal page (`/p/<id>`); filing an artifact under a shared category never shares it ([spec](spec.md#category-sharing-and-personal-categories-decided-2026-11-19)). Only `false`, `0`, `no` or `off` turns it off: category grants then count for nothing, the share and portal endpoints answer `feature_disabled` or 404, and agents are no longer told about shared categories. Passes issued through a share before you turn it off end within 12 hours; `pnpm --filter @plinth/worker admin -- bump-epochs --category-shared --remote` ends them at once. The privacy notice names shared categories while it is on |
| `ALLOW_LIVE_VIEWS` | `true` | Live views: open artifact pages pick up a new version within seconds, and pages that keep shared data learn of changes without waiting for their 15 s poll, over one WebSocket the app page opens on `APP_HOST` (`/api/v1/view/<id>/watch`). It carries only version numbers and change signals. Needs the `ROOMS` Durable Object binding (the same as live rooms), but neither `ALLOW_ROOMS` nor origin isolation; data signals also need shared data. Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off, and pages poll as before. Each open view, version and shared-data write then costs a Durable Object request ([deploy-checklist.md](deploy-checklist.md#live-views)); on the Workers Free plan a busy instance may prefer it off. The same switch, without the binding, has open views keep the reader's state across versions: a doc updates in place, a page that loads the runtime keeps its scroll and place, and a page that declares `hold` waits while the viewer uses it ([spec.md](spec.md#live-views-decided-2026-11-19)); off, every new version reloads the frame |
| `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT` | `1000` | Open views of one artifact that get pushed signals, `10` to `10000`, counted apart from `ROOM_MAX_CONNECTIONS_PER_ARTIFACT`: half for the owner and the people it is shared with, half for everyone else. Views over it poll. It also sets how long open views spread their follow-up requests after a signal: 2 ms per socket, at most 10 s (2 s at the default) |
| `SHEET_EVAL_BUDGET` | `200000` | Formula steps one `read_sheet` call may spend, `10000` to `20000000`: one step per expression and per cell a range visits. Past it, the agent gets the cells it did not reach as `#LIMIT!` with an `eval_budget` warning. Lower it on the Workers Free plan (10 ms of CPU per request) if large sheets time out; raise it on Workers Paid for big sheets. It never changes what viewers see: browsers compute sheets themselves |
| `ALLOW_SLIDES_FOLLOW` | `true` | Following the presenter: an owner or editor can lead a deck, and the identified viewers who have it open follow their slide over the deck's live room (`/__plinth/room/v1/slides`), which carries only slide numbers. In effect only where live rooms are (`ALLOW_ROOMS`, the `ROOMS` binding, `CONTENT_ISOLATION=origin`); every follower is a room socket and counts toward `ROOM_MAX_CONNECTIONS_PER_ARTIFACT`, so a talk to more than about 50 people needs that raised. Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off, and decks page alone |
| `ALLOW_FILES` | `false` | Files people add to a page: pages that declare `files` let the people they are shared with upload raster images, PDFs, video and audio, which everyone who can open the page sees ([spec](spec.md#files-people-add-to-a-page-decided-2026-11-19), [security.md](security.md#files-people-add-to-a-page)). Only `true`, `1`, `yes` or `on` turns it on; only with `CONTENT_ISOLATION=origin`. The bytes go to the `FILES` bucket under each artifact's root, apart from the owners' version quota. The privacy notice and the acceptable use policy describe files while it is on; an operator with documents of their own should do the same, and should expect to moderate what people upload |
| `FILES_MAX_FILE_BYTES` | `20971520` (20 MiB) | One file, `1048576` (1 MiB) to `104857600` (100 MiB) |
| `FILES_MAX_PER_ARTIFACT` | `500` | Files on one artifact, counting unfinished uploads, `1` to `10000` |
| `FILES_MAX_BYTES_PER_ARTIFACT` | `268435456` (256 MiB) | Bytes of files on one artifact. At least `FILES_MAX_FILE_BYTES` |
| `FILES_MAX_BYTES_PER_UPLOADER` | `67108864` (64 MiB) | Bytes one person may upload to one artifact; the owner is exempt. From `FILES_MAX_FILE_BYTES` to `FILES_MAX_BYTES_PER_ARTIFACT` |
| `FILES_MAX_BYTES_PER_USER` | `1073741824` (1 GiB) | Bytes of files across one owner's live artifacts, apart from `MAX_STORAGE_BYTES_PER_USER`. At least `FILES_MAX_BYTES_PER_ARTIFACT` |
| `FILES_UPLOADS_PER_UPLOADER_PER_HOUR` | `60` | Uploads one person may start on one artifact per hour. At least 1 |
| `FILES_UPLOADS_PER_ARTIFACT_PER_HOUR` | `300` | Uploads everyone together may start on one artifact per hour. At least 1 |
| `DESIGN_EXPORT` | `true` | Designs download as PNG (one artboard, 1x or 2x) or PDF (every board or one, each page the board's size), rendered by the server: "Download PNG or PDF…" in the artifact menu, and `GET /api/v1/artifacts/:ref/export` ([spec](spec.md#designs-decided-2026-11-19), [security.md](security.md#design-export)). Only works with the Browser Rendering binding that thumbnails use (`"browser": { "binding": "BROWSER" }` in your own wrangler config); without it, or with any other value than `true`, `1`, `yes` or `on` (empty keeps it on), people keep the browser's own Print or save as PDF. Each export runs a browser for a few seconds, billed by Cloudflare per browser hour, and anyone who may view a design may export it |
| `DESIGN_EXPORTS_PER_HOUR` | `30` | Design exports one person may start per hour (per confirmed email, or signed out per client network, an IPv6 /64 counting as one), `1` to `1000`. A refused request (a bad board or scale) does not count, nor does a busy answer: at most two exports render at once across the instance, beside the thumbnails' two. Lower it to bound Browser Rendering time |
| `ALLOW_PAGE_REQUESTS` | `false` | Page requests: pages that declare `requests` let the people who may comment on them hand work to the owner's agent, which picks it up from its mention queue ([spec](spec.md#page-requests-decided-2026-11-19), [security.md](security.md#page-requests)). Only `true`, `1`, `yes` or `on` turns it on; only with `CONTENT_ISOLATION=origin`. Turning this on seals the viewer identity claim into identified viewers' content passes even when `ALLOW_SHARED_DATA` and `ALLOW_ROOMS` are off. Each request is stored like a comment under the requester's email; the privacy notice says so while it is on, and an operator with a notice of their own should do the same |
| `PAGE_REQUESTS_PER_VIEWER_PER_HOUR` | `10` | Requests one person may file on one artifact per hour, `1` to `100` |
| `PAGE_REQUESTS_PER_ARTIFACT_PER_HOUR` | `60` | Requests everyone together may file on one artifact per hour, `1` to `1000` |
| `PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT` | `25` | Requests waiting for or claimed by the owner's agent on one artifact, `1` to `500`. One person may have at most 3 open on an artifact |
| `STAGING_CONTENT_FALLBACK` | `false` | Serves content at `APP_HOST/__content/<id>/` instead of subdomains, for a staging deploy on `workers.dev` without a content domain. All artifacts then share the app's origin, so never use it with real users. Refused in production |
| `DEV_OUTBOX` | `false` (`true` in the committed local config) | Keeps console emails in D1 and exposes `GET /api/v1/__dev/outbox` for tests. Only honoured when `ENVIRONMENT=development` |

| Secret | Required | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | yes | At least 32 characters. Server-side key for sign-in codes and sessions. The setup script generates 64 |
| `TOKEN_SIGNING_KEY` | yes | At least 32 characters. Signs viewer tokens, content cookies and password passes |
| `ADMIN_TOKEN` | optional, single-user mode | At least 32 characters if set. Extra bearer token for the owner, for scripts |
| `SENDGRID_API_KEY` | with `EMAIL_PROVIDER=sendgrid` | API key with Mail Send permission only |
| `RESEND_API_KEY` | with `EMAIL_PROVIDER=resend` | Sending-access API key |

Rotating `TOKEN_SIGNING_KEY` invalidates open viewer links, content cookies and password passes;
viewers pass the gate again. Rotating `SESSION_SECRET` may invalidate pending sign-in codes and
sessions. Personal access tokens and OAuth tokens are stored as plain SHA-256 hashes and survive
both.

If a setting is missing or unsafe, every request returns a 500 that names the variable (never its
value), and the Worker log says the same.

## From a checkout: the setup script

The same deployment from a clone of the repository, for operators who change the code.
`scripts/setup.mjs` uses the wrangler in `apps/worker` and needs no other tools. It is safe to run
again: existing resources and secrets are kept unless you pass `--force` (local) or
`--rotate-secrets` (remote). `--dry-run` prints every command and the generated config without
running or writing anything.

Local development:

```sh
node scripts/setup.mjs --local
node scripts/setup.mjs --local --single-user --admin-email you@example.com   # single-user, local
```

This writes `apps/worker/.dev.vars` (mode 600) with fresh `SESSION_SECRET` and `TOKEN_SIGNING_KEY`
and applies the migrations to the local D1 database.

Your Cloudflare account:

```sh
node scripts/setup.mjs --remote --env production \
  --app-host plinth.example.com --content-host example-usercontent.net \
  --email-provider sendgrid --email-from "Plinth <noreply@example.com>" \
  --admin-email you@example.com
```

It:

1. creates the D1 database (`--db-name`, default `plinth`) if it does not exist;
2. creates the R2 bucket (`--bucket`, default `plinth-files`) if it does not exist;
3. writes `apps/worker/wrangler.<env>.jsonc` from the committed config, with the database id, the
   bucket, your hosts and settings, and routes for both hosts. The committed `wrangler.jsonc`
   is not touched. The generated file is git-ignored; it holds ids, not secrets;
4. generates `SESSION_SECRET` and `TOKEN_SIGNING_KEY` (and `ADMIN_TOKEN` with `--single-user`)
   and stores them with `wrangler secret put`, piping each value on stdin. Values never appear on a
   command line. If `SENDGRID_API_KEY` or `RESEND_API_KEY` is set in your shell, it is stored too;
5. applies the migrations to the remote database.

Other flags: `--worker-name` (default `plinth`, or `plinth-<env>` for other environments),
`--content-zone` (the Cloudflare zone for the content route; default: the last two labels of the
content host), `--environment staging|production` (default: `staging` for `--env staging`,
otherwise `production`), `--content-isolation origin|opaque` (writes `CONTENT_ISOLATION`; the
script refuses app and content hosts on one registrable domain unless it is `opaque`, as the Worker
does). Run `node scripts/setup.mjs --help` for the full list.

`pnpm run setup -- --local` works too. Plain `pnpm setup` is pnpm's own command, not this script.

## From a checkout: deploy

```sh
pnpm install
pnpm build
pnpm --filter @plinth/worker run deploy:production
```

Then do the DNS, email and verification steps in [deploy-checklist.md](deploy-checklist.md).

To update later:

```sh
git pull && pnpm install && \
  pnpm --filter @plinth/worker check-config wrangler.production.jsonc && \
  pnpm build && \
  pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc && \
  pnpm --filter @plinth/worker run deploy:production
```

The commands are one `&&` list, so a step that fails stops the rest (a refused config never
reaches the migrations).

`deploy:production` checks `wrangler.production.jsonc` again and runs
`wrangler deploy --config wrangler.production.jsonc`; `deploy:staging` does the same with
`wrangler.staging.jsonc`. For another environment name, run `check-config wrangler.<env>.jsonc`
and then `exec wrangler deploy --config wrangler.<env>.jsonc`.

Apply migrations before deploying code that needs them. Migrations only add; they never rewrite
stored versions.

Your `wrangler.production.jsonc` keeps the compatibility flags and cron triggers it was written
with. When a release adds one (0.4.0 adds the `enable_request_signal` flag, which lets an abandoned
upload clean up after itself, and the hourly cron trigger `0 * * * *`, which sweeps what abandoned
uploads leave), `check-config` and the deploy scripts stop with the file and the missing lines.
`pnpm build` only prints a warning line for each `apps/worker/wrangler.<env>.jsonc` that lacks them,
so a stale config never breaks a build. Re-run
`node scripts/setup.mjs --remote` with the arguments you first used, which adds the release's flags
and cron triggers, moves `compatibility_date` up to the committed config's when that is later (a
date you pinned earlier is replaced) and keeps the rest, or copy `compatibility_flags` and
`triggers` from `apps/worker/wrangler.jsonc` by hand, then run the update again.
[deploy-checklist.md](deploy-checklist.md#6-upgrading-and-rolling-back) lists what each release
needs.

## Connect agents

The MCP endpoint is `https://<APP_HOST>/mcp`.

- **Multi-user:** add Plinth as a remote MCP server in Claude or Codex and approve the OAuth
  consent screen, or create a personal access token on the Connections page.
- **Single-user:** OAuth or a personal access token as above, or `ADMIN_TOKEN` if you set one.

Step-by-step instructions for each client are in [mcp.md](mcp.md).

**CI.** Pipelines publish to your instance with the GitHub Action or the CLI, given its app origin
(`url: https://<APP_HOST>` on the Action, `PLINTH_URL` for the CLI) and a token made on it,
ideally one limited to the artifact (its Settings page, **Publish from CI**). Tokens limited to
one artifact need migration `0012_bound_tokens.sql`, which `deploy` applies; there is no setting
to turn them on or off. See [ci.md](ci.md).

## Operating notes

- **Quota.** `MAX_ARTIFACTS_PER_USER` is the default. To change one account, set
  `users.artifact_limit` with the admin command (`pnpm --filter @plinth/worker admin --help`) or
  `wrangler d1 execute`.
- **Abuse and usage.** Emails in `ADMIN_EMAIL` see the report queue at `/admin/reports` and can
  take an artifact down. They also see instance totals and 7, 30 or 90-day trends at
  `/admin/stats` (people, artifacts, publishes, storage, shared data, agent connections, open
  reports and opens), which never name a page or a person. The hourly cron folds daily open counts
  older than 90 days into one total per artifact at 03 UTC; instances without a cron (local,
  tunnel, Docker) keep the daily rows instead, and every figure stays correct.
- **Legal pages.** `/legal/terms`, `/legal/privacy` and `/legal/acceptable-use` are short, final,
  plain-language pages built from the `OPERATOR_*` settings. Set `OPERATOR_NAME` and
  `OPERATOR_EMAIL` (and in the EU your address and registration or VAT number) before letting other
  people sign up. Read them on your instance; if your situation needs different terms, change
  `apps/web/src/components/viewer/legalDocs.tsx`.
- **Privacy requests.** The privacy notice promises erasure on request. Deleting an artifact only
  hides it; to erase for good, run
  `pnpm --filter @plinth/worker admin -- erase-artifact <id|slug> --remote --config wrangler.production.jsonc`,
  or `erase-user <email>` for a whole account (artifacts, versions, files, comments, connections).
  Add `--dry-run` first to see what goes.
- **Shared data.** Pages that declare it store documents in D1 (`artifact_docs`, with exact totals
  in `artifact_data_usage`). `SELECT sum(bytes), sum(docs), count(*) FROM artifact_data_usage`
  shows how much there is. Data is deleted with its artifact and on takedown, and `erase-user`
  removes a person's documents on other people's artifacts too.
- **Live rooms.** Pages and docs reach their room over a WebSocket on the artifact's own content
  host (`/__plinth/room/`), served by one Durable Object per artifact (`ArtifactRoom`, binding
  `ROOMS`) that stores nothing; unsaved page edits of a doc live in D1 (`live_drafts`) until
  someone saves or discards them. To turn rooms off, set `ALLOW_ROOMS` (and, for on-page doc
  editing, `ALLOW_LIVE_EDITING`) to `"false"` and keep the binding. A config without the binding
  also runs, with rooms off, and `check-config` prints a note. Usage is billed as Durable Objects:
  see [deploy-checklist.md](deploy-checklist.md#live-rooms) for the Free plan, costs and rollback.
  A reverse proxy in front of a container must pass WebSocket upgrades
  ([docker.md](docker.md#what-the-proxy-must-do)).
- **Live views.** Open artifact pages hold a WebSocket on the app host
  (`/api/v1/view/<id>/watch`) into the same `ArtifactRoom` object, which pushes new version
  numbers and "shared data changed" signals; nothing is stored. While they are on, every new
  version, shared-data write and sharing change calls the artifact's object (one Durable Object
  request each). `ALLOW_LIVE_VIEWS=false` turns them off: pages then poll every 15 s, as without the
  binding. A reverse proxy must pass this upgrade too.
- **Names and the people list.** Pages that declare `viewer` see each person's display name
  (`users.name`, read live) wherever they see their email, and pages that declare `data viewer
  people` let their owner and editors list everyone the artifact is shared with. Neither has a
  setting of its own: names reach pages only while identity claims are on (`ALLOW_SHARED_DATA` or
  `ALLOW_ROOMS`, with `CONTENT_ISOLATION=origin`), and the people list only while
  `ALLOW_SHARED_DATA` is on, so turning those off turns them off. Nothing is stored: `erase-user`
  removes a name with the account.
- **Interrupted publishes.** A version's files go to R2 before its database row, so a publish
  that dies midway (a closed connection, a CPU or memory limit) leaves files no version points to,
  under that attempt's own prefix. Each attempt records that prefix in the `staging_attempts`
  table first, and the Worker's hourly cron trigger deletes the files of attempts older than 45
  minutes (an upload ticket's 30 plus a 15-minute margin), at most 50 per run. Minting an upload
  ticket and posting a bundle also start a sweep of at most 20 attempts after the response (at
  most once a minute per Worker isolate), which is how a local, tunnel or Docker instance clears
  them: `wrangler dev` fires no cron triggers. Deleting, taking down or erasing the artifact removes
  them too, and keeps its attempts' rows for at least 45 minutes so the sweep also deletes what an attempt
  still running wrote afterwards. The admin command is for legacy orphans, files written before 0.4.0 that no row names:
  `pnpm --filter @plinth/worker admin -- sweep-orphans --local|--remote [--artifact <id|slug>] [--older-than-minutes N] [--dry-run] [--env E] [--config C] [--bucket B]`.
  It deletes only prefixes no version names that are older than `--older-than-minutes` (default
  60, minimum 45: an upload ticket can still commit for 30 minutes after it is minted). The R2 bucket is always the `FILES` binding of the same wrangler config and
  environment as the database; `--bucket` only checks that name and is refused if it differs (the
  erase commands do the same). The sweep deletes nothing, and says why, when the database answer
  cannot be read, names no version, or names none of the prefixes in the bucket. Run it with
  `--dry-run` first, with the same `--config` as the deployment (for example
  `--config wrangler.production.jsonc`).
- **Backups.** D1 Time Travel restores the database to any minute in the last 30 days (Workers
  Paid) or 7 days (Free). R2 objects are written once per version and never overwritten.
- **Logs.** `wrangler tail --config wrangler.production.jsonc` (for `plinth deploy`:
  `npx wrangler tail --config ~/.plinth/plinth/cloudflare/wrangler.jsonc`). Secrets and tokens are
  never logged.
- **Admin commands on a `plinth deploy` instance.** The quota and erasure commands above run from a
  checkout; point them at the deployment with
  `--config $HOME/.plinth/plinth/cloudflare/wrangler.jsonc`.
- **Invitation emails.** When an owner adds people with **Notify people** ticked (or an agent passes
  `notify: true`), each new person gets one email through `EMAIL_PROVIDER`, from `EMAIL_FROM`:
  who shared what, their role and the link. There is no setting of its own. One change sends at
  most 40, each owner at most 100 a day (3 of them to any one address) and each address receives
  at most 10 a day, so plan your
  provider's daily quota
  with sign-in emails and invitations together. With `EMAIL_PROVIDER=console` they go to the Worker
  log like sign-in codes. Their counters (hashed addresses) sit in `rate_limits` and the hourly
  cron removes them after two days; on an instance without a cron they are pruned with the other
  rate-limit rows.

## Docker

To run Plinth on a server or laptop of your own instead of Cloudflare Workers, the
`ghcr.io/mr0b0t0/plinth` image runs the same Worker in a container, with D1 and R2 on a volume:
localhost only, behind your own reverse proxy with your domains, or through a Cloudflare Tunnel.
It takes its settings as `PLINTH_*` environment variables. See [docker.md](docker.md).
