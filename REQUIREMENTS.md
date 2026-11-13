# Requirements

Self-review of [docs/build-prompt.md](docs/build-prompt.md), section by section, against the code on
branch `v1-build` (2026-11-13). Started from an independent reviewer's line-by-line check (a
subagent that did not write the code), then updated after the fixes from that review, the
independent security audit and the independent UI review. Every Partial or Blocked row says
what is missing and why; decisions a human should look at are marked **Review** in
[DECISIONS.md](DECISIONS.md).

Status key: **Met** = code plus a test or verifiable artifact that proves it. **Partial** = code
exists but the proof is missing or the behaviour is incomplete. **Missing** = not built.
**N/A-later** = process item, out of scope, or blocked (staging).

Final verification (2026-11-13, all exit 0): `pnpm lint` (283 files clean),
`pnpm typecheck --force` (4/4), `pnpm test --force` (shared 72, web 281, worker 298 = 651 tests),
`pnpm build --force`, `pnpm openapi --check`, `node scripts/check-bundle-secrets.mjs` (72 files
clean), `PLINTH_E2E_PORT=8871 pnpm test:e2e` (150 passed: 50 tests in each of light, dark and
mobile 360 px). No `.skip`/`.only`/`.fixme` anywhere.

Test-file shorthand: `W:` = `apps/worker/test/`, `Wb:` = `apps/web/src/`, `E:` = `e2e/tests/`.

## How to work

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Work autonomously; record ambiguous choices in `DECISIONS.md` | Met | `DECISIONS.md` (45 rows, 12 marked Review) | No row for: report/legal pages not behind a flag; legal templates naming Aconite on every instance |
| Check current docs before using a library | N/A-later | — | Process; not verifiable |
| Pin versions | Met | all `package.json` files: no `^`/`~` ranges | GitHub Actions are tag-pinned (`@v7`), not SHA-pinned |
| Follow the build order's dependencies (step 1 first, step 10 last) | Met | `git log`: foundation commit first, workstreams merged one at a time, staging last | |
| After each milestone: typecheck, lint, full tests, commit | N/A-later | — | Not verifiable from history |
| Everything runs and passes locally (`wrangler dev`, local D1/R2) | Met | e2e suite runs on `wrangler dev` (`e2e/support/server.ts`); 141 passed | |
| No real deploy; write deploy steps for a human | Met | `docs/deploy-checklist.md` | DECISIONS row 51 records a real SendGrid send, outside the "no credentials" rule (now superseded by the staging step) |
| Never weaken a security requirement to pass a test | Met | No skipped tests; security suite intact | |
| Never skip/delete/expected-fail tests | Met | grep for `.skip/.only/.fixme/test.fail`: none | |
| Final report separates verified vs not | N/A-later | — | Not in repo |

## Working in parallel

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Foundation alone first: schema, shared types and schemas, policy interface, REST/MCP signatures, route map, design tokens | Met | commit "Foundation: schema, shared contracts, policy..." (68 tests passing) | |
| Fan out along file boundaries; each subagent in its own worktree | Met | 13 workstream branches `worktree-agent-*` merged into `v1-build` | 4 + 1 backend/infra, 5 UI, 3 reviewers |
| Contracts change only through the orchestrator | Met | the only CONTRACT commit (additive shared types) was reviewed at merge; migration 0002 added by the orchestrator | |
| Briefs carry the build prompt sections word for word, contracts, boundaries, acceptance tests | Met | briefs pointed each agent at `docs/build-prompt.md` sections to read in full | |
| Done means tested (typecheck, lint, own tests, list of commands) | Met | every workstream report listed commands and counts | |
| Integrate one workstream at a time, full suite after each | Met | merge commits each followed by gates; integration fixes committed separately | |
| Independent review before step 10: security, REQUIREMENTS.md, UI in both modes and mobile | Met | three fresh reviewers; their findings fixed (see DECISIONS rows from 2026-11-13 on audit and UI review) | |
| Migrations, dependency changes, staging and final verification only by the orchestrator | Met | migration 0002, Testing Library, staging prep and final runs done by the orchestrator | |

