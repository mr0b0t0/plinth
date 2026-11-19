// Sheets (type "sheet"): an agent publishes JSON lines over MCP and Plinth renders a spreadsheet
// with its fixed renderer on the artifact's own origin. Checked here: computed values and column
// formats, a cycle, links, hostile cells shown as text, no request to another host, sort, filter
// and the formula bar, phones, the dark scheme and print; CSV and .xlsx downloads from the menu and
// from the frame's own toolbar; edit_sheet publishing a version the open page picks up, and its
// one-line diff; and the editor's problem list and save. The opaque case is in
// typed-sheet-opaque.spec.ts.
import { readFileSync } from "node:fs";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { APP_ORIGIN, apiGet, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';

const TITLE = "Fruit budget";
const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 180 },
    { name: "Qty", type: "number" },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Total", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Bought", type: "date" },
    { name: "Paid", type: "checkbox" },
    { name: "Stage", type: "select", options: ["todo", "done"] },
    { name: "Shop", type: "url" },
    { name: "Note", type: "text" },
  ],
  freeze: { cols: 1 },
});
const SHEET = [
  HEADER,
  JSON.stringify([
    "Apples",
    3,
    1.2,
    "=B2*C2",
    "2026-11-02",
    true,
    "done",
    "https://shop.example/apples",
    '<img src=x onerror="window.__pwned=1">',
  ]),
  JSON.stringify([
    "Pears",
    5,
    0.8,
    "=B3*C3",
    "2026-11-03",
    false,
    "todo",
    null,
    '\'=HYPERLINK("https://evil.example","x")',
  ]),
  JSON.stringify([
    "Total",
    "=SUM(B2:B3)",
    null,
    "=SUM(D2:D3)",
    null,
    null,
    null,
    null,
    '=VLOOKUP("Pears",A2:C3,3,FALSE)',
  ]),
  JSON.stringify(["Loop", "=B6", null, null, null, null, null, null, null]),
  JSON.stringify(["Loop 2", "=B5"]),
].join("\n");

interface Published {
  id: string;
  slug: string;
  type: string;
  version: number;
}

async function publishSheet(page: Page, content = SHEET) {
  const email = uniqueEmail("sheet");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title: TITLE,
    type: "sheet",
    content,
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.type).toBe("sheet");
  return { client, artifact: r.data };
}

async function sheetFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  const locator = page.frameLocator(selector);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

