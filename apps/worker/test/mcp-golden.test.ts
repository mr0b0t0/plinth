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
// who is viewing (names and the people list in list_artifact_data's description), the
// whiteboard type (its publish and update note, the type, content and get_artifact descriptions,
// list_artifact_data's whiteboard sentence and the instructions' whiteboard sentence, and its
// default edit setting), and live sheets (the live_draft sentences of the publish notes and
// get_artifact name sheets as well as docs, and say a sheet's page edits are always reviewed,
// never merged).
// Category sharing adds its note to publish_artifact, update_artifact, start_upload and
// list_artifacts and a sentence to the instructions, only while ALLOW_CATEGORY_SHARING is on: the
// pins below hold with the switch off, and "category sharing on" pins the surface with it on.
// Invitation emails add set_visibility's `notify` input and its sentence in the description.
// Project files sentences ride only on the tools where they apply: the recipe on publish_artifact,
// update_artifact and start_upload, the sentence that nothing on Plinth chooses local files on the
// six tools that return what it names (and after UNTRUSTED_NOTE in the instructions, whose bytes
// stay the same), and sensitive_file in the instructions only.
// Ask an agent adds list_mentions' sentence on requests sent from the app (the "@agent:other" target
// for every other client) and the untrusted note's Ask an agent sentence, on every instance.
// Sheet looks change read_sheet's and edit_sheet's descriptions (styles, option colours and
// highlight rules) and edit_sheet's schema (the format op, set_column's colors and highlight).
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
const INSTRUCTIONS = "b4248a0f8324ca752e356e7dd54321f9c5be172f9ae7342b445aa3e8d85d117c";
/** Every pin but "category sharing on" is the surface with category sharing off. */
const OFF = { ALLOW_CATEGORY_SHARING: "false" };

describe("MCP surface (golden)", () => {
  it("origin isolation", async () => {
    expect(await surface(OFF)).toEqual({
      names: NAMES,
      tools: "bf5a0de202420d8ba5a92348613d6276ddb278c9c6addf114dd225e29d2f71f6",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ ...OFF, CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "c5af2b082d98edf1bf92c6b25ffc875d0529ad3ef96d72ea2701f7589b555a2a",
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
      tools: "844bc2868b223f8344c5353a1394abfa82a32d45348d674ecb922f061224c4d0",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("category sharing on (the default): the share note and the instructions' sentence", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "892cc3031c2ea8150abec3bcf9a36dc4aae511f56452fe2d92e5479288694f77",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: "2a24eb0eedee809683ad4aec0509c0bb0626a4a53ffd5ee771625da43f35a1ee",
    });
  });
});