## Stack

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| TypeScript strict everywhere | Met | `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`); `pnpm typecheck` | TS 7.0.2 native compiler (Review row) |
| pnpm workspace | Met | `pnpm-workspace.yaml` | |
| Workers + Hono | Met | `apps/worker/src/index.ts` | |
| D1 with Drizzle | Met | `apps/worker/src/db/schema.ts` | |
| Checked-in SQL migrations | Met | `migrations/0001_init.sql`, `0002_refresh_reuse.sql`; `W:apply-migrations.ts` | |
| R2 for artifact files | Met | `services/storage.ts`; `W:artifacts.test.ts` "publishes version 1 ... stores files in R2" | |
| React + Vite, served as static assets by the same Worker | Met | `apps/web`, `wrangler.jsonc` `assets`; `E:smoke.spec.ts` "the SPA shell loads" | |
| Monaco for the editor | Met | `Wb:components/editor/CodeEditor.tsx`; `E:editor.spec.ts` "edit in Monaco, see it in the preview" | |
| MCP: one remote server, streamable HTTP, `/mcp`, official TS SDK | Met | `mcp/server.ts` (SDK v2 `@modelcontextprotocol/server` 2.4.0); `W:mcp.test.ts` | SDK v2 choice is a Review row |
| Vitest with Workers pool | Met | `apps/worker/vitest.config.ts` (`@cloudflare/vitest-plugin`) | |
| Playwright e2e | Met | `e2e/` | |

## Hosts and configuration

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| One Worker routed by hostname | Met | `index.ts`, `content/serve.ts#resolveHost`; `W:security.test.ts` "content hosts never answer with the SPA..." | |
| All hosts from env vars, nothing hard-coded | Met | `config.ts` | Legal templates hard-code the operator (see Features) |
| `APP_HOST` (default `app.localhost:8787`) | Met | `wrangler.jsonc`, `config.ts` | |
| `CONTENT_HOST`, artifact at `<id>.<CONTENT_HOST>` | Met | `config.ts#contentOrigin`; `W:security.test.ts` "each artifact is its own origin" | |
| `EMAIL_PROVIDER` sendgrid/resend/console, default console | Met | `config.ts`, `email/index.ts`; `W:email.test.ts` "EMAIL_PROVIDER picks the implementation" | |
| `SENDGRID_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` | Met | `config.ts`; `W:config.test.ts` | |
| `MAX_ARTIFACTS_PER_USER` default 100 | Met | `config.ts`; `W:artifacts.test.ts` "enforces the quota"; `W:limits.test.ts` "MAX_ARTIFACTS_PER_USER sets the default limit" |  |
| `CDN_ALLOWLIST` with the default list | Met | `constants.ts` DEFAULTS; `W:security.test.ts` "a custom CDN_ALLOWLIST replaces the default" | |
| `SINGLE_USER_MODE`, `ADMIN_TOKEN` | Met | `config.ts`, `auth/principal.ts`; `W:auth.test.ts` "single-user mode"; `W:config.test.ts` | Also needs exactly one `ADMIN_EMAIL` (undocumented in the build prompt, documented in self-hosting.md) |
| `ALLOW_PUBLIC_VISIBILITY` enables public listing features | Partial | `config.ts`, `policy.ts#canMakePublic`; `W:limits.test.ts` "public visibility: allowed for a verified, old-enough account; refused for a new one"; `W:artifacts.test.ts` "public visibility is refused unless the instance enables it" | The flag unlocks `public`; there is no listing page in v1 (DECISIONS, **Review**) |
| `SESSION_SECRET`, `TOKEN_SIGNING_KEY` generated by setup script | Partial | `scripts/setup.mjs` | Verified by running `--local` and `--remote --dry-run` (docs workstream and orchestrator); no automated test |
| Refuse to run in production if hosts share a registrable domain | Met | `config.ts#validate`; `W:security.test.ts` "Production refuses to run..." (3 tests), `W:config.test.ts` | Implemented as 500 on every request |

