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

It ends with the commands that connect Claude Code, Codex and the other agents.

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
- **Backups.** D1 Time Travel restores the database to any minute in the last 30 days (Workers
  Paid) or 7 days (Free). R2 objects are written once per version and never overwritten.
- **Logs.** `wrangler tail --config wrangler.production.jsonc` (for `plinth deploy`:
  `npx wrangler tail --config ~/.plinth/plinth/cloudflare/wrangler.jsonc`). Secrets and tokens are
  never logged.
- **Admin commands on a `plinth deploy` instance.** The quota and erasure commands above run from a
  checkout; point them at the deployment with
  `--config $HOME/.plinth/plinth/cloudflare/wrangler.jsonc`.
