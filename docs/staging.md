# Staging

Status on 2026-11-13: **not deployed. No cloud resources were created.**

The build brief allows a staging deploy to the Cloudflare account's `workers.dev` address with
three new resources, all named `plinth-staging`. Two account-level prerequisites are missing, and
both are outside what the build was allowed to change:

| Prerequisite | Found | How to fix (human) |
| --- | --- | --- |
| A `workers.dev` subdomain for the account | The API answers `10007 You do not have a workers.dev subdomain` | Cloudflare dashboard → Workers & Pages → choose your `workers.dev` subdomain. It is an account-wide setting, not a `plinth-staging` resource |
| R2 enabled on the account | The API answers `10042 Please enable R2 through the Cloudflare Dashboard` | Cloudflare dashboard → R2 → enable (accept the terms) |

Checked with the Cloudflare API as `german@aconite.io`, account
`ebc2059679ce36868d5e16290c7730eb`. No Worker, D1 database or R2 bucket named `plinth*` existed.

## What staging will be

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `plinth-staging` | Served at `https://plinth-staging.<subdomain>.workers.dev`, `ENVIRONMENT=staging` |
| D1 database | `plinth-staging` | Migrations from `migrations/` |
| R2 bucket | `plinth-staging` | Artifact files |

No DNS records, zone settings, routes or custom domains. Nothing under `aconite.io` is touched.

`workers.dev` has no wildcard subdomains, so staging serves artifacts from the app host under
`/__content/<artifact_id>/` (`STAGING_CONTENT_FALLBACK=true`). The Worker refuses that flag in
production. In this mode artifact HTML is same-origin with the app, so its CSP adds `sandbox`
without `allow-same-origin` (an opaque origin, no app cookies or API access), and the editor live
preview and comment pins are disabled. **Per-artifact subdomain isolation is verified locally
only** (Workers Vitest suite and Playwright against `*.content.localhost`).

Email: `EMAIL_PROVIDER=sendgrid`, `EMAIL_FROM="Plinth <noreply@aconite.io>"` (a test email through
the real adapter was accepted on 2026-11-13; `noreply@plinth.aconite.io` is not a verified sender).

## Deploy steps (after the prerequisites)

From the repo root, with `wrangler login` done for the account:

```sh
pnpm install && pnpm build
SENDGRID_API_KEY=... node scripts/setup.mjs --remote --env staging --workers-dev \
  --worker-name plinth-staging --db-name plinth-staging --bucket plinth-staging \
  --app-host plinth-staging.<subdomain>.workers.dev \
  --email-provider sendgrid --email-from "Plinth <noreply@aconite.io>"
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.staging.jsonc
```

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
node e2e/staging/smoke.mjs --url https://plinth-staging.<subdomain>.workers.dev --token "$TOKEN" --email german@aconite.io
```

The smoke test checks health, that a sign-in email is accepted (with `--email`), OAuth discovery
metadata and the 401 challenge on `/mcp`, publish and update through `/mcp` with the official MCP
client, the artifact fetched as an anonymous viewer through the gate and one-time token, the
security headers on the artifact response, and that the token cannot be replayed. It passed 5/5
against a local Worker started with `ENVIRONMENT=staging` and `STAGING_CONTENT_FALLBACK=true` on
2026-11-13. It has not run against a live deployment.

## Deleting staging

```sh
pnpm --filter @plinth/worker exec wrangler delete --name plinth-staging
pnpm --filter @plinth/worker exec wrangler d1 delete plinth-staging
pnpm --filter @plinth/worker exec wrangler r2 bucket delete plinth-staging   # empty it first
```

To empty the bucket: Cloudflare dashboard → R2 → `plinth-staging` → select all → delete, or
`wrangler r2 object delete plinth-staging/<key>` per object.
