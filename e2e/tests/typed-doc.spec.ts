// Doc artifacts (type "doc"): an agent publishes Markdown over MCP and Plinth renders it with its
// fixed renderer on the artifact's own origin. Checked here: what a good doc looks like (heading
// anchors, tables, code, its own images, light and dark, phone width, print), that the Markdown
// cannot run script or reach other hosts, printing from the artifact menu, and the Markdown editor
// with its live preview, history compare, restore and the conflict view. The opaque-isolation case
// is in opaque.spec.ts.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { APP_ORIGIN, apiGet, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

// The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads.
const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';
const WIDE = { width: 1280, height: 860 };

/** A 1x1 PNG, published as the doc's own image. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PIXEL = {
  path: "pixel.png",
  content: PIXEL_PNG,
  encoding: "base64",
  content_type: "image/png",
};

const TITLE = "Field notes";

/** Every feature a doc renders, plus Markdown that tries to run script. */
const DOC = [
  `# ${TITLE}`,
  "",
  "Read the [method](https://example.com/method) first, and never [click this](javascript:window.__pwned=1).",
  "",
  "## Measurements",
  "",
  "| Site | Depth | Reading one | Reading two | Reading three | Reading four | Remarks |",
  "| :--- | ---: | ---: | ---: | ---: | ---: | :---: |",
  "| Northwesternescarpmentridge | 12 | 0.51 | 0.52 | 0.53 | 0.54 | Uncharacteristically |",
  "| South | 7 | 0.41 | 0.42 | 0.43 | 0.44 | Clear |",
  "",
  "## Procedure",
  "",
  "```python",
  "def depth(reading):",
  "    return reading * 2  # <b>not bold</b>",
  "```",
  "",
  "![A tiny square](pixel.png)",
  "",
  "![Remote picture](https://example.org/remote.png)",
  "",
  "<script>window.__pwned = 1; alert('pwned')</script>",
  "",
  '<img src="nothing.png" onerror="window.__pwned = 2">',
  "",
].join("\n");

interface Published {
  id: string;
  slug: string;
  type: string;
  version: number;
}

/** A signed-in owner whose agent ("Work agent") publishes `content` as a doc over MCP. */
async function publishDoc(page: Page, content = DOC, title = TITLE) {
  const email = uniqueEmail("doc");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title,
    type: "doc",
    content,
    assets: [PIXEL],
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.type).toBe("doc");
  return { client, artifact: r.data };
}

/** The Frame object of the artifact frame the viewer is showing, once its doc has rendered. */
async function docFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  const locator = page.frameLocator(selector);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

/** CSP reports and page errors in the page and every frame in it. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function editorReady(page: Page) {
  await expect(page.locator(".pl-editor .monaco-editor .view-lines").first()).toBeVisible({
    timeout: 15_000,
  });
}

/** Type `text` on new lines at the end of the draft, key by key (Monaco drops keys under load). */
async function appendLines(page: Page, text: string) {
  await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text, { delay: 25 });
}

