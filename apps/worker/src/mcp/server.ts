// The MCP server at /mcp (streamable HTTP). One fresh McpServer per request, bound to the
// authenticated principal; every tool calls the same services (and so the same policy) as REST.
// Tools register from per-feature files under mcp/tools/; their summaries and annotations are
// in mcp/catalog.ts and the sentences they share in mcp/notes.ts.

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { LIMITS, PRODUCT_NAME } from "@plinth/shared";
import { PLINTH_VERSION } from "../app/version.ts";
import type { Ctx } from "../services/context.ts";
import {
  BOUND_TOKEN_NOTE,
  CATEGORY_INSTRUCTION,
  CATEGORY_SHARE_INSTRUCTION,
  CRAFT_INSTRUCTION,
  contentNote,
  PLUGIN_NOTE,
  SENSITIVE_INSTRUCTION,
  TYPES_NOTE,
  UNTRUSTED_FILES_NOTE,
} from "./notes.ts";
import { PREVIEW_TOOL_META, previewSupported } from "./preview.ts";
import { registerArtifactTools } from "./tools/artifacts.ts";
import { registerCommentTools } from "./tools/comments.ts";
import type { ToolRegistrar } from "./tools/context.ts";
import { registerDataTools } from "./tools/data.ts";
import { registerDesignSystemTools } from "./tools/designSystems.ts";
import { registerPreviewTools } from "./tools/preview.ts";
import { registerSheetTools } from "./tools/sheets.ts";
import { registerStatsTools } from "./tools/stats.ts";
import { registerUploadTools } from "./tools/uploads.ts";

export * from "./catalog.ts";
export * from "./notes.ts";

/**
 * The tool files, one per line, in the order tools/list shows their tools. A feature adds its
 * file under mcp/tools/ and one line here.
 */
export const MCP_TOOL_FILES: readonly ToolRegistrar[] = [
  registerArtifactTools,
  registerCommentTools,
  registerUploadTools,
  registerStatsTools,
  registerDataTools,
  registerPreviewTools,
  registerDesignSystemTools,
  registerSheetTools,
];

export function buildMcpServer(ctx: Ctx): McpServer {
  const opaque = contentNote(ctx.config);
  // Hosts that support MCP Apps show the published version under the tool call (mcp/preview.ts).
  const preview = previewSupported(ctx.config) ? { _meta: PREVIEW_TOOL_META } : {};
  const server = new McpServer(
    { name: PRODUCT_NAME.toLowerCase(), version: PLINTH_VERSION },
    {
      instructions:
        `${PRODUCT_NAME} hosts HTML pages ("artifacts") that you publish for the user, and lets them ` +
        "decide who can view each one. When the user wants a page, report, dashboard, prototype or " +
        "visualization to look at or pass on, write one self-contained HTML document and publish it with " +
        "publish_artifact. New artifacts are private (only the user and people they add), so publish " +
        `without asking, then give the user the returned url. ${CATEGORY_INSTRUCTION} ` +
        (ctx.config.allowCategorySharing ? `${CATEGORY_SHARE_INSTRUCTION} ` : "") +
        "Make it a finished page: a short real " +
        "<title>, light and dark color schemes, readable at phone width, scripts only from the CDN " +
        `allowlist at pinned versions, no requests to other hosts. ${CRAFT_INSTRUCTION} ` +
        "To change an artifact, read it with " +
        "get_artifact and publish a new version with update_artifact and base_version; never publish a " +
        "copy, and the link stays the same. Change who can view it with set_visibility only when the " +
        "user asks. A page can keep shared data (polls, sign-up sheets, trackers among invited people): " +
        "read it with list_artifact_data and change it with write_artifact_data. " +
        "For a build folder or more than ~1 MB, call start_upload instead of inline assets. " +
        "Results list warnings; fix them before handing over the link (not_scanned and live_draft need no action). " +
        `${SENSITIVE_INSTRUCTION} ` +
        "For feedback, read threads with list_comments, answer with reply_comment and close " +
        "them with resolve_comment; requests addressed to you arrive through list_mentions and " +
        `claim_mention. ${BOUND_TOKEN_NOTE} ${UNTRUSTED_FILES_NOTE} ${TYPES_NOTE} ${PLUGIN_NOTE}`,
    },
  );

  for (const register of MCP_TOOL_FILES) register({ server, ctx, opaque, preview });

  return server;
}

/** Serve one /mcp request for an authenticated agent. */
export function handleMcp(
  request: Request,
  ctx: Ctx,
  authInfo: { token: string; clientId: string; scopes: string[] },
) {
  const handler = createMcpHandler(() => buildMcpServer(ctx), {
    legacy: "stateless",
    responseMode: "json",
    // Inline sources and base64 assets, plus JSON overhead. Builds go through start_upload.
    maxRequestBodySize: LIMITS.maxInlineRequestBytes,
  });
  return handler.fetch(request, { authInfo });
}
