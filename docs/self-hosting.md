# Self-hosting Plinth

Plinth runs as one Cloudflare Worker with one D1 database and one R2 bucket. A personal instance
fits Cloudflare's free tier. This guide covers the two modes, every setting, the setup script,
deploying, and connecting agents. The step-by-step DNS and email work is in
[deploy-checklist.md](deploy-checklist.md).

## What you need

- A Cloudflare account. Log in once with `pnpm --filter @plinth/worker exec wrangler login`.
- Two domains on that account (zones):
  - an **app host** for sign-in, the dashboard, the API and `/mcp`, e.g. `plinth.example.com`;
  - a **content host** on a *different registrable domain*, e.g. `example-usercontent.net`. Each
    artifact is served from `<artifact_id>.<content host>`. In production Plinth refuses to start
    if the two hosts share a registrable domain. A subdomain of your own domain works once it is on
    the Public Suffix List (see [deploy-checklist.md](deploy-checklist.md#the-content-domain)), or
    before that with `CONTENT_ISOLATION=opaque`, which costs artifacts their browser storage (see
    [security.md](security.md#opaque-content-isolation)).
- For multi-user mode: a SendGrid or Resend account with a verified sending domain.
- Node 22.12+ and pnpm 10 on the machine you deploy from.

## Choose a mode

**Multi-user (default).** People sign in with an email magic link or six-digit code. Each person
connects their own agents and owns their own artifacts. Needs an email provider.

**Single-user.** For one person. Set `SINGLE_USER_MODE=true` and exactly one `ADMIN_EMAIL`. Agents
connect with OAuth as on any instance. Optionally set a secret `ADMIN_TOKEN` of at least 32
characters: agents and scripts can then also send it as a bearer token and act as `ADMIN_EMAIL`. The web app still signs that one address in by email code. In
single-user mode production accepts `EMAIL_PROVIDER=console`, which writes the code to the Worker
log instead of sending mail; read it with `wrangler tail`. Use a real provider if the log is shared
with anyone else.

**On your own machine.** Either mode can also run on your computer instead of Cloudflare Workers,
with D1 and R2 on local disk and a Cloudflare Tunnel for access:
`node scripts/setup.mjs --tunnel`, then `pnpm local:start`. See
[local-hosting.md](local-hosting.md).

## Settings

Plain settings are `vars` in the Worker config (`apps/worker/wrangler.jsonc`, or the per-environment
copy the setup script writes). Secrets are set with `wrangler secret put` and never go in the config.
Booleans accept `true`, `1`, `yes` or `on`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENVIRONMENT` | `production` | `development`, `staging` or `production`. Production refuses unsafe settings (below) |
| `APP_HOST` | none (required) | Host and optional port of the app: sign-in, dashboard, API, `/mcp` |
| `CONTENT_HOST` | none (required) | Host for artifact content. Must differ from `APP_HOST`, not be a subdomain of it, and not be its parent. In production it must be a different registrable domain, or a subdomain listed on the Public Suffix List (see [deploy-checklist.md](deploy-checklist.md#the-content-domain)), unless `CONTENT_ISOLATION=opaque` |
| `CONTENT_ISOLATION` | `origin` | `origin` or `opaque`. `origin`: each artifact is its own origin with its own storage. `opaque`: every content response adds a CSP `sandbox` without `allow-same-origin`, so artifacts get an opaque origin: no cookies, `localStorage`, IndexedDB or service workers, and no `fetch` of their own files (load data with `<script>` or inline it). Editor preview and comment pins keep working. Required to run production with `APP_HOST` and `CONTENT_HOST` on one registrable domain, e.g. while the content host's Public Suffix List entry is pending; switch back to `origin` once it ships. See [security.md](security.md#opaque-content-isolation) for what it does not protect. `STAGING_CONTENT_FALLBACK` always behaves as `opaque` |
| `PUBLIC_SCHEME` | `https` | `http` only for local development. Production requires `https` |
| `EMAIL_PROVIDER` | `console` | `sendgrid`, `resend` or `console`. `console` logs sign-in links and codes; production refuses it unless in single-user mode |
| `EMAIL_FROM` | `Plinth <noreply@<APP_HOST>>` | Sender address. Must be on a domain verified with your provider |
| `MAX_ARTIFACTS_PER_USER` | `100` | Artifact quota per account. A per-user override lives in `users.artifact_limit` |
| `MAX_PUBLISHES_PER_HOUR` | `60` | Publishes and new versions per user per hour |
| `CDN_ALLOWLIST` | cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, cdn.tailwindcss.com, code.jquery.com, cdn.plot.ly | Script hosts artifacts may load from, comma or space separated. Empty means the default list |
| `SINGLE_USER_MODE` | `false` | One-person instance; needs exactly one `ADMIN_EMAIL` |
| `OPERATOR_NAME` | empty | Who runs the instance, named in its terms of use and privacy notice. With `OPERATOR_EMAIL`, the instance publishes both pages; without, only the acceptable use policy (right for a personal instance) |
| `OPERATOR_EMAIL` | empty | The one published contact address (questions, privacy, reports, authorities). A monitored inbox |
| `OPERATOR_ADDRESS` | empty | Registered address, shown in the terms and privacy notice |
| `OPERATOR_REGISTRATION` | empty | Company registration or VAT number, as it should read, e.g. `VAT PT516696696` |
| `OPERATOR_HOSTING` | `Cloudflare` | The hosting provider the privacy notice names as a processor |
| `ADMIN_EMAIL` | empty | Instance admins (comma separated): they see the report queue and can take artifacts down. In single-user mode, exactly one address: the owner |
| `ALLOW_PUBLIC_VISIBILITY` | `false` | Allows `public` visibility. Even then an account needs a verified email and a minimum age |
| `PUBLIC_MIN_ACCOUNT_AGE_HOURS` | `72` | Account age before `public` unlocks |
| `ALLOW_SHARED_DATA` | `true` | Lets pages that declare it keep shared data (polls, sign-up sheets, trackers among invited people) and learn who is viewing; see [security.md](security.md#shared-data-api). Empty keeps it on; any other value than `true`, `1`, `yes` or `on` turns it off. Off: no identity claims, pages report shared data as unavailable, and MCP and REST writes are refused while reads still work, so owners can export. Always off under `CONTENT_ISOLATION=opaque` |
| `DATA_MAX_DOCS_PER_ARTIFACT` | `1000` | Shared-data documents per artifact |
| `DATA_MAX_BYTES_PER_ARTIFACT` | `1048576` (1 MiB) | Shared-data bytes per artifact. At least `DATA_MAX_DOC_BYTES` |
| `DATA_MAX_BYTES_PER_USER` | `16777216` (16 MiB) | Shared-data bytes across all of one owner's artifacts (checked before each write, so concurrent writers may pass it by a request or two). At least `DATA_MAX_BYTES_PER_ARTIFACT`. D1 has a hard database size limit, so keep this modest |
| `DATA_MAX_DOC_BYTES` | `16384` (16 KiB) | Size of one shared-data document, `1024` to `65536` |
| `DATA_WRITES_PER_VIEWER_PER_HOUR` | `300` | Shared-data writes per writer per artifact (page, agent and app writes, deletes included). At least 1 |
| `DATA_WRITES_PER_ARTIFACT_PER_HOUR` | `2000` | Shared-data writes per artifact by all writers together. At least 1 |
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

## The setup script

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

## Deploy

```sh
pnpm install
pnpm build
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.production.jsonc
```

Then do the DNS, email and verification steps in [deploy-checklist.md](deploy-checklist.md).

To update later:

```sh
git pull
pnpm install
pnpm build
pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.production.jsonc
```

Apply migrations before deploying code that needs them. Migrations only add; they never rewrite
stored versions.

## Connect agents

The MCP endpoint is `https://<APP_HOST>/mcp`.

- **Multi-user:** add Plinth as a remote MCP server in Claude or Codex and approve the OAuth
  consent screen, or create a personal access token on the Connections page.
- **Single-user:** OAuth or a personal access token as above, or `ADMIN_TOKEN` if you set one.

Step-by-step instructions for each client are in [mcp.md](mcp.md).

## Operating notes

- **Quota.** `MAX_ARTIFACTS_PER_USER` is the default. To change one account, set
  `users.artifact_limit` with the admin command (`pnpm --filter @plinth/worker admin --help`) or
  `wrangler d1 execute`.
- **Abuse.** Emails in `ADMIN_EMAIL` see the report queue at `/admin/reports` and can take an
  artifact down.
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
- **Backups.** D1 Time Travel restores the database to any minute in the last 30 days (Workers
  Paid) or 7 days (Free). R2 objects are written once per version and never overwritten.
- **Logs.** `wrangler tail --config wrangler.production.jsonc`. Secrets and tokens are never logged.
