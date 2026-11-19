// Editing a doc on its page, live across editors (#36): the owner and an editor have the doc open
// in two browser contexts. A block one of them opens shows up held in the other, the text arrives
// as it is typed, Publish makes an immutable version, a version an agent publishes meanwhile is
// merged under the page edits (or frozen for the whole-draft review in the page when it touches the
// same lines), two editors' choices in the review never both take effect, and a commenter never
// sees draft text. The opaque-isolation case is in live-edit-opaque.spec.ts.
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const DOC = [
  "# Plan",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  "Third paragraph.",
  "",
].join("\n");

interface Setup {
  slug: string;
  id: string;
  token: string;
  owner: string;
  editor: string;
  commenter: string;
}

/** An owner's doc shared with an editor and a commenter. */
async function setup(page: Page): Promise<Setup> {
  const owner = uniqueEmail("live-owner");
  const editor = uniqueEmail("live-editor");
  const commenter = uniqueEmail("live-commenter");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Plan",
    type: "doc",
    content: DOC,
    html: undefined,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    {
      grants: [
        { email: editor, role: "editor" },
        { email: commenter, role: "commenter" },
      ],
    },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return { slug: art.slug, id: art.id, token, owner, editor, commenter };
}

async function openAs(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("Plan", {
    timeout: 15_000,
  });
  return page;
}

/** Turn edit mode on: the toggle, or its item in the ⋯ menu at phone width. */
async function startEditing(page: Page) {
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  await expect(page.getByRole("region", { name: "Editing on the page" })).toBeVisible();
  await expect(page.frameLocator(CURRENT_FRAME).locator("main.plinth-doc--editing")).toBeVisible();
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);

/** Wait until the frame reports the doc socket open (the bar stops saying "Connecting…"). */
async function connected(page: Page) {
  await expect(page.getByRole("region", { name: "Editing on the page" })).not.toContainText(
    "Connecting",
    { timeout: 10_000 },
  );
  await expect(page.getByRole("region", { name: "Editing on the page" })).not.toContainText(
    "Not connected",
  );
}

test("two editors on one doc: a held block, typing that arrives live, Publish makes v2", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const s = await setup(page);
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.editor, s.slug);

  await startEditing(page);
  await connected(page);
  await startEditing(other);
  await connected(other);

  // The owner opens the first paragraph and types.
  await frameOf(page).locator("p", { hasText: "First paragraph." }).click();
  const field = frameOf(page).locator("textarea.plinth-doc__field");
  await expect(field).toHaveValue("First paragraph.");
  await expect(field).toBeFocused();
  if (info.project.name === "mobile") {
    // Touch screens get a 16px field, so focusing it does not zoom the page.
    expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  }
  await field.press("End");
  await field.pressSequentially(" Typed live.");

  // The editor sees the block held, with the owner's email, and the text as it arrives.
  await expect(frameOf(other).locator(".plinth-doc__holder")).toHaveText(`${s.owner} is editing`);
  await expect(frameOf(other).locator("p.plinth-doc__held")).toHaveText(
    "First paragraph. Typed live.",
  );
  await expect(other.getByRole("region", { name: "Editing on the page" })).toContainText(s.owner);
  // Clicking it does not open it.
  await frameOf(other).locator("p.plinth-doc__held").click();
  await expect(frameOf(other).locator("textarea")).toHaveCount(0);
  await expect(frameOf(other).locator(".plinth-doc__notice")).toContainText(
    `${s.owner} is editing this.`,
  );

  // The editor edits another block at the same time.
  await frameOf(other).locator("p", { hasText: "Third paragraph." }).click();
  const theirs = frameOf(other).locator("textarea.plinth-doc__field");
  await theirs.press("End");
  await theirs.pressSequentially(" And theirs.");
  await expect(frameOf(page).locator("p", { hasText: "And theirs." })).toBeVisible();

  const results = await new AxeBuilder({ page }).include(".pl-editbar").analyze();
  expect(results.violations).toEqual([]);

  await field.press("Escape");
  await expect(frameOf(page).locator("p", { hasText: "Typed live." })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toContainText(
    "Published as v2",
  );
  const detail = await apiGet(page.request, `/artifacts/${s.id}`);
  expect(detail.body.current_version).toBe(2);
  expect(detail.body.content).toContain("First paragraph. Typed live.");
  expect(detail.body.content).toContain("Third paragraph. And theirs.");

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toHaveCount(0);
  await other.context().close();
});