const cell = (frame: Frame, a: string) => frame.locator(`#__plinth-cell-${a}`);

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function openMenuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test.describe("a published sheet", () => {
  test("computes and formats its cells, shows hostile text as text, and reaches no other host", async ({
    page,
  }, info) => {
    const problems = watchConsole(page);
    const { artifact, client } = await publishSheet(page);
    const artifactHost = `${artifact.id}.${CONTENT_HOST}`;
    const hosts = new Set<string>();
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    try {
      await page.goto(`/a/${artifact.slug}`);
      const frame = await sheetFrame(page);
      expect(new URL(frame.url()).host).toBe(artifactHost);
      await expect(cell(frame, "D2")).toHaveText(/3[.,]60/);
      await expect(cell(frame, "D2")).toContainText("€");
      await expect(cell(frame, "D4")).toHaveText(/7[.,]60/);
      await expect(cell(frame, "B4")).toHaveText("8");
      await expect(cell(frame, "I4")).toHaveText("0.8");
      await expect(cell(frame, "B5")).toHaveText("#CYCLE!");
      await expect(cell(frame, "B6")).toHaveText("#CYCLE!");
      await expect(cell(frame, "E2")).toHaveText("2026-11-02");
      await expect(cell(frame, "F2").locator('[aria-label="Yes"]')).toHaveCount(1);
      const link = cell(frame, "H2").locator("a");
      await expect(link).toHaveAttribute("href", "https://shop.example/apples");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(cell(frame, "I2")).toHaveText('<img src=x onerror="window.__pwned=1">');
      await expect(cell(frame, "I3")).toHaveText('=HYPERLINK("https://evil.example","x")');
      await expect(frame.locator("main img, main svg, main script")).toHaveCount(0);
      expect(await frame.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();

      const background = await frame.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      expect(background).toBe(
        info.project.name === "dark" ? "rgb(21, 24, 28)" : "rgb(255, 255, 255)",
      );
      if (info.project.name === "mobile") {
        // The grid scrolls inside its own box: the page never scrolls sideways.
        const widths = await frame.evaluate(() => ({
          view: window.innerWidth,
          page: document.documentElement.scrollWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.view);
      }
      expect([...hosts].sort()).toEqual([new URL(APP_ORIGIN).host, artifactHost].sort());
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("sorts by a header, filters, shows the raw cell, and prints without its toolbar", async ({
    page,
  }) => {
    const { artifact, client } = await publishSheet(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const frame = await sheetFrame(page);
      const order = () =>
        frame.evaluate(() =>
          [...document.querySelectorAll("tbody tr")]
            .filter((r) => !(r as HTMLElement).hidden)
            .map((r) => (r as HTMLElement).dataset.row),
        );
      await cell(frame, "B1").getByRole("button").click();
      await expect(cell(frame, "B1")).toHaveAttribute("aria-sort", "ascending");
      expect(await order()).toEqual(["2", "3", "4", "5", "6"]);
      await cell(frame, "B1").getByRole("button").click();
      await expect(cell(frame, "B1")).toHaveAttribute("aria-sort", "descending");
      expect(await order()).toEqual(["4", "3", "2", "5", "6"]);

      await frame.getByRole("searchbox").fill("pear");
      expect(await order()).toEqual(["3"]);
      await expect(frame.locator(".plinth-sheet__count")).toHaveText("1 of 5 rows");
      await frame.getByRole("searchbox").fill("");

      await cell(frame, "D3").click();
      await expect(frame.locator(".plinth-sheet__fx")).toHaveText("D3=B3*C3");

      await page.emulateMedia({ media: "print" });
      await expect(frame.locator(".plinth-sheet__downloads")).toBeHidden();
      await expect(frame.locator(".plinth-sheet__fx")).toBeHidden();
      await expect(cell(frame, "A2")).toBeVisible();
      await page.emulateMedia({ media: "screen" });
    } finally {
      await client.close();
    }
  });

  test("downloads CSV and .xlsx from the menu and from the frame's toolbar", async ({ page }) => {
    const { artifact, client } = await publishSheet(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const frame = await sheetFrame(page);

      const [csv] = await Promise.all([
        page.waitForEvent("download"),
        openMenuItem(page, "Download as CSV"),
      ]);
      expect(csv.suggestedFilename()).toBe("Fruit budget.csv");
      const text = readFileSync((await csv.path()) as string, "utf8");
      expect(text.startsWith("﻿Item,Qty,Price,Total,Bought,Paid,Stage,Shop,Note\r\n")).toBe(true);
      expect(text).toContain("Apples,3,1.2,3.6,2026-11-02,TRUE,done,https://shop.example/apples,");
      // Text a spreadsheet would run is guarded.
      expect(text).toContain(`,"'=HYPERLINK(""https://evil.example"",""x"")"`);

      const [xlsx] = await Promise.all([
        page.waitForEvent("download"),
        openMenuItem(page, "Download as Excel (.xlsx)"),
      ]);
      expect(xlsx.suggestedFilename()).toBe("Fruit budget.xlsx");
      const files = unzipSync(new Uint8Array(readFileSync((await xlsx.path()) as string)));
      const sheet1 = strFromU8(files["xl/worksheets/sheet1.xml"] as Uint8Array);
      expect(sheet1).toContain('<c r="D2" s="2"><f>B2*C2</f><v>3.6</v></c>');
      expect(sheet1).toContain("<f>SUM(D2:D3)</f><v>7.6</v>");
      expect(sheet1).not.toContain("<f>HYPERLINK");
      expect(Object.keys(files).some((f) => /externalLink|vbaProject/.test(f))).toBe(false);

      const [own] = await Promise.all([
        page.waitForEvent("download"),
        frame.getByRole("button", { name: "Download as CSV" }).click(),
      ]);
      expect(own.suggestedFilename()).toBe("Fruit budget.csv");
    } finally {
      await client.close();
    }
  });

  test("edit_sheet publishes a version the open page picks up, and Compare lists the cell", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { artifact, client } = await publishSheet(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      let frame = await sheetFrame(page);
      await expect(cell(frame, "D2")).toHaveText(/3[.,]60/);
      const r = await tool<{ version: number }>(client, "edit_sheet", {
        id: artifact.id,
        base_version: 1,
        ops: [{ op: "set", at: "B2", values: [[10]] }],
        note: "More apples",
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.data.version).toBe(2);
      await expect
        .poll(
          async () => {
            frame = await sheetFrame(page);
            return cell(frame, "D2").textContent();
          },
          { timeout: 40_000 },
        )
        .toMatch(/12[.,]00/);
      await page.goto(`/a/${artifact.slug}/compare?from=1&to=2`);
      // One cell changed, said as a cell and its two values; no sheet lines on the page.
      const changes = page.getByRole("region", { name: "What changed from v1 to v2" });
      const items = changes.getByRole("list").first().getByRole("listitem");
      await expect(items).toHaveCount(1);
      await expect(items).toContainText("B2 changed");
      await expect(items).toContainText("Row 2, “Qty”");
      await expect(items).toContainText(/Before: 3\b.*after: 10\b/);
      await expect(page.locator("main")).not.toContainText('["Apples"');
    } finally {
      await client.close();
    }
  });

  test.describe("in the editor", () => {
    test.skip(({ isMobile }) => isMobile, "the source editor is a desktop task");

    test("lists a bad row's problem, then saves a valid change as v2", async ({ page }) => {
      test.setTimeout(90_000);
      const short = [HEADER, JSON.stringify(["Apples", 3, 1.2, "=B2*C2"])].join("\n");
      const { artifact, client } = await publishSheet(page, short);
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await expect(page.getByText("Editing v1")).toBeVisible();
        const lines = page.locator(".pl-editor .monaco-editor .view-lines").first();
        await expect(lines).toBeVisible({ timeout: 15_000 });
        const preview = page.frameLocator(PREVIEW_FRAME);
        await expect(preview.locator("#__plinth-cell-D2")).toHaveText(/3[.,]60/, {
          timeout: 15_000,
        });

        await lines.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.press("Enter");
        await page.keyboard.type('["Pears","five"]', { delay: 20 });
        const problems = page.locator(".pl-editor__problems");
        await expect(problems).toContainText('B3: "five" is not a number (column Qty is number)');
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

        for (let i = 0; i < '"five"]'.length; i++) await page.keyboard.press("Backspace");
        await page.keyboard.type("5]", { delay: 20 });
        await expect(problems).toHaveCount(0);
        await expect(preview.locator("#__plinth-cell-B3")).toHaveText("5");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Saved as v2")).toBeVisible();
        const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body).toMatchObject({
          version: 2,
          type: "sheet",
          source_path: "sheet.jsonl",
        });
        expect(current.body.content.split("\n").at(-1)).toBe('["Pears",5]');
      } finally {
        await client.close();
      }
    });
  });
});
