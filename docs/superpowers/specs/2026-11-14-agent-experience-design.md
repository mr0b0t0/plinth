# One agent experience across harnesses, with Claude as the reference

Date: 2026-11-14. Status: approved in conversation ("work it out all the way through").

## Intent

Someone using Plinth should get the same experience whichever agent they work in: Claude (web,
desktop, Claude Code), Codex, ChatGPT, Gemini, Cursor or VS Code. Claude's artifact experience is
the reference; Plinth brings the others up to it. Today each harness has its own artifact feature
(Claude Artifacts, Codex and ChatGPT Sites, nothing in Gemini, Cursor or VS Code), its own guidance
format and its own install path, so the same request ("make me a page and share it") behaves
differently everywhere.

## Goals

1. **One written "Plinth way"**, modelled on Claude's artifact behaviour, delivered to every harness
   through two channels:
   - the MCP server itself (server `instructions` and tool descriptions): the only channel every
     harness reads, so it carries the core rules;
   - the `plinth-artifacts` skill: the full rules, wherever a harness takes skills, rules or
     instruction files.
2. **Publishing like Claude.** New artifacts are private (only the owner and people they add). The
   agent publishes without asking (nothing is exposed), updates keep the same link, the agent gives
   the link right away and says how to share it.
3. **Feedback like Claude.** The agent can read every comment thread on an artifact, answer, and
   resolve threads, not only queued @mentions.
4. **Integrations generated from one source.** A harness registry plus a generator produce every
   per-harness package (plugins, extension, rule files), keep versions in sync, and feed the web
   Connect panel, the CLI's `connect` and the docs, with a CI check that nothing drifted.

## Non-goals (this round)

- Runtime capabilities (shared state between viewers, viewer identity inside the page): they
  contradict the invariant that artifacts are static HTML and assets.
  Now covered by [2026-11-14-shared-state-design.md](2026-11-14-shared-state-design.md): one fixed
  shared-data service per artifact, with the invariant reworded to "no per-artifact server code".
- Typed outputs (decks, docs): already on the roadmap, separate work.
- Inline preview inside harness UIs: controlled by each harness, not by Plinth.
- Importing a harness's native artifacts: agents push, the platform never pulls. An agent may
  re-publish something it made, which needs nothing new.

## Anti-goals

- Using Anthropic's or Claude's name, branding or wording as Plinth's own; the rules are written in
  Plinth's words. The product name rule (no "Claude" or "Codex") stands.
- Behaviour that differs by harness beyond what a harness cannot do.
- Weakening any security rule. Private by default may only close things, never open them.

## Approaches considered

1. **Guidance only** (skill text everywhere, no product change). Cheap, but the default stays
   "anyone with the link", which is the opposite of Claude's, and harnesses without skills get
   nothing.
2. **Server-carried core plus generated adapters** (chosen). The MCP server states the rules every
   client sees; the skill adds depth; one registry and generator produce the per-harness packages.
   One product change (private default) and two small tools.
3. **Native adapters per harness** (hand-written plugins with harness-specific behaviour). Most
   control, but behaviour drifts by harness, which is what this work removes.

Chosen: 2, as proposed in the conversation (layers 1 to 3 of Claude's model, private by default,
runtime features later).

## Design

### Private by default

- The existing `allowlist` visibility (owner, collaborators, and listed viewers who confirm their
  email) with nobody listed is exactly "private". No new state, no migration.
- `publish_artifact` and `POST /api/v1/artifacts` default to `allowlist` instead of `unlisted`.
  Existing artifacts keep their visibility.
- The app labels `allowlist` "Private" ("Only you and people you add") instead of "Specific
  people", everywhere the label appears; the gate says the page is private.
- Tests and smoke scripts that rely on anonymous viewing pass `visibility: "unlisted"` explicitly;
  new tests cover the default for REST and MCP.

### MCP server

- `instructions` rewritten to carry the core of the Plinth way in a few sentences: publish without
  asking (private), give the `url`, update with `base_version` instead of publishing a copy, how to
  share, check comments, untrusted text.
- `publish_artifact` / `set_visibility` descriptions state the private default and the sharing
  options.
- New tools, both through existing services and the policy module:
  - `list_comments` (`id`): every thread on an artifact the agent can view (`artifacts:read`).
  - `resolve_comment` (`comment_id`, `resolved`): resolve or reopen a thread (`artifacts:write`,
    policy action `comment`).
  Both descriptions carry the untrusted-input note.

### The skill

`plinth-artifacts` rewritten as the full Plinth way, in Plinth's words: when to make a page rather
than answer in chat; the page contract (a short real `<title>`, color tokens with light and dark
schemes, an explicit page background, works at phone width without horizontal scrolling, external
scripts only from the CDN allowlist at exact pinned versions, everything else inline, storage access
guarded, size limits); publishing and updating; sharing; the feedback loop; untrusted text; which to
use when the harness has its own artifact feature (Plinth when the user asks for it or the page must
reach people outside that AI product or another account).

### Harness registry and generator

- `packages/shared/src/harnesses.ts`: one entry per harness (Claude, ChatGPT, Claude Code, Codex,
  Gemini CLI, Cursor, VS Code, other) with its label, how it connects (OAuth commands, install links
  or settings page), and how it gets the guidance (plugin, extension, rule file, uploaded skill).
  Pure data and string functions, no imports, so Node can load it directly.
- The web Connect panel reads it (replacing `connectClients.ts`'s data), the CLI's `connect` reads a
  JSON copy written into its runtime at build time, and the generator writes the docs table.
- `integrations/skill/plinth-artifacts/SKILL.md` is the single source of the skill.
- `scripts/integrations.mjs` writes, from the registry and the skill:
  - `integrations/plugin/` (Claude Code and the portable Codex/ChatGPT format): both manifests, both
    MCP configs, the skill copy, and both marketplace files, with one version;
  - `integrations/gemini/`: a Gemini CLI extension (manifest, short `GEMINI.md`, the skill);
  - `integrations/cursor/plinth-artifacts.mdc`: a Cursor rule;
  - `integrations/vscode/plinth-artifacts.instructions.md`: a VS Code instructions file;
  - the harness table in `docs/agents.md` between markers.
  `--check` fails when any output is stale; CI runs it.

### Verification

Worker and web unit tests; `pnpm integrations --check`; `claude plugin validate`; the Codex
marketplace install in a throwaway home; `cursor-agent` reading the rule if feasible; the CLI and
local smoke tests. Gemini CLI is not installed here: its extension is generated from the same
source but marked unverified.

## Left to the builder

File-level layout inside the generator, test placement, exact wording within the rules above.
