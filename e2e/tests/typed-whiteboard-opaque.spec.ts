// A whiteboard keeps its board in shared data, which needs each artifact's own origin: under
// CONTENT_ISOLATION=opaque (the second e2e Worker) publishing one is refused with
// feature_disabled, and the instance's config lists the type as unavailable.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

test("publishing a whiteboard under opaque isolation is refused, and config says so", async () => {
  const email = uniqueEmail("wb-opaque");
  const { token } = await seedToken(email, { origin: OPAQUE_APP_ORIGIN });
  const client = await mcpClient(token, OPAQUE_APP_ORIGIN);
  try {
    const r = await tool(client, "publish_artifact", {
      title: "Board",
      type: "whiteboard",
      content: '{"v":1}',
    });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({
      code: "feature_disabled",
      details: { type: "whiteboard", reason: "opaque_isolation" },
    });
  } finally {
    await client.close();
  }
  const config = await (await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/config`)).json();
  expect(config.artifact_types).toContainEqual({ id: "whiteboard", available: false });
});
