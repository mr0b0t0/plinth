// Version history: the list, compare (source and rendered), restore with conflict handling,
// permanent version links, access states and the axe checks for History and Compare.
import { mkdirSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, type TestInfo, test } from "@playwright/test";
import { apiGet, uniqueEmail } from "../support/api.ts";
import { signInApi } from "../support/auth.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const SHOTS =
  process.env.PLINTH_SHOTS_DIR ??
  "/private/tmp/claude-501/-Users-germanvoronin-Desktop-dev-plinth/c1991650-3525-4b3e-bfae-4f86919521e3/scratchpad/shots-history";

const TITLE = "Quarterly notes";
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const filler = Array.from({ length: 24 }, (_, i) => `<p>Unchanged paragraph ${i + 1}</p>`);
const doc = (h1: string, body: string[]) =>
  [
    "<!doctype html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${TITLE}</title></head>`,
    // No <main>: axe merges framed documents into the page, and a second main landmark would be
    // reported against the app. Artifact content is the author's, not the app's.
    "<body>",
    `<h1>${h1}</h1>`,
    ...body,
    ...filler,
    "</body>",
    "</html>",
  ].join("\n");

const V1 = doc("Version one", ["<p>Alpha line</p>"]);
const V2 = doc("Version one", ["<p>Beta line</p>"]);
const V3 = doc("Version three", ["<p>Beta line</p>", "<p>Gamma line</p>"]);

interface Seeded {
  email: string;
  token: string;
  slug: string;
  id: string;
}

/**
 * Publish `versions[0]` and update through the rest over MCP, each with base_version. The local
 * D1 file is shared with `wrangler d1 execute` seeding from parallel workers and can briefly
 * report SQLITE_BUSY ("internal"); then the whole artifact is published again from scratch, so a
 * half-written attempt never leaks into the test.
 */
async function publishVersions(
  token: string,
  title: string,
  versions: { html: string; note?: string }[],
  extra: Record<string, unknown> = {},
): Promise<{ id: string; slug: string }> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await mcpClient(token);
    try {
      const [first, ...rest] = versions;
      const pub = await tool<{ id: string; slug: string }>(client, "publish_artifact", {
        title,
        html: first?.html,
        ...extra,
      });
      let failed = pub.isError ? pub.text : "";
      for (const [i, v] of rest.entries()) {
        if (failed) break;
        const r = await tool(client, "update_artifact", {
          id: pub.data.id,
          html: v.html,
          note: v.note,
          base_version: i + 1,
        });
        if (r.isError) failed = r.text;
      }
      if (!failed) return pub.data;
      if (!failed.includes('"internal"')) throw new Error(`seeding failed: ${failed}`);
      last = failed;
    } finally {
      await client.close();
    }
  }
  throw new Error(`seeding kept failing: ${last}`);
}

/** An owner with an agent token; v1 published and updated to v3 over MCP, with notes. */
async function seedHistory(opts: { visibility?: string; password?: string } = {}): Promise<Seeded> {
  const email = uniqueEmail("history");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  const { id, slug } = await publishVersions(
    token,
    TITLE,
    [{ html: V1 }, { html: V2, note: "Second pass" }, { html: V3, note: "Retitle and add gamma" }],
    // New artifacts are private; these tests are about link viewers unless they say otherwise.
    { visibility: "unlisted", ...opts },
  );
  return { email, token, slug, id };
}

