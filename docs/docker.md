# Running Plinth with Docker

The `ghcr.io/mr0b0t0/plinth` image runs Plinth anywhere a Linux container runs: a laptop, a VPS, or
a virtual machine on AWS or GCP. It holds the same prebuilt Worker as the
[npm CLI](local-hosting.md#quickest-start-localhost-only-with-npx) and runs it in `workerd` (the
runtime behind Cloudflare Workers) through `wrangler dev`. The database (D1, as SQLite) and the
artifact files (R2, as files on disk) live in the `/data` volume. The image is built for
`linux/amd64` and `linux/arm64`.

There are three ways to run it:

| Mode | Set | Reachable from | You need |
| --- | --- | --- | --- |
| [Localhost](#quick-start-localhost-only) | `PLINTH_EMAIL` | The machine running Docker | Nothing else |
| [Your own domains](#your-own-domains-behind-a-reverse-proxy) | `PLINTH_APP_HOST`, `PLINTH_CONTENT_HOST`, an email provider | The internet | Two domains, a reverse proxy with a wildcard certificate |
| [Cloudflare Tunnel](#cloudflare-tunnel-from-the-container) | The domain settings plus `PLINTH_TUNNEL=true` | The internet | Two domains on Cloudflare, an API token for setup |

## Quick start: localhost only

```sh
docker run -d --name plinth --restart unless-stopped \
  -e PLINTH_EMAIL=you@example.com \
  -p 127.0.0.1:8788:8788 \
  -v plinth-data:/data \
  ghcr.io/mr0b0t0/plinth:latest
```

Or with Compose, using the [`docker-compose.yml`](../docker-compose.yml) at the root of this
repository:

```sh
PLINTH_EMAIL=you@example.com docker compose up -d
```

Open `http://127.0.0.1:8788` and sign in as the address you gave. The sign-in code appears in the
container's log:

```sh
docker logs -f plinth            # or: docker compose logs -f plinth
```

Then connect your agents. This prints the commands for Claude Code, Codex, Cursor and VS Code; they
sign in with OAuth, and the first time a browser opens on Plinth where you click **Allow**:

```sh
docker exec plinth plinth connect      # or: docker compose exec plinth plinth connect
```

Each artifact is served from its own origin, `http://<id>.localhost:8788`. Browsers resolve every
`*.localhost` name to your own machine and treat each one as a separate origin, so artifacts stay
isolated from the app and from each other without a domain. The app itself is on `127.0.0.1`
because MCP clients only allow OAuth over plain http to `localhost`, `127.0.0.1` or `::1`.

Two things to keep as shown:

- **Publish the port on `127.0.0.1` only.** This mode uses plain http and is meant for one person
  on one machine. Publishing it on every interface (`-p 8788:8788`) would let anyone on your
  network reach the sign-in page.
- **Use the same port number on both sides.** The app's address includes the port, so the host
  port must equal the container's. To use another port, set `PLINTH_PORT` and publish that one:
  `-e PLINTH_PORT=9000 -p 127.0.0.1:9000:9000`.

Running Docker on a remote machine works too: forward the port over SSH
(`ssh -L 8788:127.0.0.1:8788 your-server`) and open `http://127.0.0.1:8788` on your own computer.
The `*.localhost` artifact hosts resolve to your computer and travel through the same forward.

Agents on the same machine can connect. Claude on the web and ChatGPT connect from their own
servers and cannot; for them, use one of the next two modes.

## Your own domains behind a reverse proxy

This mode puts Plinth on the internet behind a reverse proxy or load balancer you run, such as
nginx, Caddy, Traefik or a cloud load balancer. The proxy terminates TLS; the container serves
plain http on port 8788. The Worker runs with `ENVIRONMENT=production` and passes every
production check.

### What you need

- An **app host** for sign-in, the dashboard, the API and `/mcp`, e.g. `plinth.example.com`.
- A **content domain** on a different registrable domain, used at its apex, e.g.
  `example-content.net`. Every artifact is served from its own subdomain,
  `<id>.example-content.net`, which is what keeps artifacts from reading the app's data or each
  other's. Plinth refuses to start with both hosts on one registrable domain.
- **DNS** for the app host, the content apex and `*.example-content.net`, all pointing at the
  proxy.
- **Certificates** for the app host and for `example-content.net` plus `*.example-content.net`. The
  wildcard needs a DNS-01 challenge, e.g. certbot with your DNS provider's plugin:
  `certbot certonly --dns-cloudflare -d example-content.net -d '*.example-content.net'`.
- **An email provider**, Resend or SendGrid, with a verified sending domain, unless the instance is
  single-user (then sign-in codes can go to the log instead).

### Why a wildcard certificate, not on-demand TLS

Proxies such as Caddy can fetch a certificate for each new host name the first time it is
requested (`on_demand_tls`). That does not fit Plinth: every artifact is its own subdomain, so every
new artifact would need its own certificate. Let's Encrypt limits how many certificates one
registered domain may get per week, and a busy instance would reach that limit; until it lifted,
new artifacts would have no certificate at all. One wildcard certificate, issued with a DNS-01
challenge, covers every artifact. Alternatively, put Cloudflare in front of both domains, whose
edge certificate covers the apex and every first-level subdomain; the
[tunnel mode](#cloudflare-tunnel-from-the-container) does that with the least setup.

### What the proxy must do

- **Forward the `Host` header unchanged.** Plinth decides from the host whether a request is for
  the app, the content apex or one artifact.
- **Set `CF-Connecting-IP` to the client's address**, replacing any value the client sent. Plinth
  keys its sign-in and password rate limits on that header. Without it, every visitor shares the
  proxy's own address and one visitor's failed attempts count against everyone.
- **Pass WebSocket upgrades** on the content names. Live rooms (`plinth.room`, and doc editors
  seeing each other's page edits) connect to `wss://<id>.<content host>/__plinth/room/`; a proxy
  that drops the `Upgrade` header leaves pages working alone. Keep the idle timeout above 30
  seconds, the interval at which pages ping their room.
- **Pass WebSocket upgrades on the app name too.** Live views connect to
  `wss://<app host>/api/v1/view/<id>/watch`; a proxy that drops that upgrade leaves pages polling
  every 15 s instead of following new versions at once. The same 30-second ping applies.
- **Be the only way in.** Publish the container's port only to the proxy, e.g.
  `-p 127.0.0.1:8788:8788` with the proxy on the same machine, or a private network. A client that
  reached the container directly could skip TLS and choose its own `CF-Connecting-IP`.

An nginx server block for the three names (repeat the `ssl_certificate` lines with the app host's
certificate in a second block for `plinth.example.com`). The `map` goes once in the `http` block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name example-content.net *.example-content.net;
    ssl_certificate     /etc/letsencrypt/live/example-content.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example-content.net/privkey.pem;
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header CF-Connecting-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`client_max_body_size` must cover the largest request the Worker accepts, in the app host's block
above all, where publishes and uploads arrive: `max_bundle_bytes` in `GET /api/v1/config` (an
uploaded build: by default 50 MB plus 8 MB of tar overhead, so 58 MB). If you raise
`PLINTH_MAX_VERSION_BYTES`, raise it to that value plus 8 MB.

### Start it

```sh
docker run -d --name plinth --restart unless-stopped \
  -e PLINTH_APP_HOST=plinth.example.com \
  -e PLINTH_CONTENT_HOST=example-content.net \
  -e PLINTH_EMAIL_PROVIDER=resend \
  -e PLINTH_EMAIL_FROM="Plinth <noreply@example.com>" \
  -e RESEND_API_KEY=re_... \
  -e PLINTH_ADMIN_EMAIL=you@example.com \
  -p 127.0.0.1:8788:8788 \
  -v plinth-data:/data \
  ghcr.io/mr0b0t0/plinth:latest
```

Open `https://plinth.example.com`. That is a multi-user instance: anyone can sign up with an email
code, and `PLINTH_ADMIN_EMAIL` sees the report queue. For a one-person instance add
`-e PLINTH_SINGLE_USER=true` (`PLINTH_ADMIN_EMAIL` is then the one account), and you may use
`PLINTH_EMAIL_PROVIDER=console` to read sign-in codes from `docker logs` instead of sending mail.
A single-user instance also gets an `ADMIN_TOKEN` for scripts, printed once in the log of its first
start and kept in `/data/plinth/.dev.vars`.

If other people will use the instance, set the operator settings before they sign up:
`PLINTH_OPERATOR_NAME` and `PLINTH_OPERATOR_EMAIL` publish terms of use and a privacy notice at
`/legal/*`, and `PLINTH_OPERATOR_HOSTING` names your hosting provider in that notice (it says
Cloudflare unless you set it). See [self-hosting.md](self-hosting.md#settings).

## Cloudflare Tunnel from the container

With both domains on Cloudflare, the container can make itself reachable through a
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/): no open ports, no proxy and no
certificates to manage. The image includes `cloudflared`. The requirements are those of the
[tunnel setup in local-hosting.md](local-hosting.md#what-you-need): two zones in one Cloudflare
account, the content domain used at its apex, and an API token with **Account · Cloudflare
Tunnel · Edit**, **Zone · DNS · Edit** and **Zone · Zone · Read** on both zones.

```sh
docker run -d --name plinth --restart unless-stopped \
  -e PLINTH_TUNNEL=true \
  -e CLOUDFLARE_API_TOKEN=... \
  -e PLINTH_APP_HOST=plinth.example.com \
  -e PLINTH_CONTENT_HOST=example-content.net \
  -e PLINTH_EMAIL_PROVIDER=resend \
  -e RESEND_API_KEY=re_... \
  -v plinth-data:/data \
  ghcr.io/mr0b0t0/plinth:latest
```

On its first start the container creates a tunnel named `plinth-plinth` and proxied DNS records
for the app host, the content apex and `*.<content apex>`, all pointing at the tunnel. It refuses
to overwrite a DNS record that points somewhere else. The tunnel's credentials are written to the
volume, and the Worker listens on loopback inside the container, so the tunnel is the only way in.
Cloudflare sets `CF-Connecting-IP` itself.

The API token is needed only when the instance is set up, which happens again whenever a setting
changes. Once the container has started, you can remove `CLOUDFLARE_API_TOKEN` from its
environment and delete the token; add a new one before you change a setting.

## Settings

Set these as environment variables (`-e`, or `environment:` in Compose). The container applies them
on its first start and again on any start where they differ from the last ones applied; otherwise
it starts the instance as it is.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLINTH_EMAIL` | none | Localhost mode: the one account that can sign in |
| `PLINTH_PORT` | `8788` | The port Plinth listens on in the container. In localhost mode, publish the same port on the host |
| `PLINTH_APP_HOST` | none | Your app host. Setting it selects the domains mode (or the tunnel, with `PLINTH_TUNNEL`) |
| `PLINTH_CONTENT_HOST` | none | Your content domain, at its apex. Required with `PLINTH_APP_HOST` |
| `PLINTH_EMAIL_PROVIDER` | none | `resend`, `sendgrid` or `console`. Required with `PLINTH_APP_HOST`. `console` writes codes to the log and is allowed only with `PLINTH_SINGLE_USER` |
| `RESEND_API_KEY`, `SENDGRID_API_KEY` | none | The provider's API key. Copied into `/data/plinth/.dev.vars` |
| `PLINTH_EMAIL_FROM` | `Plinth <noreply@<app host>>` | Sender address, on a domain verified with the provider |
| `PLINTH_ADMIN_EMAIL` | none | Instance admins (comma separated): they see the report queue. With `PLINTH_SINGLE_USER`, exactly one: the owner |
| `PLINTH_SINGLE_USER` | `false` | One-person instance |
| `PLINTH_CONTENT_ISOLATION` | `origin` | `opaque` allows the content host on the app's registrable domain, at the cost of artifacts' browser storage ([security.md](security.md#opaque-content-isolation)) |
| `PLINTH_TUNNEL` | `false` | Run a Cloudflare Tunnel from the container |
| `CLOUDFLARE_API_TOKEN` | none | Tunnel setup only; never stored |
| `PLINTH_OPERATOR_NAME`, `PLINTH_OPERATOR_EMAIL`, `PLINTH_OPERATOR_ADDRESS`, `PLINTH_OPERATOR_REGISTRATION`, `PLINTH_OPERATOR_HOSTING` | empty | Who runs the instance, for its legal pages |
| `PLINTH_MAX_ARTIFACTS_PER_USER`, `PLINTH_MAX_PUBLISHES_PER_HOUR`, `PLINTH_MAX_VERSION_BYTES`, `PLINTH_MAX_ASSETS_PER_VERSION`, `PLINTH_MAX_STORAGE_BYTES_PER_USER`, `PLINTH_CDN_ALLOWLIST`, `PLINTH_ALLOW_PUBLIC_VISIBILITY`, `PLINTH_PUBLIC_MIN_ACCOUNT_AGE_HOURS` | as in self-hosting.md | Limits and the script allowlist. `PLINTH_MAX_VERSION_BYTES` (default 50 MB) and `PLINTH_MAX_ASSETS_PER_VERSION` (default 511) size one version |
| `PLINTH_ALLOW_ROOMS`, `PLINTH_ALLOW_LIVE_EDITING` | `true` | Live rooms and on-page doc editing. The instance's config always carries the `ROOMS` binding they need; `"false"` turns them off |
| `PLINTH_ALLOW_LIVE_VIEWS` | `true` | Live views: open pages follow new versions and shared-data changes over a WebSocket on the app host, through the same `ROOMS` binding, and keep the reader's state across versions; `"false"` turns them off and pages poll and reload the frame for each version |
| `PLINTH_ALLOW_DICTATION` | `false` | Dictation run by the app for pages that declare it; `"true"` turns it on (origin isolation only) |
| `PLINTH_ALLOW_SLIDES_FOLLOW` | `true` | Following the presenter in a deck, over the same live rooms; `"false"` turns it off |
| `PLINTH_ALLOW_CATEGORY_SHARING` | `true` | Owners may share a category with people (a portal page lists what the owner reviewed into it); `"false"` turns it off |
| `PLINTH_SHEET_EVAL_BUDGET` | `200000` | Formula steps one `read_sheet` call may spend, `10000` to `20000000` ([self-hosting.md](self-hosting.md#settings)) |
| `PLINTH_LISTEN` | `0.0.0.0`; `127.0.0.1` with the tunnel | The address the Worker listens on inside the container |

Each `PLINTH_OPERATOR_*`, limit and `PLINTH_ALLOW_*` variable sets the Worker setting of the same
name without the `PLINTH_` prefix; [self-hosting.md](self-hosting.md#settings) explains them.

The secrets the Worker needs, `SESSION_SECRET` and `TOKEN_SIGNING_KEY` (and `ADMIN_TOKEN` for a
single-user instance with domains), are generated on the first start into `/data/plinth/.dev.vars`
(mode 600), kept on every later start, and never printed. Nothing secret is part of the image.

## Day to day

```sh
docker logs -f plinth                 # the Worker's log, including console sign-in codes
docker exec plinth plinth status      # address, account, data folder, running or not
docker exec plinth plinth connect     # how to connect agents
docker stop plinth                    # stops cleanly; docker start plinth brings it back
```

The container's health check asks `/healthz` every 30 seconds, so `docker ps` shows it as
`healthy` once the Worker answers.

The container runs as the image's `node` user (uid 1000). A named volume, as in the examples,
needs nothing more. To keep the data in a folder on the host instead (`-v /srv/plinth:/data`),
make that folder writable by uid 1000 first: `sudo chown 1000:1000 /srv/plinth`.

## Upgrading

Pull the newer image and recreate the container with the same volume and settings:

```sh
docker pull ghcr.io/mr0b0t0/plinth:latest
docker stop plinth && docker rm plinth
docker run -d --name plinth ...       # the same command as before
```

With Compose: `docker compose pull && docker compose up -d`. The volume keeps the database, the
files and the secrets. On start, the new version applies its database migrations and adds its
compatibility flags, and any Durable Object binding it needs (the `ROOMS` binding of live rooms),
to the instance's `wrangler.jsonc` before it serves anything. Migrations only add to the database, but older images are not tested against a database
a newer one has migrated: to go back, restore a backup made before the upgrade. To control when
upgrades happen, use a release's version tag instead of `latest`.

## Backups

Everything is in the volume: the database, every version of every artifact, the secrets and, in
tunnel mode, the tunnel's credentials. Stop the container, archive the volume, start it again:

```sh
docker stop plinth
docker run --rm --user root --entrypoint tar -v plinth-data:/data -v "$PWD":/backup \
  ghcr.io/mr0b0t0/plinth:latest czf /backup/plinth-backup.tgz -C /data .
docker start plinth
```

To restore, extract the archive into an empty volume the same way, then start a container on that
volume with the same settings:

```sh
docker run --rm --user root --entrypoint tar -v plinth-data:/data -v "$PWD":/backup \
  ghcr.io/mr0b0t0/plinth:latest xzf /backup/plinth-backup.tgz -C /data
```

The archive holds the secrets, so store it as carefully as a password.

## Limits

This image runs the Worker in `workerd` through `wrangler dev`, with D1 as a SQLite file and R2 as
files on disk. That is the same code the hosted instance runs, on one machine:

- It suits one person or a small team. It is one process with one database file; it does not
  scale out, and two containers must never share one volume.
- There is no copy anywhere else. Cloudflare's D1 Time Travel and R2 durability do not apply, so
  the backups above are the only way back from a lost disk.
- Links work only while the container runs.
- The admin commands in [self-hosting.md](self-hosting.md#operating-notes) (`set-limit`,
  `erase-user`, `erase-artifact`) work on a Cloudflare deployment or a repository's development
  database, not on this volume. Taking down a reported artifact works in the app.

For a larger instance, deploy to your own Cloudflare account instead
([self-hosting.md](self-hosting.md)). A personal instance fits Cloudflare's free tier.

## Building the image

From a checkout of this repository:

```sh
docker build -t plinth .
pnpm test:docker        # builds the image, runs it in localhost mode and uses it end to end
```

`PLINTH_DOCKER_IMAGE=<image>` makes the smoke test use an image you already built, and
`PLINTH_DOCKER_PLATFORM=linux/amd64` (or `linux/arm64`) runs it for another platform, which needs
emulation on the build machine. For both platforms in one image, use
`docker buildx build --platform linux/amd64,linux/arm64` with a builder that supports it.
