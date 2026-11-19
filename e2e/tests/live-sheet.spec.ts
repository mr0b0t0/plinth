// Editing a sheet on its page, live across editors (#36, live sheets): the owner and an editor
// have the sheet open in two browser contexts. A cell one of them opens shows its row held, with
// their email, in the other; the typing arrives as it is typed; inserting a row moves the formulas
// on both pages; Save makes the next version; and a version an agent publishes with edit_sheet
// meanwhile is never merged: the page edits freeze, and the review publishes them as they are or
// discards them.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 160 },
    { name: "Qty", type: "number" },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Paid", type: "checkbox" },
  ],
});
const SHEET = [
  HEADER,
  '["Apples",3,1.5,true]',
  '["Pears",5,0.5,false]',
  '["Plums",2,2]',
  '["Total","=SUM(B2:B4)","=SUM(C2:C4)"]',
].join("\n");

interface Setup {
  slug: string;
  id: string;
  token: string;
  owner: string;
  editor: string;
}

async function setup(page: Page): Promise<Setup> {
  const owner = uniqueEmail("sheet-owner");
  const editor = uniqueEmail("sheet-editor");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Fruit",
    type: "sheet",
    content: SHEET,
    html: undefined,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: editor, role: "editor" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return { slug: art.slug, id: art.id, token, owner, editor };
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const cell = (page: Page, a: string) => frameOf(page).locator(`#__plinth-cell-${a}`);

async function openAs(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  return page;
}

async function startEditing(page: Page) {
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  const bar = page.getByRole("region", { name: "Editing on the page" });
  await expect(bar).toBeVisible();
  await expect(frameOf(page).locator(".plinth-sheet__page--editing")).toBeVisible();
  await expect(bar).not.toContainText("Connecting", { timeout: 10_000 });
  await expect(bar).not.toContainText("Not connected");
}

test("two editors on one sheet: a held row, typing that arrives live, a row both see, Save makes v2", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.editor, s.slug);
  await startEditing(page);
  await startEditing(other);

  // The owner opens Qty of Apples and types.
  await cell(page, "B2").dblclick();
  const field = frameOf(page).locator("#__plinth-cell-B2 .plinth-sheet__input");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("3");
  await field.fill("30");

  // The editor sees the row held, with the owner's email, and the value as it arrives.
  await expect(
    frameOf(other).locator("tr.plinth-sheet__row--held .plinth-sheet__holder"),
  ).toHaveText(`${s.owner} is editing`);
  await expect(cell(other, "B2")).toHaveText("30");
  await expect(cell(other, "B5")).toHaveText("37");
  await expect(other.getByRole("region", { name: "Editing on the page" })).toContainText(s.owner);
  // Opening a cell of that row does not open it.
  await cell(other, "A2").dblclick();
  await expect(frameOf(other).locator(".plinth-sheet__input")).toHaveCount(0);
  await expect(frameOf(other).locator(".plinth-sheet__notice")).toContainText(
    `${s.owner} is editing this row.`,
  );

  // The editor edits another row at the same time, by typing into a selected cell.
  await cell(other, "A3").click();
  await cell(other, "A3").press("P");
  const theirs = frameOf(other).locator("#__plinth-cell-A3 .plinth-sheet__input");
  await expect(theirs).toHaveValue("P");
  await theirs.fill("Pears, ripe");
  await theirs.press("Enter");
  await expect(cell(page, "A3")).toHaveText("Pears, ripe");

  // A value the column cannot hold stays in the field with the reason.
  await field.fill("thirty");
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(frameOf(page).locator(".plinth-sheet__notice")).toContainText("Qty takes numbers");
  await field.fill("30");
  await field.press("Enter");
  await expect(frameOf(page).locator(".plinth-sheet__input")).toHaveCount(0);
  await expect(cell(page, "B3")).toBeFocused();

  // A row inserted above Plums: both pages show it, and the totals' ranges grow.
  await cell(page, "A4").click();
  await frameOf(page).getByRole("button", { name: "Row above" }).click();
  await expect(frameOf(page).locator("html")).toHaveAttribute("data-rows", "5");
  await expect(frameOf(other).locator("html")).toHaveAttribute("data-rows", "5");
  await expect(cell(other, "A6")).toHaveText("Total");
  await expect(cell(other, "B6")).toHaveText("37");

  await page.getByRole("button", { name: "Save version" }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toContainText(
    "Saved as v2",
  );
  const detail = await apiGet(page.request, `/artifacts/${s.id}`);
  expect(detail.body.current_version).toBe(2);
  expect((detail.body.content as string).split("\n")).toEqual([
    HEADER,
    '["Apples",30,1.5,true]',
    '["Pears, ripe",5,0.5,false]',
    "[]",
    '["Plums",2,2]',
    '["Total","=SUM(B2:B5)","=SUM(C2:C5)"]',
  ]);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toHaveCount(0);
  await other.context().close();
});