test.describe("a published doc", () => {
  test("renders headings, a table, code and its own image, and runs none of the Markdown", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      void d.dismiss();
    });
    const { artifact, client } = await publishDoc(page);
    const artifactHost = `${artifact.id}.${CONTENT_HOST}`;
    const hosts = new Set<string>();
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    try {
      await page.goto(`/a/${artifact.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
      const frame = await docFrame(page);
      expect(new URL(frame.url()).host).toBe(artifactHost);

      // Headings get ids and anchors.
      const h1 = frame.locator("h1#field-notes");
      await expect(h1).toContainText(TITLE);
      await expect(h1.locator("a.plinth-doc__anchor")).toHaveAttribute("href", "#field-notes");
      await expect(frame.locator("h2#measurements a.plinth-doc__anchor")).toHaveAttribute(
        "href",
        "#measurements",
      );

      // The table, in its scrolling wrapper, with alignment as classes.
      const table = frame.locator(".plinth-doc__table table");
      await expect(table).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Reading four" })).toBeVisible();
      await expect(table.getByRole("cell", { name: "Northwesternescarpmentridge" })).toBeVisible();
      await expect(table.locator("td.plinth-doc__align-right").first()).toHaveText("12");

      // The code block shows its source as text.
      const code = frame.locator("pre code.language-python");
      await expect(code).toContainText("def depth(reading):");
      await expect(code).toContainText("# <b>not bold</b>");
      await expect(code.locator("b")).toHaveCount(0);

      // The image comes from the artifact's own files.
      const img = frame.locator('img[alt="A tiny square"]');
      await expect(img).toHaveAttribute("src", "pixel.png");
      await expect
        .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0);

      // Links open in a new tab; an external image becomes a link and is never fetched.
      const method = frame.getByRole("link", { name: "method" });
      await expect(method).toHaveAttribute("href", "https://example.com/method");
      await expect(method).toHaveAttribute("target", "_blank");
      await expect(method).toHaveAttribute("rel", /noopener/);
      const remote = frame.locator('a[href="https://example.org/remote.png"]');
      await expect(remote).toHaveAttribute("target", "_blank");
      await expect(remote).toContainText("Remote picture");
      await expect(frame.locator('img[src^="http"]')).toHaveCount(0);

      // Nothing ran: no script, no handler, no javascript: URL, no dialog.
      expect(await frame.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
        undefined,
      );
      const urls = await frame.evaluate(() =>
        Array.from(document.querySelectorAll("[href], [src]")).map(
          (el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "",
        ),
      );
      expect(urls.filter((u) => /^\s*javascript:/i.test(u))).toEqual([]);
      await expect(frame.locator("main script, main [onerror]")).toHaveCount(0);
      await expect(frame.locator("main")).toContainText(
        "<script>window.__pwned = 1; alert('pwned')</script>",
      );
      await expect(frame.locator("main")).toContainText('onerror="window.__pwned = 2"');
      await expect(frame.locator("main")).toContainText(
        "[click this](javascript:window.__pwned=1)",
      );
      expect(dialogs).toEqual([]);

      // The page and its frame talked to two hosts only: the app and this artifact's subdomain.
      expect([...hosts].sort()).toEqual([new URL(APP_ORIGIN).host, artifactHost].sort());
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("follows the color scheme, fits a phone, and prints cleanly", async ({ page }) => {
    const { artifact, client } = await publishDoc(page);
    try {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/a/${artifact.slug}`);
      const frame = await docFrame(page);
      const bodyBackground = () =>
        frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor);

      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(bodyBackground).toBe("rgb(255, 255, 255)");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(bodyBackground).toBe("rgb(18, 20, 23)");

      // At 360px the doc never scrolls sideways; the wide table scrolls inside its wrapper.
      const widths = await frame.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        const wrap = document.querySelector(".plinth-doc__table") as HTMLElement;
        return {
          viewport: window.innerWidth,
          page: root.scrollWidth,
          wrapClient: wrap.clientWidth,
          wrapScroll: wrap.scrollWidth,
        };
      });
      expect(widths.viewport).toBeLessThanOrEqual(360);
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
      expect(widths.wrapScroll).toBeGreaterThan(widths.wrapClient);
      const wrap = frame.locator(".plinth-doc__table");
      await wrap.evaluate((w) => {
        w.scrollLeft = 100;
      });
      expect(await wrap.evaluate((w) => w.scrollLeft)).toBeGreaterThan(0);

      // Print: anchors are hidden, external links show their address, the page is white.
      const anchor = frame.locator("h1#field-notes a.plinth-doc__anchor");
      await expect(anchor).toBeVisible();
      await page.emulateMedia({ media: "print", colorScheme: "dark" });
      await expect(anchor).toBeHidden();
      await expect.poll(bodyBackground).toBe("rgb(255, 255, 255)");
      const after = await frame
        .getByRole("link", { name: "method" })
        .evaluate((a) => getComputedStyle(a, "::after").content);
      expect(after).toContain("https://example.com/method");
      await page.emulateMedia({ media: "screen" });
      await expect(anchor).toBeVisible();
    } finally {
      await client.close();
    }
  });

  test("the menu's Print or save as PDF prints the doc's frame, not the app page", async ({
    page,
  }) => {
    const { artifact, client } = await publishDoc(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const frame = await docFrame(page);
      await frame.evaluate(() => {
        const w = window as unknown as { __printed: number };
        w.__printed = 0;
        window.print = () => {
          w.__printed += 1;
        };
      });
      await page.evaluate(() => {
        window.print = () => {
          throw new Error("the app page was printed");
        };
      });
      await page.getByRole("button", { name: "Artifact actions" }).click();
      await page.getByRole("menuitem", { name: "Print or save as PDF" }).click();
      await expect
        .poll(() => frame.evaluate(() => (window as unknown as { __printed: number }).__printed))
        .toBe(1);
    } finally {
      await client.close();
    }
  });
});

