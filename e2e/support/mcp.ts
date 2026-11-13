// The official MCP client against the e2e Worker's /mcp, with a bearer token.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { APP_ORIGIN } from "./api.ts";

/** Connect to /mcp. Close it with `await client.close()`. */
export async function mcpClient(token: string, origin = APP_ORIGIN): Promise<Client> {
  const client = new Client({ name: "plinth-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export interface ToolResult<T> {
  isError: boolean;
  /** The tool's JSON text result, parsed (the raw text if it is not JSON). */
  data: T;
  text: string;
}

/** Call a tool and parse its JSON text result. Errors come back with isError, not as throws. */
export async function tool<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult<T>> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { isError: !!r.isError, data: data as T, text };
}