## Data model (D1)

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `users` (id, email unique, name, artifact_limit, created_at) | Met | `migrations/0001_init.sql` | + email_verified_at, is_admin |
| `agent_connections` (... token_hash, scopes, last_used_at, revoked_at) | Met | `0001_init.sql` | OAuth token hashes live in `oauth_grants` |
| `artifacts` (... slug unique, visibility enum, password_hash, deleted_at) | Met | `0001_init.sql` | |
| `versions` (... r2_prefix, size_bytes, created_by_user/connection, note) | Met | `0001_init.sql` | |
| Versions immutable | Met | `services/artifacts.ts#createVersion` (row first, unique prefix, files deleted before the row on a failed advance); `W:artifacts.test.ts` "update creates a new immutable version", "concurrent updates with the same base_version have exactly one winner" |  |
| `access_grants` (artifact_id, email, role) | Met | `0001_init.sql` | |
| `comments` (... anchor JSON, status) | Met | `0001_init.sql` | |
| `mention_tasks` (... target_connection or target_client_type, state, claimed_by, result_version) | Met | `0001_init.sql` | |
| `sessions`, `login_codes`, `oauth_clients`, `oauth_grants`, `reports` | Met | `0001_init.sql` | |
| R2 at `artifacts/<id>/v<n>/index.html` plus assets | Met | `storage.ts#versionPrefix`; `W:artifacts.test.ts` "stores files in R2" | |
| Limits: 5 MB HTML, 25 MB total per version | Met | `constants.ts` LIMITS; `W:artifacts.test.ts` "enforces size limits"; `W:mcp.test.ts` oversize | |

## Auth

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| People: email magic link | Met | `auth/login.ts`; `W:auth.test.ts` "magic link works once..."; `E:account.spec.ts` "magic link is not used on load" | Link token sits in the URL (inherent; single use, 15 min) |
| Six-digit code fallback | Met | `W:auth.test.ts` "sends a code and a magic link..."; `E:account.spec.ts` "code sign-in" | |
| Single use | Met | `W:auth.test.ts` "refuses a wrong code, a reused code and an expired code" | |
| 15-minute expiry | Met | `TTL.loginCodeMs`; same test | |
| Rate limited per email and per IP | Met | `W:auth.test.ts` "rate limits sign-in emails per address and per IP", "rate limits code attempts" | Per-IP skipped without `cf-connecting-ip` (DECISIONS) |
| Session cookie HttpOnly, Secure, SameSite=Lax, host-only on APP_HOST | Met | `services/sessions.ts`; `W:auth.test.ts` first test asserts flags and no `Domain=` | |
| Email adapter: SendGrid, Resend, console | Met | `email/index.ts`; `W:email.test.ts` | |
| Agents: OAuth 2.1 with PKCE | Met | `oauth/service.ts`; `W:oauth.test.ts` "refuses a PKCE mismatch", "plain PKCE" | |
| Dynamic client registration | Met | `W:oauth.test.ts` "registers, consents, gets a token and calls publish_artifact through /mcp" | |
| Discovery metadata endpoints | Met | `W:oauth.test.ts` RFC 8414 / RFC 9728 tests; `W:mcp.test.ts` 401 with `resource_metadata` | |
| Consent screen with connection label | Met | `Wb:pages/Consent.tsx`; `E:account.spec.ts` "OAuth consent" | |
| Personal access tokens from the dashboard | Met | `Wb:components/account/NewTokenDialog.tsx`; `W:connections.test.ts`; `E:account.spec.ts` "dashboard, tokens, MCP publishing..." | |
| Tokens shown once | Met | `W:connections.test.ts` "are shown once, stored only as a hash" | |
| Stored only as hashes | Met | same | |
| Individually revocable | Met | `W:connections.test.ts` "a revoked token gets 401"; `W:oauth.test.ts` "revoking the connection cuts off..." | |
| `last_used_at` | Met | `W:connections.test.ts` (polls `lastUsedAt`) | |
| Viewers: public / unlisted / password / allowlist | Met | `policy.ts`; `W:policy.test.ts` "every role x visibility" | |
| Password hashed | Met | `lib/crypto.ts` PBKDF2-SHA256 100k | |
| Password attempts rate limited | Met | `W:security.test.ts` "password attempts: the 11th attempt..." | Per artifact per IP only; no global per-artifact cap |
| Allowlist: viewer confirms email by code | Met | `W:viewer.test.ts`; `E:viewer.spec.ts` "allowlist: a listed email confirms by code; another is refused" | |
| Short-lived signed token bound to artifact id, issued after app check | Met | `content/tokens.ts`; `W:content-host.test.ts` "refuses expired, tampered...", "single use even when two requests race" | 60 s |
| Redirect to content subdomain, exchange for host-only cookie | Met | `content/serve.ts`; `W:security.test.ts` "the content cookie is host-only, HttpOnly, Secure, partitioned" | |
| App session cookie never sent to/readable from content host | Met | `W:security.test.ts` "an app session cookie sent to a content host grants nothing" | |

