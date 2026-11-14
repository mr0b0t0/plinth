// What the Connect panel shows for each MCP client: the commands, install links and config, all
// built from this instance's real MCP endpoint. Formats were checked against each product's docs
// in 2026-11 (sources in docs/mcp.md). Every client signs in with OAuth; no token is involved.

export type ConnectClient =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "codex"
  | "cursor"
  | "vscode"
  | "other";

export const CONNECT_CLIENTS: { id: ConnectClient; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other clients" },
];

/** The server name the commands and install links register. */
export const SERVER_NAME = "plinth";

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";

/** Claude Code: add the server for every project, then sign in. */
export function claudeCodeCommand(endpoint: string): string {
  return [
    `claude mcp add --transport http --scope user ${SERVER_NAME} ${endpoint}`,
    `claude mcp login ${SERVER_NAME}`,
  ].join("\n");
}

/** Codex CLI: add the server, then sign in. */
export function codexCommand(endpoint: string): string {
  return [`codex mcp add ${SERVER_NAME} --url ${endpoint}`, `codex mcp login ${SERVER_NAME}`].join(
    "\n",
  );
}

/**
 * Cursor's MCP install deeplink: `name` plus `config`, the base64 of the JSON server entry
 * (cursor.com/docs/context/mcp/install-links).
 */
export function cursorInstallLink(endpoint: string): string {
  // btoa takes ASCII, and a parsed URL is ASCII.
  const config = btoa(JSON.stringify({ url: endpoint }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

/** `~/.cursor/mcp.json` for setting Cursor up by hand. */
export function cursorConfigJson(endpoint: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { url: endpoint } } }, null, 2);
}

/**
 * VS Code's MCP install link: `vscode:mcp/install?` and the URL-encoded JSON server entry with its
 * name (code.visualstudio.com/api/extension-guides/ai/mcp), wrapped in the https
 * vscode.dev/redirect form those docs recommend for web pages.
 */
export function vscodeInstallLink(endpoint: string): string {
  const entry = { name: SERVER_NAME, type: "http", url: endpoint };
  const app = `vscode:mcp/install?${encodeURIComponent(JSON.stringify(entry))}`;
  return `https://vscode.dev/redirect?url=${encodeURIComponent(app)}`;
}

/** `.vscode/mcp.json` (or the user configuration) for setting VS Code up by hand. */
export function vscodeConfigJson(endpoint: string): string {
  return JSON.stringify({ servers: { [SERVER_NAME]: { type: "http", url: endpoint } } }, null, 2);
}

/** Where MCP clients discover the OAuth endpoints (RFC 9728). */
export function protectedResourceUrl(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "/.well-known/oauth-protected-resource/mcp";
  }
}

/** True for an instance on this computer, which hosted clients (Claude, ChatGPT) cannot reach. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * The tab to open first. A browser cannot tell which agent someone uses, so this only picks up
 * the editors' own browsers; everyone else starts on Claude.
 */
export function guessConnectClient(userAgent: string | null | undefined): ConnectClient {
  const ua = userAgent ?? "";
  if (/\bCursor\//.test(ua)) return "cursor";
  if (/\bCode\/\d/.test(ua) && /\bElectron\//.test(ua)) return "vscode";
  return "claude";
}

/** A first request to try once connected. Chat apps have a conversation; coding agents a project. */
export function firstPrompt(client: ConnectClient): string {
  return client === "claude" || client === "chatgpt"
    ? "Make a one-page HTML summary of this conversation and publish it to Plinth."
    : "Publish a one-page HTML summary of this project to Plinth.";
}