test("an agent's edit_sheet during the page edits is never merged: the review publishes mine or discards it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const bar = page.getByRole("region", { name: "Editing on the page" });

  /** Type `value` into a cell and wait until the strip shows the edit. */
  async function type(a: string, value: string) {
    await cell(page, a).dblclick();
    const field = frameOf(page).locator(`#__plinth-cell-${a} .plinth-sheet__input`);
    await field.fill(value);
    await field.press("Enter");
    await expect(bar).toContainText("Unsaved changes");
  }

  /** The agent sets one cell with edit_sheet on `base`. */
  async function agentSets(at: string, value: number, base: number) {
    const client = await mcpClient(s.token);
    try {
      const r = await tool<{ version: number; warnings: { code: string }[] }>(
        client,
        "edit_sheet",
        {
          id: s.id,
          base_version: base,
          ops: [{ op: "set", at, values: [[value]] }],
        },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.data.warnings.map((w) => w.code)).toContain("live_draft");
    } finally {
      await client.close();
    }
  }

  // The agent changes the row right below the page's edit: still never merged.
  await type("B2", "4");
  await agentSets("B3", 6, 1);
  await expect(bar).toContainText("v2 was published while you edited. Review it to go on.", {
    timeout: 10_000,
  });
  await bar.getByRole("button", { name: "Review changes" }).click();
  const review = page.getByRole("dialog", { name: "v2 was published while you were editing" });
  await expect(
    review.getByRole("region", { name: "Your page changes (not published, based on v1)" }),
  ).toContainText("B2: 3 → 4");
  // At phone width one sheet shows at a time, with a switch between them.
  const toV2 = review.getByRole("radio", { name: "v2" });
  if (await toV2.isVisible()) {
    await toV2.check();
    await expect(
      review.getByRole("region", { name: "Your page changes (not published, based on v1)" }),
    ).toHaveCount(0);
  }
  await expect(review.getByRole("region", { name: "v2" })).toContainText("B3: 5 → 6");
  // Cancel keeps the draft frozen, and the review opens again.
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toHaveCount(0);
  await expect(bar).toContainText("Review it to go on.");
  await bar.getByRole("button", { name: "Review changes" }).click();

  // Publish mine: the page edits become v3 as they are; v2 stays in the history.
  await review.getByRole("button", { name: "Publish mine" }).click();
  await expect(review).toHaveCount(0);
  await expect(bar).toContainText("Saved as v3", { timeout: 10_000 });
  const v3 = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
  expect(v3.split("\n").slice(1, 3)).toEqual(['["Apples",4,1.5,true]', '["Pears",5,0.5,false]']);
  const versions = await apiGet(page.request, `/artifacts/${s.id}/versions`);
  expect(versions.body.items[0]).toMatchObject({
    number: 3,
    note: "Edited on the page. Replaces the changes in v2.",
  });
  expect(versions.body.items[1]).toMatchObject({ number: 2 });

  // Editing resumes on v3. Discard mine asks first, naming what would be lost.
  await type("B2", "7");
  await agentSets("B4", 9, 3);
  await expect(bar).toContainText("v4 was published while you edited.", { timeout: 10_000 });
  await bar.getByRole("button", { name: "Review changes" }).click();
  const second = page.getByRole("dialog", { name: "v4 was published while you were editing" });
  await second.getByRole("button", { name: "Discard mine" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Discard the page changes?" });
  await expect(confirm).toContainText("This change will be lost: B2: 4 → 7.");
  await confirm.getByRole("button", { name: "Discard the page changes" }).click();
  await expect(page.getByText("The page is back to v4.")).toBeVisible({ timeout: 10_000 });
  await expect(cell(page, "B2")).toHaveText("4");
  await expect(cell(page, "B4")).toHaveText("9");
  const after = await apiGet(page.request, `/artifacts/${s.id}`);
  expect(after.body.current_version).toBe(4);
});
