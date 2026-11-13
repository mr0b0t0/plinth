# Deploy checklist

Everything needed to take a Plinth instance live on Cloudflare: resources, DNS for both hosts,
secrets, email authentication, and checks. The examples use the hosted instance's app host,
`plinth.aconite.io`, and a placeholder content domain, `CONTENT_DOMAIN`. Cloudflare and email
provider screens change; the details below were checked on 2026-11-13.

## The content domain is still open

The hosted instance has no content domain yet. Whatever is chosen:

- It must **not** be `aconite.io` or any subdomain of it. User HTML there would be same-site with
  the app and with Aconite's other services, so cookies and storage would leak across.
- It should be a registrable domain of its own (e.g. `plinthusercontent.net`), used for nothing
  but artifact content. Do not send email from it or host anything else on it.
- Prefer using the domain's apex as `CONTENT_HOST`. Artifacts then live at
  `<id>.plinthusercontent.net`, a first-level wildcard that Cloudflare's free Universal SSL covers.
  If `CONTENT_HOST` is itself a subdomain (`u.example.net`), the wildcard `*.u.example.net` is
  second-level and needs an Advanced Certificate (paid) or Total TLS.
- Production refuses to start if `APP_HOST` and `CONTENT_HOST` share a registrable domain.

## 1. Cloudflare resources

| Resource | Name (default) | Created by |
| --- | --- | --- |
| Worker | `plinth` (`plinth-<env>` for other environments) | `wrangler deploy`, or the first `wrangler secret put` |
| D1 database | `plinth` | `node scripts/setup.mjs --remote` |
| R2 bucket | `plinth-files` | `node scripts/setup.mjs --remote` |
| Zone for the app host | `aconite.io` | Cloudflare dashboard (already exists for the hosted instance) |
| Zone for the content domain | `CONTENT_DOMAIN` | Cloudflare dashboard, after buying the domain |

Workers Free is enough to start. The Workers Paid plan ($5/month) raises request and CPU limits
and D1 Time Travel from 7 to 30 days.

```sh
pnpm --filter @plinth/worker exec wrangler login
node scripts/setup.mjs --remote --env production --dry-run \
  --app-host plinth.aconite.io --content-host CONTENT_DOMAIN \
  --email-provider sendgrid --email-from "Plinth <noreply@aconite.io>" --admin-email you@aconite.io
# read the plan, then run the same command without --dry-run
```

## 2. DNS and routing

### App host: a Workers Custom Domain

The generated config contains `{ "pattern": "plinth.aconite.io", "custom_domain": true }`. On
`wrangler deploy`, Cloudflare creates the DNS record and certificate for `plinth.aconite.io`
itself. Requirements:

- `aconite.io` is an active zone in the same Cloudflare account.
- No existing DNS record named `plinth` (delete it first, or the custom domain fails to attach).

### Content host: a wildcard route plus a wildcard DNS record

Workers Custom Domains do not support wildcards, so the content host uses a zone route:

```jsonc
{ "pattern": "*.CONTENT_DOMAIN/*", "zone_name": "CONTENT_DOMAIN" }
```

`*.` matches every subdomain but not the apex, which is what Plinth wants: the bare content host
only answers 404. The route needs a proxied DNS record for the wildcard so traffic reaches
Cloudflare:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| `A` | `*` | `192.0.2.0` | Proxied (orange cloud) |
| `AAAA` | `*` | `100::` | Proxied (orange cloud) |

Either record works; the address is a placeholder because the Worker answers before any origin is
contacted. Add both if you want IPv4 and IPv6 clients covered explicitly. A wildcard record covers
only names that have no record of their own, so keep the content zone otherwise empty.

SSL/TLS for the content zone: encryption mode "Full (strict)" and "Always Use HTTPS" on. Check
under SSL/TLS > Edge Certificates that the Universal certificate lists `*.CONTENT_DOMAIN`.

### Checks after deploy

```sh
curl -sI https://plinth.aconite.io/healthz                 # 200, {"ok":true,"environment":"production"}
curl -sI https://abcdefghijklmnopqrst.CONTENT_DOMAIN/      # 404 from Plinth, with a CSP header
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://plinth.aconite.io/mcp   # 401
curl -sI -X POST https://plinth.aconite.io/mcp | grep -i www-authenticate        # resource_metadata=...
```

## 3. Secrets

Set by the setup script. To set or rotate one by hand, pipe the value on stdin so it never lands in
shell history or process lists:

```sh
cd apps/worker
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SECRET --config wrangler.production.jsonc
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put TOKEN_SIGNING_KEY --config wrangler.production.jsonc
pbpaste | npx wrangler secret put SENDGRID_API_KEY --config wrangler.production.jsonc   # macOS clipboard; or RESEND_API_KEY
```

