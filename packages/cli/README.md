# @mr0b0t0/plinth

Run [Plinth](https://github.com/mr0b0t0/plinth) on your own computer or on your own Cloudflare
account. Plinth is a home for the HTML artifacts AI agents make (reports, dashboards, prototypes):
agents publish over MCP, every change is a version you can revert, and you decide who can view each
page.

Needs Node 22.12+ on macOS or Linux.

## Localhost only (no domain, no account)

```sh
npx @mr0b0t0/plinth init --email you@example.com
npx @mr0b0t0/plinth start
```

Open `http://127.0.0.1:8788` and sign in with the code printed in the terminal. Then connect
your agents:

```sh
npx @mr0b0t0/plinth connect
```

It prints the commands for Claude Code, Codex, Cursor and VS Code. They sign in with OAuth: a
browser opens on Plinth and you click **Allow**. Artifacts are served from their own `*.localhost`
origins, isolated from the app and from each other. Claude and ChatGPT on the web can't reach a
local-only instance.

## Reachable from the internet

With two domains on Cloudflare and `cloudflared` installed:

```sh
export CLOUDFLARE_API_TOKEN=...   # setup only: Tunnel Edit, DNS Edit, Zone Read
export RESEND_API_KEY=...         # or SENDGRID_API_KEY
npx @mr0b0t0/plinth init --tunnel --app-host plinth.example.com \
  --content-host example-content.net --email-provider resend
npx @mr0b0t0/plinth start
```

The full guide, including running at login, backups and the security model:
[docs/local-hosting.md](https://github.com/mr0b0t0/plinth/blob/main/docs/local-hosting.md).

## Deploy to your Cloudflare account

Plinth runs as one Cloudflare Worker with a D1 database and an R2 bucket; a personal instance fits
the free plan. You need two domains on the Cloudflare account: one for the app, and a separate
registrable domain that serves only artifacts, each from its own subdomain.

```sh
export RESEND_API_KEY=...         # or SENDGRID_API_KEY: sign-in email
npx @mr0b0t0/plinth deploy --app-host plinth.example.com --content-host example-content.net \
  --email-provider resend --admin-email you@example.com
```

`deploy` logs in with wrangler (it opens `wrangler login` in a terminal the first time), creates
the database and the bucket, generates the secrets and stores them in the Worker, applies the
database migrations, deploys, and checks that the app answers. It then prints how to connect your
agents. It uses the Worker that ships in this package, so no checkout and no build are needed.

- **DNS.** Artifact pages need a proxied wildcard record in the content zone: `A`, name `*`,
  `192.0.2.0`, proxied. With `CLOUDFLARE_API_TOKEN` set (permissions: Workers Scripts, D1,
  Workers R2 Storage, Workers Routes and DNS Edit, Zone Read), `deploy` adds it when it is missing;
  with the wrangler login it prints the record for you to add. It never changes existing records.
  The app host gets its DNS record and certificate from Cloudflare as a Workers custom domain.
- **Account.** If your login can reach several Cloudflare accounts, choose one with
  `CLOUDFLARE_ACCOUNT_ID`.
- **One person.** `--single-user` limits sign-in to `--admin-email`, and also prints an
  `ADMIN_TOKEN` once, for scripts. With it, `--email-provider console` writes sign-in codes to the
  Worker log instead of sending mail.
- **Others signing up.** Name the operator first, so the instance publishes terms and a privacy
  notice: `--operator-name`, `--operator-email`, and in the EU `--operator-address` and
  `--operator-registration`.
- **Updating.** Settings are saved in `~/.plinth/<name>/cloudflare/`. Run
  `npx @mr0b0t0/plinth deploy` again with no flags to redeploy them, and
  `npx @mr0b0t0/plinth@latest deploy` to upgrade: it applies the new version's migrations, then
  deploys its Worker. Flags on a later run change the saved settings, and an empty value
  (`--operator-address ""`) clears an optional one. Other Worker settings, such as
  `MAX_ARTIFACTS_PER_USER`, go under `vars` in `deploy.json` there.

`--dry-run` prints every command and the generated config without contacting Cloudflare.
Everything else, from the content domain to email and the Public Suffix List, is in
[docs/self-hosting.md](https://github.com/mr0b0t0/plinth/blob/main/docs/self-hosting.md).

## Commands

| Command | Does |
| --- | --- |
| `plinth init` | Create or update an instance (localhost only, or `--tunnel`) |
| `plinth start` | Run it; applies new migrations first; Ctrl-C stops it |
| `plinth status` | Address, account, data folder, and whether it is running |
| `plinth connect` | How to connect agents |
| `plinth deploy` | Deploy to your Cloudflare account, or redeploy and upgrade with the saved settings |

Every command takes `--name` (default `plinth`) and `--home` (default `~/.plinth`, or
`PLINTH_HOME`). `status` and `connect` use the local instance of that name, or the Cloudflare
deployment with `--cloudflare` (also when there is no local one). To upgrade, run a newer version
of this package.

The Plinth plugin for Claude Code and Codex adds a skill that teaches agents what an artifact may
contain: [docs/agents.md](https://github.com/mr0b0t0/plinth/blob/main/docs/agents.md).

MIT licensed.