## MCP tools

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| All tools act as the connected user | Met | `mcp/server.ts` uses `serviceCtx` principal; `W:policy.test.ts` "act as the connected user" | |
| Input validated with schemas | Met | `packages/shared/src/schemas.ts`; `W:mcp.test.ts` "bad input" | |
| Tool descriptions state that comment/artifact text is untrusted | Met | `mcp/server.ts` `UNTRUSTED_NOTE` on all 10 tools; `W:mcp.test.ts` "lists every tool, and descriptions warn..." (checks every tool) |  |
| `publish_artifact` returns id, slug, URLs | Met | `W:mcp.test.ts` "publish, update, get..." | |
| Default visibility unlisted | Met | same test asserts `visibility: "unlisted"` | |
| Enforces quota | Met | `W:mcp.test.ts` "over quota" | Count-then-insert is not atomic; parallel publishes can exceed the quota |
| `update_artifact` creates a new version | Met | `W:mcp.test.ts` | |
| Stale `base_version` rejected with conflict | Met | `W:mcp.test.ts` stale; `W:artifacts.test.ts` "concurrent updates ... exactly one winner" | |
| `get_artifact`, `list_artifacts`, `list_versions`, `restore_version` | Met | `W:mcp.test.ts` | |
| `set_visibility(id, visibility, emails?, password?)` | Met | `W:mcp.test.ts`, `W:artifacts.test.ts` "set_visibility with password and allowlist" | |
| `list_mentions`, `claim_mention` (atomic, one winner), `reply_comment` | Met | `W:mentions.test.ts` "10 concurrent claims over /mcp: exactly one winner", "full pull-mode flow through MCP tools" | Claimed tasks never time out; a crashed agent leaves a task stuck |
| Every tool mirrored as REST under `/api/v1`, same auth | Met | `api/artifacts.ts`, `api/comments.ts`; `W:openapi.test.ts` "mirrors every MCP tool with the same auth" | |
| Generate an OpenAPI file | Met | `docs/openapi.json`; `pnpm openapi --check`; `W:openapi.test.ts` "documents exactly the routes the Worker serves" | |

