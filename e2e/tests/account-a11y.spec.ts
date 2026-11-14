// Accessibility and layout of the account pages in every project (light, dark, mobile 360px):
// axe finds no violations, nothing scrolls sideways. With PLINTH_E2E_SHOTS=<dir> set, each page
// is also saved as a screenshot there (for looking at the work; never written into the repo).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { APP_ORIGIN, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession as seedContextSession } from "../support/db.ts";
import { createToken } from "../support/tokens.ts";

const SHOTS = process.env.PLINTH_E2E_SHOTS;

async function check(page: Page, info: TestInfo, name: string): Promise<void> {
  // Let entrance animations settle so axe sees final colors.
  await page.waitForTimeout(350);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`),
    })),
    `axe violations on ${name}`,
  ).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${name}`).toBeLessThanOrEqual(0);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: path.join(SHOTS, `${info.project.name}-${name}.png`),
      fullPage: true,
    });
  }
}

test("signed-out pages: home, sign-in steps, magic link", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await check(page, info, "home");

  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await check(page, info, "login");

  await page.getByLabel("Email").fill(uniqueEmail("a11y-login"));
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByLabel("Six-digit code")).toBeVisible();
  await page.getByLabel("Six-digit code").fill("12");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter the six digits from the email.")).toBeVisible();
  await check(page, info, "login-code");

  await page.goto("/login/magic?token=not-a-real-token-but-long-enough");
  await expect(page.getByRole("heading", { name: "Finish signing in" })).toBeVisible();
  await check(page, info, "magic");
});

test("signed-in pages: dashboard, connections, consent, settings", async ({ page }, info) => {
  test.setTimeout(90_000);
  const email = uniqueEmail("a11y");
  await seedContextSession(page.context(), email);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Nothing on display yet" })).toBeVisible();
  await check(page, info, "dashboard-empty");

  // Nothing connected yet: the Connect panel is open. Check a tab with a link and one with a
  // copyable command block.
  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await check(page, info, "connections-connect");
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByRole("button", { name: "Copy Claude Code commands" })).toBeVisible();
  await check(page, info, "connections-connect-cli");
  await page.getByRole("tab", { name: "Cursor" }).click();
  await expect(page.getByRole("link", { name: "Add to Cursor" })).toBeVisible();
  await check(page, info, "connections-connect-cursor");

  const { token } = await createToken(page.request, {
    label: "Work Claude",
    client_type: "claude",
  });
  const a = await publishArtifact(page.request, token, {
    title: "Quarterly revenue with a fairly long title that has to wrap on a phone",
  });
  await publishArtifact(page.request, token, { title: "Team offsite plan" });

  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Team offsite plan" })).toBeVisible();
  await check(page, info, "dashboard");
  await page.getByRole("button", { name: "Actions for Team offsite plan" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await check(page, info, "dashboard-menu");
  await page.keyboard.press("Escape");

  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Work Claude" })).toBeVisible();
  await check(page, info, "connections");
  await page.getByText("Advanced: personal access tokens for scripts and CI").click();
  await check(page, info, "connections-advanced");
  await page.getByRole("button", { name: "New token" }).click();
  await expect(page.getByRole("dialog", { name: "New token" })).toBeVisible();
  await check(page, info, "connections-new-token");
  await page.getByRole("dialog").getByLabel("Name").fill("Codex");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByRole("dialog", { name: "Copy your new token" })).toBeVisible();
  await check(page, info, "connections-token");
  await page.getByRole("button", { name: "Done" }).click();

  await page.goto(`/a/${a.slug}/settings`);
  await expect(page.getByRole("button", { name: "Save access" })).toBeVisible();
  await page.getByRole("radio", { name: /^Password/ }).check();
  await check(page, info, "settings");
  await page.getByRole("button", { name: "Delete artifact" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await check(page, info, "settings-delete");
  await page.keyboard.press("Escape");

  // Consent: a registered client with a loopback redirect, then the authorize hand-off.
  const redirectUri = "http://127.0.0.1:47123/callback";
  const reg = await page.request.post("/oauth/register", {
    data: { client_name: "Claude", redirect_uris: [redirectUri] },
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "a11y",
    resource: `${APP_ORIGIN}/mcp`,
  });
  // The Connections page waits for the new agent in a second tab.
  const watcher = await page.context().newPage();
  await watcher.goto("/connections?connect=1");
  await expect(watcher.getByRole("heading", { name: "Connect an agent" })).toBeVisible();

  await page.route("http://127.0.0.1:47123/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "callback reached" }),
  );
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await check(page, info, "consent");
  await page.getByRole("button", { name: "Change name" }).click();
  await expect(page.getByLabel("Name this connection")).toBeVisible();
  await check(page, info, "consent-change-name");
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL((u) => u.host === "127.0.0.1:47123");

  await expect(watcher.getByText("Claude is connected.")).toBeVisible({ timeout: 10_000 });
  await check(watcher, info, "connections-connected");
  await watcher.close();

  await page.goto("/oauth/consent?request=unknown");
  await expect(page.getByRole("heading", { name: "This request has expired" })).toBeVisible();
  await check(page, info, "consent-expired");
});
