# Production (hosted instance)

Status on 2026-11-14: **deployed** at <https://plinth.aconite.io>, with artifacts at
`<id>.plinthusercontent.com`.

## Configuration

| Setting | Value |
| --- | --- |
| `APP_HOST` | `plinth.aconite.io` (Workers Custom Domain) |
| `CONTENT_HOST` | `plinthusercontent.com` (zone route `*.plinthusercontent.com/*`) |
| `CONTENT_ISOLATION` | `origin`. The content host is its own registrable domain, so each artifact is its own origin, cross-site to the app (see [security.md](security.md)) |
| `ENVIRONMENT` | `production` |
| `ALLOW_SHARED_DATA` | `true`, set explicitly; the `DATA_*` limits use the defaults. The privacy notice covers shared data |
| Email | SendGrid, `EMAIL_FROM="Plinth <noreply@plinth.aconite.io>"` (`plinth.aconite.io` authenticated in SendGrid on 2026-11-14) |
| `ADMIN_EMAIL` | The maintainer's address |
| Operator (legal pages) | `OPERATOR_NAME="Aconite Software & Investments, Lda."`, `OPERATOR_ADDRESS="Avenida República da Bulgária, Lote 15, Loja A, 1950-375 Lisboa, Portugal"`, `OPERATOR_REGISTRATION="VAT PT516696696"`, `OPERATOR_EMAIL=hello@aconite.io` |
| Browser Rendering | `BROWSER` binding, for thumbnails and link-preview images (0.4.1); `THUMBNAILS` uses its default (on) |
| Compatibility and cron | `nodejs_compat` and `enable_request_signal`; hourly cron `0 * * * *` for the staging sweep and upload-ticket pruning (0.4.0) |
| Config file | `apps/worker/wrangler.production.jsonc` (git-ignored; written by `scripts/setup.mjs`) |

## Cloud resources (2026-11-14)

All in the operator's Cloudflare account:

