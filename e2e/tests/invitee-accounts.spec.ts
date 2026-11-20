// Invitees get an account (docs/spec.md "Auth and permissions", Viewers): someone an artifact is
// shared with by email opens the link, confirms their address with the emailed code at the gate,
// and is signed in to Plinth with it (an account created on first use, no viewer cookie). The
// artifact then shows under Shared on their dashboard and opens from there.
import { expect, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { latestCode } from "../support/mail.ts";
import { CURRENT_FRAME } from "../support/poll.ts";
import { seedToken } from "../support/tokens.ts";

test("an invitee confirms the code at the gate, is signed in, and finds the artifact on the dashboard", async ({
  page,
}) => {
  // One project is enough: every viewing code in the suite counts against one per-IP limit (the
  // e2e Worker ignores client IPs), so code flows run in one project only.
  test.skip(test.info().project.name !== "light", "code flows run in the light project only");
  test.setTimeout(60_000);
  const owner = uniqueEmail("inv-owner");
  const invitee = uniqueEmail("inv-guest");
  const title = `Client brief ${Date.now().toString(36)}`;
  const { token } = await seedToken(owner, { clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title,
    html: `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>For the client</h1></body></html>`,
    visibility: "allowlist",
    emails: [invitee],
  });

  // The gate says what confirming does before anyone asks for a code.
  await page.goto(art.url);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Sign in with a one-time code.", { exact: false })).toBeVisible();

  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email").fill(invitee);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
  // On the code step the sent-code line is the only text above the field.
  await expect(page.getByText("Sign in with a one-time code.", { exact: false })).toBeHidden();
  const code = await latestCode(page.request, invitee, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
  await expect(
    page.frameLocator(CURRENT_FRAME).getByRole("heading", { name: "For the client" }),
  ).toBeVisible({ timeout: 10_000 });

  // Signed in: the session is a normal account session, and there is no viewer cookie.
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => c.name)).toContain("__Host-plinth_session");
  expect(cookies.map((c) => c.name)).not.toContain("__Host-plinth_viewer");
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(invitee);

  // The dashboard lists the artifact under Shared.
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Shared" }).check();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${art.slug}$`));
  await expect(
    page.frameLocator(CURRENT_FRAME).getByRole("heading", { name: "For the client" }),
  ).toBeVisible({ timeout: 10_000 });
});
