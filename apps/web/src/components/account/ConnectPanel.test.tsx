import type { ConnectionInfo } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectPanel } from "./ConnectPanel.tsx";
import {
  claudeCodeCommand,
  codexCommand,
  cursorConfigJson,
  cursorInstallLink,
  vscodeInstallLink,
} from "./connectClients.ts";

const ENDPOINT = "https://plinth.example/mcp";

const CONN: ConnectionInfo = {
  id: "c9",
  label: "Claude Code",
  client_type: "claude",
  kind: "oauth",
  scopes: ["artifacts:read", "artifacts:write", "mentions"],
  created_at: "2026-11-14T10:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

function renderPanel(props: Partial<Parameters<typeof ConnectPanel>[0]> = {}) {
  return render(
    <ConnectPanel endpoint={ENDPOINT} connected={null} onConnectAnother={() => {}} {...props} />,
  );
}

/** The text of the copyable block captioned `caption`. */
const codeText = (caption: RegExp | string) =>
  screen
    .getByText((_, el) => {
      if (el?.tagName !== "FIGCAPTION") return false;
      const text = el.textContent ?? "";
      return typeof caption === "string" ? text === caption : caption.test(text);
    })
    .closest("figure")
    ?.querySelector("pre code")?.textContent;

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConnectPanel", () => {
  it("starts on Claude with the URL and a link to Claude's connector settings", () => {
    renderPanel();
    expect(screen.getByRole("tab", { name: "Claude", selected: true })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "MCP server URL" }) as HTMLInputElement).value,
    ).toBe(ENDPOINT);
    const link = screen.getByRole("link", { name: /Open Claude connectors/ });
    expect(link.getAttribute("href")).toBe("https://claude.ai/customize/connectors");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText(/Register automatically/)).toBeTruthy();
    // A public instance gets no "cannot reach" warning.
    expect(screen.queryByText(/cannot reach this instance/)).toBeNull();
  });

  it("renders every client's command, link or config from the endpoint", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("tab", { name: "ChatGPT" }));
    expect(screen.getByRole("link", { name: /Open ChatGPT plugins/ }).getAttribute("href")).toBe(
      "https://chatgpt.com/plugins",
    );
    expect(
      (screen.getByRole("textbox", { name: "MCP server URL" }) as HTMLInputElement).value,
    ).toBe(ENDPOINT);
    expect(screen.getByText(/Add custom MCP server/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(codeText("Or, tools only, without Plinth's rules")).toBe(claudeCodeCommand(ENDPOINT));
    expect(screen.getByRole("button", { name: "Copy Claude Code commands" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(codeText("Run in a terminal")).toBe(codexCommand(ENDPOINT));
    expect(codeText("Run in a terminal")).not.toContain("bearer");

    await user.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByRole("link", { name: "Add to Cursor" }).getAttribute("href")).toBe(
      cursorInstallLink(ENDPOINT),
    );
    expect(codeText(/~\/\.cursor\/mcp\.json/)).toBe(cursorConfigJson(ENDPOINT));

    await user.click(screen.getByRole("tab", { name: "VS Code" }));
    expect(screen.getByRole("link", { name: /Add to VS Code/ }).getAttribute("href")).toBe(
      vscodeInstallLink(ENDPOINT),
    );
    expect(codeText(/\.vscode\/mcp\.json/)).toContain('"type": "http"');

    await user.click(screen.getByRole("tab", { name: "Other clients" }));
    expect(
      screen.getByText("https://plinth.example/.well-known/oauth-protected-resource/mcp"),
    ).toBeTruthy();
    expect(screen.getByText(/streamable HTTP/)).toBeTruthy();
  });

  it("puts the Claude Code plugin first, and labels the bare server as tools only", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    const panel = screen.getByRole("tabpanel");
    const captions = [...panel.querySelectorAll("figcaption")].map((f) => f.textContent);
    expect(captions).toEqual(["Run in a terminal", "Or, tools only, without Plinth's rules"]);
    expect(codeText("Run in a terminal")).toBe(
      "claude plugin marketplace add mr0b0t0/plinth\nclaude plugin install plinth@plinth",
    );
    expect(screen.getByRole("button", { name: "Copy plugin commands" })).toBeTruthy();
    // The in-session form, checked against code.claude.com/docs/en/discover-plugins.
    expect(screen.getByText("/plugin marketplace add mr0b0t0/plinth")).toBeTruthy();
    expect(screen.getByText("/plugin install plinth@plinth")).toBeTruthy();
    expect(screen.getByText("plugin:plinth:plinth")).toBeTruthy();
    // Doing both gives two servers: say so.
    expect(panel.textContent).toContain(
      "Use one or the other: doing both gives Claude Code two Plinth servers (plinth and plugin:plinth:plinth) and two connections.",
    );
    // Not the hosted instance: say how to point the plugin's server here.
    expect(screen.getByText("PLINTH_URL=https://plinth.example")).toBeTruthy();
    // The plugin is the guidance, so there is no separate "Teach it" block repeating it.
    expect(screen.queryByText("Teach it Plinth's rules")).toBeNull();
  });

  it("says nothing about PLINTH_URL on the hosted instance", async () => {
    const user = userEvent.setup();
    renderPanel({ endpoint: "https://plinth.aconite.io/mcp" });
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.queryByText(/PLINTH_URL/)).toBeNull();
  });

  it("shows how each client learns Plinth's rules, from the harness registry", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText("Teach it Plinth's rules")).toBeTruthy();
    expect(codeText("Run")).toBe(
      "codex plugin marketplace add mr0b0t0/plinth\ncodex plugin add plinth@plinth",
    );

    await user.click(screen.getByRole("tab", { name: "Gemini CLI" }));
    expect(codeText("Run in a terminal")).toBe(
      `gemini mcp add --transport http plinth ${ENDPOINT}`,
    );

    await user.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(
      screen.getByRole("link", { name: /plinth-artifacts\.mdc/ }).getAttribute("href"),
    ).toMatch(/integrations\/cursor\/plinth-artifacts\.mdc$/);
  });

  it("remembers the chosen client", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    unmount();
    renderPanel();
    expect(screen.getByRole("tab", { name: "Codex", selected: true })).toBeTruthy();
  });

  it("opens on Cursor inside Cursor's own browser", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh) Cursor/1.7.0 Chrome/138.0 Electron/37.0.0 Safari/537.36",
    );
    renderPanel();
    expect(screen.getByRole("tab", { name: "Cursor", selected: true })).toBeTruthy();
  });

  it("warns that hosted apps cannot reach a local instance", () => {
    renderPanel({ endpoint: "http://app.localhost:8787/mcp" });
    expect(screen.getByText(/cannot reach this instance on your computer/)).toBeTruthy();
  });

  it("announces a new connection with a first prompt to try", async () => {
    const user = userEvent.setup();
    const onConnectAnother = vi.fn();
    const { rerender } = renderPanel({ onConnectAnother });
    expect(screen.getByRole("status").textContent).toContain("updates by itself");

    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    rerender(
      <ConnectPanel endpoint={ENDPOINT} connected={CONN} onConnectAnother={onConnectAnother} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Claude Code is connected.");
    expect(codeText("Try this first")).toBe(
      "Publish a one-page HTML summary of this project to Plinth.",
    );
    await user.click(screen.getByRole("button", { name: "Connect another agent" }));
    expect(onConnectAnother).toHaveBeenCalledOnce();
  });
});
