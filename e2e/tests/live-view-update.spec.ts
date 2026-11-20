// Live views end to end, applying a new version while keeping the reader's state (docs/spec.md
// "Live views"): a doc scrolled to a lower heading updates in place (no new enter request) and the
// heading stays where it was, and an image the new version changed under the same name shows the
// new file; a page with the runtime hands its state and scroll to the next
// version; a page that declares `hold` waits while the viewer types in it, and Update loads it.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { CURRENT_FRAME } from "../support/poll.ts";
import { seedToken } from "../support/tokens.ts";

async function update(token: string, id: string, body: Record<string, unknown>, base: number) {
  const client = await mcpClient(token);
  try {
    const r = await tool(client, "update_artifact", { id, ...body, base_version: base });
    expect(r.isError, r.text).toBe(false);
  } finally {
    await client.close();
  }
}

/** The Frame object of the frame on view. */
async function shownFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

/** Records every content-host enter request, the one a fresh frame makes. */
function enters(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/enter?")) seen.push(r.url());
  });
  return seen;
}

const sections = (n: number, extra = "") =>
  Array.from(
    { length: n },
    (_, i) =>
      `## Section ${i + 1}\n\n${i === 3 ? extra : ""}${"A paragraph that takes up some room on the page. ".repeat(12)}\n`,
  ).join("\n");

test("a doc updates in place and keeps the heading the reader was at", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("doc-live"));
  const v1 = `# Field notes\n\n${sections(20)}`;
  const art = await publishArtifact(page.request, token, {
    type: "doc",
    content: v1,
    html: undefined,
  });
  const entered = enters(page);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1);
  const frame = await shownFrame(page);
  const heading = frame.locator("#section-12");
  await heading.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await frame.evaluate(() => window.scrollBy(0, -40));
  const before = await heading.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(before).toBeGreaterThan(20);
  expect(entered).toHaveLength(1);

  // Two new paragraphs above the heading, and a new last line.
  const v2 = `# Field notes\n\n${sections(20, "A new paragraph near the top.\n\nAnd another one.\n\n")}\nThe end.\n`;
  await update(token, art.id, { content: v2 }, 1);
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('iframe[title$="version 2"]')).toHaveCount(1);
  await expect(frame.getByText("A new paragraph near the top.")).toHaveCount(1);
  await expect(frame.getByText("The end.")).toHaveCount(1);
  // Same frame, no new enter request, and the heading where it was.
  expect(await shownFrame(page)).toBe(frame);
  expect(entered).toHaveLength(1);
  const after = await heading.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});

const CHART = (width: number) => ({
  path: "chart.svg",
  content: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40"><rect width="${width}" height="40" fill="#4a7"/></svg>`,
  content_type: "image/svg+xml",
});

test("a doc updated in place shows the new version's image under the same name", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("doc-live-image"));
  const art = await publishArtifact(page.request, token, {
    type: "doc",
    content: "# Report\n\n![Chart](chart.svg)\n\nFirst draft.\n",
    html: undefined,
    assets: [CHART(100)],
  });
  const entered = enters(page);
  await page.goto(`/a/${art.slug}`);
  const current = page.frameLocator(CURRENT_FRAME);
  await expect(current.locator('html[data-ready="ok"]')).toHaveCount(1);
  const frame = await shownFrame(page);
  const width = () =>
    frame.locator("img").evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0));
  await expect.poll(width).toBe(100);

  await update(
    token,
    art.id,
    { content: "# Report\n\n![Chart](chart.svg)\n\nSecond draft.\n", assets: [CHART(300)] },
    1,
  );
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  await expect(frame.getByText("Second draft.")).toHaveCount(1);
  // In place (the same frame, no new enter request), and the chart is v2's, not the one v1 loaded.
  expect(await shownFrame(page)).toBe(frame);
  expect(entered).toHaveLength(1);
  await expect.poll(width).toBe(300);
});

const RUNTIME_PAGE = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Notes</title><script src="/__plinth/runtime.js"></script></head><body>
<h1>${title}</h1><label>Draft <input id="draft"></label><p id="carried">none</p>
<div style="height: 3000px"></div>
<script>
  var input = document.getElementById("draft");
  if (plinth.carried && plinth.carried.state) {
    input.value = plinth.carried.state.draft;
    document.getElementById("carried").textContent =
      "from v" + plinth.carried.from + ": " + plinth.carried.state.draft;
  }
  plinth.onVersion(function () {
    return { state: { draft: input.value } };
  });
