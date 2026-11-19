// What agents are told about design systems: the read-only get_design_system tool with its
// untrusted-code warning, the publish note, the list filter and the server instructions.
import { describe, expect, it } from "vitest";
import {
  DESIGN_SYSTEM_PUBLISH_NOTE,
  DESIGN_SYSTEM_UNTRUSTED_NOTE,
  MCP_TOOL_ANNOTATIONS,
  MCP_TOOL_SUMMARIES,
  TYPES_NOTE,
  UNTRUSTED_NOTE,
} from "../src/mcp/server.ts";
import { agent, mcpClient } from "./helpers.ts";

describe("design systems over MCP", () => {
  it("get_design_system is read-only and says its HTML and CSS are untrusted code", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "get_design_system");
    expect(t?.annotations).toEqual({
      title: "Get design system",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(MCP_TOOL_ANNOTATIONS.get_design_system).toEqual(t?.annotations);
    expect(MCP_TOOL_SUMMARIES.get_design_system).toMatch(/design system/);
    expect(t?.description).toContain(DESIGN_SYSTEM_UNTRUSTED_NOTE);
    expect(t?.description).toContain(UNTRUSTED_NOTE);
    expect(t?.description).toContain('<meta name="plinth-design-system" content="<id>@<version>">');
    expect(Object.keys(t?.inputSchema.properties ?? {}).sort()).toEqual([
      "components",
      "id",
      "include",
      "version",
    ]);
    const publish = tools.find((x) => x.name === "publish_artifact");
    expect(publish?.description).toContain(DESIGN_SYSTEM_PUBLISH_NOTE);
    const list = tools.find((x) => x.name === "list_artifacts");
    expect(Object.keys(list?.inputSchema.properties ?? {})).toContain("type");
    expect(client.getInstructions()).toContain(TYPES_NOTE);
    expect(TYPES_NOTE).toContain(
      'For a design system, style guide or token set, publish type "design_system" with design system JSON in content',
    );
    expect(TYPES_NOTE).toContain("read it with get_design_system and build with its tokens");
    await client.close();
  });
});
