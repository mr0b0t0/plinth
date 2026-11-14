# Deploy checklist

Everything needed to take a Plinth instance live on Cloudflare: resources, DNS for both hosts,
secrets, email authentication, and checks. The examples use the hosted instance's app host,
`plinth.aconite.io`; `CONTENT_DOMAIN` stands for a self-hoster's separate content domain, and the
hosted instance's content host, `plinth-usercontent.aconite.io`, is covered where it differs. Cloudflare and email
provider screens change; the details below were checked on 2026-11-13.

## The content domain

The hosted instance uses `CONTENT_HOST=plinth-usercontent.aconite.io`, so artifacts live at
`<id>.plinth-usercontent.aconite.io` (decided 2026-11-13, see `DECISIONS.md`). A self-hoster can
do either of the following:

- **A registrable domain of its own** (e.g. `plinthusercontent.net`), used for nothing but
  artifact content. Prefer its apex as `CONTENT_HOST`: `*.plinthusercontent.net` is a first-level
  wildcard that Cloudflare's free Universal SSL covers. Still submit it to the Public Suffix List.
- **A subdomain of a domain you already use** (the hosted instance's choice). It is safe only once
  it is on the Public Suffix List, because until then user HTML there is same-site with the app
  and can set cookies on the parent domain. Production refuses to start until the `tldts` version
  Plinth pins knows the entry (see "Public Suffix List" below), unless `CONTENT_ISOLATION=opaque`
  (next section). The wildcard is second-level, so it needs a paid Advanced Certificate.

### Until the PSL entry ships: `CONTENT_ISOLATION=opaque`

The hosted instance runs with `CONTENT_ISOLATION=opaque` while `plinth-usercontent.aconite.io` is
not yet on the Public Suffix List (or not yet in current browsers and the pinned `tldts`). Every
content response then carries a CSP `sandbox` without `allow-same-origin`, so artifacts get an
opaque origin: they cannot set or read cookies, so no cookie tossing onto `aconite.io`, and they
have no browser storage. Editor preview and comment pins keep working. What it does not cover
(same-site with `aconite.io`, a shared renderer process in some browsers, shared Safe Browsing
reputation) is in [security.md](security.md#opaque-content-isolation).

- Setup: pass `--content-isolation opaque` to `scripts/setup.mjs`; without it the script, like the
  Worker, refuses the shared registrable domain.
- Tell artifact authors (and agents) that `localStorage`, cookies and `fetch` of the artifact's own
  files do not work on the hosted instance for now.
- When the PSL entry is in current Chrome, Firefox and Safari and the pinned `tldts` knows it
  (step 4 below), set `CONTENT_ISOLATION=origin` (rerun setup with `--content-isolation origin`,
  or edit the var), deploy, and check that artifact responses no longer carry `sandbox`.

Either way, do not send email from the content host or serve anything else on it, and never use
the app host itself or a subdomain of it.

### Public Suffix List

1. Add `_psl.plinth-usercontent.aconite.io` as a `TXT` record whose value is the URL of the pull
   request below. The PSL maintainers check it.
2. Open a pull request on [github.com/publicsuffix/list](https://github.com/publicsuffix/list)
   adding `plinth-usercontent.aconite.io` to the private section under an
   "Aconite Software & Investments, Lda." heading. Follow the repository's current guidelines.
   Among other things, they want the domain registered for some time ahead (check `aconite.io`'s
   expiry first) and a reason, here: isolating user-uploaded HTML per subdomain.
3. After the merge, wait until the entry is in current Chrome, Firefox and Safari releases (each
   bundles a copy of the list, so this takes weeks to months).
4. Upgrade `tldts` in `apps/worker` and the root to a release that contains the entry, then run
   `pnpm test`. Until then the Worker answers 500 on every request in production with this
   configuration unless `CONTENT_ISOLATION=opaque`, and `setup.mjs` refuses it without
   `--content-isolation opaque`. Do not work around either check in any other way. Once the
   upgrade lands, switch the hosted instance to `CONTENT_ISOLATION=origin`.
5. Audit `aconite.io`: no service may set a sensitive cookie with `Domain=aconite.io`. The PSL
   entry stops artifacts from setting such cookies but not from receiving them.

## 1. Cloudflare resources

| Resource | Name (default) | Created by |
| --- | --- | --- |
| Worker | `plinth` (`plinth-<env>` for other environments) | `wrangler deploy`, or the first `wrangler secret put` |
| D1 database | `plinth` | `node scripts/setup.mjs --remote` |
| R2 bucket | `plinth-files` | `node scripts/setup.mjs --remote` |
| Zone for the app host | `aconite.io` | Cloudflare dashboard (already exists for the hosted instance) |
| Zone for the content host | `aconite.io` for the hosted instance (shared with the app host); for a separate domain, its own zone | Cloudflare dashboard |
| Advanced Certificate for `*.plinth-usercontent.aconite.io` | hosted instance only | Cloudflare dashboard → SSL/TLS → Edge Certificates → Order Advanced Certificate (Advanced Certificate Manager, paid) |

Workers Free is enough to start. The Workers Paid plan ($5/month) raises request and CPU limits
and D1 Time Travel from 7 to 30 days.

```sh
pnpm --filter @plinth/worker exec wrangler login
node scripts/setup.mjs --remote --env production --dry-run \
  --app-host plinth.aconite.io --content-host plinth-usercontent.aconite.io \
  --content-isolation opaque \
  --email-provider sendgrid --email-from "Plinth <noreply@aconite.io>" --admin-email you@aconite.io
# --content-isolation opaque only until the PSL entry ships (see "The content domain")
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
under SSL/TLS > Edge Certificates that a certificate lists `*.CONTENT_DOMAIN`. Universal SSL
covers only first-level wildcards.

For the hosted instance the content host is a subdomain inside the existing `aconite.io` zone:

- Route: `{ "pattern": "*.plinth-usercontent.aconite.io/*", "zone_name": "aconite.io" }`
  (`setup.mjs` writes it).
- DNS in the `aconite.io` zone: `A` record `*.plinth-usercontent` → `192.0.2.0`, proxied (and
  optionally `AAAA` `*.plinth-usercontent` → `100::`, proxied). Add nothing else under
  `plinth-usercontent`.
- Certificate: an Advanced Certificate covering `*.plinth-usercontent.aconite.io` (and
  `plinth-usercontent.aconite.io`). Universal SSL's `*.aconite.io` does not match
  `<id>.plinth-usercontent.aconite.io`.
- The `_psl.plinth-usercontent.aconite.io` `TXT` record from the PSL steps above.

### Checks after deploy

```sh
curl -sI https://plinth.aconite.io/healthz                 # 200, {"ok":true,"environment":"production"}
curl -sI https://abcdefghijklmnopqrst.CONTENT_DOMAIN/      # 404 from Plinth, with a CSP header
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://plinth.aconite.io/mcp   # 401
curl -sI -X POST https://plinth.aconite.io/mcp | grep -i www-authenticate        # resource_metadata=...
# CONTENT_ISOLATION=opaque: the CSP ends in "sandbox allow-scripts ..." without allow-same-origin
curl -sI https://abcdefghijklmnopqrst.plinth-usercontent.aconite.io/ | grep -i content-security-policy
curl -s https://plinth.aconite.io/api/v1/config        # "content_isolation":"opaque" (until the PSL entry ships)
curl -sI https://plinth.aconite.io/api/v1/config | grep -i set-cookie   # __Host-plinth_csrf=...; Path=/; ...; Secure
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
   the account's `workers.dev` subdomain. Done on 2026-11-13 (`aconite-io.workers.dev`).
1. Content host: `plinth-usercontent.aconite.io` (chosen 2026-11-13). Submit it to the Public
   Suffix List now. Until browsers and `tldts` know it, production runs only with
   `CONTENT_ISOLATION=opaque` (see "The content domain" and "Public Suffix List" above); switch to
   `origin` once they do. Self-hosters: choose a domain and record the choice in
   `docs/spec.md`, and submit it to the Public Suffix List (private section) early, since approval
   takes weeks.
2. Add the content host's DNS and certificate. Hosted instance: the `*.plinth-usercontent` record
   and the Advanced Certificate in the `aconite.io` zone (section 2). Separate domain: add it as a
   zone in the Cloudflare account that runs the Worker and point the registrar's nameservers at
   Cloudflare.
3. Audit `aconite.io` for sensitive `Domain=aconite.io` cookies (see
   [security.md](security.md#operator-checklist-for-the-content-domain)).
4. `wrangler login` with an account that can edit Workers, D1, R2 and both zones.
5. Run `node scripts/setup.mjs --remote --env production ...` (dry run first).
6. Authenticate the sending domain with SendGrid (hosted) or Resend; add DMARC; turn off click
   tracking. Put the API key in with `wrangler secret put`. The hosted instance sends as
   `Plinth <noreply@aconite.io>` (verified in Aconite's SendGrid account); authenticate
   `plinth.aconite.io` there first if you want a product-specific sender.
7. `pnpm build` and `wrangler deploy --config wrangler.production.jsonc`.
8. Confirm the route `*.plinth-usercontent.aconite.io/*` (or `*.CONTENT_DOMAIN/*`) shows under
   the Worker's Domains & Routes, and that `https://<any id>.plinth-usercontent.aconite.io/`
   answers 404 from Plinth with a valid certificate.
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
