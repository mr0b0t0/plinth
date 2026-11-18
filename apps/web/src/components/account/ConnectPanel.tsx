// "Connect an agent": one tab per MCP client with the shortest path to an OAuth connection, built
// from this instance's MCP endpoint. When a new connection appears (the page polls while this is
// open), it says so and offers a first prompt to try. No tokens here; those live under Advanced.
import { ArrowSquareOutIcon, CheckCircleIcon } from "@phosphor-icons/react";
import {
  CLAUDE_CODE_ONE_OR_THE_OTHER,
  CLAUDE_CODE_PLUGIN_CONFIGURE,
  CLAUDE_CODE_PLUGIN_SERVER,
  CLAUDE_CODE_TOOLS_ONLY,
  type ConnectionInfo,
  claudeCodePluginCommands,
  claudeCodePluginSlashCommands,
  HOSTED_ORIGIN,
  harness,
  T3_CODE_USES_AGENTS,
} from "@plinth/shared";
import { type ReactNode, type Ref, useState } from "react";
import { Button, buttonClassName, ICON_SIZE, Tabs } from "../ui/index.ts";
import { CopyBlock, CopyField } from "./CopyField.tsx";
import {
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  CONNECT_CLIENTS,
  type ConnectClient,
  claudeCodeCommand,
  codexCommand,
  cursorConfigJson,
  cursorInstallLink,
  firstPrompt,
  geminiCommand,
  guessConnectClient,
  isLocalEndpoint,
  protectedResourceUrl,
  vscodeConfigJson,
  vscodeInstallLink,
} from "./connectClients.ts";
import { Note } from "./Note.tsx";

const STORAGE_KEY = "plinth-connect-client";

/** A two-letter mark and a quiet hint for each client in the list. */
const CLIENT_LOOK: Record<ConnectClient, { mark: string; hint: string }> = {
  claude: { mark: "C", hint: "web, desktop" },
  chatgpt: { mark: "G", hint: "web" },
  "claude-code": { mark: "CC", hint: "terminal" },
  codex: { mark: "Cx", hint: "terminal" },
  t3code: { mark: "T3", hint: "desktop, web" },
  "gemini-cli": { mark: "Ge", hint: "terminal" },
  cursor: { mark: "Cu", hint: "1 click" },
  vscode: { mark: "VS", hint: "1 click" },
  other: { mark: "…", hint: "" },
};

function initialClient(): ConnectClient {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && CONNECT_CLIENTS.some((c) => c.id === saved)) return saved as ConnectClient;
  } catch {
    // storage blocked: fall back to the guess
  }
  return guessConnectClient(typeof navigator === "undefined" ? "" : navigator.userAgent);
}

function rememberClient(id: ConnectClient) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // a convenience only
  }
}

/** A link to another site styled as a button; opens in a new tab. */
function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClassName({ variant: "secondary" })}
    >
      <span className="pl-button__content">
        <span>
          {children}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </span>
        <ArrowSquareOutIcon size={ICON_SIZE.sm} aria-hidden="true" />
      </span>
    </a>
  );
}

function UrlField({ endpoint }: { endpoint: string }) {
  return (
    <CopyField
      label="MCP server URL"
      value={endpoint}
      copyLabel="Copy MCP server URL"
      copiedMessage="MCP server URL copied"
    />
  );
}

function HostedOnlyNote({ endpoint, app }: { endpoint: string; app: string }) {
  if (!isLocalEndpoint(endpoint)) return null;
  return (
    <Note>
      {app} connects from its own servers, so it cannot reach this instance on your computer. Use
      Claude Code, Codex, Cursor or VS Code instead.
    </Note>
  );
}

/** The endpoint's origin; the hosted one when it does not parse, which keeps the hosted wording. */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return HOSTED_ORIGIN;
  }
}

const ALLOW = (
  <>
    then click <strong>Allow</strong> on the Plinth page that opens
  </>
);

/**
 * Claude Code: the plugin (server and rules) first, then the bare server (tools only). On an
 * instance other than the hosted one, the install also sets the plugin's Plinth instance option to
 * this origin (the plugin's server is otherwise the hosted instance's).
 */
