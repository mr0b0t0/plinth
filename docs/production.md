# Production (hosted instance)

Status on 2026-11-14: **deployed** at <https://plinth.aconite.io>. Artifact subdomains
(`<id>.plinth-usercontent.aconite.io`) **don't work yet**: they need the Advanced Certificate in
"Waiting on a human" below.

## Configuration

| Setting | Value |
| --- | --- |
| `APP_HOST` | `plinth.aconite.io` (Workers Custom Domain) |
| `CONTENT_HOST` | `plinth-usercontent.aconite.io` (zone route `*.plinth-usercontent.aconite.io/*`) |
| `CONTENT_ISOLATION` | `opaque`. App and content share `aconite.io`, so artifacts run in an opaque sandbox until a Public Suffix List entry ships (see [security.md](security.md)) |
| `ENVIRONMENT` | `production` |
| Email | SendGrid, `EMAIL_FROM="Plinth <noreply@aconite.io>"` |
| `ADMIN_EMAIL` | `german@aconite.io` |
| Config file | `apps/worker/wrangler.production.jsonc` (git-ignored; written by `scripts/setup.mjs`) |

## Cloud resources created (2026-11-14)

All in Cloudflare account `ebc2059679ce36868d5e16290c7730eb` (`german@aconite.io`):

| Resource | Name / ID | Created by |
| --- | --- | --- |
| D1 database | `plinth` (`7dd95d0b-dd98-469f-8eac-8c6a06c35b52`), migrations 0001 and 0002 applied | `scripts/setup.mjs --remote --env production` |
| R2 bucket | `plinth-files` | `scripts/setup.mjs` |
| Worker | `plinth` | `wrangler deploy --config wrangler.production.jsonc` |
| Worker secrets | `SESSION_SECRET`, `TOKEN_SIGNING_KEY` (generated), `SENDGRID_API_KEY` | `scripts/setup.mjs` |
| Workers Custom Domain | `plinth.aconite.io`, plus the read-only `AAAA 100::` record and certificate Cloudflare creates for it | `wrangler deploy` |
| Worker route | `*.plinth-usercontent.aconite.io/*` → `plinth` (id `509b4305addd4409b87748f9196032f6`) | `wrangler deploy` |
| DNS record | `A *.plinth-usercontent.aconite.io` → `192.0.2.0`, proxied | Cloudflare API |

The `aconite.io` zone itself was moved from Namecheap DNS to Cloudflare by German on 2026-11-14,
with every existing record kept as DNS-only. Nothing else in the zone was changed.

## Verified against production (2026-11-14)

`e2e/staging/smoke.mjs --url https://plinth.aconite.io` (run with Node's DNS pointed at
Cloudflare's edge while public DNS was still switching over), **4/5**:

- PASS health: `environment=production`
- PASS sign-in code email accepted by SendGrid for `german@aconite.io`
- PASS OAuth discovery metadata and the 401 challenge on `/mcp`
- PASS publish and update through `/mcp` with the official MCP client (v1 → v2)
- FAIL anonymous viewer fetch: the TLS handshake to `<id>.plinth-usercontent.aconite.io` fails
  because there's no certificate for the second-level wildcard yet (item 1 below)

The smoke test used a personal access token named "Production smoke test" on
`german@aconite.io`'s account, which was created for it (a user row for that address was inserted
into the production database).

## Waiting on a human

1. **Advanced Certificate for `*.plinth-usercontent.aconite.io`** (Cloudflare Advanced
   Certificate Manager, about $10/month): Cloudflare dashboard → `aconite.io` → SSL/TLS → Edge
   Certificates → Order Advanced Certificate, hosts `plinth-usercontent.aconite.io` and
   `*.plinth-usercontent.aconite.io`. Universal SSL covers only `*.aconite.io`, so until this
   exists, browsers can't open any artifact (TLS handshake failure). The app host works without it.
2. **Public Suffix List** (optional, later): renew `aconite.io` past 2028, submit
   `plinth-usercontent.aconite.io`, and once it has shipped in browsers and `tldts`, switch
   `CONTENT_ISOLATION` to `origin` (see [deploy-checklist.md](deploy-checklist.md)).
3. **Legal pages**: replace the `/legal/*` placeholder templates and publish a takedown contact.

## Redeploy

```sh
pnpm install && pnpm build
pnpm --filter @plinth/worker exec wrangler deploy --config wrangler.production.jsonc
```

Migrations: `pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`.
