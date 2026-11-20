// Designs (type "design"): an agent publishes artboards over MCP and Plinth lays them out on a
// canvas, each board alone at its size in a nested frame with an opaque origin, loaded from the
// fixed board loader. Checked here: boards run their own scripts, styles and images and nothing of
// the shell, the app or each other; nothing reaches another host; zoom, Fit and interact mode; the
// dark scheme and phone width; printing; a comment pinned to a board; and the editor with its
// preview, save, compare, restore and conflict. The opaque case is in typed-design-opaque.spec.ts.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { APP_ORIGIN, apiGet, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { captureLoad, openCapture, seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';
const WIDE = { width: 1280, height: 860 };

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ASSETS = [
  { path: "img/hero.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
  { path: "brand.css", content: "h1 { color: rgb(47, 91, 234); }", content_type: "text/css" },
];

const TITLE = "Launch kit";
const LAST_LINE = "<p>The end of the design.</p>";
const HOSTILE = [
  '<div id="report">pending</div>',
  "<script>",
  "  var r = {};",
  "  try { r.parent = String(parent.document.title); } catch (e) { r.parent = 'blocked'; }",
  "  try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked'; }",
  "  try { localStorage.setItem('x', '1'); r.storage = 'open'; } catch (e) { r.storage = 'blocked'; }",
  "  try { top.location.href = 'https://example.com/'; } catch (e) {}",
  "  try { top.postMessage({ source: 'plinth-renderer', v: 1, type: 'save' }, '*'); } catch (e) {}",
  "  try { parent.postMessage({ source: 'plinth-board', v: 1, type: 'ready' }, '*'); } catch (e) {}",
  "  window.__pwned = 1;",
  "  fetch('/__plinth/api/v1/session', { headers: { 'x-plinth-data': '1' } })",
  "    .then(function (res) { r.fetch = res.status; }, function () { r.fetch = 'blocked'; })",
  "    .then(function () { document.getElementById('report').textContent = JSON.stringify(r); });",
  "</script>",
].join("\n");

const DESIGN = [
  `<title>${TITLE}</title>`,
  '<link rel="stylesheet" href="brand.css">',
  "",
  '<!-- artboard id="home" name="Home" size="iphone" section="Mobile" -->',
  '<main style="padding: 24px">',
  '  <img id="hero" src="img/hero.png" alt="" width="40" height="40">',
  "  <h1>Ship faster</h1>",
  '  <p id="out">static</p>',
  "  <button id=\"tap\" onclick=\"document.getElementById('out').textContent = 'tapped'\">Tap</button>",
  "  <script>document.getElementById('out').textContent = 'script ran';</script>",
  "</main>",
  "",
  '<!-- artboard id="post" name="Launch post &lt;img src=x onerror=alert(1)&gt;" size="instagram-post" section="Social" background="#0b0b0f" -->',
  '<div style="color: white; font-size: 96px; padding: 80px">Now live</div>',
  "",
  '<!-- artboard id="mrec" name="Ad 300x250" size="ad-medium-rectangle" section="Ads" -->',
  HOSTILE,
  LAST_LINE,
].join("\n");

/** Puts the editor's cursor at the end of the draft. */
async function toEnd(page: Page) {
  await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
  // Monaco picks its shortcuts from the user agent (the test devices report Windows).
  const mac = await page.evaluate(() => /Macintosh/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+End" : "Control+End");
}

interface Published {
  id: string;
  slug: string;
  type: string;
  version: number;
}

async function publishDesign(page: Page, content = DESIGN) {
  const email = uniqueEmail("design");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title: TITLE,
    type: "design",
    content,
    assets: ASSETS,
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.type).toBe("design");
  return { client, artifact: r.data };
}

/** The shell's frame, once the canvas has rendered. */
async function shellFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  await expect(page.frameLocator(selector).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

/** One board's frame, once its document has loaded. */
async function boardFrame(shell: Frame, id: string): Promise<Frame> {
  await expect(shell.locator(`.plinth-design__board[data-board="${id}"][data-loaded]`)).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  const handle = await shell
    .locator(`.plinth-design__board[data-board="${id}"] iframe`)
    .elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no board ${id}`);
  return frame;
}

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const zoomOf = async (shell: Frame) =>
  Number(await shell.locator("html").getAttribute("data-zoom"));

test.describe("a published design", () => {
  test.use({ viewport: WIDE });

  test("renders each board alone in an opaque frame that runs its own code and nothing else", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const shell = await shellFrame(page);
      await expect(shell.locator("html")).toHaveAttribute("data-boards", "3");
      const frames = shell.locator(".plinth-design__board iframe");
      await expect(frames).toHaveCount(3);
      expect(
        await frames.evaluateAll((els) =>
          els.map((e) => [e.getAttribute("title"), e.getAttribute("sandbox")]),
        ),
      ).toEqual([
        [
          "Home",
          "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
        ],
        [
          "Launch post <img src=x onerror=alert(1)>",
          "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
        ],
        [
          "Ad 300x250",
          "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
        ],
      ]);
      await expect(shell.locator("html")).toHaveAttribute("data-boards-loaded", "3", {
        timeout: 15_000,
      });

      // The phone board: its inline script ran, its image and CSS came from the version's files,
      // its origin is opaque and its viewport is the board's width.
      const home = await boardFrame(shell, "home");
      await expect(home.locator("#out")).toHaveText("script ran");
      await expect
        .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0);
      await expect(home.locator("h1")).toHaveCSS("color", "rgb(47, 91, 234)");
      expect(
        await home.evaluate(() => [self.origin, window.innerWidth, window.innerHeight]),
      ).toEqual(["null", 393, 852]);
      // The shell's label shows the hostile name as text.
      await expect(
        shell.locator('.plinth-design__label[data-board="post"] .plinth-design__label-name'),
      ).toHaveText("Launch post <img src=x onerror=alert(1)>");

      // The hostile board reached nothing.
      const ad = await boardFrame(shell, "mrec");
      await expect(ad.locator("#report")).not.toHaveText("pending", { timeout: 10_000 });
      const report = JSON.parse((await ad.locator("#report").textContent()) ?? "{}");
      expect(report).toEqual({
        parent: "blocked",
        cookie: "blocked",
        storage: "blocked",
        fetch: "blocked",
      });
      expect(await shell.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
        undefined,
      );
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
        undefined,
      );
      await expect(page).toHaveURL(`${APP_ORIGIN}/a/${artifact.slug}`);
      // The forged ready did not render the board again.
      expect(await ad.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(1);
      expect(dialogs).toEqual([]);

      // The app, this artifact's subdomain and nothing else.
      expect([...hosts].sort()).toEqual(
        [new URL(APP_ORIGIN).host, `${artifact.id}.${CONTENT_HOST}`].sort(),
      );
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("zooms with the toolbar and keys, fits every board, and lets a board be used", async ({
    page,
  }) => {
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const shell = await shellFrame(page);
      const fitted = await zoomOf(shell);
      expect(fitted).toBeLessThan(100);
      await shell.getByRole("button", { name: "Zoom in" }).click();
      await expect.poll(() => zoomOf(shell)).toBeGreaterThan(fitted);
      await shell.getByRole("button", { name: "Zoom to 100%" }).click();
      await expect.poll(() => zoomOf(shell)).toBe(100);
      await shell.locator(".plinth-design__canvas").focus();
      await page.keyboard.press("-");
      await expect.poll(() => zoomOf(shell)).toBe(80);
      await page.keyboard.press("0");
      await expect.poll(() => zoomOf(shell)).toBe(fitted);
      // Fit shows every board whole.
      const view = await shell.evaluate(() => [window.innerWidth, window.innerHeight]);
      for (const id of ["home", "post", "mrec"]) {
        const box = await shell
          .locator(`.plinth-design__board[data-board="${id}"]`)
          .evaluate((e) => {
            const r = e.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom];
          });
        expect(box[0]).toBeGreaterThanOrEqual(0);
        expect(box[1]).toBeGreaterThanOrEqual(0);
        expect(box[2]).toBeLessThanOrEqual(view[0] ?? 0);
        expect(box[3]).toBeLessThanOrEqual(view[1] ?? 0);
      }

      // A board's name zooms to it.
      await shell.getByRole("button", { name: "Zoom to Ad 300x250" }).click();
      await expect.poll(() => zoomOf(shell)).toBe(100);

      // Covered, a board takes no clicks; in interact mode it does, and Done covers it again.
      await shell.getByRole("button", { name: "Fit all boards" }).click();
      // Interact shows on the board zoomed to, not on every label.
      await expect(shell.getByRole("button", { name: /^Interact with/ })).toHaveCount(0);
      await shell.getByRole("button", { name: "Zoom to Home" }).click();
      const home = await boardFrame(shell, "home");
      await shell.getByRole("button", { name: "Interact with Home" }).click();
      await expect(shell.locator("#__plinth-board-home")).toBeHidden();
      await home.locator("#tap").click();
      await expect(home.locator("#out")).toHaveText("tapped");
      await shell.getByRole("button", { name: "Done interacting" }).click();
      await expect(shell.locator("#__plinth-board-home")).toBeVisible();
    } finally {
      await client.close();
    }
  });

  test("follows the color scheme and fits a phone without sideways scrolling", async ({ page }) => {
    const { artifact, client } = await publishDesign(page);
    try {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/a/${artifact.slug}`);
      const shell = await shellFrame(page);
      const canvasBg = () =>
        shell
          .locator(".plinth-design__canvas")
          .evaluate((c) => getComputedStyle(c).backgroundColor);
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(canvasBg).toBe("rgb(241, 240, 236)");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(canvasBg).toBe("rgb(20, 22, 25)");
      const widths = await shell.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        const bar = document.querySelector(".plinth-design__toolbar")?.getBoundingClientRect();
        return { viewport: window.innerWidth, page: root.scrollWidth, bar: bar?.right ?? 0 };
      });
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
      expect(widths.bar).toBeLessThanOrEqual(widths.viewport);
    } finally {
      await client.close();
    }
  });

  test("the menu's Print or save as PDF prints the design's frame once every board loaded", async ({
    page,
  }) => {
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      const shell = await shellFrame(page);
      await shell.evaluate(() => {
        const w = window as unknown as { __printed: number; __loadedAtPrint: string | null };
        w.__printed = 0;
        window.print = () => {
          w.__printed += 1;
          w.__loadedAtPrint = document.documentElement.getAttribute("data-boards-loaded");
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
        .poll(() => shell.evaluate(() => (window as unknown as { __printed: number }).__printed))
        .toBe(1);
      expect(
        await shell.evaluate(
          () => (window as unknown as { __loadedAtPrint: string }).__loadedAtPrint,
        ),
      ).toBe("3");
      const pages = await shell.evaluate(
        () => document.getElementById("__plinth-design-print")?.textContent ?? "",
      );
      expect(pages).toContain("@page s393x852 { size: 393px 852px; margin: 0; }");
      expect(pages).toContain("@page s1080x1080 { size: 1080px 1080px; margin: 0; }");
    } finally {
      await client.close();
    }
  });
});

