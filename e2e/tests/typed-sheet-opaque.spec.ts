// A sheet under opaque content isolation (CONTENT_ISOLATION=opaque), against the second e2e
// Worker: the grid renders under the CSP sandbox, and the menu's CSV download still arrives (the
// export message carries no data, so it may go to the opaque frame at "*").
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const SHEET = [
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item"},{"name":"Qty","type":"number"}]}',
  '["Apples",3]',
  '["Pears","=B2*2"]',
].join("\n");

test("the grid renders and CSV downloads from the menu", async ({ page }) => {
  const email = uniqueEmail("sheet-opaque");
  const { token } = await seedToken(email, {
    label: "Sheet agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Opaque fruit", type: "sheet", content: SHEET }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  await page.goto(`/a/${art.slug}`);
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(frame.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(frame.locator("#__plinth-cell-B3")).toHaveText("6");

  await page.getByRole("button", { name: "Artifact actions" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download as CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Opaque fruit.csv");
  const text = readFileSync((await download.path()) as string, "utf8");
  expect(text).toBe('﻿"Item","Qty"\r\n"Apples",3\r\n"Pears",6\r\n');
});
