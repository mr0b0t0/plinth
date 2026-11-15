# Staging

Status on 2026-11-13: **deployed** at <https://plinth-staging.aconite-io.workers.dev>.

## Cloud resources created

All in the operator's Cloudflare account:

| Resource | Name / ID | Created by |
| --- | --- | --- |
| `workers.dev` subdomain for the account | `aconite-io` (`aconite` was taken). Account-wide | Cloudflare API, `PUT /accounts/<id>/workers/subdomain` |
| D1 database | `plinth-staging` (`757e3e98-7966-4f42-a0dd-dd1cfea29eb3`), migrations 0001 and 0002 applied | `scripts/setup.mjs --remote` |
| R2 bucket | `plinth-staging` | `scripts/setup.mjs --remote` |
| Worker | `plinth-staging`, `workers_dev` on, preview URLs off | `wrangler deploy` |
| Worker secrets | `SESSION_SECRET`, `TOKEN_SIGNING_KEY` (generated), `SENDGRID_API_KEY` | `scripts/setup.mjs --remote` |
| Test data (2026-11-14) | The maintainer's user, with a token "Orchestrator session" (used to publish the design mockups; revoked 2026-11-14), and the Codex and Claude Code OAuth test connections (revoked) |
| Test data | User `smoke@aconite.io` with one agent connection "Staging smoke", and the artifacts the smoke test published | Smoke test steps below |

R2 was enabled on the account before the deploy. No DNS records, zone settings,
routes or custom domains were created or changed, and nothing under `aconite.io` was touched.
`ADMIN_EMAIL` on staging is the maintainer's address.

## Verified against the live deployment (2026-11-13)

- `e2e/staging/smoke.mjs`: **5/5 passed**: health, a sign-in code email accepted by SendGrid
  for the maintainer's address, OAuth discovery and the 401 challenge on `/mcp`, publish and update
  through `/mcp` with the official MCP client (v1 → v2), and an anonymous viewer fetch through the
  gate and one-time token with CSP, `nosniff` and `Permissions-Policy`, where the token can't be
  replayed.
- Chromium (Playwright): the home page renders, and `/a/<id>` shows the artifact inside its frame
  from `/__content/<id>/`. The only console errors are the expected 401s from `/api/v1/me` for an
  anonymous visitor.

### Real agent clients (2026-11-14, after the one-click connect flow, c61182a)

- **Codex CLI 0.154.0**: `codex mcp login` against staging registered a client, opened
  `/oauth/authorize`, the one-click consent page showed one Allow button, and the callback finished
  with "Successfully logged in". Plinth listed a new OAuth connection named "Codex" (client type
  `codex`, named automatically) that Codex then used. A Codex prompt could not run because this
  machine's Codex CLI is signed out of ChatGPT; that is the CLI's own login, not Plinth's.
- **Claude Code 2.1.325**: `claude mcp add --transport http` + `claude mcp login` completed the
  same flow ("Authenticated with plinthstg"). Then `claude -p` on the owner's Claude subscription
  called the MCP tools and published
  <https://plinth-staging.aconite-io.workers.dev/a/hello-from-claude-code-dbb5b09rmn>.
- In both runs the browser side (sign-in session + clicking Allow) was driven by Playwright with a
  staging session for the maintainer's account. Both test registrations were removed from the local
  client configs afterwards.

## What staging is

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `plinth-staging` | Served at `https://plinth-staging.aconite-io.workers.dev`, `ENVIRONMENT=staging` |
| D1 database | `plinth-staging` | Migrations from `migrations/` |
| R2 bucket | `plinth-staging` | Artifact files |

No DNS records, zone settings, routes or custom domains. Nothing under `aconite.io` is touched.

