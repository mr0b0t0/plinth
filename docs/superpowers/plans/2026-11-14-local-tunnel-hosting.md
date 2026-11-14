# Local Tunnel Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a full Plinth instance on the owner's machine, with D1 and R2 on local disk, reachable from the internet through a named Cloudflare Tunnel on two owned domains.

**Architecture:** No Worker changes. `scripts/setup.mjs --tunnel` writes an instance directory
(`$PLINTH_HOME/<name>/`, default `~/.plinth/plinth/`) holding a generated Wrangler config, its
`.dev.vars`, the `cloudflared` config and the tunnel credentials. It creates the tunnel and DNS
records through the Cloudflare API, using a setup-time API token. `pnpm local:start` runs
`wrangler dev` bound to 127.0.0.1 against that config, plus `cloudflared tunnel run`, and
supervises both. Pure helpers live in Node-free `.mjs` modules under `apps/worker/scripts/`, so
the Workers Vitest pool can test them, following `admin-lib.mjs`.

**Tech Stack:** Node 22+ scripts (no new dependencies), wrangler 4.158.0, `cloudflared`
(user-installed), the Cloudflare REST API v4, and Vitest in the Workers pool.

**Spec:** `docs/superpowers/specs/2026-11-14-local-tunnel-hosting-design.md`

## Global Constraints

- No Worker code path for local mode. Nothing under `apps/worker/src/` changes. Exception: a
  shared fix for a proxy bug that Task 1 finds, which must be flagged to German first.
- The Worker listens on `127.0.0.1` only, never `0.0.0.0` or a LAN address.
- Generated config: `ENVIRONMENT=production`, `PUBLIC_SCHEME=https`, `DEV_OUTBOX=false`,
  `DEV_SEED=false`, `DEV_IGNORE_CLIENT_IP=false`, `STAGING_CONTENT_FALLBACK=false`, and no `routes`.
- The `cloudflared` config never sets `httpHostHeader` or `originServerName`.
- Secrets (`SESSION_SECRET`, `TOKEN_SIGNING_KEY`, `ADMIN_TOKEN`, email API keys, the tunnel
  secret, `CLOUDFLARE_API_TOKEN`) never appear in argv, logs or the repo. Files holding them
  use mode 0600. `CLOUDFLARE_API_TOKEN` is read from the environment at setup time and never
  written anywhere.
- Instance names match `^[a-z][a-z0-9-]{0,30}$`.
- The default local port is `8788`, so it doesn't clash with `pnpm dev` on 8787.
- Pin dependency versions exactly. No new npm dependencies.
- Product copy never says "Claude" or "Codex" in the product name.
- Coordination: tasks 1, 2, 3 and 5 add only new files and can start now. Tasks 4 and 7 edit
  files the v1-build session is changing (`scripts/setup.mjs`, docs, `DECISIONS.md`), so they
  wait for that session's go-ahead and rebase onto its merges. Work in a worktree off `v1-build`.

## Review Focus

1. **Rerunning setup after a partial failure** (tunnel created, credentials file lost). Setup
   must not create a second tunnel. It stops with a clear message explaining how to recover.
   Pinned in Task 3.
2. **A DNS record for the app host that already points elsewhere** (an old site, for example).
   Setup refuses and never overwrites it. Pinned in Task 3.
3. **A content host that isn't the zone apex in origin mode** (`content.example.net`). Setup
   refuses and explains the wildcard certificate limit. Pinned in Task 2.
4. **The port is in use, or `wrangler` dies.** `local:start` stops `cloudflared` and exits
   non-zero, rather than leaving a tunnel that points at nothing. Pinned in Task 6.
5. **The two zones are in different Cloudflare accounts, or the token lacks a permission.**
   Setup refuses, names the zone or the permission, and never prints the token. Pinned in Task 3.

---

### Task 1: Verify the local runtime assumptions

No product code. This de-risks the design before anything is built on it.

**Files:**
- Create (scratch, not committed): `$TMP/plinth-rt/wrangler.jsonc`, `$TMP/plinth-rt/.dev.vars`

- [ ] **Step 1:** Write a config outside `apps/worker`, with absolute `main`
  (`<repo>/apps/worker/src/index.ts`), `assets.directory` (`<repo>/apps/web/dist`) and
  `migrations_dir`. Use the vars from Global Constraints, with `APP_HOST=plinth.example.com`,
  `CONTENT_HOST=example-content.net`, `SINGLE_USER_MODE=true`, `ADMIN_EMAIL=owner@example.com`,
  `EMAIL_PROVIDER=console`, plus a `.dev.vars` next to it holding three random 64-character
  secrets.