</script></body></html>`;

test("a page with the runtime hands its state and scroll to the next version", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("runtime-live"));
  const art = await publishArtifact(page.request, token, { html: RUNTIME_PAGE("First") });
  await page.goto(`/a/${art.slug}`);
  const current = page.frameLocator(CURRENT_FRAME);
  await expect(current.locator("h1")).toHaveText("First");
  await current.locator("#draft").fill("half a sentence");
  const frame = await shownFrame(page);
  await frame.evaluate(() => window.scrollTo(0, 600));

  await update(token, art.id, { html: RUNTIME_PAGE("Second") }, 1);
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  const next = page.frameLocator('iframe[title$="version 2"]');
  await expect(next.locator("h1")).toHaveText("Second");
  await expect(next.locator("#carried")).toHaveText("from v1: half a sentence");
  await expect(next.locator("#draft")).toHaveValue("half a sentence");
  const shown = await shownFrame(page, 'iframe[title$="version 2"]');
  await expect.poll(() => shown.evaluate(() => Math.round(window.scrollY))).toBe(600);
});

test("a page with the runtime keeps its query as it was, and gets its hash back", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("runtime-place"));
  const art = await publishArtifact(page.request, token, { html: RUNTIME_PAGE("First") });
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toHaveText("First");
  const frame = await shownFrame(page);
  // A query that form-data serialization would rewrite (%20 to +, a bare name to "name=").
  const place = "/?q=a%20b&tab&p=/x/y";
  await frame.evaluate((p) => history.replaceState(null, "", `${p}#step-3`), place);

  await update(token, art.id, { html: RUNTIME_PAGE("Second") }, 1);
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText("Second");
  const shown = await shownFrame(page, 'iframe[title$="version 2"]');
  expect(await shown.evaluate(() => location.pathname + location.search)).toBe(place);
  expect(await shown.evaluate(() => location.hash)).toBe("#step-3");
});

test("a page on a sub-page the new version lacks lands on the new version's root", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("runtime-gone"));
  const art = await publishArtifact(page.request, token, {
    html: RUNTIME_PAGE("First"),
    assets: [{ path: "about.html", content: RUNTIME_PAGE("About") }],
  });
  await page.goto(`/a/${art.slug}`);
  const current = page.frameLocator(CURRENT_FRAME);
  await expect(current.locator("h1")).toHaveText("First");
  const frame = await shownFrame(page);
  await frame.evaluate(() => {
    location.href = "/about.html";
  });
  await expect(current.locator("h1")).toHaveText("About");
  await current.locator("#draft").fill("kept anyway");

  // v2 renames about.html: the place the page reports is gone, so the frame lands on v2's root,
  // not on the content host's "Not found", and the state still crosses.
  await update(
    token,
    art.id,
    {
      html: RUNTIME_PAGE("Second"),
      assets: [{ path: "team.html", content: RUNTIME_PAGE("Team") }],
    },
    1,
  );
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 10_000 });
  const next = page.frameLocator('iframe[title$="version 2"]');
  await expect(next.locator("h1")).toHaveText("Second");
  await expect(next.locator("#carried")).toHaveText("from v1: kept anyway");
  const shown = await shownFrame(page, 'iframe[title$="version 2"]');
  expect(await shown.evaluate(() => location.pathname)).toBe("/");
});

const HOLD_PAGE = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="plinth-capabilities" content="hold"><title>Form</title></head><body>
<h1>${title}</h1><label>Answer <input id="answer"></label></body></html>`;

test("a page that declares hold waits while the viewer types, and Update loads it", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("hold-live"));
  const art = await publishArtifact(page.request, token, { html: HOLD_PAGE("First") });
  await page.goto(`/a/${art.slug}`);
  const current = page.frameLocator(CURRENT_FRAME);
  await expect(current.locator("h1")).toHaveText("First");
  await current.locator("#answer").click();
  await current.locator("#answer").pressSequentially("typing");
  const top = (await page.locator(CURRENT_FRAME).boundingBox())?.y;

  await update(token, art.id, { html: HOLD_PAGE("Second") }, 1);
  const notice = page.getByText(/v2 is available/);
  await expect(notice).toBeVisible({ timeout: 10_000 });
  // The notice is a toast: the frame does not move under the viewer.
  expect((await page.locator(CURRENT_FRAME).boundingBox())?.y).toBe(top);
  // The page on view stays, with what the viewer typed.
  await expect(page.locator('iframe[title$="version 2"]')).toHaveCount(0);
  await expect(current.locator("#answer")).toHaveValue("typing");
  await expect(page.getByText("Updated to v2")).toHaveCount(0);

  await page.getByRole("button", { name: "Update" }).click();
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText("Second");
  await expect(notice).toHaveCount(0);
  // The viewer chose it: no "Updated" toast after the notice.
  await expect(page.getByText("Updated to v2")).toHaveCount(0);
});