test.describe("a design's thumbnail capture", () => {
  test.use({ viewport: { width: 1200, height: 630 } });

  test("a top-level load with a capture pass shows the boards with their images and styles", async ({
    page,
  }) => {
    // What services/thumbnails.ts does in Browser Rendering: open the version's enter URL
    // top-level, so the shell is the top document and each board an opaque frame inside it.
    // The boards' own requests are keyed with a cross-site ancestor, so they need the second
    // capture cookie the Worker hands the browser for that partition (captureFrameCookies).
    const { artifact, client } = await publishDesign(page);
    try {
      await page.context().clearCookies();
      const load = await captureLoad(artifact.id, artifact.version);
      expect(load.cookies).toHaveLength(1);
      expect(load.cookies[0]?.partitionKey).toEqual({
        topLevelSite: `http://${CONTENT_HOST.replace(/:\d+$/, "")}`,
        hasCrossSiteAncestor: true,
      });
      await openCapture(page, load);
      expect(page.url()).toBe(`http://${artifact.id}.${CONTENT_HOST}/__plinth/v/1/`);
      const shell = page.mainFrame();
      await expect(shell.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
      await expect(shell.locator("html")).toHaveAttribute("data-boards-loaded", "3", {
        timeout: 15_000,
      });
      const home = await boardFrame(shell, "home");
      await expect(home.locator("#out")).toHaveText("script ran");
      await expect
        .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0);
      await expect(home.locator("h1")).toHaveCSS("color", "rgb(47, 91, 234)");
    } finally {
      await client.close();
    }
  });
});