## Features

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Dashboard: list with search | Met | `Wb:pages/Dashboard.tsx`; `E:account.spec.ts` "dashboard, tokens, MCP publishing, search..." | |
| Visibility badges, version count | Met | `Wb:components/account/ArtifactRow.tsx`; same e2e | |
| Connections page: create, label, revoke, last used | Met | `Wb:pages/Connections.tsx`; same e2e | |
| Per-artifact settings: visibility, allowlist, roles | Met | `Wb:pages/Settings.tsx`; `E:account.spec.ts` "settings are for the owner only"; `W:sharing.test.ts` | |
| Artifact page `/a/<slug>`, sandboxed iframe on content subdomain | Met | `Wb:components/viewer/ArtifactFrame.tsx`; `E:viewer.spec.ts` "unlisted: ... sandboxed frame" | |
| Top bar: title, version picker, share, edit, comments toggle, report link | Met | `Wb:components/viewer/ViewerStage.tsx`; `Wb:pages/ArtifactPage.test.tsx`; `E:viewer.spec.ts` "the owner sees visibility, Edit..." | |
| `/a/<slug>/v/<n>` permanent link | Met | `E:viewer.spec.ts` "a version link keeps showing that version after an update" | |
| History list with author (person or label), note, date | Met | `Wb:pages/History.tsx`; `E:history.spec.ts` "history lists every version with author, note and links" | |
| Source diff between any two versions | Met | `E:history.spec.ts` "compare v1 and v3: source diff..."; `Wb:components/history/diff.test.ts` | |
| Side-by-side rendered comparison | Met | `E:history.spec.ts` same test (frames + sandbox asserted) | |
| Restore publishes old content as next version | Met | `W:artifacts.test.ts` "restore publishes the old content as the next version"; `E:history.spec.ts` "restore v1 publishes it as v4" | |
| Editor: Monaco with live preview in sandboxed iframe | Met | `E:editor.spec.ts` "edit in Monaco, see it in the preview, save with a note" | |
| Save with optional note | Met | same | |
| Stale save shows a diff and refuses to overwrite | Met | `E:editor.spec.ts` "saving against a stale version shows the diff and never overwrites" | |
| Owner and editors only | Met | `E:editor.spec.ts` "a viewer sees that they cannot edit"; `W:policy.test.ts` | |
| Comments threaded, resolvable | Met | `W:comments.test.ts` "create, list, thread, resolve" | |
| Optionally anchored to an element | Met | `W:comments.test.ts` "anchors are validated"; `E:comments.spec.ts` "an editor pins a mention..." | |
| Bridge script injected only in review mode | Met | `content/bridge.ts`; `W:bridge.test.ts` "adds the bridge script ... only in review mode" | |
| postMessage with strict origin checks on both sides | Met | `W:bridge.test.ts` "embeds the exact app origin and never posts to '*'"; `Wb:components/comments/bridge.test.ts` "accepts a message only from the content origin and the frame's own window" | |
| `@claude`, `@codex`, `@<label>` create a `mention_tasks` row | Met | `W:mentions.test.ts` "@claude, @codex and @<label>..." | |
| Only commenters and editors can mention | Met | `W:mentions.test.ts` "commenters and editors can mention" | |
| Only the owner's connections can be targets | Met | `W:mentions.test.ts` "an editor's mention targets the owner's connections" | |
| Agent result is a new version plus a reply | Met | `W:mentions.test.ts` "validates result_version and supports failed" | |
| Quota 100 from `MAX_ARTIFACTS_PER_USER` | Met | `W:limits.test.ts`, `W:artifacts.test.ts`; atomic insert `W:limits.test.ts` "parallel publishes cannot overshoot the artifact limit" |  |
| Per-user override via `users.artifact_limit` | Met | `W:artifacts.test.ts` "enforces the quota ... per-user override" | |
| Admin CLI command for the override | Met | `apps/worker/scripts/admin.mjs`; `W:admin-cli.test.ts` | |
| Cap publishes per hour | Met | `W:security.test.ts` "publishes per hour are capped ... new artifacts, updates and restores" | |
| Hosted features behind flags | Partial | `ALLOW_PUBLIC_VISIBILITY`, `PUBLIC_MIN_ACCOUNT_AGE_HOURS` | Reports, takedown and legal templates are on for every instance (DECISIONS, **Review**) |
| Public only after email verification + minimum account age | Met | `policy.ts#canMakePublic`; `W:policy.test.ts`; `W:limits.test.ts` "public visibility: allowed ... refused for a new one" (publish and set_visibility) |  |
| Report flow with admin takedown page | Met | `W:reports.test.ts`; `E:viewer.spec.ts` "a report reaches the admin, who takes the artifact down" | |
| Terms, privacy, AUP as clearly marked placeholder templates | Met | `Wb:components/viewer/legalDocs.tsx` (operator is a placeholder field); `E:viewer.spec.ts` "renders as a marked template" |  |

