// The MCP surface agents see (tools/list with descriptions, input schemas, annotations and _meta;
// resources/list and the preview resource; the server instructions) is pinned by hash to the
// server before tool registration moved into per-feature files (mcp/tools/), so that move changed
// no byte of it. A change that means to alter the surface updates the hashes here, on purpose
// (viewer identity: names on document authors and the people list; page comments: the anchor note
// in list_comments and list_mentions; the design_system type: get_design_system, list_artifacts'
// type filter, the publish and update notes, and the server instructions' design system sentence;
// the slides type: its publish note, the type and content descriptions and the instructions' deck
// sentence).
import { describe, expect, it } from "vitest";
import { PREVIEW_RESOURCE_URI } from "../src/mcp/preview.ts";
import { agent, mcpClient } from "./helpers.ts";

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function surface(vars?: Record<string, string>) {
  const a = await agent();
  const client = await mcpClient(a.token, vars);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const preview = await client.readResource({ uri: PREVIEW_RESOURCE_URI });
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return {
    names: tools.tools.map((t) => t.name),
    tools: await sha256(JSON.stringify(tools)),
    resources: await sha256(JSON.stringify(resources)),
    preview: await sha256(JSON.stringify(preview)),
    instructions: await sha256(instructions),
  };
}

const NAMES = [
  "publish_artifact",
  "update_artifact",
  "get_artifact",
  "list_artifacts",
  "list_versions",
  "restore_version",
  "set_visibility",
  "list_comments",
  "resolve_comment",
  "list_mentions",
  "claim_mention",
  "reply_comment",
  "start_upload",
  "list_artifact_data",
  "write_artifact_data",
  "preview_artifact",
  "get_design_system",
];

const RESOURCES = "8c9a70350ae4c13067ef489e651d5f5eafe12471c2c63f7c925f9d3bf5bf5e78";
const INSTRUCTIONS = "ca1a080e217664904532f73f57a349d6f22e0f6382606e142f26837a6fe153e7";

describe("MCP surface (golden)", () => {
  it("origin isolation", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "d438cd39c20ebdb54667dc7a0dd27ede283d0e1546d25512376b92f110d450a4",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "cf9ed3eedf8bfc51632c0d1052b2d2f65bea751aa43b938dc2a72fb1ddc1e5cb",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("the staging path fallback (no in-chat preview)", async () => {
    expect(
      await surface({ STAGING_CONTENT_FALLBACK: "true", CONTENT_ISOLATION: "opaque" }),
    ).toEqual({
      names: NAMES,
      tools: "20ca3ad2bf298ddde9fb918de92cbae7cdd8616d74780435e8e1f9dcea65757a",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });
});
