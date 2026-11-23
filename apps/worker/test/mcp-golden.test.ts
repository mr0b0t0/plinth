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
// never merged), the whiteboard's wider elements (its publish note's element format,
// list_artifact_data's whiteboard sentence, and write_artifact_data's merge op and its schema),
// and live design systems (the same sentences name design systems with sheets).
// Category sharing adds its note to publish_artifact, update_artifact, start_upload and
// list_artifacts and a sentence to the instructions, only while ALLOW_CATEGORY_SHARING is on: the
// pins below hold with the switch off, and "category sharing on" pins the surface with it on.
// Invitation emails add set_visibility's `notify` input and its sentence in the description.
// Project files sentences ride only on the tools where they apply: the recipe on publish_artifact,
// update_artifact and start_upload, the sentence that nothing on Plinth chooses local files on the
// six tools that return what it names (and after UNTRUSTED_NOTE in the instructions, whose bytes
// stay the same), and sensitive_file in the instructions only.
// The design canvas (fluid boards, placement, notes, flows and #board= links) adds its sentence to
// the design publish note.
// Asking an agent adds list_mentions' sentence on requests made in comments (the "@agent:other"
// target for every other client) and the untrusted note's sentence on mentions pinned to a place,
// on every instance; asking from comments only (no Ask an agent button) reworded both.
// The craft guides add CRAFT_NOTE to publish_artifact, CRAFT_UPDATE_NOTE to update_artifact and
// CRAFT_INSTRUCTION to the instructions, pointing at the skill's craft/<type>.md.
// Design systems other types use add copy_files (its input on publish_artifact, update_artifact and
// start_upload, and their copy note), the default design system (list_artifacts, get_artifact and
// the instructions' design system sentence), get_design_system's install, and get_artifact's
// sentence on a design's design_system and copied_from.
// get_design_system's install_for and folder inputs and its install sentence changed them again.
// get_design_system's deck_format input, and update_artifact's HTML deck sentence (only what changed
// is sent; every other file but a slide the new order drops is kept), changed them again.
// Published from code adds `editing` to publish_artifact, update_artifact and start_upload; its
// description says a publish from code is the whole next version, without page edits.
// show_artifact (shows an artifact under the call in MCP Apps hosts), its sentence in the
// instructions and the preview's full screen button changed them again.
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
  "show_artifact",
  "preview_artifact",
  "get_design_system",
  "read_sheet",
  "edit_sheet",
];

const RESOURCES = "78c96b166894144d57e68ef977b2e7e414eab8ea233a9c35c2973cfe3b5bc9a7";
const INSTRUCTIONS = "20830bac6f039d062d40b37f827ee33c9ab8a5aa9591e59171e03489a5d3b1aa";
/** Every pin but "category sharing on" is the surface with category sharing off. */
const OFF = { ALLOW_CATEGORY_SHARING: "false" };

describe("MCP surface (golden)", () => {
  it("origin isolation", async () => {
    expect(await surface(OFF)).toEqual({
      names: NAMES,
      tools: "3f92d2dcdb4055adaa8bce4f9245f3b5fded3a3326c321322229d1708b483945",
      resources: RESOURCES,
      preview: "86970cd4f2b511fa6d96a9f44ee54a25ba3e3d26f303fc3db16555b9adba8491",
      instructions: INSTRUCTIONS,
    });
  });

  it("opaque isolation", async () => {
    expect(await surface({ ...OFF, CONTENT_ISOLATION: "opaque" })).toEqual({
      names: NAMES,
      tools: "41a19bb25bf2f5a1d0a45ddce58d672737421c9f1bd53981df79fa95395ea38c",
      resources: RESOURCES,
      preview: "ca2fef7357c958f9d3b41340f260ff55eed0173e95303860bac71cc03244c69c",
      instructions: INSTRUCTIONS,
    });
  });

  it("the staging path fallback (no in-chat preview)", async () => {
    expect(
      await surface({ ...OFF, STAGING_CONTENT_FALLBACK: "true", CONTENT_ISOLATION: "opaque" }),
    ).toEqual({
      names: NAMES,
      tools: "139b6b6f528f43718c682553094b296badd3932cc429e417213b9fe26bb367bf",
      resources: RESOURCES,
      preview: "ca2fef7357c958f9d3b41340f260ff55eed0173e95303860bac71cc03244c69c",
      instructions: INSTRUCTIONS,
    });
  });

  it("category sharing on (the default): the share note and the instructions' sentence", async () => {
    expect(await surface()).toEqual({
      names: NAMES,
      tools: "3d6a77ee1b795e26844c98195d76daeb990fe1185765ff4267b9b583722f30c6",
      resources: RESOURCES,
      preview: "86970cd4f2b511fa6d96a9f44ee54a25ba3e3d26f303fc3db16555b9adba8491",
      instructions: "b56c72071108dc740f7eafea6ec0f31e433635807a87b688f094fe62045560d5",
    });
  });
});