async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS, `${info.project.name}-${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

/** A signed-in page in a new browser context (for a second person or tab). */
async function secondBrowser(browser: Browser, email: string, info: TestInfo) {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    colorScheme: info.project.use.colorScheme,
    viewport: info.project.use.viewport,
  });
  await signInApi(context.request, email);
  return { context, page: await context.newPage() };
}

const rows = (page: Page) => page.getByRole("list", { name: "Versions" }).getByRole("listitem");
const row = (page: Page, n: number) => page.locator(`li[data-version="${n}"]`);

test("history lists every version with author, note and links", async ({ page }, info) => {
  const s = await seedHistory();
  await signInApi(page.request, s.email);
  await page.goto(`/a/${s.slug}/history`);

  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page).toHaveTitle(`History of ${TITLE} · Plinth`);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).getByRole("heading", { level: 2 })).toHaveText("v3");
  await expect(rows(page).nth(1).getByRole("heading", { level: 2 })).toHaveText("v2");
  await expect(rows(page).nth(2).getByRole("heading", { level: 2 })).toHaveText("v1");

  await expect(row(page, 3)).toContainText("Retitle and add gamma");
  await expect(row(page, 3)).toContainText("Current");
  await expect(row(page, 2)).toContainText("Second pass");
  await expect(row(page, 1)).toContainText("No note");
  for (const n of [1, 2, 3]) {
    await expect(row(page, n)).toContainText("Agent: Work agent");
  }
  // The date has its full timestamp in a tooltip, reachable by keyboard.
  await row(page, 3).locator("time").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();

  // Permanent version links. The artifact page renders them (another workstream); check the link
  // here and the stored content of v1 through the API.
  await expect(row(page, 1).getByRole("link", { name: "View v1" })).toHaveAttribute(
    "href",
    `/a/${s.slug}/v/1`,
  );
  const v1 = await apiGet(page.request, `/artifacts/${s.slug}/versions/1`);
  expect(v1.status).toBe(200);
  expect(v1.body.html).toBe(V1);
  const res = await page.goto(`/a/${s.slug}/v/1`);
  expect(res?.status()).toBe(200);
  await page.goBack();

  await expect(rows(page)).toHaveCount(3);
  await expectNoAxeViolations(page);
  await shot(page, info, "history");
});

test("compare v1 and v3: source diff, side by side, and rendered frames", async ({
  page,
}, info) => {
  const s = await seedHistory();
  await signInApi(page.request, s.email);
  await page.goto(`/a/${s.slug}/history`);

  await row(page, 1).getByRole("checkbox", { name: "Select v1 to compare" }).check();
  await row(page, 3).getByRole("checkbox", { name: "Select v3 to compare" }).check();
  await page.getByRole("button", { name: "Compare selected" }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${s.slug}/compare\\?from=1&to=3$`));
  await expect(page).toHaveTitle(`Compare v1 and v3 of ${TITLE} · Plinth`);

  // Source: the changed lines, with markers, and the unchanged run folded.
  const diff = page.getByRole("table", { name: /Changes to index.html from v1 to v3/ });
  await expect(diff).toBeVisible();
  await expect(diff.getByRole("row", { name: /Removed <h1>Version one<\/h1>/ })).toBeVisible();
  await expect(diff.getByRole("row", { name: /Added <h1>Version three<\/h1>/ })).toBeVisible();
  await expect(diff.getByRole("row", { name: /Removed <p>Alpha line<\/p>/ })).toBeVisible();
  await expect(diff.getByRole("row", { name: /Added <p>Gamma line<\/p>/ })).toBeVisible();
  const fold = diff.getByRole("button", { name: /Show \d+ unchanged lines/ });
  await expect(fold).toBeVisible();
  await expect(page.locator(".hx-stat--added")).toHaveText(/^\+3/);
  await expect(page.locator(".hx-stat--removed")).toHaveText(/^−2/);
  await expectNoAxeViolations(page);
  await shot(page, info, "compare-source");

  await fold.click();
  await expect(diff.getByRole("row", { name: /Unchanged paragraph 12/ })).toBeVisible();

  if (info.project.name !== "mobile") {
    await page.getByRole("radio", { name: "Side by side" }).check();
    const split = page.getByRole("table", { name: /v1 on the left and v3 on the right/ });
    await expect(split).toBeVisible();
    await expect(
      split
        .getByRole("row")
        .filter({ hasText: "Version one" })
        .filter({ hasText: "Version three" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await shot(page, info, "compare-split");
  }

  // Swap sides.
  await page.getByRole("button", { name: "Swap sides" }).click();
  await expect(page).toHaveURL(/compare\?from=3&to=1$/);
  await page.getByRole("button", { name: "Swap sides" }).click();
  await expect(page).toHaveURL(/compare\?from=1&to=3$/);

  // Rendered: both versions in sandboxed frames on the content host.
  await page.getByRole("tab", { name: "Rendered" }).click();
  await expect(page).toHaveURL(/view=rendered/);
  const f1 = page.locator(`iframe[title="v1 of ${TITLE}"]`);
  const f3 = page.locator(`iframe[title="v3 of ${TITLE}"]`);
  for (const f of [f1, f3]) {
    await expect(f).toHaveAttribute("sandbox", SANDBOX);
    await expect(f).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(f).toHaveAttribute("src", new RegExp(`^http://${s.id}\\.content\\.localhost:`));
  }
  await expect(
    page
      .frameLocator(`iframe[title="v1 of ${TITLE}"]`)
      .getByRole("heading", { name: "Version one" }),
  ).toBeVisible();
  await expect(
    page.frameLocator(`iframe[title="v3 of ${TITLE}"]`).getByText("Gamma line"),
  ).toBeVisible();
  await expect(
    page.frameLocator(`iframe[title="v1 of ${TITLE}"]`).getByText("Gamma line"),
  ).toHaveCount(0);
  await expect(page.getByRole("figure", { name: "v1" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "v3" })).toBeVisible();
  await expectNoAxeViolations(page);
  await shot(page, info, "compare-rendered");
});

test("restore v1 publishes it as v4; a stale restore elsewhere gets the conflict message", async ({
  page,
  browser,
}, info) => {
  const s = await seedHistory();
  await signInApi(page.request, s.email);
  await page.goto(`/a/${s.slug}/history`);
  await expect(rows(page)).toHaveCount(3);

  // A second browser opens the same history before the restore.
  const other = await secondBrowser(browser, s.email, info);
  try {
    await other.page.goto(`/a/${s.slug}/history`);
    await expect(rows(other.page)).toHaveCount(3);

    await row(page, 1).getByRole("button", { name: "More actions for v1" }).click();
    await page.getByRole("menuitem", { name: "Restore v1" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore v1?" });
    await expect(dialog).toContainText("This publishes v1's content as v4. Nothing is lost");
    await shot(page, info, "restore-dialog");
    await dialog.getByRole("button", { name: "Restore v1" }).click();
    await expect(page.getByText("Restored v1")).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    await expect(row(page, 4)).toContainText("Restored from v1");
    await expect(row(page, 4)).toContainText("Current");

    const v4 = await apiGet(page.request, `/artifacts/${s.slug}/versions/4`);
    expect(v4.body.html).toBe(V1);

    // The other browser still thinks v3 is current: its restore is refused, nothing is lost.
    await row(other.page, 2).getByRole("button", { name: "More actions for v2" }).click();
    await other.page.getByRole("menuitem", { name: "Restore v2" }).click();
    await other.page
      .getByRole("dialog", { name: "Restore v2?" })
      .getByRole("button", { name: "Restore v2" })
      .click();
    await expect(other.page.getByText("Someone published meanwhile")).toBeVisible();
    await expect(rows(other.page)).toHaveCount(4);
    await expect(row(other.page, 4)).toContainText("Restored from v1");
    await shot(other.page, info, "restore-conflict");

    const list = await apiGet(page.request, `/artifacts/${s.slug}/versions`);
    expect(list.body.items).toHaveLength(4);
  } finally {
    await other.context.close();
  }
});

test("viewers without a role see the history but cannot restore", async ({ browser }, info) => {
  const s = await seedHistory();
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    colorScheme: info.project.use.colorScheme,
    viewport: info.project.use.viewport,
  });
  try {
    const page = await context.newPage();
    await page.goto(`/a/${s.slug}/history`);
    await expect(rows(page)).toHaveCount(3);
    await row(page, 1).getByRole("button", { name: "More actions for v1" }).click();
    await expect(page.getByRole("menuitem", { name: "Compare with current" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Restore/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a password-protected history explains how to get in", async ({ browser }, info) => {
  const s = await seedHistory({ visibility: "password", password: "correct horse 42" });
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    colorScheme: info.project.use.colorScheme,
    viewport: info.project.use.viewport,
  });
  try {
    const page = await context.newPage();
    await page.goto(`/a/${s.slug}/history`);
    await expect(
      page.getByRole("heading", { level: 1, name: "You can't see this yet" }),
    ).toBeVisible();
    await expect(page.getByText("This artifact needs a password")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the artifact" })).toHaveAttribute(
      "href",
      `/a/${s.slug}`,
    );
    await page.goto(`/a/${s.slug}/compare?from=1&to=2`);
    await expect(
      page.getByRole("heading", { level: 1, name: "You can't see this yet" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  } finally {
    await context.close();
  }
});

test("a 5,000-line document diffs quickly and renders in pages", async ({ page }, info) => {
  const email = uniqueEmail("history-big");
  const { token } = await seedToken(email, { label: "Work agent" });
  const lines = Array.from({ length: 5000 }, (_, i) => `<p class="r${i}">Row ${i}</p>`);
  const big = (edit: (l: string, i: number) => string) =>
    `<!doctype html>\n<html lang="en">\n<head><title>Big</title></head>\n<body>\n${lines.map(edit).join("\n")}\n</body>\n</html>`;
  // v2: 100 scattered edits. v3: every line changed.
  const { slug } = await publishVersions(token, "Big document", [
    { html: big((l) => l) },
    { html: big((l, i) => (i % 50 === 0 ? l.replace("Row", "Line") : l)) },
    { html: big((l) => l.replace("Row", "Changed row")) },
  ]);
  await signInApi(page.request, email);

  // Scattered edits: unchanged runs fold, so each edit shows 2 changed and 6 context rows.
  const t0 = Date.now();
  await page.goto(`/a/${slug}/compare?from=1&to=2`);
  const table = page.getByRole("table", { name: /Changes to index.html from v1 to v2/ });
  await expect(table).toBeVisible();
  const scatteredMs = Date.now() - t0;
  await expect(page.locator(".hx-stat--added")).toHaveText(/^\+100\b/);
  expect(await table.locator("tr.hx-line").count()).toBeLessThan(1000);

  // Everything changed: the diff stays bounded and renders the first page of rows.
  const t1 = Date.now();
  await page.goto(`/a/${slug}/compare?from=1&to=3`);
  const all = page.getByRole("table", { name: /Changes to index.html from v1 to v3/ });
  await expect(all).toBeVisible();
  const replacedMs = Date.now() - t1;
  await expect(page.locator(".hx-stat--added")).toHaveText(/^\+5,000\b/);
  expect(await all.locator("tr.hx-line").count()).toBe(1500);
  await page.getByRole("button", { name: /Show 1,500 more lines/ }).click();
  await expect(all.locator("tr.hx-line")).toHaveCount(3000);

  info.annotations.push({
    type: "timing",
    description: `5,000 lines: scattered edits ${scatteredMs} ms, full rewrite ${replacedMs} ms`,
  });
  console.log(
    `[${info.project.name}] 5,000-line diff: scattered ${scatteredMs} ms, rewrite ${replacedMs} ms`,
  );
  expect(scatteredMs).toBeLessThan(5000);
  expect(replacedMs).toBeLessThan(5000);
});