function ClaudeCodeSteps({ endpoint }: { endpoint: string }) {
  const origin = originOf(endpoint);
  const hosted = origin === HOSTED_ORIGIN;
  const [addMarketplace, install] = claudeCodePluginSlashCommands();
  const pluginSignIn = (
    <>
      Then run <code>/mcp</code> in Claude Code, choose <code>{CLAUDE_CODE_PLUGIN_SERVER}</code> and
      sign in, {ALLOW}.
    </>
  );
  const bareSignIn = (
    <>
      <code>claude mcp login</code> opens Plinth in your browser; click <strong>Allow</strong>.
    </>
  );
  return (
    <div className="pl-acct-howto__item">
      <p>
        {hosted
          ? "Install the Plinth plugin: the server and Plinth's publishing rules in one step."
          : "Install the Plinth plugin, set to this instance: the server and Plinth's publishing rules in one step."}
      </p>
      <CopyBlock
        label="Run in a terminal"
        value={claudeCodePluginCommands(origin).join("\n")}
        copyLabel="Copy plugin commands"
        copiedMessage="Commands copied"
      />
      <p>
        Or inside Claude Code: <code>{addMarketplace}</code>, then <code>{install}</code>
        {hosted ? (
          "."
        ) : (
          <>
            , and enter <code>{origin}</code> when it asks for the Plinth instance.
          </>
        )}{" "}
        {pluginSignIn}
      </p>
      {!hosted && (
        <p className="type-small text-muted">
          Already have the plugin? The terminal commands above point it at this instance, or run{" "}
          <code>{CLAUDE_CODE_PLUGIN_CONFIGURE}</code> in Claude Code. Restart Claude Code
          afterwards.
        </p>
      )}
      <CopyBlock
        label={`Or, ${CLAUDE_CODE_TOOLS_ONLY}`}
        value={claudeCodeCommand(endpoint)}
        copyLabel="Copy tools-only commands"
        copiedMessage="Commands copied"
      />
      <p className="type-small text-muted">
        {bareSignIn} {CLAUDE_CODE_ONE_OR_THE_OTHER}
      </p>
    </div>
  );
}

function CodexSteps({ endpoint }: { endpoint: string }) {
  return (
    <div className="pl-acct-howto__item">
      <CopyBlock
        label="Run in a terminal"
        value={codexCommand(endpoint)}
        copyLabel="Copy Codex commands"
        copiedMessage="Commands copied"
      />
      <p>
        <code>codex mcp login</code> opens Plinth in your browser; click <strong>Allow</strong>.
      </p>
    </div>
  );
}

/**
 * T3 Code has no MCP settings of its own for its agents: it runs Claude Code and Codex with their
 * own configuration, so its tab is theirs, with Codex's plugin step (Claude Code's steps already
 * carry the plugin).
 */
function T3CodeSteps({ endpoint }: { endpoint: string }) {
  return (
    <>
      <div className="pl-acct-howto__item">
        <p>{T3_CODE_USES_AGENTS}</p>
      </div>
      <section className="pl-acct-howto__section" aria-labelledby="t3-claude">
        <h3 id="t3-claude" className="pl-acct-howto__heading">
          Claude in T3 Code
        </h3>
        <ClaudeCodeSteps endpoint={endpoint} />
        {originOf(endpoint) !== HOSTED_ORIGIN && (
          <p className="type-small text-muted">
            The plugin keeps its Plinth instance in Claude Code's settings, so the Claude that T3
            Code runs uses it too, as long as it runs with the same Claude Code profile.
          </p>
        )}
      </section>
      <section className="pl-acct-howto__section" aria-labelledby="t3-codex">
        <h3 id="t3-codex" className="pl-acct-howto__heading">
          Codex in T3 Code
        </h3>
        <CodexSteps endpoint={endpoint} />
        <Guidance client="codex" endpoint={endpoint} />
      </section>
    </>
  );
}

