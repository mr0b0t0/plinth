// Live data from the owner's agents, end to end (docs/spec.md "Live data from the owner's
// agents"): the owner's agent publishes the example dashboard, describes its source and writes a
// stamped figure; the page cites it and the bar says where it came from; the owner reviews the
// recipe from confirm_url and confirms it; a commenter cannot overwrite the figure from the page;
// the owner's own change from the page is counted as made by a person; an agent's change to the
// recipe makes the source wait for the owner again.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { apiPut, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { seedToken } from "../support/tokens.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const HTML = readFileSync(path.join(ROOT, "docs/examples/live-dashboard.html"), "utf8");
const SOURCE = {
  id: "linear-issues",
  label: "Open issues",
  connector: "Linear",
  recipe: "Linear: count issues in team ENG by state (open, in progress, done this week).",
  collection: "issues",
};

const isMobile = () => test.info().project.name === "mobile";
const inFrame = (page: Page) => page.frameLocator(CURRENT_FRAME);
const sourcesLine = (page: Page) => page.locator(".pl-viewer__sources");

async function openShareDialog(page: Page) {
  if (isMobile()) {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
  } else {
    await page.getByRole("button", { name: "Share", exact: true }).click();
  }
  return page.getByRole("dialog", { name: "Share this artifact" });
}

/** A write from the page's own runtime: the result, or the PlinthError's code and message. */
const pageSet = (frame: Frame, id: string, count: number) =>
  frame.evaluate(
    async ([docId, n]) => {
      try {
        const c = (window as any).plinth.db.collection("issues");
        const doc = await c.get(docId);
        await c.set(docId, { count: n }, { ifRev: doc ? doc.rev : 0 });
        return "ok";
      } catch (e) {
        return `${(e as { code?: string }).code}: ${(e as Error).message}`;
      }
    },
    [id, count] as const,
  );

test("a cited dashboard: the owner confirms its source, a commenter cannot overwrite it, changes are counted", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("sources-owner");
  const commenter = uniqueEmail("sources-commenter");
  const { token } = await seedToken(owner, { label: "Dashboard agent", clientType: "claude" });
  const client = await mcpClient(token);
  try {
    // 1. The agent publishes the dashboard, describes the fetch and writes a stamped figure.
    const pub = await tool<{ id: string; slug: string; url: string }>(client, "publish_artifact", {
      title: "Engineering issues",
      html: HTML,
      visibility: "allowlist",
    });
    expect(pub.isError, pub.text).toBe(false);
    const art = pub.data;
    const share = await apiPut(
      request,
      `/artifacts/${art.id}/sharing`,
      { grants: [{ email: commenter, role: "commenter" }] },
      { token },
    );
    expect(share.status, JSON.stringify(share.body)).toBe(200);
    const set = await tool(client, "set_data_sources", { id: art.id, sources: [SOURCE] });
    expect(set.isError, set.text).toBe(false);
    expect(set.data.awaiting_confirmation).toEqual(["linear-issues"]);
    const confirmUrl = set.data.confirm_url as string;
    expect(confirmUrl).toMatch(/\?sources=review$/);
    const write = await tool(client, "write_artifact_data", {
      id: art.id,
      ops: [
        {
          op: "set",
          collection: "issues",
          doc_id: "open",
          data: { count: 14 },
          if_rev: 0,
          source: { id: "linear-issues", fetched_at: new Date().toISOString() },
        },
      ],
    });
    expect(write.data.results[0].ok, write.text).toBe(true);

    // 2. The owner opens confirm_url: the Share dialog shows the recipe as text; they confirm.
    await seedSession(page.context(), owner);
    await page.goto(confirmUrl);
    const dialog = page.getByRole("dialog", { name: "Share this artifact" });
    await expect(dialog.locator("pre.pl-share-sources__recipe")).toHaveText(SOURCE.recipe);
    await expect(dialog.getByText("Waiting for you to confirm")).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm Open issues" }).click();
    await expect(dialog.getByText(/^Confirmed/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText(/waiting for you to confirm it/)).toHaveCount(0);

    // The page cites the figure; the bar line says where it came from.
    let frame = await readyFrame(page);
    await expect(inFrame(page).locator("[data-plinth-cite='issues/open']")).toContainText("14");
    await expect(inFrame(page).locator("[data-plinth-cite='issues/open'] sup")).toHaveText(
      /^Linear · (just now|\d+ min ago)$/,
    );
    await expect(inFrame(page).locator("[data-plinth-cite='issues/in_progress'] sup")).toHaveText(
      "not fetched",
    );
    await expect(sourcesLine(page)).toHaveText(
      /^Figures from Linear \(1 figure, fetched (just now|\d+ minutes? ago)\) were written by an agent of the owner\.$/,
    );

    // 3. A commenter sees the line and cannot overwrite the figure from the page.
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await seedSession(ctx, commenter);
    await other.goto(art.url);
    const theirFrame = await readyFrame(other);
    await expect(sourcesLine(other)).toContainText("Figures from Linear");
    await expect(other.getByRole("button", { name: "Review" })).toHaveCount(0);
    expect(await pageSet(theirFrame, "open", 0)).toMatch(/^forbidden: /);
    // Nor add a figure of their own: the collection is sourced.
    expect(await pageSet(theirFrame, "in_progress", 3)).toMatch(
      /^forbidden: Only the owner and editors change this collection/,
    );
    await ctx.close();

    // 4. The owner changes the figure from the page: allowed, and counted as a person's change.
    expect(await pageSet(frame, "open", 15)).toBe("ok");
    await page.goto(art.url);
    frame = await readyFrame(page);
    await expect(inFrame(page).locator("[data-plinth-cite='issues/open'] sup")).toHaveText(
      "not fetched",
    );
    await expect(sourcesLine(page)).toHaveText(
      "This page says its figures come from Linear, but none are stored as fetched: what it shows comes from the page itself. 1 was last changed by a person, not fetched.",
    );

    // 5. The agent changes the recipe: the source waits for the owner again.
    const changed = await tool(client, "set_data_sources", {
      id: art.id,
      sources: [{ ...SOURCE, recipe: `${SOURCE.recipe} Include closed issues.` }],
    });
    expect(changed.data.awaiting_confirmation).toEqual(["linear-issues"]);
    await page.goto(art.url);
    await readyFrame(page);
    await expect(page.getByText("1 data source is waiting for you to confirm it.")).toBeVisible();
    await page.getByRole("button", { name: "Review" }).click();
    const again = page.getByRole("dialog", { name: "Share this artifact" });
    await expect(again.locator("pre.pl-share-sources__recipe")).toHaveText(
      `${SOURCE.recipe} Include closed issues.`,
    );
    // Removing never needs a confirmation.
    await again.getByRole("button", { name: "Remove Open issues" }).click();
    await expect(again.getByText("Data sources:")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByText(/waiting for you to confirm/)).toHaveCount(0);
    await expect(sourcesLine(page)).toHaveCount(0);
    // The address carried the review flag once; the Share dialog opens as usual now.
    expect(new URL(page.url()).searchParams.has("sources")).toBe(false);
    const plain = await openShareDialog(page);
    await expect(plain.getByText("Data sources:")).toHaveCount(0);
  } finally {
    await client.close();
  }
});
