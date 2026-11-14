# Distribution (maintainers)

How Plinth reaches people besides the hosted instance: the npm CLI, the agent plugin, and the
directory listings. User-facing guides: [local-hosting.md](local-hosting.md) and
[agents.md](agents.md).

## npm: `@aconite/plinth`

`packages/cli` is the package. `pnpm build` assembles `packages/cli/runtime/` (git-ignored): the
Worker bundle from `apps/worker/dist`, the web app, the migrations, and the instance scripts from
`apps/worker/scripts/` that `scripts/setup.mjs` and `scripts/local-start.mjs` use too. Its only
runtime dependencies are `wrangler` (which runs the Worker) and `tldts`.

Release:

1. Bump `version` in `packages/cli/package.json`.
2. `pnpm install && pnpm build`
3. `pnpm --filter @aconite/plinth test:smoke` (packs the package, installs the tarball with npm into
   a temporary prefix, and runs a localhost-only instance end to end).
4. `cd packages/cli && pnpm publish --access public`. Needs an npm account that owns the `aconite`
   scope (create the `aconite` organization on npmjs.com once) and two-factor authentication.

Keep the pinned `wrangler` version in `packages/cli/package.json` equal to the one in
`apps/worker/package.json`.

## Agent plugin

`integrations/plugin/` serves Claude Code (`.claude-plugin/plugin.json`, `.mcp.json`) and Codex and
ChatGPT (`plugin.json`, `mcp.json`, the portable format); both read `skills/`. Marketplaces:
`.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex), at
the repository root, so `mr0b0t0/plinth` is the marketplace address while the repository lives
there. The repository must be public for others to add the marketplace.

Release: bump the version in all four manifests together, then
`claude plugin validate ./integrations/plugin --strict` and `claude plugin validate ./`.

## Directory listings (manual, operator)

These need the operator's accounts and go out under Aconite's name, so they are not scripted:

- **Anthropic connector directory** (Claude web, desktop and mobile): submit the remote MCP server
  `https://plinth.aconite.io/mcp`. The review expects published privacy and terms pages, a support
  contact, and OAuth that works end to end. The `/legal/*` pages are still placeholders.
- **Claude Code plugin directory**: submit `integrations/plugin`. `claude plugin validate --strict`
  runs a subset of the directory's checks; the icon is `.claude-plugin/icon.png`.
- **OpenAI plugin listing** (ChatGPT and Codex): submit the plugin through OpenAI's developer
  platform. Public submission requires the remote https endpoint the plugin's `mcp.json` names.
- **npm**: published by the release steps above.
