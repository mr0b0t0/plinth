// What `plinth connect` prints for Claude Code. Kept apart from bin/plinth.mjs so a test can check
// it without a built runtime: `reg` is runtime/harnesses.mjs (packages/shared/src/harnesses.ts).

const indent = (text, by = "  ") => text.replace(/^/gm, by);

const ONE_OR_THE_OTHER = [
  "  Use one or the other: both give two servers (plinth and plugin:plinth:plinth) and two",
  "  connections.",
];

/**
 * The Claude Code block, in the same order as the Connect panel and /llms.txt. On the hosted
 * instance: the plugin first (the server plus Plinth's rules), then the bare server as the
 * tools-only alternative. On any other instance the bare server for this instance comes first,
 * because the plugin's server is ${PLINTH_URL:-<hosted origin>}/mcp: without PLINTH_URL set every
 * time Claude Code starts, the plugin signs in to a different instance.
 */
export function claudeCodeConnectText(reg, appOrigin) {
  const bare = indent(reg.claudeCodeCommand(`${appOrigin}/mcp`), "    ");
  const plugin = indent(reg.claudeCodePluginCommands().join("\n"), "    ");
  if (appOrigin === reg.HOSTED_ORIGIN) {
    return [
      "  The Plinth plugin (recommended): the server and Plinth's rules in one step.",
      plugin,
      "  Or tools only, without Plinth's rules:",
      bare,
      ...ONE_OR_THE_OTHER,
    ].join("\n");
  }
  const hostedHost = new URL(reg.HOSTED_ORIGIN).host;
  return [
    "  This instance's server (tools only, without Plinth's rules):",
    bare,
    "  Or the Plinth plugin: the server and Plinth's rules. Its server points at",
    `  ${hostedHost}, a different instance, unless PLINTH_URL is set every time Claude Code`,
    "  starts (for example in your shell profile):",
    indent(`export PLINTH_URL=${appOrigin}`, "    "),
    plugin,
    ...ONE_OR_THE_OTHER,
  ].join("\n");
}
