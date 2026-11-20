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
      tools: "ded03e90816b1a553c09c3b8b7c1a4678ca9622263e63ba50548c6491f232b46",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ ...OFF, CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "9ca0046a7f728a968966aa3fec9d23a231808f1b86cbf6d3ffd87a2874bf0e9c",
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
      tools: "e7f050a59d9e4c9ba235e7f1b1e9f9fdfe59728e7ad9f5146c84406d4cb5f39c",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("category sharing on (the default): the share note and the instructions' sentence", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "cce5ffc9450bb79817660422aee9c535e73c36b1f1e71c0337d46e0a4ae3da4f",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: "dcf077349eac3dad2bcd66acfd1cfa4a6dd4da4ede190eb983d35fc4e3aff528",
    });
  });
});