function ClientSteps({ client, endpoint }: { client: ConnectClient; endpoint: string }) {
  switch (client) {
    case "claude":
      return (
        <div className="pl-acct-howto__item">
          <HostedOnlyNote endpoint={endpoint} app="Claude" />
          <UrlField endpoint={endpoint} />
          <ol className="pl-acct-steps">
            <li>
              Open Claude's connector settings.
              <div className="pl-acct-steps__action">
                <ExternalButton href={CLAUDE_CONNECTORS_URL}>Open Claude connectors</ExternalButton>
              </div>
            </li>
            <li>
              Click <strong>+ Add</strong>, choose <strong>Add custom connector</strong>, name it
              Plinth, paste the URL and click <strong>Continue</strong>. If Claude asks which OAuth
              client to use, choose <strong>Register automatically</strong>. Then click{" "}
              <strong>Add</strong>.
            </li>
            <li>
              Click <strong>Connect</strong>, {ALLOW}.
            </li>
          </ol>
          <p className="type-small text-muted">
            Works in Claude on the web and on desktop. On Team and Enterprise plans an owner adds it
            once under Organization settings, Connectors; members then click Connect.
          </p>
        </div>
      );
    case "chatgpt":
      return (
        <div className="pl-acct-howto__item">
          <HostedOnlyNote endpoint={endpoint} app="ChatGPT" />
          <UrlField endpoint={endpoint} />
          <ol className="pl-acct-steps">
            <li>
              Open ChatGPT's plugins page.
              <div className="pl-acct-steps__action">
                <ExternalButton href={CHATGPT_PLUGINS_URL}>Open ChatGPT plugins</ExternalButton>
              </div>
            </li>
            <li>
              Click <strong>+</strong>, choose <strong>Add custom MCP server</strong>, name it
              Plinth and paste the URL as the server URL.
            </li>
            <li>
              Choose <strong>OAuth</strong> for authentication, confirm the warning and click{" "}
              <strong>Create as a plugin</strong>.
            </li>
            <li>Connect the plugin, {ALLOW}.</li>
          </ol>
          <p className="type-small text-muted">
            Custom MCP servers depend on your ChatGPT plan and workspace settings.
          </p>
        </div>
      );
    case "claude-code":
      return <ClaudeCodeSteps endpoint={endpoint} />;
    case "codex":
      return <CodexSteps endpoint={endpoint} />;
    case "t3code":
      return <T3CodeSteps endpoint={endpoint} />;
    case "gemini-cli":
      return (
        <div className="pl-acct-howto__item">
          <CopyBlock
            label="Run in a terminal"
            value={geminiCommand(endpoint)}
            copyLabel="Copy Gemini CLI command"
            copiedMessage="Command copied"
          />
          <p>
            The first time Gemini uses Plinth it opens Plinth in your browser (or run{" "}
            <code>/mcp auth plinth</code>); click <strong>Allow</strong>.
          </p>
        </div>
      );
    case "cursor":
      return (
        <div className="pl-acct-howto__item">
          <div>
            <a
              href={cursorInstallLink(endpoint)}
              className={buttonClassName({ variant: "secondary" })}
            >
              Add to Cursor
            </a>
          </div>
          <p>
            Cursor asks to install <code>plinth</code>. Sign in to it from Cursor's MCP settings,{" "}
            {ALLOW}.
          </p>
          <CopyBlock
            label={
              <>
                Or add it by hand to <code>~/.cursor/mcp.json</code>
              </>
            }
            value={cursorConfigJson(endpoint)}
            copyLabel="Copy Cursor configuration"
            copiedMessage="Configuration copied"
          />
        </div>
      );
    case "vscode":
      return (
        <div className="pl-acct-howto__item">
          <div>
            <ExternalButton href={vscodeInstallLink(endpoint)}>Add to VS Code</ExternalButton>
          </div>
          <p>
            VS Code shows the server; click <strong>Install</strong>. When it asks to sign in to{" "}
            <code>plinth</code>, allow it, {ALLOW}.
          </p>
          <CopyBlock
            label={
              <>
                Or add it by hand to <code>.vscode/mcp.json</code>
              </>
            }
            value={vscodeConfigJson(endpoint)}
            copyLabel="Copy VS Code configuration"
            copiedMessage="Configuration copied"
          />
        </div>
      );
    default:
      return (
        <div className="pl-acct-howto__item">
          <UrlField endpoint={endpoint} />
          <ul className="pl-acct-steps">
            <li>Transport: streamable HTTP.</li>
            <li>
              Sign-in: OAuth 2.1 with PKCE and dynamic client registration, discovered at{" "}
              <code>{protectedResourceUrl(endpoint)}</code>. Your client opens Plinth in the
              browser; click <strong>Allow</strong>.
            </li>
            <li>
              Clients without OAuth can use a personal access token, under Advanced on this page.
            </li>
          </ul>
        </div>
      );
  }
}

