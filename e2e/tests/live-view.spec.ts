// Live views end to end (docs/spec.md "Live views"): the app page's watch socket on the app host.
// A version an agent publishes shows on an open page within seconds on real timers; a vote on a
// poll reaches another person's open page within seconds; a refused socket leaves the 15 s poll
// working; and taking a person's access away closes their socket and the page asks for an email.
import { expect, type Page, test, type WebSocket } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { CURRENT_FRAME, POLL_HTML, pollFrame } from "../support/poll.ts";
import { seedToken } from "../support/tokens.ts";

const page1 = (heading: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title></head><body><h1>${heading}</h1></body></html>`;

/** Resolves with the watch socket once its welcome arrived. */
function watchOpened(page: Page): Promise<WebSocket> {
  return new Promise((resolve) => {
    page.on("websocket", (ws) => {
      if (!/\/api\/v1\/view\/[a-z0-9]+\/watch$/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        if (typeof f.payload === "string" && f.payload.includes('"t":"welcome"')) resolve(ws);
      });
    });
  });
}

async function update(token: string, id: string, html: string, base: number) {
  const client = await mcpClient(token);
  try {
    const r = await tool(client, "update_artifact", { id, html, base_version: base });
    expect(r.isError).toBe(false);
  } finally {
    await client.close();
  }
}

test("a version an agent publishes shows on an open page within seconds", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("owner"));
  const art = await publishArtifact(page.request, token, { html: page1("First draft") });
  const opened = watchOpened(page);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("First draft");
  const ws = await opened;
  expect(ws.url()).toBe(
    `${new URL(page.url()).origin.replace(/^http/, "ws")}/api/v1/view/${art.id}/watch`,
  );

  const started = Date.now();
  await update(token, art.id, page1("Second draft"), 1);
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 5_000 });
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText(
    "Second draft",
    { timeout: 5_000 },
  );
  // Well before the 15 s poll would have noticed.
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a vote reaches another person's open poll within seconds", async ({ page, browser }) => {
  const ownerEmail = uniqueEmail("poll-owner");
  const guestEmail = uniqueEmail("poll-guest");
  const { token } = await seedToken(ownerEmail);
  const art = await publishArtifact(page.request, token, {
    html: POLL_HTML,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: guestEmail, role: "viewer" }] },
    { token },
  );
  expect(shared.status).toBe(200);

  await seedSession(page.context(), ownerEmail);
  const opened = watchOpened(page);
  await page.goto(`/a/${art.slug}`);
  await pollFrame(page);
  await opened;
  const tally = page.frameLocator(CURRENT_FRAME).locator("#total");
  await expect(tally).toHaveText("0");

  const guestCtx = await browser.newContext();
  try {
    await seedSession(guestCtx, guestEmail);
    const guest = await guestCtx.newPage();
    await guest.goto(`/a/${art.slug}`);
    await pollFrame(guest);
    await guest.frameLocator(CURRENT_FRAME).getByRole("button", { name: "Tacos" }).click();
    await expect(guest.frameLocator(CURRENT_FRAME).locator("#note")).toHaveText("Saved: tacos");
    // The owner's page did not wait for its poll (15 s, or 60 s while pushed).
    await expect(tally).toHaveText("1", { timeout: 5_000 });
  } finally {
    await guestCtx.close();
  }
});

test("a refused watch socket leaves the 15 s poll working", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("owner"));
  const art = await publishArtifact(page.request, token, { html: page1("Steady") });
  let refused = 0;
  await page.routeWebSocket(/\/api\/v1\/view\/[a-z0-9]+\/watch$/, (ws) => {
    refused++;
    ws.close({ code: 4409, reason: "full" });
  });
  await page.clock.install();
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("Steady");
  await expect.poll(() => refused).toBe(1);

  await update(token, art.id, page1("Moved on"), 1);
  await page.clock.fastForward(16_000);
  await expect(page.getByText("Updated to v2")).toBeVisible();
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText(
    "Moved on",
  );
  // A full socket is tried again only after 5 minutes.
  expect(refused).toBe(1);
});

test("taking a person's access away closes their socket and the page asks for an email", async ({
  page,
}) => {
  const ownerEmail = uniqueEmail("owner");
  const guestEmail = uniqueEmail("guest");
  const { token } = await seedToken(ownerEmail);
  const art = await publishArtifact(page.request, token, {
    html: page1("For invited people"),
    visibility: "allowlist",
  });
  const share = (grants: { email: string; role: string }[]) =>
    apiPut(page.request, `/artifacts/${art.id}/sharing`, { grants }, { token });
  expect((await share([{ email: guestEmail, role: "viewer" }])).status).toBe(200);

  await seedSession(page.context(), guestEmail);
  const opened = watchOpened(page);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("For invited people");
  const ws = await opened;
  const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));

  expect((await share([])).status).toBe(200);
  await closed;
  await expect(page.getByLabel("Email")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(CURRENT_FRAME)).toHaveCount(0);
});
