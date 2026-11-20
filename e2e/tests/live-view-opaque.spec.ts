// Live views under opaque content isolation (docs/spec.md "Live views"): the watch socket is on the
// app host, so versions are pushed here too, while artifact documents keep their opaque origin.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const page1 = (heading: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title></head><body><h1>${heading}</h1></body></html>`;

test("a version an agent publishes is pushed to an open page on the opaque server", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("opaque-live-view"), {
    origin: OPAQUE_APP_ORIGIN,
  });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Live", html: page1("First"), visibility: "unlisted" }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  const welcomed = new Promise<string>((resolve) => {
    page.on("websocket", (ws) => {
      ws.on("framereceived", (f) => {
        if (typeof f.payload === "string" && f.payload.includes('"t":"welcome"')) resolve(ws.url());
      });
    });
  });
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("First");
  expect(await welcomed).toBe(
    `ws://app.localhost:${new URL(OPAQUE_APP_ORIGIN).port}/api/v1/view/${art.id}/watch`,
  );

  const client = await mcpClient(token, OPAQUE_APP_ORIGIN);
  try {
    const r = await tool(client, "update_artifact", {
      id: art.id,
      html: page1("Second"),
      base_version: 1,
    });
    expect(r.isError).toBe(false);
  } finally {
    await client.close();
  }
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 5_000 });
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText("Second", {
    timeout: 5_000,
  });
  // The frame still has an opaque origin: the app's sandbox drops allow-same-origin.
  const sandbox = (await page.locator(CURRENT_FRAME).getAttribute("sandbox")) ?? "";
  expect(sandbox.split(" ")).not.toContain("allow-same-origin");
});
