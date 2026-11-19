// Data sources under opaque content isolation (the second e2e Worker): pages have no shared data,
// so the owner's agent publishes the figures inline; the source, the owner's confirmation and the
// bar line still work, and plinth.cite cites inline objects without any request.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const AT = new Date().toISOString();
const INLINE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issues (inline)</title>
<style>body{font:16px system-ui;margin:1rem}@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style>
</head><body>
<p>Open issues: <strong id="open">14</strong></p>
<script src="/__plinth/runtime.js"></script>
<script>
  const figure = { source: { label: "Open issues", connector: "Linear", fetched_at: ${JSON.stringify(AT)} } };
  if (window.plinth) window.plinth.cite(document.getElementById("open"), figure);
  document.body.dataset.ready = "1";
</script>
</body></html>`;

const SOURCE = {
  id: "linear-issues",
  label: "Open issues",
  connector: "Linear",
  recipe: "Linear: count open issues in team ENG.",
  collection: "issues",
};

test("an inline dashboard on an opaque instance: the bar names its source, the owner confirms it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("opaque-sources");
  const { token } = await seedToken(owner, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  const client = await mcpClient(token, OPAQUE_APP_ORIGIN);
  try {
    const pub = await tool<{ id: string; slug: string }>(client, "publish_artifact", {
      title: "Issues (inline)",
      html: INLINE,
    });
    expect(pub.isError, pub.text).toBe(false);
    // Shared data is off here: a stamped write is refused, and the source is set all the same.
    const write = await tool(client, "write_artifact_data", {
      id: pub.data.id,
      ops: [{ op: "set", collection: "issues", doc_id: "open", data: { count: 14 }, if_rev: 0 }],
    });
    expect(write.isError).toBe(true);
    const set = await tool(client, "set_data_sources", { id: pub.data.id, sources: [SOURCE] });
    expect(set.isError, set.text).toBe(false);

    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/__plinth/api")) requests.push(r.url());
    });
    await seedSession(page.context(), owner, OPAQUE_APP_ORIGIN);
    await page.goto(`${OPAQUE_APP_ORIGIN}/a/${pub.data.slug}`);
    await readyFrame(page);
    // The page cites its inline figure without a request.
    await expect(page.frameLocator(CURRENT_FRAME).locator("#open sup")).toHaveText(
      /^Linear · (just now|\d+ min ago)$/,
    );
    expect(requests).toEqual([]);
    // The bar names the source and says nothing is stored as fetched; the owner is asked to review.
    await expect(page.locator(".pl-viewer__sources")).toHaveText(
      "This page says its figures come from Linear, but none are stored as fetched: what it shows comes from the page itself.",
    );
    await expect(page.getByText("1 data source is waiting for you to confirm it.")).toBeVisible();
    await page.getByRole("button", { name: "Review" }).click();
    const dialog = page.getByRole("dialog", { name: "Share this artifact" });
    await expect(dialog.locator("pre.pl-share-sources__recipe")).toHaveText(SOURCE.recipe);
    await dialog.getByRole("button", { name: "Confirm Open issues" }).click();
    await expect(dialog.getByText(/^Confirmed/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText(/waiting for you to confirm/)).toHaveCount(0);
  } finally {
    await client.close();
  }
});
