// What every MCP tool file gets to register its tools (mcp/tools/<key>.ts), and the wrapper that
// turns a service result or an ApiError into a tool result.
import type { McpServer } from "@modelcontextprotocol/server";
import { ApiError } from "../../lib/errors.ts";
import type { Ctx } from "../../services/context.ts";
import type { PREVIEW_TOOL_META } from "../preview.ts";

export interface ToolContext {
  server: McpServer;
  ctx: Ctx;
  /** The extra sentence publishing tools carry on this instance (contentNote), or "". */
  opaque: string;
  /** `_meta` that shows a publishing tool's result in the in-chat preview, where supported. */
  preview: { _meta?: typeof PREVIEW_TOOL_META };
}

/** A tool file: registers its tools, in order, on the server. */
export type ToolRegistrar = (t: ToolContext) => void;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError("internal", "Internal error");
    if (!(e instanceof ApiError)) console.error("mcp tool error", e);
    return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toBody()) }] };
  }
}
