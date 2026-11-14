// The artifact page and its gates, as an anonymous viewer: each visibility, direct content links,
// permanent version links, the report flow through to an admin takedown, and the legal pages.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { signInApi } from "../support/auth.ts";
import { latestCode } from "../support/mail.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

// The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads.
const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const SHOTS = shotsDir("viewer");
const ADMIN = "admin@plinth.local";
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

interface Published {
  id: string;
  slug: string;
  url: string;
  content_url: string;
  version: number;
}

/** An artifact page with a unique marker. */
const html = (marker: string, title = "Exhibit") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main><h1>${marker}</h1><p>Shown on a plinth.</p></main></body></html>`;

const unique = (label: string) =>
  `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Seed an owner with a token and publish through MCP. */
async function publish(input: {
  title: string;
  marker: string;
  visibility?: string;
  password?: string;
  emails?: string[];
}): Promise<Published & { token: string; owner: string }> {
  const owner = uniqueEmail("owner");
  const { token } = await seedToken(owner, { clientType: "claude" });
  const client = await mcpClient(token);
  try {
    const r = await tool<Published>(client, "publish_artifact", {
      title: input.title,
      html: html(input.marker, input.title),
      visibility: input.visibility ?? "unlisted",
      ...(input.password ? { password: input.password } : {}),
      ...(input.emails ? { emails: input.emails } : {}),
    });
    expect(r.isError, r.text).toBe(false);
    return { ...r.data, token, owner };
  } finally {
    await client.close();
  }
}

const isMobile = () => test.info().project.name === "mobile";

/** Wait for entry animations (dialogs, toasts) to finish. */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
}

