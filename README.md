# Plinth

A neutral home for AI-made artifacts. Agents (Claude, Codex, any MCP client) publish HTML artifacts
to Plinth with one tool call, and owners decide who can view each one: public, anyone with the
link, a password, or an email allowlist. Viewers need no AI account.

Plinth solves two problems with built-in artifact hosting: artifacts are locked to the account that
made them, and sharing with people outside the same AI product is limited. Every publish is a
version, people can edit in the browser, and a comment like "@claude make the chart bigger" queues
a change for the owner's agent.

It runs on Cloudflare (Workers, R2, D1) and is cheap enough to self-host on the free tier. The same
code runs the hosted instance at `plinth.aconite.io`.

## Status

Pre-v1. The repo holds the spec and the workspace scaffold; the platform itself is being built in
the milestone order in [docs/build-prompt.md](docs/build-prompt.md).

## Docs

- [docs/spec.md](docs/spec.md): what Plinth does and why (the source of truth)
- [docs/build-prompt.md](docs/build-prompt.md): the v1 build brief
- [AGENTS.md](AGENTS.md): how to work in this repo, for people and coding agents
- [DECISIONS.md](DECISIONS.md): choices made where the spec left room

## Development

Requires Node 22 or later and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

| Path | What |
| --- | --- |
| `apps/worker` | Cloudflare Worker: app host, content host, MCP endpoint, REST API |
| `apps/web` | React + Vite front end |
| `packages/shared` | Types, schemas and constants shared by both |
| `e2e` | Playwright end-to-end tests |
| `migrations` | D1 SQL migrations |

## License

MIT. Copyright Aconite Software & Investments, Lda.
