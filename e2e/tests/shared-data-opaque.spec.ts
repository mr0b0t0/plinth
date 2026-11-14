// Shared data under opaque content isolation (CONTENT_ISOLATION=opaque, the second e2e Worker):
// artifact documents have an opaque origin and no cookies, so the feature is off. The poll page
// must say so cleanly: plinth.ready resolves opaque_isolation without any request to the data API,
// the page shows its fallback text, the app shows the "not available" notice, and nothing throws.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { CURRENT_FRAME, POLL_HTML, POLL_TITLE, pollFrame } from "../support/poll.ts";

test("a poll page on an opaque instance reports shared data unavailable", async ({ page }) => {
  const email = uniqueEmail("opaque-poll");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: POLL_TITLE, html: POLL_HTML }),
  });
  const art = (await res.json()) as { slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const apiCalls: string[] = [];
  const runtime: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/api")) apiCalls.push(r.url());
  });
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/__plinth/runtime.js") runtime.push(r.status());
  });

  await page.goto(`/a/${art.slug}`);
  const frame = await pollFrame(page);
  const ready = await frame.evaluate(() => (window as any).plinth.ready);
  expect(ready).toMatchObject({
    available: false,
    reason: "opaque_isolation",
    canWrite: false,
    viewer: null,
  });
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  const inFrame = page.frameLocator(CURRENT_FRAME);
  await expect(inFrame.locator("#note")).toHaveText("Voting is not available on this server.");
  await expect(inFrame.locator("body")).toHaveAttribute("data-reason", "opaque_isolation");
  await expect(page.getByRole("main").getByRole("note")).toHaveText(
    "Shared data is not available on this server.",
  );
  // A data call fails cleanly with a PlinthError, still without a request.
  expect(
    await frame.evaluate(() =>
      (window as any).plinth.db
        .collection("votes")
        .list()
        .then(
          () => "ok",
          (e: { code: string }) => e.code,
        ),
    ),
  ).toBe("unavailable");

  await page.waitForTimeout(500);
  expect(runtime).toEqual([200]);
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});
