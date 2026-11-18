// The harness registry: every agent environment Plinth supports, how it connects to an instance,
// and how it receives "the Plinth way" (docs/superpowers/specs/2026-11-14-agent-experience-
// design.md). One source for the web app's Connect panel, the CLI's `plinth connect`, the generated
// plugins, extension and rule files (scripts/integrations.mjs), and the table in docs/agents.md.
// No imports and plain TypeScript, so Node loads it directly (type stripping) in the scripts.

// Globals present in browsers, Workers and Node; the shared package compiles without DOM or Node
// types, so declare the little this file uses. `declare` is erased at runtime.
declare function btoa(data: string): string;
declare class URL {
  constructor(input: string, base?: string);
  readonly origin: string;
  readonly hostname: string;
  readonly pathname: string;
}

/** The server name every command and install link registers. */
export const SERVER_NAME = "plinth";

/** The hosted instance the plugins and extension point at by default. */
export const HOSTED_ORIGIN = "https://plinth.aconite.io";

/** The GitHub repository that is also the plugin marketplace. */
export const MARKETPLACE_REPO = "mr0b0t0/plinth";
/** The source repository (also the docs and the issue tracker). */
export const REPO_URL = `https://github.com/${MARKETPLACE_REPO}`;
const RAW_URL = `https://raw.githubusercontent.com/${MARKETPLACE_REPO}/main`;

/** The skill every harness gets, in whatever form it takes guidance. */
export const SKILL_NAME = "plinth-artifacts";
export const SKILL_SOURCE = `integrations/skill/${SKILL_NAME}/SKILL.md`;

/** Plugin metadata, shared by the Claude Code and portable (Codex, ChatGPT) manifests. */
export const PLUGIN = {
  name: "plinth",
  version: "0.12.0",
  /**
   * SHA-256 of the sources the plugin ships (the skill and the mention watcher; see
   * scripts/plugin-sources.mjs), and the `version` it was recorded under. When they change, bump
   * `version` (one minor above main, so installed plugins update), then run `pnpm integrations`,
   * which records both here; it refuses while `version` still equals `skillHashVersion`.
   */
  skillHash: "2df407fb2447c10bbe56fc04440c683284026536e74c792be27cfb8ee0763842",
  skillHashVersion: "0.12.0",
  description:
    "Publish, update and share HTML artifacts and Markdown documents on Plinth: the Plinth MCP server plus a skill with its publishing rules",
  author: { name: "Aconite Software & Investments, Lda.", url: "https://aconite.io" },
  homepage: `${REPO_URL}/blob/main/docs/agents.md`,
  repository: REPO_URL,
  license: "MIT",
  keywords: ["artifacts", "html", "publishing", "sharing", "mcp"],
  privacyPolicyUrl: `${HOSTED_ORIGIN}/legal/privacy`,
} as const;

export type ConnectClient =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "codex"
  | "t3code"
  | "gemini-cli"
  | "cursor"
  | "vscode"
  | "other";

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";

/** Claude Code: add the server for every project, then sign in. */
export function claudeCodeCommand(endpoint: string): string {
  return [
    `claude mcp add --transport http --scope user ${SERVER_NAME} ${endpoint}`,
    `claude mcp login ${SERVER_NAME}`,
  ].join("\n");
}

/** Claude Code: install the Plinth plugin (the MCP server plus the plinth-artifacts skill). */
export function claudeCodePluginCommands(): string[] {
  return [
    `claude plugin marketplace add ${MARKETPLACE_REPO}`,
    `claude plugin install ${PLUGIN.name}@${PLUGIN.name}`,
  ];
}

/**
 * The same install inside a Claude Code session. The two-step form works in every Claude Code
 * version with plugins (code.claude.com/docs/en/discover-plugins); the one-step
 * `/plugin install <name> --marketplace <repo>` needs v2.1.275 or later.
 */
export function claudeCodePluginSlashCommands(): string[] {
  return [
    `/plugin marketplace add ${MARKETPLACE_REPO}`,
    `/plugin install ${PLUGIN.name}@${PLUGIN.name}`,
  ];
}

/** The MCP server name Claude Code gives the plugin's server, as `/mcp` lists it. */
export const CLAUDE_CODE_PLUGIN_SERVER = `plugin:${PLUGIN.name}:${SERVER_NAME}`;

/** What the bare `claude mcp add` gives, next to the plugin. */
export const CLAUDE_CODE_TOOLS_ONLY = "tools only, without Plinth's rules";

/** Said wherever both Claude Code options appear. */
export const CLAUDE_CODE_ONE_OR_THE_OTHER = `Use one or the other: doing both gives Claude Code two Plinth servers (${SERVER_NAME} and ${CLAUDE_CODE_PLUGIN_SERVER}) and two connections.`;

/** Codex CLI: add the server, then sign in. */
export function codexCommand(endpoint: string): string {
  return [`codex mcp add ${SERVER_NAME} --url ${endpoint}`, `codex mcp login ${SERVER_NAME}`].join(
    "\n",
  );
}

/**
 * T3 Code (t3.codes) has no MCP configuration of its own for its agents: it runs the Claude Code
 * and Codex installed on the computer with their own settings, plugins and sign-ins. Said wherever
 * T3 Code appears; checked with t3 0.1.9 on 2026-11-16.
 */
export const T3_CODE_USES_AGENTS =
  "T3 Code runs the Claude Code and Codex on your computer with their own settings, so it uses Plinth wherever they do: set Plinth up in each one you pick in T3 Code and sign in there once.";

