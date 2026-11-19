// The MCP surface agents see (tools/list with descriptions, input schemas, annotations and _meta;
// resources/list and the preview resource; the server instructions) is pinned by hash to the
// server before tool registration moved into per-feature files (mcp/tools/), so that move changed
// no byte of it. A change that means to alter the surface updates the hashes here, on purpose
// (viewer identity: names on document authors and the people list; page comments: the anchor note
// in list_comments and list_mentions; the design_system type: get_design_system, list_artifacts'
// type filter, the publish and update notes, and the server instructions' design system sentence;
// the slides type: its publish note, the type and content descriptions and the instructions' deck
// sentence; publishing from CI: the instructions' sentence on tokens limited to one artifact; the
// design type: its publish note, the type, content, update and get_artifact descriptions and the
// instructions' design sentence; the slides .pptx download: its clause in the slides publish note;
// project files: the publish, update and upload recipe, the mention note, the sensitive_file
// sentences and the UNTRUSTED_NOTE sentence that nothing on Plinth chooses local files; the
// sheet type: read_sheet and edit_sheet, the publish, update and get_artifact notes, the content
// and content_format descriptions, the untrusted note's sheet sentence and the instructions'
// sheet sentence; the whiteboard type: its publish and update note, the type, content and
// get_artifact descriptions, list_artifact_data's whiteboard sentence and the instructions'
// whiteboard sentence).
// Category sharing adds its note to publish_artifact, update_artifact, start_upload and
// list_artifacts and a sentence to the instructions, only while ALLOW_CATEGORY_SHARING is on: the
// pins below hold with the switch off, and "category sharing on" pins the surface with it on.
// Files people add to a page add list_artifact_files and delete_artifact_file, on every instance.
// Data sources add set_data_sources, the source field of write_artifact_data's set op and its
// sentence, the source sentences of list_artifact_data and get_artifact, a DATA_UNTRUSTED_NOTE and
// an UNTRUSTED_NOTE sentence, and the instructions' sentence on live data from the user's systems.
// Page requests change no tool but the comment tools' text and the instructions, on every
// instance, since requests already filed stay in the queue when the switch goes off: the
// untrusted note's page-request sentence, list_comments' and list_mentions' page-request notes,
// claim_mention's "act with" sentence, reply_comment's `done` input and its page-request
// sentence, and "(from comments or from pages)" in the instructions.
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
  "read_sheet",
  "edit_sheet",
  "list_artifact_files",
  "delete_artifact_file",
  "set_data_sources",
];

const RESOURCES = "8c9a70350ae4c13067ef489e651d5f5eafe12471c2c63f7c925f9d3bf5bf5e78";
const INSTRUCTIONS = "de92f8fd37dbcf7b1d04f9685181ba84c1feaf83cae2160f6fdbeaf0b5da9a46";
/** Every pin but "category sharing on" is the surface with category sharing off. */
const OFF = { ALLOW_CATEGORY_SHARING: "false" };

describe("MCP surface (golden)", () => {
  it("origin isolation", async () => {
    expect(await surface(OFF)).toEqual({
      names: NAMES,
      tools: "3797a9a9a3f276557b3e28a419ee7651f465c968c790808dd193b693241ac6aa",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ ...OFF, CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "4b6fd9e4d9215c96d237c9fa78e9162cd68c1f38ca641cb8198fb40d5c48b0dd",
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
      tools: "f00f190d618196e37a1cda0c823042b5c0c827b559567ea1c3b4046f998b3f64",
      resources: RESOURCES,
      preview: "257bbf5bb47164c389849fffa7fc1dd46e6e7c20e4ef616b4bffefb53a8fd08b",
      instructions: INSTRUCTIONS,
    });
  });

  it("category sharing on (the default): the share note and the instructions' sentence", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "f023055bd8336ae381a559e05f3c52ff9a20f023ae3bfbc4770df73377492282",
      resources: RESOURCES,
      preview: "fd84092d5ecc5a28f494373097e8a3b6e27065d5ef6928f3e124c634f8cf6f47",
      instructions: "141a818ae8521ca40c082d6d4134028015b5205ce2b46642b82dc9a0da6e78db",
    });
  });
});
