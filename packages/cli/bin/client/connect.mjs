// What `plinth connect` prints for Claude Code. Kept apart from bin/plinth.mjs so a test can check
// it without a built runtime: `reg` is runtime/harnesses.mjs (packages/shared/src/harnesses.ts).

const indent = (text, by = "  ") => text.replace(/^/gm, by);

/**
 * The Claude Code block: the plugin first (the server plus Plinth's rules), then the bare server as
 * the tools-only alternative. The plugin's server is ${PLINTH_URL:-<hosted origin>}/mcp, so for any
 * other instance the PLINTH_URL line sits with the plugin commands, before the alternative.
 */
export function claudeCodeConnectText(reg, appOrigin) {
  const lines = [
    "  The Plinth plugin (recommended): the server and Plinth's rules in one step.",
    indent(reg.claudeCodePluginCommands().join("\n"), "    "),
  ];
  if (appOrigin !== reg.HOSTED_ORIGIN) {
    lines.push(
      `    The plugin's server points at ${new URL(reg.HOSTED_ORIGIN).host} unless PLINTH_URL is set.`,
      "    For this instance, start Claude Code with:",
      `      export PLINTH_URL=${appOrigin}`,
    );
  }
  lines.push(
    "  Or tools only, without Plinth's rules. Use one or the other: both give two servers",
    "  (plinth and plugin:plinth:plinth) and two connections.",
    indent(reg.claudeCodeCommand(`${appOrigin}/mcp`), "    "),
  );
  return lines.join("\n");
}
