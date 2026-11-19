// The MCP tool catalog: one summary and one set of annotations per tool, one entry per line. A
// feature that adds a tool adds its lines here and registers it from its file in mcp/tools/.
import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * One line per MCP tool, for /llms.txt and other discovery pages. Every tool is registered under a
 * name from this table (toolName), and a test compares it with the live tools/list, so the
 * list agents read before connecting cannot drift from the server.
 */
export const MCP_TOOL_SUMMARIES = {
  publish_artifact:
    "Publish a new HTML artifact as the connected user (private by default) and get its link.",
  update_artifact:
    "Publish a new version of an artifact; with base_version it is rejected instead of overwriting.",
  get_artifact: "Read an artifact's metadata and HTML, current version or a given one.",
  list_artifacts: "List the user's artifacts and those shared with them.",
  list_versions: "Version history: number, author, note and date.",
  restore_version: "Make an old version current by publishing it as the next version.",
  set_visibility: "Change who can view an artifact (owner only).",
  list_comments: "Read every comment thread on an artifact.",
  resolve_comment: "Resolve a comment thread, or reopen it.",
  list_mentions: "Requests addressed to this agent from comments and pages.",
  claim_mention: "Lock a pending mention task so only one agent acts on it.",
  reply_comment: "Reply in a comment thread; completes a mention task this agent claimed.",
  list_artifact_data: "Read a page's shared data (polls, sign-ups, trackers): summary, documents.",
  write_artifact_data: "Create, replace or delete a page's shared data documents, with if_rev.",
  start_upload:
    "For a build folder or a big page: a single-use ticket and a curl command that publishes it as one tar.",
  preview_artifact:
    "Used by Plinth's in-chat preview (MCP Apps hosts) for a short-lived link to show a version; agents never need it.",
  get_design_system:
    "Read a design system's tokens, CSS, guidelines and components to build another artifact with it.",
  read_sheet: "Read a sheet's columns and cells, formulas with their computed values.",
  edit_sheet: "Change a sheet's cells, rows and columns as one new version, with base_version.",
  list_artifact_files:
    "List the files people uploaded from a page (names, types, sizes, uploaders); never the bytes.",
  delete_artifact_file: "Delete one file people uploaded from a page (owner or editor).",
  set_data_sources:
    "Describe where a page's figures come from (owner only); the user confirms each source in Plinth.",
} as const;

export type McpToolName = keyof typeof MCP_TOOL_SUMMARIES;

/** A tool name, checked against the catalog. */
export const toolName = (name: McpToolName): McpToolName => name;

/** Annotations for a tool that only reads: no side effects, safe to repeat. */
const reads = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** Annotations for a tool that writes: not destructive and not idempotent unless it says so. */
const writes = (
  title: string,
  o: { destructive?: boolean; idempotent?: boolean } = {},
): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: o.destructive ?? false,
  idempotentHint: o.idempotent ?? false,
  openWorldHint: false,
});

/**
 * MCP tool annotations (hints for clients and directories), one per tool. Writes never delete an
 * artifact or a version: publish, update and restore add a version anyone can revert, so they are
 * not destructive. set_visibility (replaces the viewer allowlist), write_artifact_data (shared
 * data is not versioned; ops can delete documents), delete_artifact_file (files people added
 * are not versioned either) and set_data_sources (it replaces the list, removing sources left out)
 * are. Every tool acts only on this Plinth instance, so none is
 * open-world.
 */
export const MCP_TOOL_ANNOTATIONS: Record<McpToolName, ToolAnnotations> = {
  publish_artifact: writes("Publish artifact"),
  update_artifact: writes("Update artifact"),
  get_artifact: reads("Get artifact"),
  list_artifacts: reads("List artifacts"),
  list_versions: reads("List versions"),
  restore_version: writes("Restore version"),
  set_visibility: writes("Set visibility", { destructive: true, idempotent: true }),
  list_comments: reads("List comments"),
  resolve_comment: writes("Resolve comment", { idempotent: true }),
  list_mentions: reads("List mentions"),
  claim_mention: writes("Claim mention"),
  reply_comment: writes("Reply to comment"),
  list_artifact_data: reads("List artifact data"),
  write_artifact_data: writes("Write artifact data", { destructive: true }),
  start_upload: writes("Start upload"),
  preview_artifact: reads("Preview artifact"),
  get_design_system: reads("Get design system"),
  read_sheet: reads("Read sheet"),
  edit_sheet: writes("Edit sheet"),
  list_artifact_files: reads("List artifact files"),
  delete_artifact_file: writes("Delete artifact file", { destructive: true, idempotent: true }),
  set_data_sources: writes("Set data sources", { destructive: true, idempotent: true }),
};