`workers.dev` has no wildcard subdomains, so staging serves artifacts from the app host under
`/__content/<artifact_id>/` (`STAGING_CONTENT_FALLBACK=true`). The Worker refuses that flag in
production. In this mode artifact HTML is same-origin with the app, so its CSP adds `sandbox`
without `allow-same-origin` (an opaque origin, no app cookies or API access): the fallback always
runs as `CONTENT_ISOLATION=opaque`. The editor live preview and comment pins use the opaque-mode
protocol there (frames identified by window and nonce); that path is verified locally with
subdomains (`CONTENT_ISOLATION=opaque` e2e project), not on staging's path fallback yet.
**Per-artifact subdomain isolation is verified locally only** (Workers Vitest suite and Playwright
against `*.content.localhost`).

Email: `EMAIL_PROVIDER=sendgrid`, `EMAIL_FROM="Plinth <noreply@aconite.io>"` (a test email through
the real adapter was accepted on 2026-11-13; `noreply@plinth.aconite.io` is not a verified sender).

## Deploy steps

From the repo root, with `wrangler login` done for the account:

```sh
pnpm install
SENDGRID_API_KEY=... node scripts/setup.mjs --remote --env staging --workers-dev \
  --worker-name plinth-staging --db-name plinth-staging --bucket plinth-staging \
  --app-host plinth-staging.aconite-io.workers.dev \
  --email-provider sendgrid --email-from "Plinth <noreply@aconite.io>"
pnpm build
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.staging.jsonc
```

Setup runs before the build because the build refuses a `wrangler.<env>.jsonc` that lacks the
release's compatibility flags or cron trigger, and a setup re-run adds them.

`setup.mjs` creates the D1 database and R2 bucket if missing, writes
`apps/worker/wrangler.staging.jsonc` (git-ignored), sets `SESSION_SECRET`, `TOKEN_SIGNING_KEY` and
`SENDGRID_API_KEY` through stdin, and applies the migrations. Add `--dry-run` first to see every
command.

## Smoke test

A personal access token for the smoke test (staging has no dev seed endpoint; this inserts a user
and the token's SHA-256 hash, the same way the Worker stores tokens):

```sh
TOKEN="plinth_pat_$(node -e 'console.log(require("crypto").randomBytes(30).toString("base64url").replace(/[-_]/g,"x").slice(0,40))')"
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$TOKEN').digest('hex'))")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pnpm --filter @plinth/worker exec wrangler d1 execute DB --remote --config wrangler.staging.jsonc --command \
  "INSERT INTO users (id,email,created_at,email_verified_at) VALUES ('smokeuser00000000001','smoke@aconite.io','$NOW','$NOW') ON CONFLICT(email) DO NOTHING;
   INSERT INTO agent_connections (id,user_id,label,client_type,kind,token_hash,scopes,created_at)
   SELECT 'smoke$(date +%s)abcdefg', id, 'Staging smoke', 'other', 'token', '$HASH', 'artifacts:read artifacts:write mentions', '$NOW' FROM users WHERE email='smoke@aconite.io';"
node e2e/staging/smoke.mjs --url https://plinth-staging.aconite-io.workers.dev --token "$TOKEN" --email you@example.com
```

The smoke test checks health, that a sign-in email is accepted (with `--email`), OAuth discovery
metadata and the 401 challenge on `/mcp`, publish and update through `/mcp` with the official MCP
client, the artifact fetched as an anonymous viewer through the gate and one-time token, the
security headers on the artifact response, and that the token cannot be replayed. It passed 5/5
against a local Worker started with `ENVIRONMENT=staging` and `STAGING_CONTENT_FALLBACK=true` on
2026-11-13, and 5/5 against the live staging deployment the same day.

## Deleting staging

```sh
pnpm --filter @plinth/worker exec wrangler delete --name plinth-staging
pnpm --filter @plinth/worker exec wrangler d1 delete plinth-staging
pnpm --filter @plinth/worker exec wrangler r2 bucket delete plinth-staging   # empty it first
```

To empty the bucket: Cloudflare dashboard → R2 → `plinth-staging` → select all → delete, or
`wrangler r2 object delete plinth-staging/<key>` per object.
