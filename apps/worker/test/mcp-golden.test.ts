// The MCP surface agents see (tools/list with descriptions, input schemas, annotations and _meta;
// resources/list and the preview resource; the server instructions) is pinned by hash to the
// server before tool registration moved into per-feature files (mcp/tools/), so that move changed
// no byte of it. A change that means to alter the surface updates the hashes here, on purpose:
// the design_system type (get_design_system, list_artifacts' type filter, the publish and update
// notes, and the server instructions' design system sentence) did, so did the slides type (its
// publish note, the type and content descriptions and the instructions' deck sentence), comments
// from the page (the page anchor note in list_comments and list_mentions), the slides .pptx
// download (its clause in the slides publish note), the design type (its publish note, the
// type, content, update and get_artifact descriptions and the instructions' design sentence),
// the sheet type (read_sheet and edit_sheet, the publish, update and get_artifact notes, the
// content and content_format descriptions, the untrusted note's sheet sentence, the instructions'
// sheet sentence, edit_sheet's cap on the empty rows a set adds and read_sheet's range default),
// who is viewing (names and the people list in list_artifact_data's description), and the
// whiteboard type (its publish and update note, the type, content and get_artifact descriptions,
// list_artifact_data's whiteboard sentence and the instructions' whiteboard sentence, and its
// default edit setting).
// Category sharing adds its note to publish_artifact, update_artifact, start_upload and
// list_artifacts and a sentence to the instructions, only while ALLOW_CATEGORY_SHARING is on: the
// pins below hold with the switch off, and "category sharing on" pins the surface with it on.
// Invitation emails add set_visibility's `notify` input and its sentence in the description.
// Project files sentences ride only on the tools where they apply: the recipe on publish_artifact,
// update_artifact and start_upload, the sentence that nothing on Plinth chooses local files on the
// six tools that return what it names (and after UNTRUSTED_NOTE in the instructions, whose bytes
// stay the same), and sensitive_file in the instructions only.
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
  "get_artifact_stats",
  "list_artifact_data",
  "write_artifact_data",
  "preview_artifact",
  "get_design_system",
  "read_sheet",
  "edit_sheet",
];

const RESOURCES = "8c9a70350ae4c13067ef489e651d5f5eafe12471c2c63f7c925f9d3bf5bf5e78";
const INSTRUCTIONS = "ab97877c49ee7ea237d6ebfb16e54edec8553b614e7ac8c834b16b2695edd8eb";
/** Every pin but "category sharing on" is the surface with category sharing off. */
const OFF = { ALLOW_CATEGORY_SHARING: "false" };

describe("MCP surface (golden)", () => {
  it("origin isolation", async () => {
    expect(await surface(OFF)).toEqual({
      names: NAMES,
      tools: "292e6901102afd29237f6cc224fd21711787bf4cab28a4d14f920db8ce9e5f7c",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ ...OFF, CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "b13bd15bcd49a4a86445f4f24c3320d5805e0c7418348720dec2620d9c8d20de",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("the staging path fallback (no in-chat preview)", async () => {
    expect(
      await surface({ ...OFF, STAGING_CONTENT_FALLBACK: "true", CONTENT_ISOLATION: "opaque" }),
    ).toEqual({
      names: NAMES,
      tools: "deb4b616a07ba0a1a04da1afa770f156933609df73e991f1a30b6fed6da9e5da",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("category sharing on (the default): the share note and the instructions' sentence", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "246dd7c96c63163ac55b6e2fb7f3ef801edf9f7502745c0f7a87d0c239a4e33c",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: "dcf077349eac3dad2bcd66acfd1cfa4a6dd4da4ede190eb983d35fc4e3aff528",
    });
  });
});
