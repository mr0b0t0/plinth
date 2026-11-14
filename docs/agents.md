# Plugins and skills for agents

Agents use Plinth through its MCP server ([mcp.md](mcp.md)). The Plinth plugin adds two things on
top: a one-step install with the server already configured, and a skill, `plinth-artifacts`, that
teaches the agent Plinth's rules: what an artifact may load, how to update without overwriting
someone else's version, how to handle mentions, and that artifact and comment text is untrusted.

The plugin lives in [`integrations/plugin/`](../integrations/plugin). One folder serves Claude Code
and Codex (and ChatGPT, which reads the same portable format). It points at the hosted instance,
`https://plinth.aconite.io/mcp`, and signs in with OAuth on first use.

## Claude Code

```sh
/plugin marketplace add mr0b0t0/plinth
/plugin install plinth@plinth
```

Or from a shell: `claude plugin marketplace add mr0b0t0/plinth`, then
`claude plugin install plinth@plinth`. Run `/mcp` and choose `plugin:plinth:plinth` to sign in. The
skill is available as `/plinth:plinth-artifacts`, and Claude also loads it on its own when you ask
it to publish or share a page.

**Your own instance.** The plugin's server URL is `${PLINTH_URL:-https://plinth.aconite.io}/mcp`.
Set `PLINTH_URL` to your instance's origin before starting Claude Code: for example
`export PLINTH_URL=https://plinth.example.com`, or `export PLINTH_URL=http://127.0.0.1:8788` for a
localhost-only instance from `npx @aconite/plinth`. Sign-in is OAuth either way. The plugin's skill
works with any instance.

## Codex

```sh
codex plugin marketplace add mr0b0t0/plinth
codex plugin add plinth@plinth
```

Codex reads the marketplace at `.agents/plugins/marketplace.json` and the plugin's portable
`plugin.json`, `mcp.json` and `skills/`. Start a new session for it to load, and sign in when Codex
asks.

For the skill alone, or a self-hosted instance, set things up by hand instead:

```sh
mkdir -p ~/.agents/skills
cp -R integrations/plugin/skills/plinth-artifacts ~/.agents/skills/   # from a checkout of this repo
codex mcp add plinth --url https://plinth.example.com/mcp
codex mcp login plinth
```

Codex reads personal skills from `~/.agents/skills` and project skills from `.agents/skills`.

## Other clients

- **Claude and ChatGPT (web and desktop)**: add Plinth as a custom connector or plugin
  ([mcp.md](mcp.md)). To give Claude the skill as well, upload the `plinth-artifacts` folder as a
  custom skill in Claude's skills settings.
- **Cursor and VS Code**: use the install links on **Connections > Connect an agent**. Both read
  `AGENTS.md`-style project instructions; copy the body of
  [`SKILL.md`](../integrations/plugin/skills/plinth-artifacts/SKILL.md) into your project's rules if
  you want the guidance there too.

## Maintaining the plugin

- The skill restates server behaviour: the default CDN allowlist, the size limits, the iframe
  sandbox, the update and mention rules. When one of those changes, update
  `integrations/plugin/skills/plinth-artifacts/SKILL.md` in the same commit.
- Bump `version` in `.claude-plugin/plugin.json`, `plugin.json` and both marketplace files together.
  Installed copies update only when the version changes.
- Check it with `claude plugin validate ./integrations/plugin --strict` and
  `claude plugin validate ./` (the marketplace).
- Submitting to Anthropic's plugin directory and OpenAI's plugin listing is a manual step for the
  operator: see [distribution.md](distribution.md).
