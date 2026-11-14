# Hosting Plinth on your own machine

Plinth can run entirely on your computer. The Worker runs locally under `wrangler dev`, the
database and artifact files stay on your disk, and a named
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) makes the instance reachable from
the internet. Everything works as it does on the hosted instance: sign-in, sharing links,
allowlists with email codes, comments and mentions, the editor, and agents connecting over MCP,
including cloud clients that call `/mcp` from the internet.

The security model is the same one [self-hosting](self-hosting.md) uses. The local Worker runs with
`ENVIRONMENT=production` and passes every production check. Artifacts are served from their own
subdomains on a separate content domain, and the Worker accepts connections from your own machine
only, so the tunnel is the only way in.

## What you need

- **macOS or Linux** with Node 22.12+ and pnpm 10, and this repo cloned with `pnpm install` run.
- **[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)**,
  for example `brew install cloudflared`.
- **A free Cloudflare account with two domains (zones) on it**, both in the same account:
  - an **app host** for sign-in, the dashboard, the API and `/mcp`, e.g. `plinth.example.com`;
  - a **content domain**, used at its apex, e.g. `example-content.net`. Artifacts are served at
    `<id>.example-content.net`. It has to be the apex because Cloudflare's free certificate covers
    only one level of wildcard below it, so `<id>.content.example.net` would get no certificate.
- **A Cloudflare API token** for setup only, with these permissions:
  **Account · Cloudflare Tunnel · Edit**, **Zone · DNS · Edit** and **Zone · Zone · Read**, on both
  zones. Create it under *My Profile → API Tokens*. Setup reads it from the environment and never
  stores it, so you can delete the token afterwards.
- **To share with other people:** a SendGrid or Resend account with a verified sending domain.
  Viewers on an allowlist confirm their address with an emailed code. If only you will use the
  instance, single-user mode with the `console` provider works, and the codes appear in the
  terminal.

## Set it up

```sh
export CLOUDFLARE_API_TOKEN=...        # the setup-only token above
export RESEND_API_KEY=...              # or SENDGRID_API_KEY
node scripts/setup.mjs --tunnel \
  --app-host plinth.example.com \
  --content-host example-content.net \
  --email-provider resend \
  --email-from "Plinth <noreply@example.com>"
```

Add `--single-user --admin-email you@example.com` for a one-person instance. That prints an
`ADMIN_TOKEN` once, for agents and scripts. Other flags: `--name` (instance name, default `plinth`),
`--home` (default `~/.plinth`, or `PLINTH_HOME`), `--port` (default `8788`), and `--dry-run`.

Setup does the following, and is safe to run again:

1. Creates `~/.plinth/<name>/` with mode 700. It holds `wrangler.jsonc`, `.dev.vars` (the secrets,
   mode 600), `instance.json`, `cloudflared.yml`, `tunnel-credentials.json` (mode 600) and
   `state/`, which is the D1 database and R2 files.
2. Generates `SESSION_SECRET`, `TOKEN_SIGNING_KEY` and, in single-user mode, `ADMIN_TOKEN`.
   Existing secrets are kept unless you pass `--force`.
3. Creates a tunnel named `plinth-<name>`, plus proxied DNS records for the app host, the content
   apex and `*.content apex`, all pointing at the tunnel. It refuses to overwrite a DNS record that
   points somewhere else.
4. Applies the database migrations.

## Start it

```sh
pnpm local:start            # add --name <name> for another instance
```

This builds the web app on first start, applies any new migrations, and starts the Worker on
`127.0.0.1:8788` and `cloudflared`. Ctrl-C stops both. If either one stops on its own, the other
stops too and the command exits non-zero. Then open `https://<app host>` and
[connect your agents](mcp.md).

## Who can see what

| Who | What they see |
| --- | --- |
| Your machine | Everything: accounts, allowlists, hashed codes and sessions, every version of every artifact |
| SendGrid or Resend | Each recipient's address and the email with their code or sign-in link |
| Cloudflare | Traffic in transit. TLS ends at Cloudflare's edge, so Cloudflare can read pages while it serves them. Nothing is stored there |
| A viewer's browser | Their session cookie and the artifacts they're allowed to open |

**Links only work while your machine is awake, online and running `pnpm local:start`.** There is
no copy anywhere else: if the disk is lost, so is the instance, so keep backups.

## Start at login (optional)

macOS, `~/Library/LaunchAgents/io.plinth.local.plist` (replace the repo path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.plinth.local</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /path/to/plinth &amp;&amp; exec pnpm local:start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/plinth-local.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/plinth-local.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/io.plinth.local.plist`. Keep the log in your
own `~/Library/Logs`, not `/tmp`, because in single-user mode with the `console` provider it holds
sign-in codes. Wrangler's own logs go to `~/.plinth/<name>/logs/`, which only you can read.

Linux, `~/.config/systemd/user/plinth.service`:

```ini
[Unit]
Description=Plinth (local)
After=network-online.target

[Service]
ExecStart=/bin/bash -lc 'cd /path/to/plinth && exec pnpm local:start'
Restart=on-failure

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now plinth`. Run `loginctl enable-linger $USER` if it
should run without you being logged in.

## Backups

Stop the instance, then copy the whole instance directory:

```sh
cp -a ~/.plinth/plinth ~/plinth-backup-$(date +%F)
```

The copy includes the secrets and the tunnel credentials, so store it as carefully as a password.

## Upgrades

Stop the instance first. `wrangler dev` reloads the Worker whenever the checkout changes, so
pulling while it runs would put new code live against a database that hasn't been migrated yet.
For the same reason, run your instance from a checkout you don't edit, and use a second checkout
for development.

```sh
launchctl unload ~/Library/LaunchAgents/io.plinth.local.plist   # or: systemctl --user stop plinth, or Ctrl-C
git pull && pnpm install && pnpm build
pnpm local:start            # applies new migrations before starting (or load/start the service again)
```

## One domain instead of two

With `--content-isolation opaque`, the content host can sit on the same registrable domain as the
app, for example `<id>.content.example.com`. Artifacts then run with an opaque origin, which means
no cookies or local storage inside artifacts. That's a second-level wildcard, which Cloudflare's
free certificate doesn't cover. It needs a paid
[Advanced Certificate](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/),
so a second cheap domain is usually the better deal. See [security.md](security.md).

## Troubleshooting

- **502 or "Bad gateway" from Cloudflare:** the tunnel is up but the Worker isn't. Check the
  `local:start` output, and that nothing else uses the port.
- **404 for every page:** the request reached `cloudflared` with a host its config doesn't list.
  Rerun setup with the right `--app-host` and `--content-host`.
- **"Cross-origin request refused" on sign-in:** start through `pnpm local:start`, not plain
  `wrangler dev`. It passes `--upstream-protocol https`, without which `wrangler dev` rewrites the
  browser's `Origin` header.
- **No sign-in or viewer emails:** check that `RESEND_API_KEY` or `SENDGRID_API_KEY` is in
  `~/.plinth/<name>/.dev.vars`, and that the `--email-from` domain is verified with the provider.
- **"Tunnel … exists but its credentials file is missing", or "points at an earlier tunnel":** rerun
  setup with the same flags plus `--replace-tunnel`. It deletes the old tunnel, creates a new one
  and repoints the DNS records it left. Records that point anywhere else are never changed.
