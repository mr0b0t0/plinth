# Mention wake-ups: design notes (2026-11-25)

The rules are in [docs/spec.md "Mention wake-ups"](../../spec.md#mention-wake-ups-decided-2026-11-25).
This note keeps the reasoning, what each client allows, and how each path was checked.

## The problem

A comment that mentions an agent (`@claude`, `@codex`, `@agent:other`) creates a mention task.
Before this change only Claude Code reacted on its own, through a plugin monitor that needed a
separate sign-in, woke whichever session saw the task first, and ran only in the interactive CLI.
Every other client waited for the person to say "check my mentions". Claude's own artifacts work
the other way: publishing makes the publishing session watch its comments. The goal was that
model, with no subscribe step, in as many clients as allow it.

## What each client allows (verified 2026-11-25)

Nothing in core MCP lets a server start a turn. Revision 2026-07-28 removed `resources/subscribe`
and the GET stream, and no client starts a turn on a notification. Three mechanisms remain:

1. **MCP tasks** (the tasks extension). A tool call returns a task; the client polls `tasks/get`;
   when the task completes, an idle Claude Code session starts a turn on the result. The server can't
   start a turn, but it can finish work the agent started, so the agent starts a wait right after it
   publishes.
2. **Client hooks plus a local process.** Hooks tell a process on the computer which session
   published which artifact; the process wakes the session through the client's own door.
3. **MCP Events** (SEP-3415, and the sketch ChatGPT implements): the client subscribes once with a
   callback; the server POSTs signed webhooks; ChatGPT starts work in the subscribed chat.

| Client | How a request reaches the session | Wakes an idle session? | Checked how |
| --- | --- | --- | --- |
| Claude Code CLI (interactive, v2.1.304+) | MCP task from `watch_mentions` | Yes | Real TUI against a local instance: publish, watch, comment, woke in ~25 s, claimed, v2, replied, re-armed |
| Claude Agent SDK / `claude -p --input-format stream-json` with `CLAUDE_AUTO_BACKGROUND_TASKS=1` | MCP task | Yes | Real stream-json session: woke ~15 s after the comment, handled it |
| Same without that variable (T3 Code's Claude threads) | Relay: plugin hooks, `t3 thread send` | Yes | Claude Code does not declare tasks there (no hint, no block); relay round and `t3 thread send` covered by tests; T3 wake checked on production |
| VS Code, Claude Desktop local sessions (v2.1.331+, HTTP server) | MCP task | Yes, per Anthropic's docs | Same server path as the CLI |
| claude.ai chats, Claude Code cloud sessions | MCP task (claude.ai connector) | Yes on paid plans, per Anthropic's docs | Same server path; not driven from here |
| Codex CLI / app / IDE | Relay: `codex queue --thread <id>` | Yes for a loaded thread; an unloaded one runs it when opened | Real Codex TUI against a local instance: woke ~30 s after the comment, published v2, replied. Plugin hooks load from `.codex-plugin` (checked with `hooks/list`) |
| Copilot CLI | Relay: handed over at session start or `agentStop` | No (at turn boundaries) | Real Copilot CLI with the plugin: hooks fire with session ids; a resumed session handled a waiting request (v2, reply) |
| Cursor | Relay: `sessionStart` context, `stop` → `followup_message` | No (at turn boundaries) | Hook formats from Cursor's docs and app bundle; parsing and output under test. The installed `cursor-agent` predates hooks |
| Gemini CLI | Relay: `SessionStart`, `AfterAgent` block | No (at turn boundaries) | From Gemini CLI's source and docs; not installed here |
| Antigravity CLI | None yet | No | Its plugin format can't add context after a tool; requests wait in `list_mentions` |
| ChatGPT (Work chats, dots) | MCP Events webhook (`mention.created`) | Yes, in the subscribed chat | Signed delivery, both dialects, verification, retries under test; production delivery checked with a public callback |

## Choices worth remembering

- **Ids only in every wake-up.** Relay messages arrive as the user's own prompt in Codex, T3 Code,
  Cursor and Copilot. Carrying the comment text there would give a collaborator the user's voice.
  The agent reads the request through `claim_mention`, marked untrusted. This also keeps the
  ChatGPT event payload smaller than OpenAI's own example.
- **One routing rule for all paths**, decided lazily on poll. Workers have no background loop, and
  a conditional UPDATE makes each offer exclusive. The cost is that delivery waits for the next
  poll (15 seconds).
- **A new scope rather than reusing `mentions`.** One approval per computer covers every client
  there, and a leaked relay token reads ids only.
- **Browser approval, not a pairing code through the model.** A code the agent approves over its
  own MCP connection would be zero-click, but a comment could plant an attacker's code.
- **`t3 thread send`, not Claude Code's messaging socket.** T3 runs Claude threads in bypass
  mode, where the socket holds outside messages; the socket also trusts a self-declared
  `from-mode` wrapper, which nothing here may rely on.
- **Codex gets its own plugin folder.** Codex 0.172 loads no hooks from a plugin whose root
  `plugin.json` is an Agent Plugins manifest, even with a `.codex-plugin` overlay; it does from a
  `.codex-plugin` manifest. Copilot reads plugin hooks from `com.github.copilot/hooks/hooks.json`
  in the shared folder, Cursor from the Cursor plugin's `hooks/hooks.json`, Gemini from the
  extension's `hooks/hooks.json`.
- **A minute cron only for webhook retries.** SEP-3415 asks for 3 to 5 attempts within 10 to 15
  minutes; the hourly cron could not.

## Sources

- Claude Code docs: MCP tasks and automatic backgrounding (code.claude.com/docs/en/mcp), hooks,
  plugins, cross-session messaging, artifacts.
- MCP Tasks extension spec (modelcontextprotocol.github.io/ext-tasks, revision 2026-07-28).
- SEP-3415 (events extension) and the ext-events design sketch; OpenAI's "MCP Events" guide.
- Codex 0.172.0 source (`codex-rs/core-plugins`), hooks and CLI docs; Copilot CLI plugin
  reference; Cursor hooks and plugins reference; Gemini CLI extension source.
