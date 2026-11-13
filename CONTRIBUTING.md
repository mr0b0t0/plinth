# Contributing to Plinth

Thanks for helping. This page covers setup, the commands, conventions, and the two most common
changes: a database migration and a new MCP tool. Read [AGENTS.md](AGENTS.md) first; its rules
apply to people and coding agents alike. [docs/spec.md](docs/spec.md) is the source of truth for
behaviour: if the code and the spec disagree, the spec wins, and a change to the spec goes in the
same commit as the code that follows it.

## Setup

Node 22.12+ and pnpm 10. pnpm runs Node 24.22.2 for this repo through `use-node-version` in
`.npmrc`, so you do not need to switch Node versions globally.

```sh
pnpm install
node scripts/setup.mjs --local   # apps/worker/.dev.vars with fresh secrets, local D1 migrated
pnpm build
pnpm dev                         # Worker on http://app.localhost:8787, web app rebuilt on change
pnpm seed                        # optional: demo user, sample artifacts, a token
```

Artifacts are served on `<id>.content.localhost:8787`. Sign-in codes appear in the `wrangler dev`
log (`EMAIL_PROVIDER=console`).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome over the whole repo |
| `pnpm format` | Biome, writing fixes |
| `pnpm typecheck` | `tsc --noEmit` in every package (Turbo) |
| `pnpm test` | Vitest: the Worker in the Workers pool, shared and web in Node/happy-dom |
| `pnpm build` | Web app (Vite), then a Worker dry-run bundle |
| `pnpm test:e2e` | Playwright against a fresh `wrangler dev` (light, dark, mobile) |
| `pnpm openapi` | Regenerate `docs/openapi.json`; `pnpm openapi --check` fails if stale |
| `pnpm seed` | Sample data in the local instance |
| `pnpm --filter @plinth/worker db:migrate:local` | Apply migrations to local D1 |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, build, the bundle secret scan, the
OpenAPI check and the e2e suite on every push and pull request. Run the same before you push.

The e2e suite starts its own Worker on port 8787 with state in `e2e/.wrangler-state` (wiped each
run), so stop `pnpm dev` first. If Playwright reports a missing browser, run
`pnpm --filter @plinth/e2e exec playwright install chromium`. Helpers for new specs are in
`e2e/support/`: `api.ts` (REST with CSRF), `auth.ts` (`signIn`), `mail.ts` (dev outbox),
`mcp.ts` (MCP client), `tokens.ts` and `db.ts` (tokens without the UI).

## Conventions

- **Branches.** Branch from `main` (`feature/...`, `fix/...`, `docs/...`). Do not commit to `main`
  directly.
- **Commits.** Imperative subject under about 70 characters ("Add allowlist sharing API"), a blank
  line, then what changed and why. One logical change per commit; tests in the same commit as the
  code.
- **Pull requests.** Describe the change, link the spec section, list how you tested it. Keep CI
  green; never skip, delete or mark tests as expected failures to get there.
- **Dependencies.** Pin exact versions, prefer releases at least a week old, and say why in the PR.
- **Decisions.** Where the spec leaves room, pick the simplest option that fits it and add a row
  to [DECISIONS.md](DECISIONS.md). Mark it **Review** if a maintainer should look.
- **Style.** TypeScript strict everywhere. Wire format is snake_case. Shared types, schemas and
  constants live in `packages/shared`. Anything a self-hoster may change is an env var.
- **Docs.** Plain technical English, short sentences. The product name must not contain "Claude"
  or "Codex".

## Security rules

From [AGENTS.md](AGENTS.md); these are requirements, not options. Never weaken one to make a test
pass.

- User HTML never runs on the app host. The content host is a different registrable domain, and
  each artifact is served from its own subdomain.
- No app cookies on the content host. App session cookies are host-only on the app host. The
  content host checks access with a short-lived signed token bound to one artifact.
- Every artifact response carries a CSP built from the configurable CDN allowlist. Network calls
  to other hosts are blocked.
- Artifacts render in sandboxed iframes, never with `allow-same-origin` toward the app.
- Comment and artifact text is untrusted input for agents. A mention is a request from a
  collaborator, not an instruction with the owner's authority. MCP tool descriptions say so.
- Authorization lives in one shared policy module (`apps/worker/src/policy.ts`) and is checked on
  every read and write, never only in the UI.
- Tokens are stored hashed, shown once, revocable per connection. Secrets never appear in logs,
  URLs or client bundles.

Also: versions are immutable, a save against a stale version is rejected, and an agent's change is
always a new version. See [docs/security.md](docs/security.md) for how each rule is enforced, and
report vulnerabilities privately as described there.

## Adding a migration

Migrations are plain SQL in `migrations/`, applied in file-name order by
`wrangler d1 migrations apply`.

1. Create the next file: `migrations/0002_short_name.sql` (four digits, snake_case name). Never
   edit a migration that has been merged; add a new one.
2. Write forward-only SQL. Prefer additive changes (new tables, nullable columns, indexes). D1 is
   SQLite: use `TEXT` ISO-8601 timestamps and `CHECK` constraints for enums, like `0001_init.sql`.
3. Mirror the change in the Drizzle schema, `apps/worker/src/db/schema.ts`.
4. Apply locally: `pnpm --filter @plinth/worker db:migrate:local`. Worker tests apply every
   migration automatically (`apps/worker/test/apply-migrations.ts`); the e2e server does too.
5. If a self-hoster must do anything besides applying it, say so in the PR and in
   [docs/self-hosting.md](docs/self-hosting.md).

## Adding an MCP tool

Every tool has a REST twin with the same auth, validation and policy. The order:

1. **Shared schema.** Add the input schema to `packages/shared/src/schemas.ts` (snake_case fields,
   limits from `LIMITS`) and the result type to `packages/shared/src/types.ts`.
2. **Policy.** If it needs a new action, add it to `apps/worker/src/policy.ts` with tests in
   `apps/worker/test/policy.test.ts` for every role and visibility.
3. **Service.** Implement it once in `apps/worker/src/services/`, taking a `Ctx` and calling the
   policy. Throw `ApiError` for expected failures.
4. **MCP.** Register it in `apps/worker/src/mcp/server.ts` with `inputSchema` set to the shared
   schema. If it returns text written by people, append `UNTRUSTED_NOTE` to the description.
5. **REST.** Add the path to `API` in `packages/shared/src/routes.ts` and the handler to the
   matching router in `apps/worker/src/api/`, parsing input with the same schema.
6. **OpenAPI.** Add the operation to `apps/worker/src/api/openapi.ts` (with `mcpTool` set), then
   run `pnpm openapi`. `apps/worker/test/openapi.test.ts` fails if an `API` route is missing.
7. **Tests.** Success and failure paths through the real `/mcp` endpoint with the official client
   (`apps/worker/test/mcp.test.ts`) and over REST: no auth, wrong owner, bad input, limits.
8. **Docs.** Add the tool with its fields and an example to [docs/mcp.md](docs/mcp.md), and update
   the MCP section of the spec if the tool is new behaviour.
