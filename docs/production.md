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
| Operator (legal pages) | `OPERATOR_NAME="Aconite Software & Investments, Lda."`, `OPERATOR_ADDRESS="Avenida República da Bulgária, Lote 15, Loja A, 1950-375 Lisboa, Portugal"`, `OPERATOR_REGISTRATION="VAT PT516696696"`, `OPERATOR_EMAIL=hello@aconite.io` |
| Config file | `apps/worker/wrangler.production.jsonc` (git-ignored; written by `scripts/setup.mjs`) |

## Cloud resources (2026-11-14)

All in Cloudflare account `ebc2059679ce36868d5e16290c7730eb` (`german@aconite.io`):

| Resource | Name / ID | Created by |
| --- | --- | --- |
| D1 database | `plinth` (`7dd95d0b-dd98-469f-8eac-8c6a06c35b52`), migrations 0001 and 0002 applied | `scripts/setup.mjs --remote --env production` |
| R2 bucket | `plinth-files` | `scripts/setup.mjs` |
| Worker | `plinth` (version `3a6b8ea4-95d6-4334-b127-8203e49989ae`, commit `3bbbdbe`: private by default, `list_comments` and `resolve_comment`) | `wrangler deploy --config wrangler.production.jsonc` |
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

Full run after the switch (12:34 CET), against public DNS:

- `node e2e/staging/smoke.mjs --url https://plinth.aconite.io --token <token>`: **4/4**:
  - health;
  - OAuth discovery and the `/mcp` 401 challenge;
  - publish and update over `/mcp` with the official MCP client;
  - the anonymous viewer fetch, served from `<id>.plinthusercontent.com` with CSP, `nosniff`,
    `Permissions-Policy` and a single-use token.

  The token ("Production smoke test 2") was revoked afterwards.
- `POST /api/v1/auth/login` for `german@aconite.io`: 200, so SendGrid accepted a sign-in email
  from `noreply@plinth.aconite.io`. Delivery to the inbox wasn't checked from here.
- **Real client**: Claude Code 2.1.325 signed in to `https://plinth.aconite.io/mcp`:
  - The sign-in used dynamic client registration and PKCE, ending with a one-click Allow.
  - `claude mcp add --transport http`, then `claude mcp login`. Playwright drove the browser side
    with a session for `german@aconite.io`.
  - `claude -p` then published <https://plinth.aconite.io/a/welcome-to-plinth-lftvvkap0l> on the
    owner's Claude subscription. This was before the content-host switch.
  - After the switch it renders for an anonymous visitor in Chromium, light and dark, from
    `<id>.plinthusercontent.com`, with no console errors.
  - The OAuth connection was revoked and the server removed from the local Claude Code config
    afterwards.

## Waiting on a human

1. **Public Suffix List** (optional): submit `plinthusercontent.com` to the private section so that
   artifacts are separate sites from each other, not only from the app (see
   [deploy-checklist.md](deploy-checklist.md#public-suffix-list)).

## Redeploy

```sh
pnpm install && pnpm build
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.production.jsonc
```

Migrations: `pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`.