## Security requirements (each needs a test on real Worker responses)

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| CSP scripts inline or CDN allowlist (default 6 hosts) | Met | `content/csp.ts`; `W:security.test.ts` "the policy has exactly the required sources", "is on every content response" | Adds `'self'`, `'unsafe-eval'`, `'wasm-unsafe-eval'` (Review row) |
| Styles inline or `fonts.googleapis.com` | Met | same | Adds `'self'` |
| Fonts `fonts.gstatic.com` or `data:` | Met | same | Adds `'self'` |
| Images and media: own files, `data:`, `blob:` | Met | same | |
| `connect-src` own origin only | Met | same | |
| `X-Content-Type-Options: nosniff` | Met | `W:security.test.ts` "is on every content response" | |
| Restrictive `Permissions-Policy` | Met | `W:csp.test.ts` "Permissions-Policy grants no powerful feature" | |
| Iframes: `sandbox` without `allow-top-navigation` | Met | `E:viewer.spec.ts` (frame check), `E:history.spec.ts`, `E:editor.spec.ts`; `Wb:pages/ArtifactPage.test.tsx` | Worker suite only checks `frame-ancestors`/`frame-src`; sandbox string duplicated in 3 files |
| Iframes: no `allow-same-origin` toward the app | Met | frames point at `<id>.CONTENT_HOST` (`E:viewer.spec.ts`), `W:security.test.ts` "each artifact is its own origin" | Uses `allow-same-origin` toward the artifact's own origin (Review row) |
| One artifact cannot read another's cookies, storage, files | Met | `W:security.test.ts` "each artifact is its own origin", "a cookie tossed onto the parent domain...", "file paths cannot escape" | |
| Viewer token for A rejected on B | Met | `W:security.test.ts` "a token for A is refused on B" | |
| No content-host route serves app pages or accepts app cookies | Met | `W:security.test.ts` "content hosts never answer with the SPA, the API, MCP or OAuth" | |
| No app-host route serves raw user HTML | Met | `W:security.test.ts` "the app host never serves an artifact's HTML as a page" | Staging-only exception: `STAGING_CONTENT_FALLBACK`, CSP-sandboxed, refused in production (DECISIONS, **Review**) |
| CSRF on all state-changing app routes | Met | `W:security.test.ts` "every unsafe /api/v1 route refuses...", "routes outside /api/v1 that take writes do not read cookies" | |
| User-supplied text escaped | Met | React escaping; `E:comments.spec.ts` "hostile comment text renders inert" | Not in the Worker security suite (it is a browser concern) |
| Markdown in comments sanitized | Met | `packages/shared/src/markdown.ts`; `packages/shared/test/markdown.test.ts`; same e2e | Only `dangerouslySetInnerHTML` is in `Thread.tsx`, fed by the escape-first renderer |
| Authorization on every read and write, one policy module | Met | `policy.ts`; `W:security.test.ts` "Authorization is checked on every read and write" (3 tests) | `/api/v1/me` returns the stored `is_admin`, not the live `ADMIN_EMAIL` decision (UI only) |
| Rate limits: login codes | Met | `W:auth.test.ts` rate-limit tests | |
| Rate limits: password attempts | Met | `W:security.test.ts` | |
| Rate limits: publishes | Met | `W:security.test.ts` | |
| Rate limits: comment creation | Met | `W:comments.test.ts` "allows 60 comments per user per hour, then 429" | |
| No secrets in logs | Met | `W:security.test.ts` "nothing secret is logged across..." | Console provider logs sign-in links by design; allowed in production in single-user mode |
| No secrets in URLs except the viewer token exchange | Met | `W:security.test.ts` "the viewer token travels only in the enter URL"; magic link token in the fragment (`auth/login.ts`, `W:auth.test.ts`), removed from history (`Wb:pages/Magic.tsx`) |  |
| No secrets in client bundles | Met | `scripts/check-bundle-secrets.mjs` (run: clean); `W:security.test.ts` "the client bundle served by the app contains no server secret" | That test passes vacuously if no bundle is served (no `sources.length > 0` assertion) |

## UI design

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Original design, no copied identity | N/A-later | — | Needs human review |
| Quiet, editorial feel | N/A-later | — | Needs human review |
| Light "Gallery" and dark "After hours" modes | Met | `Wb:styles/tokens.css`; e2e light/dark projects | |
| Follow system setting | Met | `Wb:components/ui/ThemeToggle.test.tsx` "going back to System follows the system setting"; `E:editor.spec.ts` emulateMedia | |
| Manual toggle | Met | `ThemeToggle.test.tsx` "offers Gallery, After hours and System" | |
| Persist the choice | Met | `Wb:components/ui/ThemeToggle.test.tsx`; `E:theme.spec.ts` "the manual toggle persists across reloads, applied before the app script runs" |  |
| No flash of wrong theme | Met | `apps/web/public/theme.js` loaded synchronously in `index.html`; `ThemeToggle.test.tsx` "uses the key and values public/theme.js reads" | |
| One accent, verdigris, for primary/focus/active | Met | `tokens.css` `--color-accent`, `--color-focus` | |
| Semantic success/warning/danger colors | Met | `tokens.css` | |
| All colors are tokens defined once | Met | grep: no hex/rgb outside `tokens.css` in CSS | |
| WCAG AA contrast in both modes | Met | `Wb:styles/contrast.test.ts`; axe in e2e | |
| Instrument Serif / Geist / JetBrains Mono, self-hosted | Met | `Wb:styles/fonts.css` (fontsource woff2 bundled) | |
| Type scale used consistently | Met | `tokens.css` `--text-*` | Three `em`-relative sizes outside the scale (minor) |
| Phosphor icons, one weight, consistent grid | Met | `Wb:components/ui/icons.tsx` (`ICON_WEIGHT`, `ICON_SIZE`) | |
| Original logo mark: small block on wider base | Met | `Wb:components/Logo.tsx` | Visual check only |
| Components: button, input, select, dialog, menu, tabs, toast, badge, tooltip, empty state, skeleton | Met | `Wb:components/ui/*`; tests for Dialog, Menu, Tabs, Toast, Tooltip | No unit tests for Badge, EmptyState, Skeleton, Select |
| Keyboard accessible, visible focus | Met | component tests; `E:comments.spec.ts` "keyboard friendly and passes axe" | |
| Reduced motion respected | Met | `@media (prefers-reduced-motion)` in `tokens.css`, `skeleton.css`, `spinner.css` | No test |
| Responsive from 360 px (dashboard, artifact page, comments) | Met | e2e `mobile` project (360×740); `E:account-a11y.spec.ts` overflow checks | |
| Editor may need 900 px and says so | Met | `E:editor.spec.ts` "says the editor needs a wider screen" | |
| `/design` route shows every token and component in both modes | Met | `Wb:pages/Design.tsx`; `E:theme.spec.ts` "/design shows tokens and components in both modes and passes axe" |  |

