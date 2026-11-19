// Page requests under opaque content isolation (the second e2e Worker, with ALLOW_PAGE_REQUESTS on):
// they need origin isolation, so the runtime has no plinth.requests there, no request to
// /__plinth/api/v1/requests is ever sent, and the example report still shows with its form off.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ROOT } from "../support/paths.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const HTML = readFileSync(path.join(ROOT, "docs/examples/ask-agent.html"), "utf8");

test("the report renders without plinth.requests and sends no request", async ({ page }) => {
  const email = uniqueEmail("opaque-ask");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Quarterly sales report", html: HTML }),
  });
  const art = (await res.json()) as { slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  const config = await (await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/config`)).json();
  expect(config.page_requests.enabled).toBe(false);

  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/api/v1/requests")) calls.push(r.url());
  });
  await page.goto(`/a/${art.slug}`);
  const frame = await readyFrame(page);
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  expect(
    await frame.evaluate(() => (window as { plinth?: { requests?: unknown } }).plinth?.requests),
  ).toBe(undefined);
  const inFrame = page.frameLocator(CURRENT_FRAME);
  await expect(inFrame.locator("h1")).toHaveText("Quarterly sales report");
  await expect(inFrame.locator("#status")).toHaveText(
    "Requests to the owner's agent are not available here.",
  );
  await expect(inFrame.locator("#send")).toBeDisabled();
  // No notice line about requests: the gate has no `requests` block here.
  await expect(page.getByRole("main").getByText("send requests to the owner's agent")).toHaveCount(
    0,
  );
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
});