| Secret | When |
| --- | --- |
| `SESSION_SECRET`, `TOKEN_SIGNING_KEY` | Always. At least 32 characters each |
| `SENDGRID_API_KEY` | `EMAIL_PROVIDER=sendgrid`. Restrict the key to Mail Send |
| `RESEND_API_KEY` | `EMAIL_PROVIDER=resend`. Sending access only, limited to the sending domain |
| `ADMIN_TOKEN` | `SINGLE_USER_MODE=true` only |

List what is set (names only): `npx wrangler secret list --config wrangler.production.jsonc`.

## 4. Email domain authentication

Sign-in links and viewer codes must arrive in inboxes, not spam. Authenticate the domain in
`EMAIL_FROM` (for the hosted instance, `aconite.io` or a subdomain such as `mail.aconite.io`).
Never send from the content domain.

### SendGrid (hosted instance)

1. Settings > Sender Authentication > Authenticate Your Domain. Choose Cloudflare as the DNS host,
   enter the sending domain, keep "automated security" on.
2. Add the records SendGrid shows. With automated security they are CNAMEs (ids differ per account):

   | Type | Name | Target |
   | --- | --- | --- |
   | CNAME | `em1234.<domain>` | `u1234567.wl.sendgrid.net` |
   | CNAME | `s1._domainkey.<domain>` | `s1.domainkey.u1234567.wl.sendgrid.net` |
   | CNAME | `s2._domainkey.<domain>` | `s2.domainkey.u1234567.wl.sendgrid.net` |

   Set them to **DNS only** (grey cloud) in Cloudflare. SPF is covered by the `em` CNAME (the
   return-path domain); DKIM by the two `_domainkey` CNAMEs.
3. Press Verify in SendGrid.
4. Turn off click tracking for this sender (Settings > Tracking). Click tracking rewrites links, and
   magic links must reach Plinth unchanged.

### Resend (self-hosters)

1. Domains > Add Domain. Using a subdomain such as `mail.example.com` keeps the root domain's
   reputation separate.
2. Add the records from the domain's Records tab. Values are generated per domain; typically:
   - a DKIM `TXT` record at `resend._domainkey.<domain>`;
   - an `MX` and an SPF `TXT` record on the return-path subdomain (`send.<domain>` by default).
3. Set them to **DNS only** in Cloudflare (proxied records break verification), then Verify.

### DMARC (both providers)

One `TXT` record on the organisational domain, starting in monitoring mode:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@<domain>` |

Read the reports for a few weeks, then tighten to `p=quarantine` and later `p=reject` once all
legitimate mail passes SPF or DKIM alignment. If the domain already has a DMARC record (Aconite's
probably does), keep it; do not add a second one.

## 5. Human steps to go live

These need accounts, money or legal judgement, so no script does them.

0. Before staging (see [staging.md](staging.md)): enable R2 on the Cloudflare account and choose
   the account's `workers.dev` subdomain (Workers & Pages). Both were missing on 2026-11-13, so the
   staging deploy has not happened yet.
1. Choose and buy the content domain. It must not be under `aconite.io`. Record the choice in
   `docs/spec.md` (it is listed under "Still open").
2. Submit the content domain to the Public Suffix List (private section); see
   [security.md](security.md#operator-checklist-for-the-content-domain). Approval takes weeks, so
   start early.
3. Add the content domain as a zone in the Cloudflare account that will run the Worker, and point
   the registrar's nameservers at Cloudflare.
4. `wrangler login` with an account that can edit Workers, D1, R2 and both zones.
5. Run `node scripts/setup.mjs --remote --env production ...` (dry run first).
6. Authenticate the sending domain with SendGrid (hosted) or Resend; add DMARC; turn off click
   tracking. Put the API key in with `wrangler secret put`. The hosted instance sends as
   `Plinth <noreply@aconite.io>` (verified in Aconite's SendGrid account); authenticate
   `plinth.aconite.io` there first if you want a product-specific sender.
7. `pnpm build` and `wrangler deploy --config wrangler.production.jsonc`.
8. Add the wildcard `*` DNS record on the content zone (proxied) and confirm the route
   `*.CONTENT_DOMAIN/*` shows under the Worker's Domains & Routes.
9. Run the checks in section 2. Sign in with an address in `ADMIN_EMAIL`, publish a test artifact
   over MCP, and open its link in a private window for each visibility.
10. Replace the placeholder terms, privacy and acceptable-use pages (`/legal/*`) with reviewed text,
    and publish a takedown contact (the operator is a hosting provider under the DSA and a
    controller under GDPR).
11. Decide when to set `ALLOW_PUBLIC_VISIBILITY=true`. Until then, artifacts can be unlisted,
    password or allowlist only.
12. Turn on GitHub private vulnerability reporting for the repository (see
    [security.md](security.md)).
13. Watch the first days with `wrangler tail` and the Cloudflare analytics for the Worker and D1.