test("an agent's version is merged under the page edits, or frozen for review when it overlaps", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  await connected(page);

  await frameOf(page).locator("p", { hasText: "First paragraph." }).click();
  const field = frameOf(page).locator("textarea.plinth-doc__field");
  await field.press("End");
  await field.pressSequentially(" Mine.");
  await field.press("Escape");
  await expect(page.getByRole("region", { name: "Editing on the page" })).toContainText(
    "Draft saved",
  );

  const client = await mcpClient(s.token);
  try {
    // The agent changes another paragraph: a clean merge.
    const clean = await tool<{ version: number; warnings: { code: string }[] }>(
      client,
      "update_artifact",
      {
        id: s.id,
        content: DOC.replace("Third paragraph.", "Third, by the agent."),
        base_version: 1,
      },
    );
    expect(clean.isError, clean.text).toBe(false);
    expect(clean.data.warnings.map((w) => w.code)).toContain("live_draft");
    await expect(page.getByRole("region", { name: "Editing on the page" })).toContainText(
      "v2 was published; your changes were kept",
      { timeout: 10_000 },
    );
    await expect(frameOf(page).locator("p", { hasText: "Third, by the agent." })).toBeVisible();
    await expect(frameOf(page).locator("p", { hasText: "First paragraph. Mine." })).toBeVisible();

    // Then it rewrites the paragraph the page edited: a conflict, frozen for review.
    const v2 = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
    const clash = await tool(client, "update_artifact", {
      id: s.id,
      content: v2.replace("First paragraph.", "First, rewritten by the agent."),
      base_version: 2,
    });
    expect(clash.isError, clash.text).toBe(false);
  } finally {
    await client.close();
  }
  const bar = page.getByRole("region", { name: "Editing on the page" });
  await expect(bar).toContainText("v3 was published while you edited", {
    timeout: 10_000,
  });
  // The review opens in the page itself: both docs rendered, and what each changed.
  await bar.getByRole("button", { name: "Review changes" }).click();
  const review = frameOf(page).getByRole("region", { name: "Review v3 and your changes" });
  await expect(review).toBeVisible();
  // The strip says what happened, once: the review has no heading repeating it.
  await expect(review.getByRole("heading", { level: 2 })).toHaveCount(0);
  // While the review is open, the strip shows its status only: the review's Back is the one way
  // out, so neither "Review changes" nor Done is offered there.
  await expect(bar.getByRole("button", { name: "Review changes" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Done" })).toHaveCount(0);
  await expect(bar).toContainText("v3 was published while you edited");
  // The update shows in the strip only: no toast repeats it while editing.
  await expect(page.getByText("Updated to v3")).toHaveCount(0);
  const mine = review.getByRole("region", { name: "Your changes" });
  await expect(mine.getByRole("list", { name: "Changes" })).toContainText("Paragraph changed");
  await expect(mine).toContainText("First paragraph. Mine.");
  const theirs = review.getByRole("region", { name: "v3" });
  const toV3 = review.getByRole("radio", { name: "v3" });
  if (await toV3.isVisible()) await toV3.click();
  await expect(theirs).toContainText("First, rewritten by the agent.");
  await expect(theirs.getByRole("list", { name: "Changes" })).toContainText("Paragraph changed");
  // No source is shown: no Markdown field, and no editor.
  await expect(review.locator("textarea, .monaco-editor")).toHaveCount(0);
  // Discard your changes asks first, naming what would be lost; Cancel keeps them.
  await review.getByRole("button", { name: "Discard your changes" }).click();
  const ask = frameOf(page).getByRole("alertdialog", { name: "Discard unpublished changes?" });
  await expect(ask).toContainText("will be lost");
  await expect(ask).toContainText("The page will show v3 for everyone editing.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await review.getByRole("button", { name: "Publish your changes", exact: true }).click();
  await expect
    .poll(async () => (await apiGet(page.request, `/artifacts/${s.id}`)).body.current_version)
    .toBe(4);
  await expect(review).toHaveCount(0);
  await expect(bar).toContainText("Published as v4", { timeout: 10_000 });
  const v4 = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
  expect(v4).toContain("First paragraph. Mine.");
  expect(v4).toContain("Third, by the agent.");
  expect(v4).not.toContain("rewritten by the agent");
  const versions = await apiGet(page.request, `/artifacts/${s.id}/versions`);
  expect(versions.body.items[0]).toMatchObject({
    number: 4,
    note: "Edited on the page. Replaces the changes in v3.",
  });
});

test("a review open in two browsers: one choice takes effect, and the other review closes saying so", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.editor, s.slug);
  for (const p of [page, other]) {
    await startEditing(p);
    await connected(p);
  }
  const client = await mcpClient(s.token);
  /** The owner edits the first paragraph, and the agent rewrites it on `base`. */
  async function clash(base: number, mark: string) {
    await frameOf(page).locator("p", { hasText: "First" }).first().click();
    const field = frameOf(page).locator("textarea.plinth-doc__field");
    await field.press("End");
    await field.pressSequentially(` ${mark}`);
    await field.press("Escape");
    const now = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
    const r = await tool(client, "update_artifact", {
      id: s.id,
      content: now.replace(/^First.*$/m, `First, by the agent ${mark}.`),
      base_version: base,
    });
    expect(r.isError, r.text).toBe(false);
    for (const p of [page, other]) {
      const bar = p.getByRole("region", { name: "Editing on the page" });
      await expect(bar).toContainText(`v${base + 1} was published while you edited`, {
        timeout: 10_000,
      });
      await bar.getByRole("button", { name: "Review changes" }).click();
      await expect(
        frameOf(p).getByRole("region", { name: `Review v${base + 1} and your changes` }),
      ).toBeVisible();
    }
  }
  try {
    await clash(1, "one");
    // The owner publishes theirs; the editor's review closes with what happened.
    await frameOf(page).getByRole("button", { name: "Publish your changes", exact: true }).click();
    await expect(frameOf(other).locator(".plinth-review__announce")).toHaveText(
      "Another editor published these changes as v3.",
      { timeout: 10_000 },
    );
    await expect(frameOf(other).locator(".plinth-review")).toHaveCount(0);
    await expect
      .poll(async () => (await apiGet(page.request, `/artifacts/${s.id}`)).body.current_version)
      .toBe(3);

    // Both choices at once: exactly one takes effect, and History gains at most one version.
    await clash(3, "two");
    await frameOf(other).getByRole("button", { name: "Discard your changes" }).click();
    await Promise.all([
      frameOf(other)
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard changes", exact: true })
        .click(),
      frameOf(page).getByRole("button", { name: "Publish your changes", exact: true }).click(),
    ]);
    for (const p of [page, other]) {
      await expect(frameOf(p).locator(".plinth-review")).toHaveCount(0, { timeout: 15_000 });
    }
    const after = (await apiGet(page.request, `/artifacts/${s.id}`)).body;
    expect([4, 5]).toContain(after.current_version);
    const versions = await apiGet(page.request, `/artifacts/${s.id}/versions`);
    expect(versions.body.items.length).toBe(after.current_version);
  } finally {
    await client.close();
    await other.context().close();
  }
});

test("a commenter never sees draft text, nor any editing control", async ({ page, browser }) => {
  test.setTimeout(60_000);
  const s = await setup(page);
  await openAs(browser, s.owner, s.slug, page);
  await startEditing(page);
  await connected(page);
  await frameOf(page).locator("p", { hasText: "Second paragraph." }).click();
  const field = frameOf(page).locator("textarea.plinth-doc__field");
  await field.press("End");
  await field.pressSequentially(" Secret draft words.");
  await field.press("Escape");

  const commenter = await openAs(browser, s.commenter, s.slug);
  await expect(frameOf(commenter).locator("p", { hasText: "Second paragraph." })).toBeVisible();
  await expect(frameOf(commenter).locator("main")).not.toContainText("Secret draft words");
  await expect(commenter.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(commenter.getByText(/Unpublished changes/)).toHaveCount(0);
  await commenter.context().close();
});
