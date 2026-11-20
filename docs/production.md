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
| Live rooms (#36) | On since 2026-11-18: the `ROOMS` binding (`ArtifactRoom`, migration tag `rooms-v1`) was added to the config by hand; `ALLOW_ROOMS` and `ALLOW_LIVE_EDITING` use their defaults (on) and `LIVE_DRAFT_RETENTION_DAYS` stays at 30. The privacy notice covers presence and unsaved page edits ([deploy-checklist.md](deploy-checklist.md#5-human-steps-to-go-live), step 13) |
| Category sharing | `ALLOW_CATEGORY_SHARING` is not set, so its default (on) applies once a release with it is deployed (migration `0013_category_sharing.sql`). The privacy notice's "Shared categories" item is part of that release and needs the maintainer's approval before the deploy |
| Compatibility and cron | `nodejs_compat` and `enable_request_signal`; hourly cron `0 * * * *` for the staging sweep and upload-ticket pruning (0.4.0) |
| Config file | `apps/worker/wrangler.production.jsonc` (git-ignored; written by `scripts/setup.mjs`) |

## Cloud resources (2026-11-14)

All in the operator's Cloudflare account:

| Resource | Name / ID | Created by |
| --- | --- | --- |
| D1 database | `plinth` (`7dd95d0b-dd98-469f-8eac-8c6a06c35b52`), migrations 0001, 0002, 0004 to 0012 and 0020 applied (there is no 0003, and 0013 to 0019 are not yet used; 0012 was applied after 0020, on 2026-11-20) | `scripts/setup.mjs --remote --env production` |
| R2 bucket | `plinth-files` | `scripts/setup.mjs` |
| Worker | `plinth` (version `87a8ef95-f96a-4c62-9ca3-18f049738ed2`, commit `76a988c` (v0.6.0): design systems (#59), slides (#60), comments from the page (#58), publishing from CI with tokens limited to one artifact (#61, migration `0012_bound_tokens.sql` applied first, after the v0.6.0 release that the Action and the New token dialog pin) and thumbnails bound to the version they picture (#99); before it `190060a` (version `e4040d5e-eb3b-4d0f-81da-e8d050d620c8`): the artifact type and server extension scaffolding (#54, #55), no migrations; before it `584db84` (version `9a63798c-0566-48d1-8445-f748e51f0396`): artifact stats (#86, migration `0020_artifact_opens.sql` applied first; `VIEW_LOG_RETENTION_DAYS` uses its default, 365), without the account-wide `/stats` page (#87), and the dashboard card fix (#78); before it `7b6e438`: the review-account sign-in (#53, off: `REVIEW_LOGIN_EMAIL` and `REVIEW_LOGIN_PASSWORD_HASH` unset), the OpenAI domain challenge route (#74, off: `OPENAI_APPS_CHALLENGE` unset) and plugin 0.16.0 with the OpenAI and Cursor builds (#73, #75, #77), no migrations; before it `3aea8c9`: live rooms and on-page doc editing (#49, migration `0011_live_drafts.sql` applied first, the `ROOMS` Durable Object), the Codex listing metadata (#47) and the plugin's instance option in the connect instructions (#50); before it `bb25eb8`: v0.5.0 plus MCP tool annotations (#40), artifact categories (#44, migration `0009_categories.sql`) and admin stats with view counts (#43, migration `0010_view_counts.sql`, `VIEW_COUNTS` on by default), both applied first; v0.5.0 (`1b094e6`) brought the T3 Code harness entry and in-chat previews (#28 to #32); v0.4.1 brought big builds and uploads (0.4.0) and thumbnails, migrations `0006_stored_bytes.sql`, `0007_upload_tickets.sql` and `0008_thumbnails.sql` applied first) | `wrangler deploy --config wrangler.production.jsonc` |
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

After the in-chat previews deploy (2026-11-16, `7239be3`):

- `GET /healthz`: `{"ok":true,"environment":"production"}`; `/llms.txt` lists T3 Code and
  `preview_artifact`.
- **T3 Code** (`t3` 0.1.9 web UI, Claude Code 2.1.325 with the maintainer's OAuth connection):
  a private page published through `publish_artifact` rendered under the call from
  `<id>.plinthusercontent.com`, with **Open on Plinth**, and no console errors.
- **Normal viewing unchanged**: a link viewer's pass for "Welcome to Plinth" still gets a 12-hour
  cookie, `frame-ancestors 'self' https://plinth.aconite.io` and
  `Cross-Origin-Resource-Policy: same-origin`.

After the v0.5.0 deploy (2026-11-16, `1b094e6`):

- **T3 Code** on production: Codex's publish and Claude's update (v2) and doc publish each
  rendered as an in-chat preview; an older thread kept showing its pinned v1; **Open on Plinth**
  opened `/a/<slug>/v/<n>`.
- **claude.ai** (custom connector): the preview shows its title, version and **Open on Plinth**,
  and says the page cannot be shown there. claude.ai leaves `https://*.plinthusercontent.com` out
  of a custom connector's `frame-src`; a listing in the Claude directory can ask for the site.
- **Connect an agent** shows the T3 Code tab with its Claude and Codex sections.

After the 2026-11-20 deploy (`76a988c`, v0.6.0, version `87a8ef95`; migration `0012` applied
first, the only one pending):

- The v0.6.0 release finished first: npm `@mr0b0t0/plinth@0.6.0`, the Docker image and the GitHub
  release, which is immutable (immutable releases were turned on for the repository before the
  tag), so `mr0b0t0/plinth/publish@v0.6.0` cannot be moved.
- `/healthz` is OK, `/api/v1/config` still reports `plinthusercontent.com` with `origin`
  isolation, the app's CSP keeps `frame-src https://*.plinthusercontent.com`, `/mcp` answers 401
  without a token, the served app bundle is the one built from `76a988c`, and `/openapi.json`
  lists the `slides` and `design_system` types and the `token_bound` error.

After the 2026-11-19 evening deploy (`190060a`, version `e4040d5e`, no migrations): the
scaffolding for artifact type modules and server extension lists (#54, #55), which changes no
behaviour.

After the 2026-11-19 afternoon deploys (`eefe367`, version `7495eee2`, migration `0020` applied
first; then `584db84`, version `9a63798c`, no migrations):

- Before the migration `artifact_view_days` held 3 rows, 4 opens; after it `artifact_opens` holds 4
  `unknown` rows and `artifact_view_days` is gone.
- `/healthz` is OK, `/api/v1/config` reports `view_log_retention_days: 365`, and
  `GET /api/v1/stats/artifacts` answers 401 without a session. The owner's per-artifact Stats page
  loads in the browser; `/stats` is the app's not-found page after #87.

After the 2026-11-19 deploy (`7b6e438`, version `7076b41f`, no migrations):

- `/healthz` returns `{"ok":true,"environment":"production"}`, and `wrangler deploy` lists
  `env.ROOMS (ArtifactRoom)`.
- `/.well-known/openai-apps-challenge` is 404 and `/api/v1/config` reports `review_login: false`,
  as neither is configured yet.

After the 2026-11-18 evening deploy (`3aea8c9`, migration `0011` applied first, version
`0193eab8`):

- `GET /healthz`: `{"ok":true,"environment":"production"}`; the version serves 100% of traffic and
  `wrangler versions view` lists `env.ROOMS (ArtifactRoom)` as a Durable Object binding.
- **Live editing**: an owner's doc page shows the **Edit** toggle ("Edit on the page").
- **Connect instructions**: the hosted `/llms.txt` gives the plugin commands without `--config`,
  as it should on the hosted instance.

After the 2026-11-18 deploy (`bb25eb8`, migrations `0009` and `0010` applied first):

- `GET /healthz`: `{"ok":true,"environment":"production"}`; `/mcp/server-card` reports `0.5.0`
  (it reported `0.4.2` before, from the build ahead of the version bump).
- **Tool annotations**: `tools/list` from an OAuth-connected Codex 0.169.0 client has all 16 tools
  with a title and explicit hints; only `set_visibility` and `write_artifact_data` are destructive.
- **Categories**: `publish_artifact`'s input schema has `category`.
- **Connect an agent**: the Cursor row reads "Cursor shared canvases (your Cursor team only)".

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
applying them before the Worker is safe. A config without the `ROOMS` binding passes the check with
a note: the Worker then runs with live rooms off.

## Shared data usage

Pages that declare shared data keep their documents in D1, which has a hard size limit per database
(10 GB on Workers Paid, 500 MB on Free). The defaults cap one owner at 16 MiB
(`DATA_MAX_BYTES_PER_USER`). Watch the total on the admin Stats page (`/admin/stats`, the Shared
data tile, for the emails in `ADMIN_EMAIL`), or from a terminal:

```sh
pnpm --filter @plinth/worker exec wrangler d1 execute DB --remote --config wrangler.production.jsonc \
  --command "SELECT sum(bytes) AS bytes, sum(docs) AS docs, count(*) AS artifacts FROM artifact_data_usage"
```

The largest artifacts: `SELECT artifact_id, docs, bytes FROM artifact_data_usage ORDER BY bytes DESC
LIMIT 20`. Shared data needs migration `0005_shared_state.sql`, applied with the migrations command
above before the Worker that uses it is deployed.