- [ ] **Step 2:** Run
  `wrangler d1 migrations apply DB --local --config <cfg> --persist-to $TMP/plinth-rt/state`, then
  `wrangler dev --config <cfg> --ip 127.0.0.1 --port 8788 --persist-to $TMP/plinth-rt/state`.
- [ ] **Step 3:** Check each of these. Expected results:
  - `curl -H 'Host: plinth.example.com' 127.0.0.1:8788/healthz` returns `{"ok":true,"environment":"production"}`, so `.dev.vars` loaded and the production checks passed.
  - `curl -H 'Host: x1.example-content.net' 127.0.0.1:8788/` reaches the content router (a content 4xx, not the SPA).
  - POST `/api/v1/auth/login` with `Host: plinth.example.com`, `Origin: https://plinth.example.com`, the CSRF cookie and header (as in `e2e/staging/smoke.mjs`), and `cf-connecting-ip: 203.0.113.7`. Then `wrangler d1 execute DB --local --config <cfg> --persist-to … --command "SELECT key FROM rate_limits"` lists `login:ip:203.0.113.7`.
  - `lsof -nP -iTCP:8788 -sTCP:LISTEN` shows only `127.0.0.1`.
- [ ] **Step 4:** If the client IP shows as `127.0.0.1` or is missing, stop. Message German and the
  v1-build session with what you saw before choosing a fix. Otherwise, record the outcome for
  Task 7's DECISIONS row: "Runtime: wrangler dev with a generated config; cf-connecting-ip passes
  through".

### Task 2: Pure helpers, `tunnel-lib.mjs`

**Files:**
- Create: `apps/worker/scripts/tunnel-lib.mjs`, `apps/worker/scripts/tunnel-lib.d.mts`
- Test: `apps/worker/test/tunnel-lib.test.ts`

**Interfaces (produces):**
```ts
type Isolation = "origin" | "opaque";
type TunnelOptions = {
  name: string; appHost: string; contentHost: string; port: number;
  emailProvider: "sendgrid" | "resend" | "console"; emailFrom: string;
  singleUser: boolean; adminEmail: string | null; isolation: Isolation; cloudflare: boolean;
};
class TunnelUsageError extends Error {}
function validateTunnelOptions(raw: Record<string, string | true | undefined>,
  deps: { getDomain(host: string): string | null }): TunnelOptions;
function instancePaths(home: string, name: string): {
  dir: string; state: string; wranglerConfig: string; devVars: string;
  cloudflaredConfig: string; credentials: string; meta: string; }; // meta = instance.json {port, name}
function buildWorkerConfig(o: TunnelOptions, repoRoot: string): object; // JSON-serializable wrangler config
function renderCloudflaredConfig(a: { tunnelId: string; credentialsFile: string;
  appHost: string; contentHost: string; port: number }): string;
function dnsRecordNames(appHost: string, contentHost: string): string[]; // [app, content, "*.content"]
function credentialsJson(a: { accountId: string; tunnelId: string; secret: string }): string;
function startCommands(paths: ReturnType<typeof instancePaths>, port: number, tunnel: boolean):
  { wrangler: string[]; cloudflared: string[] | null }; // argv after the binary
```
Paths are joined with `/` (POSIX only, per the non-goals), so the module stays free of Node imports.

