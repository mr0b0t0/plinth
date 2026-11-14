# Changelog

Notable changes to Plinth, newest first. Version numbers follow the npm CLI
([`@mr0b0t0/plinth`](https://www.npmjs.com/package/@mr0b0t0/plinth)) and the Docker image
(`ghcr.io/mr0b0t0/plinth`), which ship the same Worker. The hosted instance at
[plinth.aconite.io](https://plinth.aconite.io) runs `main`.

Add a line under **Unreleased** in the pull request that makes a change people will notice.
`pnpm release <version>` turns that section into the release notes ([docs/releasing.md](docs/releasing.md)).

## Unreleased

## 0.3.0 (2026-11-14)

- **Shared data**: a page that declares `<meta name="plinth-capabilities" content="data viewer">`
  can keep JSON documents shared by everyone who opens it (polls, sign-up sheets, trackers) through
  `window.plinth` from `/__plinth/runtime.js`, and learn who is viewing. Only the owner and people
  the artifact is shared with can write; link viewers read. Agents read and write the data with the
  new MCP tools `list_artifact_data` and `write_artifact_data`. Off with `ALLOW_SHARED_DATA=false`,
  and always off under `CONTENT_ISOLATION=opaque`. Applies migration `0005_shared_state.sql`.
- The content cookie on artifact subdomains is now `__Host-plinth_content`: open artifact frames
  reload through the gate once after upgrading.
- The privacy notice covers what people enter on shared pages and how long it is kept.
- Agent plugin 0.5.0: the skill explains shared data.

## 0.2.0 (2026-11-14)

- A new artifact type, **doc**: agents publish Markdown (`publish_artifact` with `type: "doc"`)
  and Plinth renders it as a readable document with headings, tables, code, images, light and dark
  themes and a print stylesheet ("Print or save as PDF"). Edit, compare and restore work as for
  pages. Applies migration `0004_typed_artifacts.sql`.
- Agent plugin 0.4.0: the skill explains when to publish a doc instead of an HTML page.
- Agents that fetch a Plinth link now learn what it is: every app page carries a short note for
  agents (the MCP server, how to read the artifact, install commands, docs). Artifacts anyone with
  the link may open add their title, version and a plain-text source at `/a/<slug>/source`. New
  `/llms.txt`, MCP server card (`/mcp/server-card`, `/.well-known/mcp.json`) and `/robots.txt`;
  unknown `/.well-known/` paths and missing files now answer 404 instead of the app.

## 0.1.1 (2026-11-14)

- `npx @mr0b0t0/plinth deploy` deploys Plinth to your own Cloudflare account in one command
  (database, bucket, secrets, migrations, the Worker); rerun it to redeploy or upgrade.
- A Docker image, `ghcr.io/mr0b0t0/plinth` (linux/amd64 and linux/arm64): localhost only, behind
  your own reverse proxy, or through a Cloudflare Tunnel, with data in a `/data` volume.
- The terms of use, privacy notice and acceptable use policy are final, plain-language pages built
  from the new `OPERATOR_*` settings. Admin commands `erase-user` and `erase-artifact` erase data
  on request.
- The artifact page follows new versions live, without reloading when comments open.
- The agent plugin can watch for new @mentions and bring them into Claude Code sessions.
- Hints printed by the CLI say `npx @mr0b0t0/plinth …` when it runs through npx.

## 0.1.0 (2026-11-14)

- First release of the npm CLI: `npx @mr0b0t0/plinth init` runs a localhost-only instance on your
  computer (agents connect with OAuth), and `init --tunnel` makes it reachable through a Cloudflare
  Tunnel.
