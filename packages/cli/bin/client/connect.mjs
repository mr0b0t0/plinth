// What `plinth connect` prints for Claude Code. Kept apart from bin/plinth.mjs so a test can check
// it without a built runtime: `reg` is runtime/harnesses.mjs (packages/shared/src/harnesses.ts).

const indent = (text, by = "  ") => text.replace(/^/gm, by);

const ONE_OR_THE_OTHER = [
  "  Use one or the other: both give two servers (plinth and plugin:plinth:plinth) and two",
  "  connections.",
];

/**
 * The Claude Code block, in the same order as the Connect panel and /llms.txt: the plugin first
 * (the server plus Plinth's rules), then the bare server as the tools-only alternative. On any
 * instance other than the hosted one, the install sets the plugin's Plinth instance option to this
 * origin, since the plugin's server is the hosted instance's by default.
 */
export function claudeCodeConnectText(reg, appOrigin) {
  const bare = indent(reg.claudeCodeCommand(`${appOrigin}/mcp`), "    ");
  const plugin = indent(reg.claudeCodePluginCommands(appOrigin).join("\n"), "    ");
  const lines =
    appOrigin === reg.HOSTED_ORIGIN
      ? ["  The Plinth plugin (recommended): the server and Plinth's rules in one step.", plugin]
      : [
          "  The Plinth plugin (recommended), set to this instance: the server and Plinth's rules.",
          plugin,
          "  Already installed? The same commands point it here (or run",
          `  ${reg.CLAUDE_CODE_PLUGIN_CONFIGURE} in Claude Code). Restart Claude Code afterwards.`,
        ];
  return [...lines, "  Or tools only, without Plinth's rules:", bare, ...ONE_OR_THE_OTHER].join(
    "\n",
  );
}