/**
 * How this client learns "the Plinth way" (the plinth-artifacts skill) beyond what the server's own
 * instructions say: a plugin, an extension, a rule file or an uploaded skill.
 */
function Guidance({ client, endpoint }: { client: ConnectClient; endpoint: string }) {
  // Claude Code's steps already install the plugin, which carries the rules; T3 Code's steps hold
  // Claude Code's and Codex's.
  if (client === "claude-code" || client === "t3code") return null;
  const g = harness(client).guidance;
  const ownInstance = originOf(endpoint) !== HOSTED_ORIGIN;
  return (
    <div className="pl-acct-howto__item pl-acct-guidance">
      <h3 className="type-small">Teach it Plinth's rules</h3>
      <p className="type-small text-muted">{g.summary}</p>
      {g.commands && (
        <CopyBlock
          label="Run"
          value={g.commands}
          copyLabel="Copy commands"
          copiedMessage="Commands copied"
        />
      )}
      {g.link && (
        <div>
          <ExternalButton href={g.link.href}>{g.link.label}</ExternalButton>
        </div>
      )}
      {ownInstance && g.ownInstance && <p className="type-small text-muted">{g.ownInstance}</p>}
    </div>
  );
}

export interface ConnectPanelProps {
  endpoint: string;
  /** A connection that appeared while the panel was open. */
  connected: ConnectionInfo | null;
  onConnectAnother: () => void;
  onHide?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

export function ConnectPanel({
  endpoint,
  connected,
  onConnectAnother,
  onHide,
  headingRef,
}: ConnectPanelProps) {
  const [client, setClient] = useState<ConnectClient>(initialClient);

  return (
    <section className="pl-acct-section pl-acct-connect" aria-labelledby="connect-agent">
      <div className="pl-acct-connect__head">
        <div className="pl-acct-section__head">
          <h2 id="connect-agent" ref={headingRef} tabIndex={-1}>
            Connect an agent
          </h2>
          <p className="text-muted">
            Use the agent you already have. It signs in to Plinth with your browser; there is no
            token to copy.
          </p>
        </div>
        {onHide && (
          <Button variant="ghost" size="sm" onClick={onHide}>
            Hide
          </Button>
        )}
      </div>

      {/* Always present, so the change to "connected" is announced. */}
      <div role="status" className="pl-acct-connect__status">
        {connected ? (
          <p className="pl-acct-connected__title">
            <CheckCircleIcon size={ICON_SIZE.sm} aria-hidden="true" />
            <span>
              <strong>{connected.label}</strong> is connected.
            </span>
          </p>
        ) : (
          <p className="pl-acct-wait">
            <span className="pl-acct-wait__pulse" aria-hidden="true" />
            <span>Waiting for your agent</span>
            <span className="pl-acct-wait__note">
              This page updates by itself when your agent connects.
            </span>
          </p>
        )}
      </div>
      {connected && (
        <div className="pl-acct-connected">
          <CopyBlock
            label="Try this first"
            value={firstPrompt(client)}
            copyLabel="Copy prompt"
            copiedMessage="Prompt copied"
          />
          <div>
            <Button variant="secondary" onClick={onConnectAnother}>
              Connect another agent
            </Button>
          </div>
        </div>
      )}

      <Tabs
        label="Agent"
        orientation="vertical"
        className="pl-acct-connect__tabs"
        value={client}
        onChange={(id) => {
          setClient(id as ConnectClient);
          rememberClient(id as ConnectClient);
        }}
        tabs={CONNECT_CLIENTS.map((c) => ({
          id: c.id,
          label: c.label,
          lead: CLIENT_LOOK[c.id].mark,
          hint: CLIENT_LOOK[c.id].hint,
          content: (
            <div className="pl-acct-howto">
              <ClientSteps client={c.id} endpoint={endpoint} />
              <Guidance client={c.id} endpoint={endpoint} />
            </div>
          ),
        }))}
      />
    </section>
  );
}
