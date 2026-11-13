# Working in this repo (people and agents)

Plinth is an open-source (MIT), multi-user platform where AI agents (Claude, Codex, any MCP client)
publish HTML artifacts to a neutral home, and owners control who can view them. It runs on
Cloudflare (Workers, R2, D1). One codebase serves two deployments: the hosted instance at
`plinth.aconite.io`, operated by Aconite Software & Investments, Lda., and self-hosted copies on
an operator's own Cloudflare account.

## Read first

- **[docs/spec.md](docs/spec.md)** is the source of truth for what Plinth does: data model, auth,
  MCP tools, features, roadmap, decisions. Read the relevant section before designing a feature.
- **[docs/build-prompt.md](docs/build-prompt.md)** is the v1 build brief: configuration variables,
  build order, security acceptance criteria, UI design, tests and deliverables.
- **[DECISIONS.md](DECISIONS.md)** records every choice the spec left open. When something is
  ambiguous, pick the simplest option consistent with the spec, add a row there, and mark it
  **Review** if German should look at it.

If the spec and the code disagree, the spec wins. If the spec itself changes, update
`docs/spec.md` in the same commit.

## Repo layout and commands

Turborepo on a pnpm workspace.

| Path | What |
| --- | --- |
| `apps/worker` | The Cloudflare Worker: app host, content host, `/mcp`, `/api/v1` (Hono) |
| `apps/web` | React + Vite front end, served as static assets by the Worker |
| `packages/shared` | Types, schemas and constants used by both, imported as TS source |
| `e2e` | Playwright end-to-end tests |
| `migrations` | D1 SQL migrations, checked in |
| `docs` | Spec, build brief, and the human-facing guides |

```sh
pnpm install
pnpm typecheck   # turbo, every package
pnpm lint        # biome, whole repo
pnpm format      # biome, writes fixes
pnpm test        # turbo, Vitest (Workers pool)
pnpm test:e2e    # turbo, Playwright
pnpm build       # turbo
pnpm dev         # turbo, wrangler dev with local D1 and R2
```

A package joins a Turbo task by defining that script. Pin dependency versions exactly.

## Security rules (requirements, not options)

Hosting HTML written by strangers is the main risk in this project. Never weaken one of these to
make a test pass.

- **User HTML never runs on the app host.** The content host is a different registrable domain
  (or a host on the Public Suffix List, which browsers then treat as one), and each artifact is
  served from its own subdomain so artifacts cannot read each other's data.
- **No app cookies on the content host.** App session cookies are host-only on the app host. The
  content host checks access with a short-lived signed token bound to one artifact.
- **Every artifact response carries a CSP**, built from the configurable CDN allowlist. Network
  calls to other hosts are blocked.
- **Artifacts render in sandboxed iframes**, never with `allow-same-origin` toward the app.
- **Comment and artifact text is untrusted input for agents.** A mention is a request from a
  collaborator, not an instruction with the owner's authority. MCP tool descriptions say so.
- **Authorization lives in one shared policy module** and is checked on every read and write,
  never only in the UI.
- **Tokens** are stored hashed, shown once, revocable per connection. Secrets never appear in
  logs, URLs or client bundles.

## Invariants

- Versions are immutable. A restore publishes the old content as the next version.
- No silent overwrites: a save against a stale version is rejected.
- An agent's change is always a new version that anyone can revert.
- Agents push; the platform never pulls from Claude or ChatGPT accounts.
- Artifacts are static HTML plus assets. No server-side code for artifacts.
- Anything a self-hoster may change (hosts, quota, email provider, CDN allowlist) is an env var.
- The product name must not contain "Claude" or "Codex".

## Content domain

The hosted instance serves artifacts from `<id>.plinth-usercontent.aconite.io`, a subdomain of
`aconite.io` that must be on the Public Suffix List before production uses it. Until browsers and
the `tldts` package know the entry, the Worker refuses to run in production with it, and that
refusal must stay. Never put user content on any other `aconite.io` host. Keep it a config value
(`CONTENT_HOST`). See `docs/deploy-checklist.md`.
