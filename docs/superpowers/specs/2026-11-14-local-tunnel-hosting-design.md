# Local hosting through a Cloudflare Tunnel

As of 2026-11-14 · requirements from the maintainer, design by Claude

## Intent

A third way to run Plinth, next to the hosted instance and self-hosting on Cloudflare Workers:
the Worker runs on the owner's own machine, all data (D1 and R2) stays on that machine's disk, and
a named Cloudflare Tunnel makes it reachable from the internet. Nothing is hosted anywhere else.

**Why:** privacy and no hosting. The owner keeps every artifact, version, comment and account on
their own disk, and still gets the whole product.

**Requirement:** absolutely the same functionality as the hosted and self-hosted
deployments. That means external sharing with people who have no Plinth or AI account, real
links that last, sign-in, allowlists with email codes, comments and mentions, the editor, and
agents connecting over MCP, including cloud clients such as Claude.ai connectors that call the
MCP endpoint from the internet.

## Goals

- One command sets up a local instance with its tunnel, DNS and config. A second command
  starts it.
- The security model in AGENTS.md is untouched: a separate content domain, one subdomain per
  artifact, the CSP, no app cookies on the content host, and the signed content tokens. The local
  instance runs with `ENVIRONMENT=production` and passes every production config check.
- Links you share stay the same across restarts and reboots.
- Both existing modes work: multi-user and single-user.
- Upgrading means pull, build, migrate, restart. Data survives upgrades.

## Non-goals

- Uptime while the machine sleeps or is offline. Links work only while the machine is awake,
  online and running Plinth. The docs say so up front.
- A Plinth-managed background service. The docs give launchd and systemd templates for starting
  at login, but the scripts don't install them.
- Windows support in the scripts. macOS and Linux only. Windows users can follow the manual steps.
- Moving data between a local instance and a Workers deployment.

## Anti-goals (failure even if it works)

- Any weakening of artifact isolation, such as path-based content serving
  (`STAGING_CONTENT_FALLBACK`), shared origins, or a relaxed CSP, to make a tunnel fit.
- A local listener reachable from the LAN. The Worker binds to `127.0.0.1` only. The tunnel is
  the only way in.
- A new code path in the Worker just for local mode. The Worker must not know or care that it
  runs locally. Differences belong in config, scripts and docs.
- Secrets in the repo, in command lines, or in logs. That includes the tunnel credentials file.

## Constraints

- **Two domains on a Cloudflare account**, the same requirement as self-hosting today. The app
  host is any hostname on the first zone (e.g. `plinth.example.com`). The content host must be
  the apex of the second zone (e.g. `example-content.net`), with artifacts at
  `<id>.example-content.net`. Cloudflare's free Universal SSL covers the apex plus one level of
  wildcard only, so `*.content.example.net` would get no certificate.
- **Cloudflare sees traffic in transit.** TLS ends at Cloudflare's edge, and the tunnel carries
  traffic to the machine from there. Files are stored only on the machine, but Cloudflare can
  read pages as it serves them. The maintainer accepted this. The docs state it plainly.
- **Email.** Outsiders on an allowlist confirm their address with a code. That needs SendGrid or
  Resend, as in self-hosting. `console` is allowed only in single-user mode, as production rules
  already say, and then only the owner can sign in and allowlisted viewers can't get codes. The
  setup script warns about this.
- **The other v1 work is in flight.** The v1-build orchestrator session is changing
  `scripts/setup.mjs`, `config.ts`, `docs/self-hosting.md`, `docs/spec.md`, `docs/security.md`,
  `docs/deploy-checklist.md` and `DECISIONS.md`. That covers the new `CONTENT_ISOLATION=origin|opaque`
  var and setup flag, and `__Host-` cookies on https. Build this in a worktree off `v1-build`, start
  only once that session says its merges are in, and rebase onto them.
- **Isolation mode.** Tunnel mode defaults to `CONTENT_ISOLATION=origin` on two domains, which is
  the full model. `--content-isolation opaque` passes through to the existing setup logic. The
  guide notes that a single-zone layout (`<id>.content.example.com`) needs a certificate beyond
  free Universal SSL, such as Advanced Certificate Manager, so two cheap domains are usually
  cheaper. That pass-through and its docs are Claude's call.

## Approaches considered

| Approach | Trade-off | Outcome |
| --- | --- | --- |
| **A. Named Cloudflare Tunnel on two owned domains** | Keeps per-artifact subdomains, through a wildcard route, so all security rules hold. Links never change. Needs a free Cloudflare account, two domains (about $10–15 each per year), and `cloudflared`. Cloudflare decrypts traffic at the edge | **Chosen** |
| B. Quick tunnel (trycloudflare), Tailscale Funnel, or free ngrok | No domain and no account. But at most one hostname, so every artifact would share one origin and could read the others' data. Quick-tunnel URLs change on every restart, which breaks shared links | Dropped: fails "same functionality" and the isolation rule |
| C. Tailscale Funnel alone | End-to-end TLS to the machine. But it has B's single-hostname problem, so artifact isolation would need redesigning for every deployment | Dropped: too big, and it weakens the shared security model |

## Design

### Shape