## Build order

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| 1. Scaffold, config, migrations, R2, publish/update over MCP+REST with PAT, unlisted+password links, versions from first publish | Met | see above | |
| 2. Accounts, magic links, email adapter, OAuth, content subdomains, CSP, quotas, rate limits | Met | see above | |
| 3. Allowlist sharing, roles, dashboard, connections pages | Met | see above | |
| 4. History UI, diff, restore, permanent version links | Met | see above | |
| 5. Comments, anchors, mention queue and tools | Met | see above | |
| 6. Editor with conflict handling | Met | see above | |
| 7. Design polish, `/design`, accessibility pass | Met | see UI table; independent UI review (0 axe violations on Plinth pages), fixes applied |  |
| 8. Hosted flags, report and takedown, policy templates | Partial | see Features | Public visibility flag; reports/takedown always on (DECISIONS, **Review**) |
| 9. README, setup script, deploy guide, license, contribution guide | Met | see Deliverables |  |
| 10. Staging deploy (named in the review brief, not in the checked-in build prompt) | Met | `docs/staging.md`, `e2e/staging/smoke.mjs`, `scripts/setup.mjs --workers-dev` | Deployed 2026-11-13 to `plinth-staging.aconite-io.workers.dev` after German enabled R2 and approved the workers.dev subdomain; smoke test 5/5 live. Uses the path fallback, so per-artifact subdomain isolation is still verified locally only |