/** Codex: install the Plinth plugin (the skill, plus a server for the hosted instance). */
export function codexPluginCommands(): string[] {
  return [
    `codex plugin marketplace add ${MARKETPLACE_REPO}`,
    `codex plugin add ${PLUGIN.name}@${PLUGIN.name}`,
  ];
}

/** Gemini CLI: add the server; it signs in the first time it is used (or with /mcp auth). */
export function geminiCommand(endpoint: string): string {
  return `gemini mcp add --transport http ${SERVER_NAME} ${endpoint}`;
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

/** How a harness receives the Plinth way beyond what the MCP server itself says. */
export type GuidanceKind = "plugin" | "extension" | "rule-file" | "skill-upload" | "server-only";

export interface Guidance {
  kind: GuidanceKind;
  /** One sentence: what to do. */
  summary: string;
  /** Commands to run, if any. */
  commands?: string;
  /** A file or page to open, if any. */
  link?: { label: string; href: string };
  /** Shown when the instance is not the hosted one. */
  ownInstance?: string;
}

export interface Harness {
  id: ConnectClient;
  label: string;
  /** Can it connect to an instance on this computer? Hosted chat apps cannot. */
  reachesLocal: boolean;
  /** Has its own artifact or page feature (the skill says when to use Plinth instead). */
  nativeArtifacts: string | null;
  /** Whether the guidance package was installed and checked against the real harness. */
  verified: boolean;
  guidance: Guidance;
}

const skillOnGithub = `${REPO_URL}/tree/main/integrations/skill/${SKILL_NAME}`;

export const HARNESSES: readonly Harness[] = [
  {
    id: "claude",
    label: "Claude",
    reachesLocal: false,
    nativeArtifacts: "Claude artifacts",
    verified: false,
    guidance: {
      kind: "skill-upload",
      summary:
        "The connector carries the core rules. For the full ones, upload the plinth-artifacts skill folder as a custom skill in Claude's skills settings.",
      link: { label: "The skill on GitHub", href: skillOnGithub },
    },
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    reachesLocal: false,
    nativeArtifacts: "ChatGPT Sites",
    verified: false,
    guidance: {
      kind: "server-only",
      summary:
        "The connection carries the core rules. The Plinth plugin (integrations/plugin) uses the portable format ChatGPT reads, for when it is listed.",
    },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    reachesLocal: true,
    nativeArtifacts: "Claude artifacts",
    verified: true,
    guidance: {
      kind: "plugin",
      summary:
        "Install the Plinth plugin: the server and the skill in one step. A bare claude mcp add gives the tools only, without Plinth's rules.",
      commands: claudeCodePluginSlashCommands().join("\n"),
      ownInstance:
        "The plugin's server points at plinth.aconite.io. For this instance, set PLINTH_URL to its origin every time Claude Code starts (for example in your shell profile), or skip the plugin's server and keep the one added above.",
    },
  },
  {
    id: "codex",
    label: "Codex",
    reachesLocal: true,
    nativeArtifacts: "Codex Sites",
    verified: true,
    guidance: {
      kind: "plugin",
      summary: "Install the Plinth plugin for the skill.",
      commands: codexPluginCommands().join("\n"),
      ownInstance:
        "The plugin also adds the hosted server; for this instance keep the server added above.",
    },
  },
  {
    id: "t3code",
    label: "T3 Code",
    reachesLocal: true,
    nativeArtifacts: "T3 Code visual replies",
    verified: true,
    guidance: {
      kind: "plugin",
      summary:
        "Install the Plinth plugin in the Claude Code and Codex that T3 Code runs; their threads in T3 Code then load it.",
      commands: [...claudeCodePluginCommands(), ...codexPluginCommands()].join("\n"),
      ownInstance:
        "The plugins' servers point at plinth.aconite.io; for this instance keep the servers added above.",
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    reachesLocal: true,
    nativeArtifacts: null,
    verified: false,
    guidance: {
      kind: "extension",
      summary: "Install the Plinth extension (server and skill) from a checkout of the repository.",
      commands: `git clone ${REPO_URL}.git\ngemini extensions install ./plinth/integrations/gemini`,
      ownInstance:
        "The extension's server points at plinth.aconite.io; for this instance keep the server added above.",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    reachesLocal: true,
    nativeArtifacts: "Cursor shared canvases (your Cursor team only)",
    verified: false,
    guidance: {
      kind: "rule-file",
      summary: "Save the Plinth rule into your project's .cursor/rules/ folder.",
      link: {
        label: "plinth-artifacts.mdc",
        href: `${RAW_URL}/integrations/cursor/${SKILL_NAME}.mdc`,
      },
    },
  },
  {
    id: "vscode",
    label: "VS Code",
    reachesLocal: true,
    nativeArtifacts: null,
    verified: false,
    guidance: {
      kind: "rule-file",
      summary: "Save the Plinth instructions into your project's .github/instructions/ folder.",
      link: {
        label: "plinth-artifacts.instructions.md",
        href: `${RAW_URL}/integrations/vscode/${SKILL_NAME}.instructions.md`,
      },
    },
  },
  {
    id: "other",
    label: "Other clients",
    reachesLocal: true,
    nativeArtifacts: null,
    verified: false,
    guidance: {
      kind: "server-only",
      summary:
        "The server's instructions carry the core rules. Give your agent the skill file for the full ones.",
      link: { label: "SKILL.md", href: `${RAW_URL}/${SKILL_SOURCE}` },
    },
  },
];

/** The registry entry for one client. */
export function harness(id: ConnectClient): Harness {
  const h = HARNESSES.find((x) => x.id === id);
  if (!h) throw new Error(`unknown harness ${id}`);
  return h;
}
