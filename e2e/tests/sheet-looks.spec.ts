// A sheet's looks and several cells at once, in a real browser: cell styles, highlight rules and
// coloured options on the page (light and dark values), a range selected with Shift+click and
// copied with Ctrl+C, and in edit mode the Format menu, fill down with the keys and the fill
// handle, undo and redo, an undo refused because another editor changed the row since, and the
// column settings' option colours and highlight rules. With PLINTH_SHOTS set to a folder, it saves
// a screenshot of each screen there.
import { type Browser, expect, type Frame, type Page, type TestInfo, test } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 140 },
    {
      name: "Qty",
      type: "number",
      highlight: [{ when: "<", value: 3, color: "red" }],
    },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Line", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    {
      name: "Stage",
      type: "select",
      options: ["To do", "Doing", "Done"],
      colors: { Doing: "yellow", Done: "green" },
    },
  ],
});
const SHEET = [
  HEADER,
  '["Apples",3,1.5,"=B2*C2","Done",{"style":{"A":{"bold":true}}}]',
  '["Pears",5,0.5,null,"Doing"]',
  '["Plums",2,2,null,"To do"]',
  '["Total","=SUM(B2:B4)",null,"=SUM(D2:D4)",null,{"style":{"A":{"bold":true,"border":["top"]},"B":{"bold":true,"border":["top"]},"C":{"border":["top"]},"D":{"bold":true,"fill":"gray","border":["top"]},"E":{"border":["top"]}}}]',
].join("\n");

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const cell = (page: Page, a: string) => frameOf(page).locator(`#__plinth-cell-${a}`);
const isPhone = (info: TestInfo) => info.project.name === "mobile";