async function shot(page: Page, name: string) {
  await settle(page);
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`) });
}

/**
 * axe on the app page. The artifact frame is excluded: its HTML is the publisher's, not ours.
 * Entry animations (dialogs, toasts) finish first so colors are measured at rest.
 */
async function expectAccessible(page: Page) {
  await settle(page);
  const results = await new AxeBuilder({ page }).exclude(CURRENT_FRAME).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

const frameOf = (page: Page) => page.locator(CURRENT_FRAME);

/** The frame is on the artifact's own subdomain, sandboxed, and the app page holds none of its HTML. */
async function expectExhibit(page: Page, a: Published, marker: string) {
  await expect(page.frameLocator(CURRENT_FRAME).getByRole("heading", { name: marker })).toBeVisible(
    { timeout: 10_000 },
  );
  const frame = frameOf(page);
  const sandbox = (await frame.getAttribute("sandbox")) ?? "";
  expect(sandbox.split(/\s+/)).toContain("allow-scripts");
  expect(sandbox).toContain(SANDBOX);
  expect(sandbox).not.toContain("allow-top-navigation");
  expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(await frame.getAttribute("allow")).toBe("");
  const src = (await frame.getAttribute("src")) ?? "";
  expect(new URL(src).host).toBe(`${a.id}.${CONTENT_HOST}`);
  expect(new URL(page.url()).origin).toBe(APP_ORIGIN);
  expect(await page.content()).not.toContain(marker);
}

test.describe("artifact page", () => {
  test("unlisted: anyone with the link sees the artifact in a sandboxed frame", async ({
    page,
  }) => {
    const marker = unique("unlisted");
    const a = await publish({ title: "Quarterly garden plan", marker });
    await page.goto(a.url);
    await expectExhibit(page, a, marker);
    await expect(page).toHaveTitle("Quarterly garden plan · Plinth");
    await expect(
      page.getByRole("heading", { level: 1, name: "Quarterly garden plan" }),
    ).toBeVisible();
    // The banner names the platform and carries a report link on every artifact page.
    const banner = page.getByRole("contentinfo");
    await expect(banner).toContainText("Hosted on Plinth");
    await expect(banner.getByRole("link", { name: "open source" })).toHaveAttribute(
      "href",
      "https://github.com/mr0b0t0/plinth",
    );
    await expect(banner.getByRole("link", { name: "Report this artifact" })).toHaveAttribute(
      "href",
      `/a/${a.slug}/report`,
    );
    // A viewer cannot edit, and owner-only chrome is absent.
    if (isMobile()) {
      await page.getByRole("button", { name: "Artifact actions" }).click();
      await expect(page.getByRole("menuitem", { name: "History" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Report" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    } else {
      await expect(page.getByRole("link", { name: "History" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
      await expect(page.getByText("Visibility:")).toHaveCount(0);
    }
    await shot(page, "artifact-unlisted");
    await expectAccessible(page);
  });

  test("password: a wrong password is refused, the right one opens it", async ({ page }) => {
    const marker = unique("pw");
    const a = await publish({
      title: "Board pack",
      marker,
      visibility: "password",
      password: "plinth-secret",
    });
    await page.goto(a.url);
    await expect(page.getByRole("heading", { level: 1, name: "Board pack" })).toBeVisible();
    await expect(frameOf(page)).toHaveCount(0);
    await shot(page, "gate-password");
    await expectAccessible(page);

    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Open artifact" }).click();
    await expect(page.getByText("That password is not right.")).toBeVisible();
    await expect(frameOf(page)).toHaveCount(0);
    await shot(page, "gate-password-wrong");

    await page.getByLabel("Password").fill("plinth-secret");
    await page.getByRole("button", { name: "Open artifact" }).click();
    await expectExhibit(page, a, marker);
  });

  test("allowlist: a listed email confirms by code; another is refused", async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const listed = uniqueEmail("listed");
    const marker = unique("allow");
    const a = await publish({
      title: "Client preview",
      marker,
      visibility: "allowlist",
      emails: [listed],
    });

    // Not on the list: the same answer, but no code works and no frame ever appears.
    const strangerCtx = await browser.newContext();
    const stranger = await strangerCtx.newPage();
    try {
      await stranger.goto(a.url);
      await stranger.getByLabel("Email").fill(uniqueEmail("stranger"));
      await stranger.getByRole("button", { name: "Send code" }).click();
      await expect(stranger.getByText("If this address has access, we sent a code")).toBeVisible();
      await stranger.getByLabel("Six-digit code").fill("123456");
      await stranger.getByRole("button", { name: "Confirm code" }).click();
      await expect(stranger.getByText("That code did not work.")).toBeVisible();
      await expect(stranger.locator("iframe")).toHaveCount(0);
    } finally {
      await strangerCtx.close();
    }

    await page.goto(a.url);
    await expect(page.getByRole("heading", { level: 1, name: "Client preview" })).toBeVisible();
    await shot(page, "gate-email");
    await expectAccessible(page);
    const since = new Date(Date.now() - 1000).toISOString();
    await page.getByLabel("Email").fill(listed);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
    await shot(page, "gate-code");
    await expectAccessible(page);
    const code = await latestCode(page.request, listed, { since });
    await page.getByLabel("Six-digit code").fill(code);
    await page.getByRole("button", { name: "Confirm code" }).click();
    await expectExhibit(page, a, marker);
  });

  test("the owner sees visibility, Edit and the sharing settings", async ({ page }) => {
    const marker = unique("owner");
    const a = await publish({ title: "Owner's view", marker });
    await signInApi(page.request, a.owner);
    await page.goto(a.url);
    await expectExhibit(page, a, marker);
    if (isMobile()) {
      await page.getByRole("button", { name: "Artifact actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
        "href",
        `/a/${a.slug}/edit`,
      );
      await page.getByRole("menuitem", { name: "Share" }).click();
    } else {
      await expect(page.getByText("Visibility:")).toHaveCount(1);
      // Edit sits in the ⋯ menu at every width; Share stays in the bar on wide screens.
      await page.getByRole("button", { name: "Artifact actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
        "href",
        `/a/${a.slug}/edit`,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Share" }).click();
    }
    const dialog = page.getByRole("dialog", { name: "Share this artifact" });
    await expect(dialog.getByLabel("Link")).toHaveValue(`${APP_ORIGIN}/a/${a.slug}`);
    await expect(dialog.getByRole("link", { name: "Sharing settings" })).toHaveAttribute(
      "href",
      `/a/${a.slug}/settings`,
    );
    await expectAccessible(page);
    await shot(page, "share-dialog");
  });

  test("a direct content link opens the artifact framed on its app page", async ({ page }) => {
    const marker = unique("direct");
    const a = await publish({ title: "Direct link", marker });
    // Top-level visits to a content host are sent to the app page: artifacts only render framed,
    // where the sandbox and the app's frame-src stop them navigating away with viewer input.
    await page.goto(a.content_url);
    await expect(page).toHaveURL(`${APP_ORIGIN}/a/${a.slug}`);
    await expectExhibit(page, a, marker);

    // Password-protected deep link: the gate runs on the app page, then the frame opens the page.
    const pwMarker = unique("direct-pw");
    const b = await publish({
      title: "Direct and protected",
      marker: pwMarker,
      visibility: "password",
      password: "open-sesame",
    });
    await page.goto(`${b.content_url}deep?x=1`);
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/a/(${b.slug}|${b.id})\\?path=`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Direct and protected" }),
    ).toBeVisible();
    await shot(page, "open-gate");
    await expectAccessible(page);
    await page.getByLabel("Password").fill("open-sesame");
    await page.getByRole("button", { name: "Open artifact" }).click();
    const src = (await frameOf(page).getAttribute("src")) ?? "";
    expect(new URL(src).searchParams.get("next")).toBe("/deep?x=1");
    await page.goto(b.content_url);
    await expectExhibit(page, b, pwMarker);
  });

  test("a version link keeps showing that version after an update", async ({ page }) => {
    const v1 = unique("first");
    const v2 = unique("second");
    const a = await publish({ title: "Versioned", marker: v1 });
    const client = await mcpClient(a.token);
    try {
      const r = await tool(client, "update_artifact", { id: a.id, html: html(v2), note: "v2" });
      expect(r.isError, r.text).toBe(false);
    } finally {
      await client.close();
    }
    await page.goto(`/a/${a.slug}/v/1`);
    await expectExhibit(page, a, v1);
    await expect(page.getByText(/You are viewing\s*v1/)).toBeVisible();
    await shot(page, "artifact-old-version");
    await expectAccessible(page);
    await page.getByRole("link", { name: /Go to current/ }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/a/${a.slug}`);
    await expectExhibit(page, a, v2);
    await expect(page.getByText(/You are viewing/)).toHaveCount(0);
  });

  test("an unknown artifact is not found", async ({ page }) => {
    await page.goto("/a/no-such-artifact-here");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
  });
});

test.describe("reports and takedown", () => {
  test("a report reaches the admin, who takes the artifact down", async ({ page, browser }) => {
    test.setTimeout(60_000);
    const marker = unique("reported");
    const title = unique("Suspicious page");
    const a = await publish({ title, marker });

    // The viewer has the artifact open (and a content cookie) before the takedown.
    await page.goto(a.url);
    await expectExhibit(page, a, marker);
    await page.getByRole("contentinfo").getByRole("link", { name: "Report this artifact" }).click();
    await expect(page).toHaveURL(`${APP_ORIGIN}/a/${a.slug}/report`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Report this artifact" }),
    ).toBeVisible();
    await expect(page.getByText(title)).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByText("Say what is wrong with this artifact.")).toBeVisible();
    await page
      .getByLabel("What is wrong with this artifact?")
      .fill("It asks for my bank password.");
    await page.getByLabel("Your email (optional)").fill("reporter@example.com");
    await shot(page, "report");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(
      page.getByRole("heading", { name: "Thank you. Your report was sent." }),
    ).toBeVisible();
    await shot(page, "report-sent");
    await expectAccessible(page);

    // Not an admin: the admin page does not exist.
    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    try {
      await signInApi(admin.request, ADMIN);
      await admin.goto("/admin/reports");
      await expect(admin.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
      const card = admin.getByRole("listitem").filter({ hasText: title });
      await expect(card).toContainText("It asks for my bank password.");
      await expect(card).toContainText("reporter@example.com");
      await expect(card.getByRole("link", { name: title })).toHaveAttribute("href", `/a/${a.slug}`);
      await shot(admin, "admin-reports");
      await expectAccessible(admin);
      await card.getByRole("button", { name: "Take down" }).click();
      const confirm = admin.getByRole("alertdialog");
      await expect(confirm).toContainText(title);
      await shot(admin, "admin-takedown-confirm");
      await confirm.getByRole("button", { name: "Take down artifact" }).click();
      await expect(admin.getByText("Artifact taken down")).toBeVisible();
      await expect(admin.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
      await admin.getByRole("tab", { name: "Taken down" }).click();
      await expect(admin.getByRole("listitem").filter({ hasText: title })).toBeVisible();
    } finally {
      await adminCtx.close();
    }

    // The artifact page shows the takedown notice; the content host no longer serves it, even
    // with the cookie this browser already holds.
    await page.goto(a.url);
    await expect(page.getByText("No longer on view")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await shot(page, "taken-down");
    await expectAccessible(page);
    // A top-level visit to the content address lands on the same notice (artifacts render only
    // framed); the content host itself answers 404 and clears the origin's storage.
    await page.goto(a.content_url);
    await expect(page.getByText("No longer on view")).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);
    const res = await page.request.get(a.content_url, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()["clear-site-data"]).toBe('"storage"');
  });
});

test.describe("legal pages", () => {
  for (const [doc, title] of [
    ["terms", "Terms of use"],
    ["privacy", "Privacy notice"],
    ["acceptable-use", "Acceptable use policy"],
  ] as const) {
    test(`${doc} renders with the instance's operator`, async ({ page }) => {
      await page.goto(`/legal/${doc}`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page).toHaveTitle(`${title} · Plinth`);
      await expect(page.getByText(/template|placeholder/i)).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "hello@operator.example" }).first(),
      ).toBeVisible();
      await shot(page, `legal-${doc}`);
      await expectAccessible(page);
    });
  }

  test("an unknown legal page is not found", async ({ page }) => {
    await page.goto("/legal/cookies");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
