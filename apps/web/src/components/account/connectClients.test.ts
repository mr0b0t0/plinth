import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  codexCommand,
  cursorConfigJson,
  cursorInstallLink,
  firstPrompt,
  guessConnectClient,
  isLocalEndpoint,
  protectedResourceUrl,
  vscodeConfigJson,
  vscodeInstallLink,
} from "./connectClients.ts";
import { defaultConnectionLabel } from "./format.ts";

const URL_ = "https://plinth.example/mcp";

describe("connect commands and links", () => {
  it("builds the CLI commands from the endpoint", () => {
    expect(claudeCodeCommand(URL_)).toBe(
      "claude mcp add --transport http --scope user plinth https://plinth.example/mcp\nclaude mcp login plinth",
    );
    expect(codexCommand(URL_)).toBe(
      "codex mcp add plinth --url https://plinth.example/mcp\ncodex mcp login plinth",
    );
  });

  it("builds Cursor's install deeplink with the base64 server entry", () => {
    const link = cursorInstallLink(URL_);
    expect(link).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install?name=plinth&config=eyJ1cmwiOiJodHRwczovL3BsaW50aC5leGFtcGxlL21jcCJ9",
    );
    const config = new URL(link).searchParams.get("config") ?? "";
    expect(JSON.parse(atob(config))).toEqual({ url: URL_ });
    expect(JSON.parse(cursorConfigJson(URL_))).toEqual({ mcpServers: { plinth: { url: URL_ } } });
  });

  it("builds VS Code's install link, wrapped in the vscode.dev redirect", () => {
    const link = new URL(vscodeInstallLink(URL_));
    expect(link.origin).toBe("https://vscode.dev");
    expect(link.pathname).toBe("/redirect");
    const inner = link.searchParams.get("url") ?? "";
    expect(inner.startsWith("vscode:mcp/install?")).toBe(true);
    const entry = JSON.parse(decodeURIComponent(inner.slice("vscode:mcp/install?".length)));
    expect(entry).toEqual({ name: "plinth", type: "http", url: URL_ });
    expect(JSON.parse(vscodeConfigJson(URL_))).toEqual({
      servers: { plinth: { type: "http", url: URL_ } },
    });
  });

  it("points other clients at the protected resource metadata", () => {
    expect(protectedResourceUrl(URL_)).toBe(
      "https://plinth.example/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceUrl("http://app.localhost:8787/mcp")).toBe(
      "http://app.localhost:8787/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("tells local instances apart", () => {
    expect(isLocalEndpoint("http://app.localhost:8787/mcp")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:8787/mcp")).toBe(true);
    expect(isLocalEndpoint(URL_)).toBe(false);
  });

  it("guesses the client from the browser, falling back to Claude", () => {
    expect(guessConnectClient("Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36")).toBe("claude");
    expect(guessConnectClient("Mozilla/5.0 Cursor/1.7.0 Chrome/138 Electron/37.0.0")).toBe(
      "cursor",
    );
    expect(guessConnectClient("Mozilla/5.0 Code/1.106.0 Chrome/138 Electron/37.0.0")).toBe(
      "vscode",
    );
    expect(guessConnectClient(undefined)).toBe("claude");
  });

  it("suggests a first prompt that fits the client", () => {
    expect(firstPrompt("claude")).toContain("conversation");
    expect(firstPrompt("claude-code")).toBe(
      "Publish a one-page HTML summary of this project to Plinth.",
    );
  });
});

describe("defaultConnectionLabel", () => {
  it("uses the client's name, or Agent without one", () => {
    expect(defaultConnectionLabel("Claude Code", [], 60)).toBe("Claude Code");
    expect(defaultConnectionLabel("  Cursor   IDE ", [], 60)).toBe("Cursor IDE");
    expect(defaultConnectionLabel(null, [], 60)).toBe("Agent");
    expect(defaultConnectionLabel("   ", [], 60)).toBe("Agent");
  });

  it("appends a number when the name is taken, ignoring case", () => {
    expect(defaultConnectionLabel("Claude Code", ["claude code"], 60)).toBe("Claude Code 2");
    expect(defaultConnectionLabel("Codex", ["Codex", "Codex 2"], 60)).toBe("Codex 3");
  });

  it("stays within the length limit", () => {
    const long = "x".repeat(60);
    const name = defaultConnectionLabel(long, [long], 60);
    expect(name).toHaveLength(60);
    expect(name.endsWith(" 2")).toBe(true);
  });
});