```
internet ──► Cloudflare edge (TLS, *.content wildcard, app host)
                │  named tunnel
                ▼
        cloudflared (on the machine)
                │  http://127.0.0.1:<port>, original Host header kept
                ▼
        Plinth Worker under the local workers runtime
        (ENVIRONMENT=production, real APP_HOST / CONTENT_HOST)
                │
        D1 + R2 persisted to ~/.plinth/<instance>/state
```

### Decided

- **Tunnel:** one named Cloudflare Tunnel per instance, with ingress rules for `APP_HOST`,
  `CONTENT_HOST` and `*.CONTENT_HOST`, all pointing at `http://127.0.0.1:<port>`, plus a final
  `http_status:404` catch-all. DNS: proxied CNAMEs for the app host, the content apex and
  `*` on the content zone, pointing at `<tunnel-id>.cfargotunnel.com`.
- **Config:** the Worker uses its normal vars, set to production values: `ENVIRONMENT=production`,
  `PUBLIC_SCHEME=https`, real hosts, `DEV_*` flags off, and `STAGING_CONTENT_FALLBACK` off.
  Secrets go in the instance's local secrets file (the `.dev.vars` mechanism), never in the repo.
- **Setup:** a new mode in `scripts/setup.mjs`, `--tunnel`, reusing the existing `--local`
  plumbing for secrets, persisted D1 and R2, and migrations. It takes `--app-host`,
  `--content-host`, `--email-provider`, `--single-user`, `--admin-email` and `--name` (the
  instance name, default `plinth`). It creates the tunnel and DNS routes with `cloudflared`, and
  writes the Worker config, the secrets file and the `cloudflared` config into the instance
  directory. Safe to run again, as today.
- **Start:** a new script, `pnpm local:start [--name <instance>]`, builds the web app if needed,
  applies pending migrations to the persisted D1, starts the Worker bound to `127.0.0.1`, and
  starts `cloudflared`. It stops both on Ctrl-C, and if either exits, it stops the other and exits
  non-zero.
- **Data location:** `~/.plinth/<instance>/` holds `state/` (D1 and R2), the Worker config, the
  secrets file (mode 0600), `cloudflared.yml` and the tunnel credentials JSON (mode 0600). All of
  it is outside the repo.
- **Docs:** a new guide, `docs/local-hosting.md`. It covers what you need, setup, start, starting
  at login (launchd and systemd templates), backups (stop, then copy `state/`), upgrades, the
  trust note about Cloudflare, and troubleshooting. Link it from `docs/self-hosting.md` and the
  README. Update `docs/spec.md` (open source and hosting model, Users table) in the same commit,
  and add rows to `DECISIONS.md`.

### Left to the builder (verify, then decide)

- **Which local runtime.** `wrangler dev --local --persist-to` with the built assets, or
  Miniflare driven by a small Node script. Either is fine if it binds to `127.0.0.1`, persists
  state, serves the built `apps/web/dist`, and stays up for days. Pick one and record it in
  DECISIONS.md.
- **Client IP.** Per-IP rate limits read `cf-connecting-ip`. Check that the Cloudflare edge's
  value reaches the Worker under the local runtime, and isn't overwritten with `127.0.0.1` or
  dropped. If it's overwritten, every visitor shares one rate-limit bucket. Find a fix that keeps
  the Worker unaware of local mode, or flag it for review.
- **Host header (confirmed by the v1-build session at 4ac781e).** `index.ts` routes by
  `new URL(request.url).host`, so `cloudflared` must keep the original Host header. That's its
  default. The generated config must never set `httpHostHeader` or `originServerName`.
- **Scheme and origin (confirmed at 4ac781e).** The `Secure` flag (`lib/cookies.ts` `secureFlag`),
  the CSRF `Origin` check, redirects, links and OAuth metadata all come from `PUBLIC_SCHEME` and
  the configured hosts, never from `request.url`'s scheme. So `http://127.0.0.1` from
  `cloudflared` works with `PUBLIC_SCHEME=https`. Still verify `secureFlag`'s localhost special
  case, and that `__Host-` cookies (from the opaque-isolation branch) key off `PUBLIC_SCHEME` too.
- **Startup config check.** Check that the production config checks in `config.ts` run and pass
  under the local runtime.
- **Two zones in `cloudflared`.** One `cloudflared tunnel login` certificate covers a single zone.
  Creating DNS routes in both zones needs a second login or a scoped Cloudflare API token. Pick
  the simpler flow and document it.
- **Client IP.** Per-IP rate limits are skipped when `cf-connecting-ip` is absent (see
  DECISIONS.md). If the local runtime drops the header, password and email-code limits fall back
  to per-email only. Treat that as a bug to fix or flag, not as acceptable.

### Tests (Claude's call)

- A script-level test for the generated `cloudflared.yml` and Worker config.
- A smoke run with no real tunnel, sending requests straight to `127.0.0.1` with production
  `Host` headers, in **single-user mode** with `EMAIL_PROVIDER=console`. It covers owner login
  (code read from the Worker log), publish over MCP with `ADMIN_TOKEN`, viewing on a content
  subdomain, and an allowlist viewer code. No real Cloudflare credentials in CI.
- Multi-user mode gets a boot check only: config passes and the sign-in page renders. Its flows
  are already covered by the existing Vitest and Playwright suites, and since the Worker has no
  local-mode path there's nothing new to test there. No email-provider override is added to the
  Worker for this.
