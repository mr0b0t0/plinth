// The in-chat preview (MCP Apps, mcp/preview.ts): preview_artifact and the app resource it shows.
import { previewArtifactInput } from "@plinth/shared";
import { MCP_TOOL_ANNOTATIONS, toolName } from "../catalog.ts";
import { UNTRUSTED_NOTE } from "../notes.ts";
import {
  MCP_APP_MIME_TYPE,
  PREVIEW_APP_ONLY_META,
  PREVIEW_RESOURCE_URI,
  previewAppHtml,
  previewArtifact,
  previewResourceMeta,
} from "../preview.ts";
import { run, type ToolRegistrar } from "./context.ts";

export const registerPreviewTools: ToolRegistrar = ({ server, ctx }) => {
  server.registerTool(
    toolName("preview_artifact"),
    {
      title: "Preview artifact",
      description:
        "Used by Plinth's in-chat preview, not by agents: returns a single-use link, valid for 60 " +
        "seconds, that shows one version of an artifact you can view in a read-only frame. Give the " +
        "user the artifact's url instead; never put this link in a message. " +
        UNTRUSTED_NOTE,
      inputSchema: previewArtifactInput,
      annotations: MCP_TOOL_ANNOTATIONS.preview_artifact,
      _meta: PREVIEW_APP_ONLY_META,
    },
    (args) => run(() => previewArtifact(ctx, args.id, args.version)),
  );

  server.registerResource(
    "plinth-preview",
    PREVIEW_RESOURCE_URI,
    {
      title: "Plinth preview",
      description: "Shows a version just published to Plinth in the conversation.",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: previewResourceMeta(ctx.config),
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME_TYPE,
          text: previewAppHtml(ctx.config),
          _meta: previewResourceMeta(ctx.config),
        },
      ],
    }),
  );
};