test.describe("comments on a design", () => {
  test.use({ viewport: WIDE });

  test("review mode pins a comment to a board, and the pin stays on it when zooming", async ({
    page,
  }, info) => {
    test.skip(info.project.name === "mobile", "pin placement is checked at desktop widths");
    test.setTimeout(60_000);
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}`);
      await page.getByRole("button", { name: "Comments", exact: true }).click();
      const panel = page.getByRole("region", { name: "Comments" });
      await expect(panel).toBeVisible();
      // The frame reloads in review mode: wait for the bridge before holding on to it.
      await expect(
        page.frameLocator(CURRENT_FRAME).locator("script[data-plinth-bridge]"),
      ).toHaveCount(1, { timeout: 15_000 });
      const shell = await shellFrame(page);
      // Review mode keeps every cover on: no Interact buttons.
      await expect(shell.locator(".plinth-design__label-interact")).toHaveCount(0);

      await panel.getByRole("button", { name: "Pin to an element" }).click();
      await shell.locator("#__plinth-board-post").click();
      await expect(panel.getByText("Pinned to")).toBeVisible();
      await panel.getByRole("textbox", { name: "New comment" }).fill("Bigger headline");
      await panel.getByRole("button", { name: "Comment", exact: true }).click();
      const pin = page.getByTestId("comment-pins").getByRole("button", { name: /^Comment 1/ });
      await expect(pin).toBeVisible();

      const frameBox = await page.locator(CURRENT_FRAME).boundingBox();
      const inside = async () => {
        const p = await pin.boundingBox();
        const c = await shell.locator("#__plinth-board-post").boundingBox();
        if (!p || !c || !frameBox) return false;
        const x = p.x + p.width / 2;
        const y = p.y + p.height / 2;
        return x >= c.x - 2 && x <= c.x + c.width + 2 && y >= c.y - 2 && y <= c.y + c.height + 2;
      };
      await expect.poll(inside).toBe(true);
      await shell.getByRole("button", { name: "Zoom in" }).click();
      await shell.getByRole("button", { name: "Zoom in" }).click();
      await expect.poll(inside).toBe(true);
    } finally {
      await client.close();
    }
  });
});

test.describe("editing a design", () => {
  test.use({ viewport: WIDE });

  test("HTML with a live preview, save as v2, compare, restore v1 as v3", async ({ page }) => {
    test.setTimeout(90_000);
    const problems = watchConsole(page);
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}/edit`);
      await expect(page.getByText("Editing v1")).toBeVisible();
      const lines = page.locator(".pl-editor .monaco-editor .view-lines").first();
      await expect(lines).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".pl-editor-pane__label").first()).toHaveText("Design HTML");
      const preview = page.frameLocator(PREVIEW_FRAME);
      await expect(preview.locator(".plinth-design__board")).toHaveCount(3, { timeout: 15_000 });

      await toEnd(page);
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(
        '<!-- artboard id="banner" name="Banner" size="ad-leaderboard" -->\n<img id="b" src="img/hero.png" alt="" width="20" height="20">',
      );
      await expect(page.getByText("Unsaved changes")).toBeVisible();
      await expect(preview.locator(".plinth-design__board")).toHaveCount(4);
      // The preview's new board loads the version's image.
      const previewEl = await page.locator(PREVIEW_FRAME).elementHandle();
      const previewFrame = await previewEl?.contentFrame();
      if (!previewFrame) throw new Error("no preview");
      const banner = await boardFrame(previewFrame, "banner");
      await expect
        .poll(() => banner.locator("#b").evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0);

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved as v2")).toBeVisible();
      const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
      expect(current.body).toMatchObject({
        version: 2,
        type: "design",
        source_path: "design.html",
      });
      expect(current.body.content).toContain('name="Banner"');

      await page.goto(`/a/${artifact.slug}/compare?from=1&to=2`);
      const diff = page.getByRole("table", { name: /Changes to design\.html from v1 to v2/ });
      await expect(diff).toBeVisible();
      await expect(diff.getByRole("row", { name: /Added .*artboard id="banner"/ })).toBeVisible();
      await page.getByRole("tab", { name: "Rendered" }).click();
      const f1 = page.frameLocator(`iframe[title="v1 of ${TITLE}"]`);
      const f2 = page.frameLocator(`iframe[title="v2 of ${TITLE}"]`);
      await expect(f1.locator(".plinth-design__board")).toHaveCount(3, { timeout: 15_000 });
      await expect(f2.locator(".plinth-design__board")).toHaveCount(4, { timeout: 15_000 });

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
      expect(restored.body).toMatchObject({ version: 3, type: "design", content: DESIGN });
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("an agent's update while the editor is open shows the conflict", async ({ page }) => {
    test.setTimeout(60_000);
    const { artifact, client } = await publishDesign(page);
    try {
      await page.goto(`/a/${artifact.slug}/edit`);
      const lines = page.locator(".pl-editor .monaco-editor .view-lines").first();
      await expect(lines).toBeVisible({ timeout: 15_000 });
      await toEnd(page);
      await page.keyboard.press("Enter");
      await page.keyboard.insertText('<!-- artboard name="Mine" size="a5" -->');
      await expect(page.getByText("Unsaved changes")).toBeVisible();
      const agent = '<!-- artboard name="Agent board" size="a4" -->\n<p>Agent version</p>';
      const updated = await tool<{ version: number }>(client, "update_artifact", {
        id: artifact.id,
        content: agent,
        base_version: 1,
        note: "Agent change",
      });
      expect(updated.isError, updated.text).toBe(false);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        page.getByRole("heading", {
          name: "v2 was published while you were editing (by Work agent)",
        }),
      ).toBeVisible();
      const conflict = page.locator(".pl-conflict");
      await expect(conflict).toContainText("Agent version");
      // The draft is kept next to v2 (its added board is further down the virtualized diff).
      await expect(conflict).toContainText("Your draft, based on v1");
      await expect(conflict).toContainText('name="Home"');
      const now = await apiGet(page.request, `/artifacts/${artifact.id}`);
      expect(now.body).toMatchObject({ version: 2, content: agent });
    } finally {
      await client.close();
    }
  });
});