| Resource | Name / ID | Created by |
| --- | --- | --- |
| D1 database | `plinth` (`7dd95d0b-dd98-469f-8eac-8c6a06c35b52`), migrations 0001, 0002 and 0004 to 0008 applied (there is no 0003) | `scripts/setup.mjs --remote --env production` |
| R2 bucket | `plinth-files` | `scripts/setup.mjs` |
| Worker | `plinth` (version `a2ef6a7c-7ecd-4a45-b5e2-0a1e901a99d5`, commit `6155b64` (v0.4.1): big builds and uploads (0.4.0) and thumbnails, migrations `0006_stored_bytes.sql`, `0007_upload_tickets.sql` and `0008_thumbnails.sql` applied first) | `wrangler deploy --config wrangler.production.jsonc` |
| Worker secrets | `SESSION_SECRET`, `TOKEN_SIGNING_KEY` (generated), `SENDGRID_API_KEY` | `scripts/setup.mjs` |
| Workers Custom Domain | `plinth.aconite.io`, plus the read-only `AAAA 100::` record and certificate Cloudflare creates for it | `wrangler deploy` |
| Domain and zone | `plinthusercontent.com`, registered through Cloudflare Registrar (Free plan zone). SSL/TLS "Full (strict)", "Always Use HTTPS" on, Universal SSL for `plinthusercontent.com` and `*.plinthusercontent.com` | Cloudflare dashboard |
| Worker route | `*.plinthusercontent.com/*` → `plinth` (zone `plinthusercontent.com`) | `wrangler deploy` |
| DNS record | `A *.plinthusercontent.com` → `192.0.2.0`, proxied (the zone's only record) | Cloudflare dashboard |
| SendGrid | Domain authentication for `plinth.aconite.io`: CNAMEs `em9604.plinth`, `s1._domainkey.plinth`, `s2._domainkey.plinth` and `TXT _dmarc.plinth` (`v=DMARC1; p=none;`), all DNS only in `aconite.io` | SendGrid and Cloudflare dashboards |
| WAF custom rule | `plinth_api_skip_bic` in zone `aconite.io` (phase `http_request_firewall_custom`), action Skip > Browser Integrity Check, logging on. Expression: `(http.host eq "plinth.aconite.io" and (http.request.uri.path eq "/mcp" or starts_with(http.request.uri.path, "/mcp/") or starts_with(http.request.uri.path, "/api/v1/") or starts_with(http.request.uri.path, "/oauth/") or starts_with(http.request.uri.path, "/.well-known/")))`. Added 2026-11-14: Browser Integrity Check (on by default) answered `403` `error code: 1010` to Python's default `Python-urllib/x.y` User-Agent before the Worker ran, so agent scripts could not reach `/mcp`, `/api/v1` or OAuth. Every other path keeps the check, and the content zone has no rule | Cloudflare API |

The `aconite.io` zone itself was moved from its registrar's DNS to Cloudflare on 2026-11-14,
with every existing record kept as DNS-only. Besides the SendGrid records and the WAF custom rule above,
nothing else in the zone was changed for Plinth.

The first deploy used `plinth-usercontent.aconite.io` with `CONTENT_ISOLATION=opaque`. Its route
`*.plinth-usercontent.aconite.io/*` and its `A *.plinth-usercontent` record were removed when the
content host moved to `plinthusercontent.com` (see `DECISIONS.md`). No Advanced Certificate was
ordered.

## Verified against production (2026-11-14)

First deploy, `e2e/staging/smoke.mjs --url https://plinth.aconite.io` (run with Node's DNS
pointed at Cloudflare's edge while public DNS was still switching over), **4/5**: health,
sign-in email accepted by SendGrid, OAuth discovery and the `/mcp` 401 challenge, and publish and
update over `/mcp` passed. The anonymous viewer fetch failed because the old content host had no
certificate. That smoke test used a personal access token named "Production smoke test" on
the maintainer's account, created for it (a user row for that address was inserted into the
production database).

After the switch to `plinthusercontent.com` (curl against Cloudflare's edge):

- `GET /healthz`: `{"ok":true,"environment":"production"}`
- `GET /api/v1/config`: `content_host` `plinthusercontent.com`, `content_isolation` `origin`
- The app's CSP has `frame-src https://*.plinthusercontent.com`
- `https://<unknown id>.plinthusercontent.com/`: 404 from Plinth with the content CSP (no
  `sandbox` directive) and `X-Content-Type-Options: nosniff`, certificate `*.plinthusercontent.com`
  (Let's Encrypt); `http://` answers 301 to `https://`

Full run after the switch (12:34 CET), against public DNS:

- `node e2e/staging/smoke.mjs --url https://plinth.aconite.io --token <token>`: **4/4**:
  - health;
  - OAuth discovery and the `/mcp` 401 challenge;
  - publish and update over `/mcp` with the official MCP client;
  - the anonymous viewer fetch, served from `<id>.plinthusercontent.com` with CSP, `nosniff`,
    `Permissions-Policy` and a single-use token.

  The token ("Production smoke test 2") was revoked afterwards.
- `POST /api/v1/auth/login` for the maintainer's address: 200, so SendGrid accepted a sign-in email
  from `noreply@plinth.aconite.io`. Delivery to the inbox wasn't checked from here.
- **Real client**: Claude Code 2.1.325 signed in to `https://plinth.aconite.io/mcp`:
  - The sign-in used dynamic client registration and PKCE, ending with a one-click Allow.
  - `claude mcp add --transport http`, then `claude mcp login`. Playwright drove the browser side
    with a session for the maintainer's account.
  - `claude -p` then published <https://plinth.aconite.io/a/welcome-to-plinth-lftvvkap0l> on the
    owner's Claude subscription. This was before the content-host switch.
  - After the switch it renders for an anonymous visitor in Chromium, light and dark, from
    `<id>.plinthusercontent.com`, with no console errors.
  - The OAuth connection was revoked and the server removed from the local Claude Code config
    afterwards.

After the v0.4.1 deploy (2026-11-15):

- `GET /healthz`: `{"ok":true,"environment":"production"}`. `GET /api/v1/config` reports the
  0.4.0 limits: `max_version_bytes` 52428800 and `max_assets_per_version` 511.
- **Thumbnails.** Fetching the link-viewable "Welcome to Plinth" page started the first capture
  (v5). Browser Rendering stored a 1200x630 JPEG of the artifact itself, not the app page, about
  20 seconds later. The page then carried `og:image` and `twitter:card` `summary_large_image`, and
  `/a/<slug>/og.jpg?version=5` answered 200 `image/jpeg` with `no-cache` and `nosniff`.
- **Private links.** A private (allowlist) artifact's page carried only the generic "Plinth
  artifact" card with no image, and its `og.jpg` answered 404.

## Waiting on a human

1. **Public Suffix List** (optional): submit `plinthusercontent.com` to the private section so that
   artifacts are separate sites from each other, not only from the app (see
   [deploy-checklist.md](deploy-checklist.md#public-suffix-list)).

## Redeploy

```sh
pnpm install && pnpm build && \
  pnpm --filter @plinth/worker check-config wrangler.production.jsonc && \
  pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc && \
  pnpm --filter @plinth/worker run deploy:production
```

`deploy:production` runs `check-config` on `wrangler.production.jsonc` and then
`wrangler deploy --config wrangler.production.jsonc`; it refuses a config without the
`enable_request_signal` compatibility flag or the `0 * * * *` cron trigger, which 0.4.0 needs
(`pnpm build` only warns about one). The commands are one `&&` list, so a failing step stops the
rest: `check-config` refusing the config stops before the migrations. The migrations only add, so
applying them before the Worker is safe.

## Shared data usage

Pages that declare shared data keep their documents in D1, which has a hard size limit per database
(10 GB on Workers Paid, 500 MB on Free). The defaults cap one owner at 16 MiB
(`DATA_MAX_BYTES_PER_USER`). Watch the total:

```sh
pnpm --filter @plinth/worker exec wrangler d1 execute DB --remote --config wrangler.production.jsonc \
  --command "SELECT sum(bytes) AS bytes, sum(docs) AS docs, count(*) AS artifacts FROM artifact_data_usage"
```

The largest artifacts: `SELECT artifact_id, docs, bytes FROM artifact_data_usage ORDER BY bytes DESC
LIMIT 20`. Shared data needs migration `0005_shared_state.sql`, applied with the migrations command
above before the Worker that uses it is deployed.