- [ ] **Step 1: Write failing tests.** Each `it` asserts exact values.
  - `validateTunnelOptions` returns `port: 8788`, `isolation: "origin"`, `cloudflare: true`,
    `emailFrom: "Plinth <noreply@plinth.example.com>"` when given only
    `{name:"plinth", "app-host":"plinth.example.com", "content-host":"example-content.net", "email-provider":"resend"}`.
  - It throws `TunnelUsageError` matching `/apex/` for `content-host: "content.example.net"` with
    `isolation` unset, and accepts it with `"content-isolation": "opaque"`.
  - It throws for each of these: an app and content host that share a registrable domain while
    isolation is origin; a bad name `"Plinth!"`; a port outside 1024–65535; `--single-user` without
    `--admin-email`; `email-provider: "console"` without `--single-user` (matching
    `/production refuses/`).
  - `--no-cloudflare` sets `cloudflare: false`.
  - `instancePaths("/h", "p").credentials === "/h/p/tunnel-credentials.json"`, and so on for each
    field (`state`, `wrangler.jsonc`, `.dev.vars`, `cloudflared.yml`, `instance.json`).
  - `buildWorkerConfig` gives `main` = `<root>/apps/worker/src/index.ts`, `assets.directory` =
    `<root>/apps/web/dist`, `d1_databases[0].migrations_dir` = `<root>/migrations`, every var from
    Global Constraints, `CONTENT_ISOLATION` equal to the option, `APP_HOST`, `CONTENT_HOST`, no
    `routes` key, and `workers_dev: false`.
  - `renderCloudflaredConfig` output contains, in order, ingress `hostname: plinth.example.com`,
    `hostname: example-content.net` and `hostname: "*.example-content.net"`, each with
    `service: http://127.0.0.1:8788`, and ends with `- service: http_status:404`. It contains none of
    `httpHostHeader` or `originServerName`.
  - `startCommands(..., tunnel=false).cloudflared === null`. `wrangler` includes `--ip`,
    `127.0.0.1`, `--port`, `"8788"`, `--persist-to <state>` and `--config <wranglerConfig>`.
    `cloudflared` equals `["tunnel", "--no-autoupdate", "--config", <cloudflaredConfig>, "run"]`.
- [ ] **Step 2:** Run `pnpm --filter @plinth/worker test -- tunnel-lib`. Expected: FAIL (module
  missing).
- [ ] **Step 3:** Implement the functions above. Mirror `HOST_RE` and `EMAIL_RE` from
  `scripts/setup.mjs`. The apex check is `deps.getDomain(contentHost) === contentHost`. The shared
  registrable domain check is `getDomain(app) === getDomain(content)`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Commit: `feat(local): pure helpers for tunnel instances`.

### Task 3: Cloudflare provisioning, `tunnel-cloudflare.mjs`

**Files:**
- Create: `apps/worker/scripts/tunnel-cloudflare.mjs`, `apps/worker/scripts/tunnel-cloudflare.d.mts`
- Test: `apps/worker/test/tunnel-cloudflare.test.ts`

**Interfaces:**
- Consumes: `dnsRecordNames`, `credentialsJson` (Task 2).
- Produces:
```ts
class CloudflareError extends Error {} // message never includes the token
function provision(a: {
  token: string; fetch: typeof fetch; tunnelName: string;
  appHost: string; contentHost: string; appZone: string; contentZone: string;
  hasCredentials: boolean; newSecret: () => string; // base64 of 32 random bytes
}): Promise<{ accountId: string; tunnelId: string;
  credentials: string | null;                       // credentialsJson when a tunnel was created
  records: { name: string; action: "created" | "kept" }[] }>;
```
API calls (`https://api.cloudflare.com/client/v4`, `Authorization: Bearer`):
`GET /zones?name=<zone>` → `result[0].id`, `result[0].account.id`;
`GET /accounts/<acct>/cfd_tunnel?name=<n>&is_deleted=false`;
`POST /accounts/<acct>/cfd_tunnel` with `{name, config_src:"local", tunnel_secret}`;
`GET /zones/<zid>/dns_records?name=<fqdn>`;
`POST /zones/<zid>/dns_records` with `{type:"CNAME", name, content:"<id>.cfargotunnel.com", proxied:true}`.

- [ ] **Step 1: Write failing tests.** Use a fake `fetch` that routes on method and URL and
  records calls.
  - A fresh account: one tunnel POST whose body has `config_src: "local"` and the injected secret,
    and three DNS POSTs for `plinth.example.com`, `example-content.net` and
    `*.example-content.net`, each with `proxied: true` and `content: "<id>.cfargotunnel.com"`.
    Returns `credentials` with `TunnelSecret` equal to the injected secret.
  - Rerun with the tunnel present and `hasCredentials: true`: no POSTs. All records report `kept`,
    because they already point at the tunnel. `credentials: null`.
  - **Review Focus 1:** tunnel present and `hasCredentials: false` rejects with `CloudflareError`
    matching `/credentials/` and naming `cloudflared tunnel delete <name>`. No POST is made.
  - **Review Focus 2:** an app-host CNAME or A record already pointing elsewhere rejects matching
    `/already exists/` and names the host. No DNS POST is made for any host, because every check
    runs before the first write.
  - **Review Focus 5:** zones with different `account.id`s reject matching `/same Cloudflare
    account/`. A `403` response with `errors:[{code:10000,message:"Authentication error"}]`
    rejects with a message containing the Cloudflare message and the required permissions
    ("Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read"). No error message
    contains the token string.
  - A zone that isn't found rejects matching `/not on this Cloudflare account/`.
