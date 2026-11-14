# @aconite/plinth

Run [Plinth](https://github.com/mr0b0t0/plinth) on your own computer. Plinth is a home for the HTML
artifacts AI agents make (reports, dashboards, prototypes): agents publish over MCP, every change
is a version you can revert, and you decide who can view each page.

Needs Node 22.12+ on macOS or Linux.

## Localhost only (no domain, no account)

```sh
npx @aconite/plinth init --email you@example.com
npx @aconite/plinth start
```

Open `http://127.0.0.1:8788` and sign in with the code printed in the terminal. Then connect
your agents:

```sh
npx @aconite/plinth connect
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
npx @aconite/plinth init --tunnel --app-host plinth.example.com \
  --content-host example-content.net --email-provider resend
npx @aconite/plinth start
```

The full guide, including running at login, backups and the security model:
[docs/local-hosting.md](https://github.com/mr0b0t0/plinth/blob/main/docs/local-hosting.md).

## Commands

| Command | Does |
| --- | --- |
| `plinth init` | Create or update an instance (localhost only, or `--tunnel`) |
| `plinth start` | Run it; applies new migrations first; Ctrl-C stops it |
| `plinth status` | Address, account, data folder, and whether it is running |
| `plinth connect` | How to connect agents |

Every command takes `--name` (default `plinth`) and `--home` (default `~/.plinth`, or
`PLINTH_HOME`). To upgrade, run a newer version of this package.

The Plinth plugin for Claude Code and Codex adds a skill that teaches agents what an artifact may
contain: [docs/agents.md](https://github.com/mr0b0t0/plinth/blob/main/docs/agents.md).

MIT licensed.
