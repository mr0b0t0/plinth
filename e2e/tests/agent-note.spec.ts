// The agent note in the SPA shell is for agents reading the HTML as text: a person never sees it,
// not before the app mounts (a stylesheet hides it, no JavaScript involved) and not after (React
// replaces it).
import { expect, test } from "@playwright/test";
import { uniqueEmail } from "../support/api.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const NOTE = ".plinth-agent-note";

async function publishUnlisted(title: string): Promise<{ slug: string }> {
  const { token } = await seedToken(uniqueEmail("note-owner"), { clientType: "claude" });
  const client = await mcpClient(token);
  try {
    const r = await tool<{ slug: string }>(client, "publish_artifact", {
      title,
      html: "<!doctype html><title>x</title><h1>Exhibit</h1>",
      visibility: "unlisted",
    });
    expect(r.isError, r.text).toBe(false);
    return r.data;
  } finally {
    await client.close();
  }
}

test.describe("without JavaScript (what shows before the app mounts)", () => {
  test.use({ javaScriptEnabled: false });

  test("the note is in the page for agents but hidden from people", async ({ page }) => {
    const { slug } = await publishUnlisted("Note check");
    for (const path of [`/a/${slug}`, "/", "/a/no-such-artifact"]) {
      await page.goto(path);
      const note = page.locator(NOTE);
      await expect(note, path).toHaveCount(1);
      await expect(note, path).toBeHidden();
      expect(await note.textContent(), path).toContain("MCP");
      // innerText, unlike textContent, leaves out what CSS hides: what a person sees.
      // biome-ignore lint/performance/useDomNodeTextContent: rendered text is the point here
      const visible = await page.evaluate(() => document.body.innerText.trim());
      expect(visible, path).toBe("");
    }
  });
});

test("the app replaces the note when it mounts", async ({ page }) => {
  const { slug } = await publishUnlisted("Note replaced");
  await page.goto(`/a/${slug}`);
  await expect(page.locator("iframe.pl-viewer-frame").first()).toBeVisible();
  await expect(page.locator(NOTE)).toHaveCount(0);
  await expect(page).toHaveTitle("Note replaced · Plinth");
});