- [ ] **Step 2:** Run `pnpm --filter @plinth/worker test -- tunnel-cloudflare`. Expected: FAIL.
- [ ] **Step 3:** Implement `provision`. Do every read first (zones, tunnel, three record
  lookups), then the writes.
- [ ] **Step 4:** Run the tests again. Expected: PASS. Then run `pnpm typecheck` and `pnpm lint`.
- [ ] **Step 5:** Commit: `feat(local): provision tunnel and DNS through the Cloudflare API`.

### Task 4: `setup.mjs --tunnel` (after the v1-build go-ahead)

**Files:**
- Modify: `scripts/setup.mjs` (usage header, `BOOLEAN_FLAGS` gets `tunnel` and `no-cloudflare`,
  the mode dispatch, a new `setupTunnel()`)

**Interfaces:**
- Consumes: Tasks 2 and 3. tldts `getDomain` as setup.mjs already loads it. `readEnvFile`,
  `writeEnvFile`, `secret`, `wrangler()`.
- Produces: an instance directory that `local:start` (Task 5) reads.
  `PLINTH_HOME` env or `--home <dir>` (default `~/.plinth`).

- [ ] **Step 1:** Add `--tunnel` with flags `--name --home --app-host --content-host --port
  --email-provider --email-from --single-user --admin-email --content-isolation --no-cloudflare
  --force --dry-run`. `--tunnel` excludes `--local` and `--remote`.
- [ ] **Step 2:** Implement `setupTunnel()` in this order. Print each step, and under `--dry-run`
  write and execute nothing.
  1. `validateTunnelOptions`.
  2. Create the instance dir with mode 0700.
  3. Write `wrangler.jsonc` from `buildWorkerConfig`, and `instance.json` (`{ "name", "port" }`).
     A rerun replaces only the keys that `buildWorkerConfig` owns.
  4. Write `.dev.vars` (0600) with `SESSION_SECRET`, `TOKEN_SIGNING_KEY` and, in single-user mode,
     `ADMIN_TOKEN` (kept unless `--force`), plus `SENDGRID_API_KEY` or `RESEND_API_KEY` from the
     environment when set. Warn if the selected provider's key is missing.
  5. Unless `--no-cloudflare`: require `CLOUDFLARE_API_TOKEN`, call `provision`, write the
     credentials (0600) when returned, and write `cloudflared.yml`.
  6. Run `wrangler d1 migrations apply DB --local --config <wranglerConfig> --persist-to <state>`.
  7. Print next steps (`pnpm local:start --name <name>`) and a newly made `ADMIN_TOKEN`, once.
- [ ] **Step 3:** Verify: `node scripts/setup.mjs --tunnel --name t1 --home $TMP/h --app-host
  plinth.example.com --content-host example-content.net --single-user --admin-email o@example.com
  --email-provider console --no-cloudflare` creates the four expected paths. `stat -f %Lp` (or
  `stat -c %a`) gives `600` for `.dev.vars` and `700` for the dir. A second run reports
  "kept" for the secrets. `--dry-run` creates nothing.
- [ ] **Step 4:** Run `pnpm lint`, then commit: `feat(local): setup --tunnel writes an instance and provisions the tunnel`.

### Task 5: `pnpm local:start`

**Files:**
- Create: `scripts/local-start.mjs`
- Modify: root `package.json` (`"local:start": "node scripts/local-start.mjs"`)

**Interfaces:**
- Consumes: `instancePaths`, `startCommands` (Task 2). Instance files (Task 4).
- Flags: `--name` (default `plinth`), `--home`, `--no-tunnel`.

