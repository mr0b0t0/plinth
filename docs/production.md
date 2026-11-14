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
| Email | SendGrid, `EMAIL_FROM="Plinth <noreply@plinth.aconite.io>"` (`plinth.aconite.io` authenticated in SendGrid on 2026-11-14) |
| `ADMIN_EMAIL` | `german@aconite.io` |
| Config file | `apps/worker/wrangler.production.jsonc` (git-ignored; written by `scripts/setup.mjs`) |

## Cloud resources (2026-11-14)

All in Cloudflare account `ebc2059679ce36868d5e16290c7730eb` (`german@aconite.io`):

| Resource | Name / ID | Created by |
| --- | --- | --- |
| D1 database | `plinth` (`7dd95d0b-dd98-469f-8eac-8c6a06c35b52`), migrations 0001 and 0002 applied | `scripts/setup.mjs --remote --env production` |
| R2 bucket | `plinth-files` | `scripts/setup.mjs` |
| Worker | `plinth` (version `7b2e4ce9-13b3-4d10-bba8-3a3875065ad3` after the content-host switch) | `wrangler deploy --config wrangler.production.jsonc` |
| Worker secrets | `SESSION_SECRET`, `TOKEN_SIGNING_KEY` (generated), `SENDGRID_API_KEY` | `scripts/setup.mjs` |
| Workers Custom Domain | `plinth.aconite.io`, plus the read-only `AAAA 100::` record and certificate Cloudflare creates for it | `wrangler deploy` |
| Domain and zone | `plinthusercontent.com`, registered through Cloudflare Registrar (Free plan zone). SSL/TLS "Full (strict)", "Always Use HTTPS" on, Universal SSL for `plinthusercontent.com` and `*.plinthusercontent.com` | Cloudflare dashboard |
| Worker route | `*.plinthusercontent.com/*` → `plinth` (zone `plinthusercontent.com`) | `wrangler deploy` |
| DNS record | `A *.plinthusercontent.com` → `192.0.2.0`, proxied (the zone's only record) | Cloudflare dashboard |
| SendGrid | Domain authentication for `plinth.aconite.io`: CNAMEs `em9604.plinth`, `s1._domainkey.plinth`, `s2._domainkey.plinth` and `TXT _dmarc.plinth` (`v=DMARC1; p=none;`), all DNS only in `aconite.io` | SendGrid and Cloudflare dashboards |

The `aconite.io` zone itself was moved from Namecheap DNS to Cloudflare by German on 2026-11-14,
with every existing record kept as DNS-only. Besides the SendGrid records above, nothing else in
the zone was changed for Plinth.

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
`german@aconite.io`'s account, created for it (a user row for that address was inserted into the
production database).

After the switch to `plinthusercontent.com` (curl against Cloudflare's edge):

- `GET /healthz`: `{"ok":true,"environment":"production"}`
- `GET /api/v1/config`: `content_host` `plinthusercontent.com`, `content_isolation` `origin`
- The app's CSP has `frame-src https://*.plinthusercontent.com`
- `https://<unknown id>.plinthusercontent.com/`: 404 from Plinth with the content CSP (no
  `sandbox` directive) and `X-Content-Type-Options: nosniff`, certificate `*.plinthusercontent.com`
  (Let's Encrypt); `http://` answers 301 to `https://`

Not yet re-run after the switch: the full smoke test (publish, update and the anonymous viewer
fetch), which needs a personal access token, and a sign-in email from the new
`noreply@plinth.aconite.io` sender.

## Waiting on a human

1. **Full smoke test**: create a personal access token on <https://plinth.aconite.io> and run
   `node e2e/staging/smoke.mjs --url https://plinth.aconite.io --token <token> --email german@aconite.io`.
   Expect 5/5, and check that the sign-in email comes from `noreply@plinth.aconite.io`.
2. **Public Suffix List** (optional): submit `plinthusercontent.com` to the private section so that
   artifacts are separate sites from each other, not only from the app (see
   [deploy-checklist.md](deploy-checklist.md#public-suffix-list)).
3. **Legal pages**: replace the `/legal/*` placeholder templates and publish a takedown contact.

## Redeploy

```sh
pnpm install && pnpm build
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.production.jsonc
```

Migrations: `pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`.