/** Save a screenshot when PLINTH_SHOTS names a folder (the visual pass), else nothing. */
async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.PLINTH_SHOTS;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}-${info.project.name}.png` });
}

async function setup(page: Page, editor = false) {
  const owner = uniqueEmail("looks-owner");
  const other = uniqueEmail("looks-editor");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Fruit",
    type: "sheet",
    content: SHEET,
    html: undefined,
    visibility: "allowlist",
  });
  if (editor) {
    const shared = await apiPut(
      page.request,
      `/artifacts/${art.id}/sharing`,
      { grants: [{ email: other, role: "editor" }] },
      { token },
    );
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  }
  return { slug: art.slug, owner, other };
}

async function openAs(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
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
  await expect(frameOf(page).locator(".plinth-sheet__page--editing")).toBeVisible();
  await expect(bar).not.toContainText("Connecting", { timeout: 10_000 });
}

/** The sheet's frame, to read what the page itself holds. */
async function sheetFrame(page: Page): Promise<Frame> {
  await expect
    .poll(async () => {
      for (const f of page.frames())
        if (await f.$("#__plinth-sheet").catch(() => null)) return true;
      return false;
    })
    .toBe(true);
  for (const f of page.frames()) if (await f.$("#__plinth-sheet").catch(() => null)) return f;
  throw new Error("no sheet frame");
}

const bg = (page: Page, a: string) =>
  cell(page, a).evaluate((el) => getComputedStyle(el).backgroundColor);

test("styles, highlights and coloured options show on the page, in light and dark", async ({
  page,
}, info) => {
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await expect(cell(page, "A2")).toHaveClass(/plinth-sheet__s-bold/);
  // Plums' 2 is under 3: red. The total's fill is gray, its top border drawn.
  await expect(cell(page, "B4")).toHaveClass(/plinth-sheet__hl--red/);
  await expect(cell(page, "D5")).toHaveClass(/plinth-sheet__fill--gray/);
  await expect(cell(page, "D5")).toHaveClass(/plinth-sheet__bd--top/);
  const chip = cell(page, "E2").locator(".plinth-sheet__chip");
  await expect(chip).toHaveText("Done");
  await expect(chip).toHaveClass(/plinth-sheet__chip--green/);
  await expect(cell(page, "E4").locator(".plinth-sheet__chip")).toHaveCount(0);
  // Each colour has a light value and a dark one.
  const dark = info.project.name === "dark";
  expect(await bg(page, "B4")).toBe(dark ? "rgb(74, 31, 31)" : "rgb(253, 226, 225)");
  expect(await bg(page, "D5")).toBe(dark ? "rgb(42, 48, 56)" : "rgb(238, 240, 242)");
  await shot(page, info, "sheet-looks-view");
});

test("a range selected with Shift+click is copied as text by Ctrl+C", async ({ page }, info) => {
  test.skip(isPhone(info), "Shift and Ctrl need a keyboard");
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  const frame = await sheetFrame(page);
  // What the page put on the clipboard, read in the copy event after it.
  await frame.evaluate(() => {
    window.addEventListener("copy", (e) => {
      document.documentElement.dataset.copied = e.clipboardData?.getData("text/plain") ?? "";
    });
  });
  await cell(page, "A2").click();
  await cell(page, "B3").click({ modifiers: ["Shift"] });
  await expect(frameOf(page).locator('[aria-selected="true"]')).toHaveCount(4);
  await expect(frameOf(page).locator(".plinth-sheet__fx-addr")).toHaveText("A2:B3");
  await page.keyboard.press("ControlOrMeta+C");
  await expect(frameOf(page).locator("html")).toHaveAttribute("data-copied", "Apples\t3\nPears\t5");
  await shot(page, info, "sheet-range-view");
  await page.keyboard.press("Escape");
  await expect(frameOf(page).locator('[aria-selected="true"]')).toHaveCount(0);
});

test("editing several cells: Format, fill down, the fill handle, undo and redo", async ({
  page,
}, info) => {
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const frame = frameOf(page);

  // Format: italic and a fill on Pears and Plums (one cell at phone width).
  await cell(page, "A3").click();
  if (!isPhone(info)) await cell(page, "A4").click({ modifiers: ["Shift"] });
  await frame.getByRole("button", { name: "Format", exact: true }).click();
  const menu = frame.getByRole("menu", { name: "Format" });
  await expect(menu).toBeVisible();
  await shot(page, info, "sheet-format-menu");
  await menu.getByRole("menuitemcheckbox", { name: "Italic" }).click();
  await expect(cell(page, "A3")).toHaveClass(/plinth-sheet__s-italic/);
  await frame.getByRole("button", { name: "Format", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Fill blue" }).click();
  await expect(cell(page, "A3")).toHaveClass(/plinth-sheet__fill--blue/);
  if (isPhone(info)) return;
  await expect(cell(page, "A4")).toHaveClass(/plinth-sheet__fill--blue/);

  // Fill down with the keys: D2's formula into D3 and D4, its references moved.
  await cell(page, "D2").click();
  await cell(page, "D4").click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+D");
  await expect(cell(page, "D3")).toHaveText("€2.50");
  await expect(cell(page, "D4")).toHaveText("€4.00");
  await cell(page, "D4").click();
  await expect(frame.locator(".plinth-sheet__fx-raw")).toHaveText("=B4*C4");

  // Undo takes the fill back, redo makes it again.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(cell(page, "D3")).toHaveText("");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(cell(page, "D3")).toHaveText("€2.50");

  // The fill handle: Plums' Stage dragged down over the total row.
  await cell(page, "E4").click();
  const handle = cell(page, "E4").locator(".plinth-sheet__fill-handle");
  await expect(handle).toBeVisible();
  await shot(page, info, "sheet-fill-handle");
  const from = await handle.boundingBox();
  const to = await cell(page, "E5").boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
  await expect(cell(page, "E5")).toHaveClass(/plinth-sheet__fill-target/);
  await page.mouse.up();
  await expect(cell(page, "E5")).toHaveText("To do");
});

test("undo is refused when another editor changed the row since", async ({
  page,
  browser,
}, info) => {
  test.skip(isPhone(info), "two editors at desktop width is enough");
  test.setTimeout(90_000);
  const s = await setup(page, true);
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.other, s.slug);
  await startEditing(page);
  await startEditing(other);
  await cell(page, "A3").click();
  await page.keyboard.press("ControlOrMeta+B");
  await expect(cell(other, "A3")).toHaveClass(/plinth-sheet__s-bold/);
  // The editor changes Pears' Qty: the row is no longer as the owner left it.
  await cell(other, "B3").dblclick();
  const field = frameOf(other).locator(".plinth-sheet__input");
  await field.fill("6");
  await field.press("Enter");
  await expect(cell(page, "B3")).toHaveText("6");
  await cell(page, "C3").click();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(frameOf(page).locator(".plinth-sheet__notice")).toContainText(
    "Changed since, so it can't be undone.",
  );
  await expect(cell(page, "A3")).toHaveClass(/plinth-sheet__s-bold/);
  await shot(page, info, "sheet-undo-refused");
  await other.context().close();
});

test("column settings give options a colour and a column highlight rules", async ({
  page,
}, info) => {
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const frame = frameOf(page);
  await cell(page, "E3").click();
  await frame.getByRole("button", { name: "Column", exact: true }).click();
  await frame.getByRole("menuitem", { name: "Column settings…" }).click();
  const settings = frame.getByRole("form", { name: "Column E settings" });
  await expect(settings).toBeVisible();
  await settings.getByLabel("Colour of To do").selectOption("gray");
  await settings.getByRole("button", { name: "Add rule" }).click();
  await settings.getByLabel("Rule 1: when").selectOption("=");
  await settings.getByLabel("Rule 1: value").fill("Doing");
  await settings.getByLabel("Rule 1: colour").selectOption("orange");
  await shot(page, info, "sheet-column-settings");
  await settings.getByRole("button", { name: "Apply" }).click();
  await expect(settings).toBeHidden();
  await expect(cell(page, "E4").locator(".plinth-sheet__chip--gray")).toHaveText("To do");
  await expect(cell(page, "E3")).toHaveClass(/plinth-sheet__hl--orange/);
});
