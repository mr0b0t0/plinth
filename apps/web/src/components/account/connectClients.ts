// What the Connect panel shows for each MCP client. The commands, install links and the list of
// clients come from the shared harness registry (packages/shared/src/harnesses.ts), which also
// feeds the CLI and the generated plugins; this file adds what only the browser needs. Every
// client signs in with OAuth; no token is involved.
import { type ConnectClient, HARNESSES } from "@plinth/shared";

export {
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  type ConnectClient,
  claudeCodeCommand,
  codexCommand,
  cursorConfigJson,
  cursorInstallLink,
  geminiCommand,
  isLocalEndpoint,
  protectedResourceUrl,
  SERVER_NAME,
  vscodeConfigJson,
  vscodeInstallLink,
} from "@plinth/shared";

export const CONNECT_CLIENTS: { id: ConnectClient; label: string }[] = HARNESSES.map((h) => ({
  id: h.id,
  label: h.label,
}));

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