## Testing and verification

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Policy for every role and visibility | Met | `W:policy.test.ts` "every role x visibility" | |
| Version creation, restore, conflict | Met | `W:artifacts.test.ts` | |
| Quota default | Met | `W:artifacts.test.ts` | |
| Quota env override | Met | `W:limits.test.ts` "MAX_ARTIFACTS_PER_USER sets the default limit"; `W:config.test.ts` |  |
| Quota per-user override | Met | `W:artifacts.test.ts`, `W:admin-cli.test.ts` | |
| Token hashing and revocation | Met | `W:connections.test.ts`, `W:oauth.test.ts` | |
| Mention claim under concurrent calls | Met | `W:mentions.test.ts` (10 concurrent, MCP and REST) | Local D1 serializes writes, so this proves the conditional UPDATE logic, not true parallelism |
| Email adapter, each provider mocked at the HTTP layer | Met | `W:email.test.ts` (SendGrid and Resend bodies; factory through the global fetch: "createEmailAdapter(sendgrid).send() calls the global fetch...") | Also one real send through the SendGrid adapter on 2026-11-13 (accepted) |
| MCP via official client: OAuth registration and consent | Met | `W:oauth.test.ts` "registers, consents, gets a token and calls publish_artifact through /mcp" | |
| MCP: every tool's success path | Met | `W:mcp.test.ts`, `W:mentions.test.ts` | |
| MCP failures: no auth, wrong owner, over quota, oversize, stale base_version | Met | `W:mcp.test.ts` "fails cleanly..." and "each tool refuses another user's artifact or task" (every tool) |  |
| Security: one test per bullet on real responses | Met | `W:security.test.ts` (one `describe` per bullet) | Escaping/sanitizing bullet lives in e2e and shared unit tests, not this suite |
| E2E: sign in through the console email provider | Met | `E:account.spec.ts` "code sign-in" (reads the dev outbox) | Other specs seed sessions via `/__dev/seed` |
| E2E: publish via MCP, open share link anonymously for each visibility | Partial | `E:viewer.spec.ts` unlisted, password, allowlist | Public is covered by Worker tests only (`W:limits.test.ts`, `W:content-host.test.ts`); the e2e server keeps `ALLOW_PUBLIC_VISIBILITY` off |
| E2E: allowlisted viewer confirms by code; non-listed refused | Met | `E:viewer.spec.ts` "allowlist: ..." | |
| E2E: comment with mention, complete via MCP, see new version and reply | Met | `E:comments.spec.ts` "an editor pins a mention, the owner's agent completes it" | |
| E2E: edit, save, hit a conflict | Met | `E:editor.spec.ts` | |
| E2E: restore a version | Met | `E:history.spec.ts` | |
| E2E: theme toggle persists | Met | `E:theme.spec.ts` (light, dark, mobile) |  |
| E2E: main flows in both modes and at mobile width | Met | `e2e/playwright.config.ts` projects light/dark/mobile; 141 passed | |
| Gates: typecheck, lint, test, test:e2e, build all pass | Met | commands above, all exit 0 | |
| axe on dashboard, artifact page, editor, login in both modes | Met | `E:account-a11y.spec.ts`, `E:viewer.spec.ts`, `E:editor.spec.ts` "no CSP violations and no axe violations, in both modes" | |
| GitHub Actions runs all of it | Partial | `.github/workflows/ci.yml` | Written, never run: the branch is not pushed (pushing needs the owner's approval) |
| Self-review in `REQUIREMENTS.md` | Met | this file |  |

## Deliverables

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Layout `apps/worker`, `apps/web`, `packages/shared`, `migrations`, `e2e`, `docs` | Met | tree | |
| README: what it is | Met | `README.md` | |
| README: quick start in under ten commands | Met | `README.md` (6 commands) | Not run in this review |
| README: screenshots of both modes | Met | `docs/screenshots/gallery.png` (dashboard, light), `docs/screenshots/after-hours.png` (artifact page, dark) |  |
| `docs/self-hosting.md` | Met | file | |
| `docs/deploy-checklist.md`: Cloudflare resources, DNS both hosts incl. wildcard, secrets, SendGrid/Resend domain auth | Met | file sections 1–4 | |
| `docs/security.md` | Met | file | |
| `docs/mcp.md` (Claude and Codex) | Met | file | |
| `LICENSE` MIT, Aconite Software & Investments, Lda. | Met | `LICENSE` | |
| `CONTRIBUTING.md` | Met | file | |
| `DECISIONS.md` | Met | file | |
| `REQUIREMENTS.md` | Met | this file |  |
| Setup script: local and remote D1+R2, secrets, config | Partial | `scripts/setup.mjs` (`--local`, `--remote`, `--workers-dev`, `--dry-run`) | Local mode verified; remote mode run for real for staging (`--workers-dev`) on 2026-11-13; production remote mode (routes, custom domain) only as a dry run; no automated test |
| Seed script: demo user and sample artifacts | Met | `scripts/seed.mjs` | Verified by running against `wrangler dev` (4 artifacts, rerun is idempotent); used for the README screenshots and the local preview |

## Out of scope for v1

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Not built: push mode, typed outputs, visual editing, teams, billing, custom domains, realtime | N/A-later | grep: none present | |

## Spec items not in the build prompt (spec wins per AGENTS.md)

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Agent tokens used for mentions scoped to that one artifact (spec, Security) | Partial | `policy.ts#canActOnMention` (only the owner's matching connection, `mentions` scope); untrusted-text notes on every tool; `comment_author_role` on tasks | Pull mode uses the owner's own connection; per-artifact task tokens belong to push mode (DECISIONS, **Review**) |
| Storage capped per account (spec, Quotas) | Met | `MAX_STORAGE_BYTES_PER_USER` (`config.ts`, `services/artifacts.ts#enforceStorage`); `W:limits.test.ts` "caps stored bytes per account across all versions" |  |
| "Deploy to Cloudflare" button (spec, Self-hosting) | Partial | `README.md` → Deploy | Button added; not tried against the repository |
| Every artifact page: report link and platform banner | Met | `Wb:pages/ArtifactPage.test.tsx` ("Hosted on Plinth") | |
| Takedown contact (spec, paperwork) | Partial | legal templates (placeholder field), `docs/deploy-checklist.md` human step 10 | The operator must publish a real contact before going live |