- [ ] **Step 1:** Implement the start sequence.
  1. Fail with a pointer to `setup --tunnel` when `wrangler.jsonc` is missing.
  2. Run `pnpm build` when `apps/web/dist/index.html` is missing.
  3. Apply migrations (as in Task 4's sub-step 6).
  4. Read the port from `instance.json` (`paths.meta`).
  5. Spawn wrangler (with `WRANGLER_SEND_METRICS=false`). Unless `--no-tunnel`, also spawn
     `cloudflared` (fail early with an install link when `cloudflared --version` fails).
  6. On SIGINT or SIGTERM, send SIGTERM to both, then exit 0. When either child exits on its own,
     send SIGTERM to the other and exit 1.
- [ ] **Step 2:** Verify with Task 4's `t1` instance: `pnpm local:start --name t1 --home $TMP/h
  --no-tunnel`, then `curl -H 'Host: plinth.example.com' 127.0.0.1:8788/healthz` returns
  `"environment":"production"`. Ctrl-C exits 0 and the port is free afterwards.
- [ ] **Step 3:** Commit: `feat(local): local:start runs the Worker and the tunnel together`.

### Task 6: Local smoke test

**Files:**
- Create: `e2e/local/smoke.mjs`
- Modify: root `package.json` (`"test:local": "node e2e/local/smoke.mjs"`) and
  `.github/workflows/ci.yml` (one step after `pnpm build`: `pnpm test:local`)

- [ ] **Step 1:** Write the script. It creates `mkdtemp` homes, runs setup `--no-cloudflare` and
  `local:start --no-tunnel` as child processes, captures the Worker's stdout, and kills everything
  on exit. Requests go to `127.0.0.1:<port>` with `Host` set to the production host, through a small
  `hostFetch(url, init): Promise<Response>` built on `node:http`. Pass `hostFetch` as the `fetch`
  option of `StreamableHTTPClientTransport`. Checks, with `PASS`/`FAIL` lines in the style of
  `e2e/staging/smoke.mjs`:
  1. `/healthz` reports production.
  2. Owner login: request a code, read it from the `[email:console]` log line, verify it, and
     check that the session cookie has `Secure`.
  3. Publish over `/mcp` with `ADMIN_TOKEN`.
  4. Set the artifact to allowlist with `viewer@example.com` (REST, per `docs/openapi.json`),
     request a viewer code, read it from the log, verify it, follow `enter_url` to
     `<id>.example-content.net`, get a 200 with the HTML, and check the CSP.
  5. The `rate_limits` keys include the `cf-connecting-ip` that was sent.
  6. Connecting to the first non-internal IPv4 address from `os.networkInterfaces()` on the port is
     refused (skip with a note when there's none).
  7. **Review Focus 4:** a second `local:start` on the same port exits non-zero within 30 s.
  8. Multi-user boot: a second instance (`--email-provider resend`, `RESEND_API_KEY=re_dummy` in the
     environment) gets `/healthz` 200 and `GET /` with the app `Host` returns the SPA (200,
     `text/html`).
- [ ] **Step 2:** Run `pnpm test:local`. Expected: every check reports PASS, and the exit code is 0.
- [ ] **Step 3:** Commit: `test(local): smoke test for tunnel instances without a tunnel`.

### Task 7: Docs and decisions (after the v1-build go-ahead)

**Files:**
- Create: `docs/local-hosting.md`
- Modify: `docs/self-hosting.md` (a "Run it on your own machine" pointer in "Choose a mode"),
  `README.md` (one line linking the guide), `docs/spec.md` (Users table: self-hoster runs it on
  Cloudflare or their own machine; "Open source and hosting model": a local-hosting bullet),
  `DECISIONS.md` (append rows: the runtime from Task 1, setup-time API token instead of `cloudflared
  login`, locally managed tunnel, port 8788, the `PLINTH_HOME` layout, single-user smoke plus
  multi-user boot, and the trust note marked **Review**)

- [ ] **Step 1:** Write `docs/local-hosting.md` with these sections:
  - What you need: Node, pnpm, `cloudflared`, two zones in one account, an API token with the three
    permissions, and email for sharing.
  - Setup: an example command.
  - Start.
  - Who can see what: the edge-TLS trust note, the table from the conversation (your machine, the
    email provider, Cloudflare, the viewer's browser), and "links work only while the machine is on".
  - Start at login: a launchd plist and a systemd user unit, both running `pnpm local:start`.
  - Backups: stop, then copy `$PLINTH_HOME/<name>/`.
  - Upgrades: `git pull`, `pnpm install`, `pnpm build`, restart (migrations run on start).
  - One domain with opaque isolation: the certificate caveat.
  - Troubleshooting: 502 from the tunnel, a 404 for a host, missing codes.
- [ ] **Step 2:** Run `pnpm lint` and `pnpm typecheck`. Check that every relative link in the new
  guide resolves (`ls` each target).
- [ ] **Step 3:** Commit: `docs(local): local hosting guide, spec and decisions`.

### Task 8: Whole-branch verification

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:local`. Every
  command must pass.
- [ ] Rebase onto the latest `v1-build` and run them again. Tell the v1-build session the branch
  name and that it's ready to merge.
