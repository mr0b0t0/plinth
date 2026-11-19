// Live views under opaque content isolation, applying a new version (docs/spec.md "Live views"):
// the app posts nothing new to frames whose origin is "null", so a doc is replaced by a fresh frame
// instead of updating in place, and a page that declares `hold` still waits while the viewer types.
import { expect, type Page, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

async function publish(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Live", visibility: "unlisted", ...body }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  return art;
}

async function update(token: string, id: string, body: Record<string, unknown>) {
  const client = await mcpClient(token, OPAQUE_APP_ORIGIN);
  try {
    const r = await tool(client, "update_artifact", { id, ...body, base_version: 1 });
    expect(r.isError, r.text).toBe(false);
  } finally {
    await client.close();
  }
}

function enters(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/enter?")) seen.push(r.url());
  });
  return seen;
}

test("a doc is replaced by a fresh frame on the opaque server", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("opaque-doc-live"), { origin: OPAQUE_APP_ORIGIN });
  const art = await publish(token, { type: "doc", content: "# First\n\nOne." });
  const entered = enters(page);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("First");
  expect(entered).toHaveLength(1);

  await update(token, art.id, { content: "# Second\n\nTwo." });
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toContainText(
    "Second",
  );
  // A fresh frame, with its own enter request, still with an opaque origin.
  expect(entered).toHaveLength(2);
  const sandbox = (await page.locator(CURRENT_FRAME).getAttribute("sandbox")) ?? "";
  expect(sandbox.split(" ")).not.toContain("allow-same-origin");
});

const HOLD_PAGE = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="plinth-capabilities" content="hold"><title>Form</title></head><body>
<h1>${title}</h1><label>Answer <input id="answer"></label></body></html>`;

test("a page that declares hold waits while the viewer types, on the opaque server", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("opaque-hold-live"), { origin: OPAQUE_APP_ORIGIN });
  const art = await publish(token, { html: HOLD_PAGE("First") });
  await page.goto(`/a/${art.slug}`);
  const current = page.frameLocator(CURRENT_FRAME);
  await expect(current.locator("h1")).toHaveText("First");
  await current.locator("#answer").click();
  await current.locator("#answer").pressSequentially("typing");

  await update(token, art.id, { html: HOLD_PAGE("Second") });
  await expect(page.getByText(/v2 is available/)).toBeVisible({ timeout: 10_000 });
  await expect(current.locator("#answer")).toHaveValue("typing");
  await page.getByRole("button", { name: "Update" }).click();
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText("Second");
});
