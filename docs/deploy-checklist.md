# Deploy checklist

Everything needed to take a Plinth instance live on Cloudflare: resources, DNS for both hosts,
secrets, email authentication, and checks. The examples use the hosted instance's app host,
`plinth.aconite.io`; `CONTENT_DOMAIN` stands for the separate content domain, which for the hosted
instance is `plinthusercontent.com`, and `APP_HOST` for the app host where a rule or command must
name your own (hosted instance: `plinth.aconite.io`). Cloudflare and email provider screens change; the details
below were checked on 2026-11-13 and 2026-11-14.

## The content domain

The hosted instance uses `CONTENT_HOST=plinthusercontent.com` with `CONTENT_ISOLATION=origin`, so
artifacts live at `<id>.plinthusercontent.com` (decided 2026-11-14, replacing
`plinth-usercontent.aconite.io`; see `DECISIONS.md`). Two options:

- **A registrable domain of its own** (the hosted instance's choice), used for nothing but
  artifact content. Use its apex as `CONTENT_HOST`: `*.plinthusercontent.com` is a first-level
  wildcard that Cloudflare's free Universal SSL covers, and the domain is cross-site to the app
  from day one. Still submit it to the Public Suffix List (below), so artifacts are separate sites
  from each other too.
- **A subdomain of a domain you already use.** It is safe only once it is on the Public Suffix
  List, because until then user HTML there is same-site with the app and can set cookies on the
  parent domain. Production refuses to start until the `tldts` version Plinth pins knows the entry
  (see "Public Suffix List" below), unless `CONTENT_ISOLATION=opaque` (next section). The wildcard
  is second-level, so on Cloudflare it needs a paid Advanced Certificate (Advanced Certificate
  Manager, about $10/month). This is why the hosted instance moved off
  `plinth-usercontent.aconite.io`.

### A content subdomain before its PSL entry ships: `CONTENT_ISOLATION=opaque`

With a content subdomain that is not yet on the Public Suffix List (or not yet in current browsers
and the pinned `tldts`), production runs only with `CONTENT_ISOLATION=opaque`. Every content
response then carries a CSP `sandbox` without `allow-same-origin`, so artifacts get an opaque
origin: they cannot set or read cookies, so no cookie tossing onto the parent domain, and they have
no browser storage. Editor preview and comment pins keep working. What it does not cover
(same-site with the parent domain, a shared renderer process in some browsers, shared Safe
Browsing reputation) is in [security.md](security.md#opaque-content-isolation).

- Setup: pass `--content-isolation opaque` to `scripts/setup.mjs`; without it the script, like the
  Worker, refuses the shared registrable domain.
- Tell artifact authors (and agents) that `localStorage`, cookies and `fetch` of the artifact's own
  files do not work on that instance for now.
- When the PSL entry is in current Chrome, Firefox and Safari and the pinned `tldts` knows it
  (step 4 below), set `CONTENT_ISOLATION=origin` (rerun setup with `--content-isolation origin`,
  or edit the var), deploy, and check that artifact responses no longer carry `sandbox`.

Either way, do not send email from the content host or serve anything else on it, and never use
the app host itself or a subdomain of it.

### Public Suffix List

For a separate content domain (the hosted instance) this is recommended; for a content subdomain
it is mandatory.

1. Add `_psl.CONTENT_DOMAIN` as a `TXT` record whose value is the URL of the pull request below.
   The PSL maintainers check it.
2. Open a pull request on [github.com/publicsuffix/list](https://github.com/publicsuffix/list)
   adding the content domain (hosted instance: `plinthusercontent.com`) to the private section
   under your organisation's heading ("Aconite Software & Investments, Lda." for the hosted
   instance). Follow the repository's current guidelines. Among other things, they want the domain
   registered for some time ahead (check its expiry first) and a reason, here: isolating
   user-uploaded HTML per subdomain.
3. After the merge, wait until the entry is in current Chrome, Firefox and Safari releases (each
   bundles a copy of the list, so this takes weeks to months).
4. Upgrade `tldts` in `apps/worker` and the root to a release that contains the entry, then run
   `pnpm test`. For a content subdomain, until then the Worker answers 500 on every request in
   production unless `CONTENT_ISOLATION=opaque`, and `setup.mjs` refuses it without
   `--content-isolation opaque`. Do not work around either check in any other way.
5. For a content subdomain, audit the parent domain: no service may set a sensitive cookie with
   `Domain=<parent>`. The PSL entry stops artifacts from setting such cookies but not from
   receiving them.

## 1. Cloudflare resources

| Resource | Name (default) | Created by |
| --- | --- | --- |
| Worker | `plinth` (`plinth-<env>` for other environments) | `wrangler deploy`, or the first `wrangler secret put` |
| D1 database | `plinth` | `node scripts/setup.mjs --remote` |
| R2 bucket | `plinth-files` | `node scripts/setup.mjs --remote` |
| Zone for the app host | `aconite.io` | Cloudflare dashboard (already exists for the hosted instance) |
| Zone for the content host | `plinthusercontent.com` for the hosted instance (registered through Cloudflare Registrar, so the zone already uses Cloudflare's nameservers); for a separate domain bought elsewhere, add it as a zone and point the registrar's nameservers at Cloudflare | Cloudflare dashboard |
| Durable Object class (live rooms) | `ArtifactRoom`, bound as `ROOMS`, migration tag `rooms-v1` | `wrangler deploy`, from the `durable_objects` and `migrations` keys every generated config carries ([Live rooms](#live-rooms)) |
| Browser Rendering binding (optional, for thumbnails) | `"browser": { "binding": "BROWSER" }` in your wrangler config | Your own `wrangler.<env>.jsonc`; Browser Rendering is billed per browser hour (Workers Free includes a small daily allowance) |
| Advanced Certificate for `*.<content subdomain>` | only for a content subdomain (second-level wildcard); not needed for the hosted instance | Cloudflare dashboard → SSL/TLS → Edge Certificates → Order Advanced Certificate (Advanced Certificate Manager, paid) |

Workers Free is enough to start with small pages. The Workers Paid plan ($5/month) raises request
and CPU limits and D1 Time Travel from 7 to 30 days.

### Version limits and the Workers plan

Two settings size what one version may hold; both are `vars` like the others
([self-hosting.md](self-hosting.md#settings)):

| Variable | Default | Allowed |
| --- | --- | --- |
| `MAX_VERSION_BYTES` | `52428800` (50 MB) | `1048576` to `67108864` (1 to 64 MB) |
| `MAX_ASSETS_PER_VERSION` | `511` | `1` to `900` |

A value outside the range stops the Worker with a configuration error. `GET /api/v1/config` reports
the values in effect under `limits`, with `max_bundle_bytes` (the version limit plus 8 MB of tar
overhead), the largest body an upload from `start_upload` or the CLI sends.

- **Cron Triggers on Workers Free:** the hourly sweep is one Cron Trigger, and Cron Triggers
  count against the account's limit: 5 per account on Workers Free (250 on Paid). An account
  already at 5 cannot deploy Plinth's config until one is removed.
- **Workers Free:** Workers Free cannot reliably publish multi-megabyte versions. Its 10 ms of CPU
  per request runs out on a publish of a few megabytes: reading, inflating and hashing a 5 MB,
  50-file version alone took 12 to 24 ms in local measurements, before routing, validation, the
  database and the warning scan. Such a publish fails with Cloudflare error 1102. On Free, set
  `MAX_VERSION_BYTES=1048576` (the minimum) and a small `MAX_ASSETS_PER_VERSION` (for example
  `20`), and expect even those to fail now and then. Big pages and uploaded builds
  (`start_upload` and `plinth publish`) need Workers Paid.
- **Workers Paid:** the defaults fit. You may also raise the CPU limit per request with
  `"limits": { "cpu_ms": 300000 }` in the Worker config (5 minutes, the Paid maximum).
- A reverse proxy in front of the Worker (the Docker setup's nginx, for example) must accept bodies
  of at least `max_bundle_bytes` ([docker.md](docker.md)).
- **Memory was not measured on a live isolate.** A bundle holds at most max(16 MB in-flight
  budget, 25 MB per-file cap) of file bytes at once, plus the copy WebCrypto makes of the file
  being hashed (up to 25 MB), up to 8 MB of scan text, a 5 MB source, and what the gzip
  decompressor has inflated but the reader has not read yet (it is fed only as the reader reads,
  in slices sized to inflate to about 1 MB, but up to about 8.4 MB for the first slice after the
  data turns from incompressible to maximally compressible, which a sender can arrange; count
  8.4 MB per bundle). Tests check that bound by counting bytes; the local runtime reports no
  heap figures.
  Bundles of different users can share one 128 MB isolate. Before relying on the 25 MB per-file
  default on a busy instance, try two concurrent maximum-size bundles plus a large inline publish
  on staging.
- **Orphaned upload files.** A bundle whose client disconnects deletes its own files (the
  `enable_request_signal` compatibility flag is what lets it notice; it must be in the config you
  deploy with, see [§6](#6-upgrading-and-rolling-back)), but a
  request the runtime kills outright can still leave files no version names. Implementation note:
  whether Cloudflare's runtime fires `request.signal` once the whole body has been read is not
  tested, and local `wrangler dev` does not, so a client that disconnects after sending everything
  may still get its version (whole: commit and abort exclude each other). Clients are told to check
  with `get_artifact` after a lost answer, never that a disconnect cannot commit. They do not count
  toward any quota. The Worker's hourly cron trigger (`"triggers": { "crons": ["0 * * * *"] }`,
  also required in the config you deploy with) removes them once the attempt is 45 minutes old;
  minting an upload ticket or posting a bundle also starts a sweep of at most 20 attempts, which
  is what clears them on an instance with no cron.
  Run `pnpm --filter @plinth/worker admin -- sweep-orphans --remote` only for legacy orphans:
  files written before 0.4.0, which no staging row names
  ([self-hosting.md](self-hosting.md#operating-notes)).

### Live rooms

Live rooms (`plinth.room` on pages that declare `room`, and doc editors seeing each other's page
edits) run in one Durable Object class inside the same Worker: `ArtifactRoom`, one object per
artifact that has a room open, SQLite-backed and storing nothing but an alarm. `apps/worker/wrangler.jsonc`,
the setup script, `plinth deploy`, local, tunnel and Docker instances all write the same two keys:

```jsonc
"durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "ArtifactRoom" }] },
"migrations": [{ "tag": "rooms-v1", "new_sqlite_classes": ["ArtifactRoom"] }]
```

- **The migration applies on the next deploy** that has the binding, once and for good: Cloudflare
  records the tag `rooms-v1` against the Worker. Never rename or drop it, and keep the
  `migrations` list in every later config (an operator's own migrations go after it, under new
  tags).
- **Workers Free** allows only SQLite-backed Durable Object classes, which is what
  `new_sqlite_classes` declares. Its daily allowance is 100,000 Durable Object requests, 13,000 GB-s
  of duration and 5 GB stored. Workers Paid ($5/month) includes 1 million requests and 400,000 GB-s
  a month, then $0.15 per million requests and $12.50 per million GB-s.
- **Cost.** An object exists only while someone has a room open: a page that declares `room`, or a
  doc that an owner or editor has open. Each connection is one request, incoming messages bill at
  20 to 1, outgoing messages and the automatic ping replies are free, and an object with only idle
  sockets hibernates and accrues no duration. Four people moving cursors on a whiteboard (40
  messages a second) cost about 7,200 billed requests and 450 GB-s an hour; two people typing in a
  doc about 1,440 requests and at most 720 D1 writes an hour (the operations are in
  [spec.md](spec.md#costs)). When the
  allowance runs out, sockets fail: pages work alone and docs are edited without seeing others.
- **Off switch.** `ALLOW_ROOMS=false` turns rooms off, `ALLOW_LIVE_EDITING=false` turns on-page
  doc editing off and `ALLOW_SLIDES_FOLLOW=false` turns following the presenter in decks off
  ([self-hosting.md](self-hosting.md#settings)). Keep the binding: turning them back
  on then needs no deploy-time change. A config without the binding also deploys and runs, with
  rooms off; `check-config` (and so `deploy:<env>`) prints a note naming it.
- **Isolation.** Rooms need `CONTENT_ISOLATION=origin`. Under `opaque` and the staging path
  fallback they are off, whatever the settings say.
- **Proxies.** Rooms are WebSockets on `wss://<id>.<CONTENT_HOST>/__plinth/room/`. Cloudflare's
  edge, Workers routes and Tunnel pass them unchanged; a reverse proxy in front of a container must
  forward the upgrade ([docker.md](docker.md#what-the-proxy-must-do)).
- **Rolling back past live rooms.** A Worker that does not export `ArtifactRoom` cannot be deployed
  over one whose migration created it unless a further migration deletes the class
  (`{ "tag": "rooms-v1-removed", "deleted_classes": ["ArtifactRoom"] }`; the class stores nothing,
  so nothing is lost, but turning rooms on again then needs yet another tag). Prefer
  `ALLOW_ROOMS=false` on the current release.

### Live views

Live views use the same `ROOMS` binding and `rooms-v1` migration as live rooms: the
`ArtifactRoom` object of an artifact also holds its open views' watch sockets, a kind that joins
no room and stores nothing.

- **Cost.** While `ALLOW_LIVE_VIEWS` is on (the default), each open view is one Durable Object
  request when it connects (again after 12 hours, or after its tab was hidden for a minute), and
  every new version, shared-data write, sharing change, takedown or delete is one notify call to
  the artifact's object, for every artifact. Hibernated watch sockets accrue no duration and their
  keep-alive is answered without waking the object. In return an idle open view stops reading its
  gate and the shared-data change counter every 15 s ([spec.md](spec.md#costs)).
- **Off switch.** `ALLOW_LIVE_VIEWS=false` ([self-hosting.md](self-hosting.md#settings)): pages poll
  as before, and artifacts without a room never get an object. Without the binding live views are
  off too, with no config error.
- **Isolation.** Live views work under every isolation mode, since the socket is on the app host;
  the shared-data signals need `CONTENT_ISOLATION=origin`, like shared data.
- **Proxies.** The socket is `wss://<APP_HOST>/api/v1/view/<id>/watch`. Cloudflare's edge, Workers
  routes and Tunnel pass it unchanged; a reverse proxy in front of a container must forward the
  upgrade on the app host as well ([docker.md](docker.md#what-the-proxy-must-do)).
- **Caps.** `LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT` (1000) per artifact, apart from the room's cap,
  half for the people an artifact is shared with and half for everyone else; views over it poll.
  After a signal, open views spread their follow-up requests over 2 ms per socket of this cap (at
  most 10 s), so one artifact sees at most about 500 a second at the default.

### Dictation

Dictation needs no binding, no migration and no Cloudflare resource: the viewer's browser does
the speech recognition, and Plinth only passes words from the app to the page.

- **Off switch.** `ALLOW_DICTATION` is off unless set to `"true"`. Off, the app's
  `Permissions-Policy` keeps `microphone=()` and pages that declare `dictation` get
  `ready` with `available: false`, `reason: "disabled"`.
- **Isolation.** Dictation needs `CONTENT_ISOLATION=origin`. Under `opaque` and the staging path
  fallback it is off, whatever the setting says.
- **Before turning it on.** Try it in desktop Chrome and Edge, and in Safari on macOS and iOS (a
  browser without a recognizer, such as Firefox, reports `unsupported`), and read the consent
  dialog with a screen reader. Check that the privacy notice on `/legal/privacy` shows its
  Dictation paragraph.

### Creating the resources

The setup script creates the D1 database and the R2 bucket and writes the Worker config with every
binding above. Read its plan first:

```sh
pnpm --filter @plinth/worker exec wrangler login
node scripts/setup.mjs --remote --env production --dry-run \
  --app-host plinth.aconite.io --content-host plinthusercontent.com \
  --email-provider sendgrid --email-from "Plinth <noreply@plinth.aconite.io>" --admin-email you@aconite.io
# a content subdomain without a shipped PSL entry also needs --content-isolation opaque
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

For the hosted instance (`CONTENT_DOMAIN` = `plinthusercontent.com`, its own zone):

- Route: `{ "pattern": "*.plinthusercontent.com/*", "zone_name": "plinthusercontent.com" }`
  (`setup.mjs` and `plinth deploy` write it).
- DNS in the `plinthusercontent.com` zone: only `A` `*` → `192.0.2.0`, proxied.
- Certificate: Universal SSL (`plinthusercontent.com`, `*.plinthusercontent.com`), issued
  automatically. SSL/TLS "Full (strict)" and "Always Use HTTPS" are on.
- Once submitted, the `_psl.plinthusercontent.com` `TXT` record from the PSL steps above.

A content subdomain inside the app's zone instead (e.g. `<sub>.example.com`) needs the route
`*.<sub>.example.com/*` on that zone, a proxied `A` `*.<sub>` record, and an Advanced Certificate
for `*.<sub>.example.com`, because Universal SSL's `*.example.com` does not match
`<id>.<sub>.example.com`.

### Checks after deploy

```sh
curl -sI https://plinth.aconite.io/healthz                 # 200, {"ok":true,"environment":"production"}
curl -sI https://abcdefghijklmnopqrst.CONTENT_DOMAIN/      # 404 from Plinth, with a CSP header
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://plinth.aconite.io/mcp   # 401
curl -sI -X POST https://plinth.aconite.io/mcp | grep -i www-authenticate        # resource_metadata=...
# CONTENT_ISOLATION=origin (hosted instance): no "sandbox" directive in the content CSP;
# with opaque it ends in "sandbox allow-scripts ..." without allow-same-origin
curl -sI https://abcdefghijklmnopqrst.plinthusercontent.com/ | grep -i content-security-policy
curl -s https://plinth.aconite.io/api/v1/config        # "content_host":"plinthusercontent.com","content_isolation":"origin"
curl -sI https://plinth.aconite.io/api/v1/config | grep -i set-cookie   # __Host-plinth_csrf=...; Path=/; ...; Secure
curl -s https://plinth.aconite.io/api/v1/config        # "limits":{..."max_version_bytes":52428800,"max_assets_per_version":511,...}
# API clients pass the edge (next section): 200, not 403 "error code: 1010"
curl -s -o /dev/null -w '%{http_code}\n' -A 'Python-urllib/3.12' https://APP_HOST/api/v1/config
curl -s -o /dev/null -w '%{http_code}\n' -A 'Python-urllib/3.12' https://APP_HOST/.well-known/oauth-authorization-server
curl -s -o /dev/null -w '%{http_code}\n' -A 'Python-urllib/3.12' https://APP_HOST/llms.txt
curl -s -o /dev/null -w '%{http_code}\n' -A 'Python-urllib/3.12' https://APP_HOST/a/no-such-artifact/source   # 404 from Plinth, not 403
```

### Edge security for API clients

Cloudflare's Browser Integrity Check (BIC, on by default in every zone) answers some programs with
403 and the text `error code: 1010` before the Worker runs. It targets HTTP clients with a default
library User-Agent such as Python's `Python-urllib/*` and Perl's `libwww-perl`: exactly what an
agent's hand-written script sends. Plinth never sees those requests.

On the app zone, exempt the machine-facing paths from BIC, and nothing else. Either add a WAF
custom rule (Security > WAF > Custom rules, action **Skip**, skip **Browser Integrity Check**, with
logging on) or a Configuration Rule (Rules > Configuration Rules, Browser Integrity Check **Off**),
with this expression, replacing `APP_HOST` with your app host:

```
(http.host eq "APP_HOST" and (
  http.request.uri.path eq "/mcp" or starts_with(http.request.uri.path, "/mcp/")
  or (starts_with(http.request.uri.path, "/api/v1/") and not starts_with(http.request.uri.path, "/api/v1/auth/"))
  or (starts_with(http.request.uri.path, "/oauth/") and http.request.uri.path ne "/oauth/authorize")
  or starts_with(http.request.uri.path, "/.well-known/")
  or (starts_with(http.request.uri.path, "/a/") and ends_with(http.request.uri.path, "/source"))
  or http.request.uri.path in {"/openapi.json" "/llms.txt" "/healthz"}))
```

- `/a/<ref>/source` is machine-facing: `/llms.txt` and the note in every artifact page tell agents
  to fetch it as plain text, so it is exempt too.
- The browser sign-in (`/api/v1/auth/*`), the OAuth consent page (`/oauth/authorize`), the app's
  pages and the rest of `/a/*` keep BIC: people use them in browsers.
- Skip only BIC. Do not skip the managed rules or lower the security level for these paths.
- Add no rule on the content zone: agents do not call it, and browsers pass BIC.
- The upload routes (`/api/v1/uploads` and `/api/v1/uploads/<id>/bundle`) are under `/api/v1/`, so
  the expression covers them.
- On `workers.dev` (staging) BIC cannot be turned off, so clients there must send a User-Agent of
  their own. The Plinth CLI sends `plinth-cli/<version>`, the mention watcher
  `plinth-mentions/<version>`, and the commands `start_upload` returns set one too.

The four `Python-urllib` lines in "Checks after deploy" above test it. With the rule, the first
three print `200` and the last `404` (the artifact does not exist, and Plinth says so); without it,
each prints `403`.

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
1. Content host: `plinthusercontent.com` (chosen 2026-11-14, replacing
   `plinth-usercontent.aconite.io`), with `CONTENT_ISOLATION=origin`. Submit it to the Public
   Suffix List (private section). Self-hosters: choose a domain, record the choice in
   `docs/spec.md`, and submit it to the PSL early, since approval takes weeks.
2. Add the content host's DNS and certificate (section 2). Separate domain: its own zone in the
   Cloudflare account that runs the Worker (a domain bought through Cloudflare Registrar already
   has one), with the proxied `*` record; Universal SSL covers it. Content subdomain: the
   `*.<sub>` record and an Advanced Certificate in the parent zone.
3. Content subdomain only: audit the parent domain for sensitive `Domain=<parent>` cookies (see
   [security.md](security.md#operator-checklist-for-the-content-domain)).
4. `wrangler login` with an account that can edit Workers, D1, R2 and both zones.
5. Run `node scripts/setup.mjs --remote --env production ...` (dry run first).
6. Authenticate the sending domain with SendGrid (hosted) or Resend; add DMARC; turn off click
   tracking. Put the API key in with `wrangler secret put`. The hosted instance sends as
   `Plinth <noreply@plinth.aconite.io>` (`plinth.aconite.io` authenticated in Aconite's SendGrid
   account on 2026-11-14).
7. `pnpm build`, then `pnpm --filter @plinth/worker run deploy:production`, which refuses a
   `wrangler.production.jsonc` without the release's compatibility flags and cron trigger before
   it runs `wrangler deploy --config wrangler.production.jsonc` (section 6).
8. Confirm the route `*.plinthusercontent.com/*` (or `*.CONTENT_DOMAIN/*`) shows under the
   Worker's Domains & Routes, and that `https://<any id>.plinthusercontent.com/` answers 404 from
   Plinth with a valid certificate.
9. Run the checks in section 2. Sign in with an address in `ADMIN_EMAIL`, publish a test artifact
   over MCP, and open its link in a private window for each visibility.
10. Set the `OPERATOR_*` settings (name, contact email, address, registration or VAT number) so the
    instance publishes its terms and privacy notice, and read `/legal/*` on the instance (the
    operator is a hosting provider under the DSA and a
    controller under GDPR).
11. Decide when to set `ALLOW_PUBLIC_VISIBILITY=true`. Until then, artifacts can be unlisted,
    password or allowlist only.
12. Shared data is on unless `ALLOW_SHARED_DATA` is set to a false value. The hosted
    instance's privacy notice covers it (what viewers enter, the email and role stamped on each
    write, and the identity in the viewing cookie). An operator with a privacy notice of their own
    should cover the same, or set `ALLOW_SHARED_DATA` to `"false"`.
13. Live rooms and on-page doc editing are on unless `ALLOW_ROOMS` and `ALLOW_LIVE_EDITING` are set
    to a false value, once the config has the `ROOMS` binding (a setup re-run adds it). The hosted
    instance's privacy notice covers them, so it may run with both on: unsaved page edits (the
    draft and who last changed it, kept in D1 until someone saves or discards it, and for at most
    `LIVE_DRAFT_RETENTION_DAYS`, 30 by default) and presence (who has a page open, where their
    cursor is, and live messages between them, passed along and never stored). An operator with a
    privacy notice of their own should cover the same, or set both to `"false"`; one who raises
    `LIVE_DRAFT_RETENTION_DAYS` should say so in their notice.
14. Dictation is off unless `ALLOW_DICTATION` is set to `"true"` ([Dictation](#dictation)). While
    it is on, the privacy notice says that the browser's speech service hears the audio and that
    Plinth never receives it. An operator with a privacy notice of their own should say the same
    before turning it on.
15. Turn on GitHub private vulnerability reporting for the repository (see
    [security.md](security.md)).
16. Watch the first days with `wrangler tail` and the Cloudflare analytics for the Worker, D1 and
    Durable Objects.

## 6. Upgrading and rolling back

Upgrades apply the new release's D1 migrations before its Worker (`plinth deploy` does this; by
hand, `wrangler d1 migrations apply` first). Plinth 0.4.0 adds migrations `0006_stored_bytes` and
`0007_upload_tickets` and a new storage layout: a version may reuse files stored under an earlier
version of the same artifact, and new versions are written under a fresh `v<n>.<nonce>/` prefix.

Plinth 0.4.1 adds migration `0008_thumbnails` (two nullable columns on `versions`). It needs no
config change; to turn thumbnails on, add a Browser Rendering binding to your wrangler config
(`"browser": { "binding": "BROWSER" }`, see section 1). Rolling 0.4.1 back to 0.4.0 is safe: the
older Worker ignores the new columns and the `thumbs/` objects, which a later delete removes with
the artifact.

Categories add migration `0009_categories`: two nullable columns (`artifacts.category`,
`upload_tickets.category`) and a partial index. It is additive and needs no backfill or config
change; apply it before deploying the Worker, as every migration. Rolling the Worker back leaves
the columns unused: an older Worker ignores them, and the categories reappear when the newer one
returns.

Plinth 0.4.0 also needs the `enable_request_signal` compatibility flag and an hourly cron
trigger. Without the flag a bundle whose client disconnects never notices, and its files stay
behind until the next sweep; without the cron only the small sweep that the next upload starts
removes them, 20 at a time. `plinth deploy` takes both
from the release (and refuses a config without them), and a local or Docker instance gets them on
its next start (`plinth start` and `pnpm local:start` add the release's flags and cron trigger to
the instance's `wrangler.jsonc`, and move its `compatibility_date` up to the release's when that is
later). A `wrangler.<env>.jsonc` that `scripts/setup.mjs` wrote before 0.4.0 has neither: re-run
setup with the same arguments (it adds the release's flags and cron trigger to an existing config,
moves its `compatibility_date` up to the committed config's when that is later, keeps everything
else, and refuses to go on if the result would still lack them), or add them by hand:
`compatibility_flags` must include `"nodejs_compat"` and `"enable_request_signal"`, and
`triggers.crons` must include `"0 * * * *"`. A checkout update checks the config before the
migrations (`check-config` exits 1 and names what is missing) and deploys through the Worker's
deploy script, which runs the same check first. The commands are one `&&` list, so a refused
config stops before the migrations:

```sh
git pull && pnpm install && pnpm build && \
  pnpm --filter @plinth/worker check-config wrangler.production.jsonc && \
  pnpm --filter @plinth/worker exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc && \
  pnpm --filter @plinth/worker run deploy:production
```

`deploy:staging` does the same with `wrangler.staging.jsonc`. `pnpm build` only prints a warning
line for each `wrangler.<env>.jsonc` in `apps/worker` that lacks either, and never fails because
of one: the refusal is in `check-config` and the deploy scripts.

Live rooms (#36) add migration `0011_live_drafts` (one table for unsaved page edits of docs) and
the Durable Object migration `rooms-v1` ([Live rooms](#live-rooms)). `plinth deploy` writes the
binding into its config on every run, and a local or Docker instance gets it on its next start
(`plinth start` adds the release's Durable Object bindings and migrations it lacks, by name and by
tag, and keeps the instance's own). A `wrangler.<env>.jsonc` that `scripts/setup.mjs` wrote gets it
when you re-run setup with the same arguments. Without it the Worker runs with rooms off, and
`check-config` prints a note. The D1 migration only adds a table, so an older Worker still starts
against it; the Durable Object migration is what limits a rollback ([Live rooms](#live-rooms)).

**Roll forward, not back.** Rolling the Worker back past 0.4.0 breaks artifacts updated since then
(any update or restore that keeps files reuses them): an older Worker looks each file up under the
version's own prefix only, so files a version reuses from an earlier one answer 404, and updating
or restoring such an artifact fails with "Missing stored file". Versions written in full keep
working, including those under a `v<n>.<nonce>/` prefix (the older Worker uses the row's
`r2_prefix` as it is). The older Worker counts storage by logical size, so accounts may reach the
storage limit sooner while it runs, and versions it writes are full copies that 0.4.0 reads as
before. If a release misbehaves, deploy a fix on top of it. The migrations only add a column and
two tables, so an older Worker still starts against the new schema; upload tickets and
`staging_attempts` are unused by it (its interrupted publishes leave files only `sweep-orphans`
finds). An older Worker has no scheduled handler, so while it runs under a config with the cron
trigger each hourly run fails harmlessly in the Worker's logs.