test.describe("editing a doc", () => {
  test.use({ viewport: WIDE });

  const V1 = `# ${TITLE}\n\nFirst paragraph.\n\n![A tiny square](pixel.png)\n`;

  test("Markdown with a live preview, save as v2, compare, restore v1 as v3", async ({ page }) => {
    test.setTimeout(90_000);
    const problems = watchConsole(page);
    const { artifact, client } = await publishDoc(page, V1);
    try {
      await page.goto(`/a/${artifact.slug}/edit`);
      await expect(page.getByText("Editing v1")).toBeVisible();
      await editorReady(page);
      await expect(page.locator(".pl-editor-pane__label").first()).toHaveText("Markdown");
      await expect(
        page.getByRole("textbox", { name: `Markdown of ${TITLE}.`, exact: false }),
      ).toHaveCount(1);

      // The preview is the doc's renderer, with the doc's own image.
      const preview = page.frameLocator(PREVIEW_FRAME);
      await expect(preview.locator("h1#field-notes")).toContainText(TITLE, { timeout: 15_000 });
      await expect
        .poll(() =>
          preview
            .locator('img[alt="A tiny square"]')
            .evaluate((i: HTMLImageElement) => i.naturalWidth),
        )
        .toBeGreaterThan(0);

      await appendLines(page, "## Added");
      await expect(page.getByText("Unsaved changes")).toBeVisible();
      await expect(preview.locator("h2#added")).toContainText("Added");

      await page.getByLabel("What changed? (optional)").fill("Added a section");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved as v2")).toBeVisible();
      await expect(page.getByText("Editing v2")).toBeVisible();

      const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
      expect(current.body).toMatchObject({ version: 2, type: "doc", source_path: "content.md" });
      expect(current.body.content).toBe(`${V1}\n## Added`);
      expect(current.body.html).toBeUndefined();

      // Compare: the source diff is on content.md and shows the added line.
      await page.goto(`/a/${artifact.slug}/compare?from=1&to=2`);
      const diff = page.getByRole("table", { name: /Changes to content\.md from v1 to v2/ });
      await expect(diff).toBeVisible();
      await expect(diff.getByRole("row", { name: /Added ## Added/ })).toBeVisible();

      // Rendered compare: each version through the renderer.
      await page.getByRole("tab", { name: "Rendered" }).click();
      const f1 = page.frameLocator(`iframe[title="v1 of ${TITLE}"]`);
      const f2 = page.frameLocator(`iframe[title="v2 of ${TITLE}"]`);
      await expect(f1.locator("h1#field-notes")).toContainText(TITLE, { timeout: 15_000 });
      await expect(f2.locator("h1#field-notes")).toContainText(TITLE, { timeout: 15_000 });
      await expect(f2.locator("h2#added")).toContainText("Added");
      await expect(f1.locator("h2#added")).toHaveCount(0);

      // Restore v1: published as v3 with v1's Markdown.
      await page.goto(`/a/${artifact.slug}/history`);
      await page
        .locator('li[data-version="1"]')
        .getByRole("button", { name: "More actions for v1" })
        .click();
      await page.getByRole("menuitem", { name: "Restore v1" }).click();
      await page
        .getByRole("dialog", { name: "Restore v1?" })
        .getByRole("button", { name: "Restore v1" })
        .click();
      await expect(page.getByText("Restored v1")).toBeVisible();
      const restored = await apiGet(page.request, `/artifacts/${artifact.id}`);
      expect(restored.body).toMatchObject({ version: 3, type: "doc", content: V1 });
      const got = await tool<{ type: string; content: string; version: number }>(
        client,
        "get_artifact",
        { id: artifact.id },
      );
      expect(got.data).toMatchObject({ type: "doc", content: V1, version: 3 });
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("an agent's update while the editor is open shows the conflict in Markdown", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { artifact, client } = await publishDoc(page, V1);
    try {
      await page.goto(`/a/${artifact.slug}/edit`);
      await editorReady(page);
      await expect(page.frameLocator(PREVIEW_FRAME).locator("h1#field-notes")).toBeVisible({
        timeout: 15_000,
      });
      await appendLines(page, "## Mine");
      await expect(page.frameLocator(PREVIEW_FRAME).locator("h2#mine")).toBeVisible();

      const agent = `# ${TITLE}\n\nAgent version of the notes.\n`;
      const updated = await tool<{ version: number }>(client, "update_artifact", {
        id: artifact.id,
        content: agent,
        base_version: 1,
        note: "Agent change",
      });
      expect(updated.isError, updated.text).toBe(false);
      expect(updated.data.version).toBe(2);

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        page.getByRole("heading", {
          name: "v2 was published while you were editing (by Work agent)",
        }),
      ).toBeVisible();
      const conflict = page.locator(".pl-conflict");
      await expect(conflict.locator(".monaco-diff-editor")).toBeVisible();
      await expect(conflict).toContainText("Agent version of the notes.");
      await expect(conflict).toContainText("## Mine");
      // Both sides of the diff are Markdown models.
      await expect(conflict.locator('[data-mode-id="markdown"]')).toHaveCount(2);
      await expect(conflict.locator('[data-mode-id="html"]')).toHaveCount(0);
      await expect(conflict.locator(".pl-conflict__labels")).toContainText("v2, published");

      // Nothing was overwritten.
      const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
      expect(current.body).toMatchObject({ version: 2, content: agent });
    } finally {
      await client.close();
    }
  });
});
