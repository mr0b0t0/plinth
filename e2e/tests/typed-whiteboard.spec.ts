// Whiteboards (type "whiteboard") in the browser: a board published over MCP with a starting set of
// blocks and an arrow, its blocks in shared data. On a board open to commenters (`edit:
// "commenters"`; the default is editors only), the owner and a commenter see each other's
// cursors, a drag shows live and is saved; a person with view access gets a read-only board whose
// direct writes the server refuses; a settings version that makes the board editors-only turns
// the commenter's board read-only as their socket reconnects; an agent's block shows up; the
// artifact menu downloads a PNG and an SVG and offers no source editor; the keyboard moves a block
// and zooms; the page fits a phone; and the ⋯ menu's one Settings item (the owner's settings page,
// the editor's dialog) saves settings versions, and after a newer version shows that version's
// settings and loads it behind the dialog instead.
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Frame, type Page, test } from "@playwright/test";
import { apiPut, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const BOARD = JSON.stringify({
  v: 1,
  blocks: [
    { id: "goal", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Ship v2", color: "yellow" },
    { id: "risk", kind: "rect", x: 240, y: 0, w: 200, h: 100, text: "Risks <b>&amp;</b>" },
    { id: "plan", kind: "ellipse", x: 0, y: 240, w: 180, h: 120, text: "Plan" },
  ],
  arrows: [{ id: "a1", from: "goal", to: "risk", label: "blocks" }],
});

async function boardFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no board frame");
  return frame;
}

/** Publish the board; `edit` "commenters" opens it to commenters (the default is editors only). */
async function publishBoard(page: Page, owner: string, edit?: "commenters") {
  const { token } = await seedToken(owner, { label: "Board agent", clientType: "claude" });
  const client = await mcpClient(token);
  const r = await tool(client, "publish_artifact", {
    title: "Launch board",
    type: "whiteboard",
    content: edit ? JSON.stringify({ ...JSON.parse(BOARD), edit }) : BOARD,
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.board).toEqual({ blocks: 3, arrows: 1 });
  await seedSession(page.context(), owner);
  return { token, client, id: r.data.id as string, slug: r.data.slug as string };
}

async function open(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  if (!base) await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  const frame = await boardFrame(page);
  await expect(frame.locator("html")).toHaveAttribute("data-room", "open", { timeout: 15_000 });
  return { page, frame };
}

/** A direct write from the frame, as page code could make it: the server decides. */
const write = (frame: Frame, method: string, path: string, body?: unknown) =>
  frame.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(`/__plinth/api/v1${p}`, {
        method: m as string,
        headers: { "x-plinth-data": "1", "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return res.status;
    },
    [method, path, body] as const,
  );

/** A cursor's tag shows the email's local part, as the people list does at phone width. */
const tag = (email: string) => email.split("@")[0] ?? email;

const leftOf = (frame: Frame, label: RegExp) =>
  frame
    .getByRole("group", { name: label })
    .evaluate((el) => Number.parseInt((el as HTMLElement).style.left, 10));

test("a shared board: cursors, a live drag that saves, viewers read-only, editors-only at once", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = uniqueEmail("wb-owner");
  const guest = uniqueEmail("wb-guest");
  const watcher = uniqueEmail("wb-watcher");
  const { token, client, id, slug } = await publishBoard(page, owner, "commenters");
  const shared = await apiPut(
    page.request,
    `/artifacts/${id}/sharing`,
    {
      grants: [
        { email: guest, role: "commenter" },
        { email: watcher, role: "viewer" },
      ],
    },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  const o = await open(browser, owner, slug, page);
  const c = await open(browser, guest, slug);
  const v = await open(browser, watcher, slug);
  try {
    // The starting board, from shared data: three blocks and the arrow; text drawn as text.
    await expect(o.frame.locator(".wb-block")).toHaveCount(3);
    await expect(o.frame.locator(".wb-arrow")).toHaveCount(1);
    await expect(o.frame.getByRole("group", { name: /^Box: Risks/ })).toHaveText(
      "Risks <b>&amp;</b>",
    );
    await expect(o.frame.locator(".wb-block b")).toHaveCount(0);
    await expect(c.frame.getByRole("button", { name: "Add note" })).toBeEnabled();

    // The viewer: read-only (no edit tools, one short line), and the server refuses a direct
    // write from their frame.
    await expect(v.frame.getByRole("button", { name: "Add note" })).toBeHidden();
    await expect(v.frame.locator(".wb-banner")).toHaveText("View only");
    await expect(v.frame.locator("html")).toHaveAttribute("data-readonly", "true");
    const block = { kind: "note", x: 0, y: 480, w: 200, h: 140, text: "x" };
    expect(await write(v.frame, "POST", "/data/blocks", { data: block })).toBe(403);

    // Cursors: the owner's shows on the commenter's board, the viewer's on the owner's.
    const area = await o.page.locator(CURRENT_FRAME).boundingBox();
    if (!area) throw new Error("no frame");
    await o.page.mouse.move(area.x + area.width - 40, area.y + area.height - 40);
    await o.page.mouse.move(area.x + area.width - 30, area.y + area.height - 30, { steps: 3 });
    await expect(c.frame.locator(".wb-cursor span").filter({ hasText: tag(owner) })).toHaveCount(
      1,
      {
        timeout: 10_000,
      },
    );
    const vArea = await v.page.locator(CURRENT_FRAME).boundingBox();
    if (!vArea) throw new Error("no frame");
    await v.page.mouse.move(vArea.x + vArea.width - 50, vArea.y + vArea.height - 50);
    await v.page.mouse.move(vArea.x + vArea.width - 40, vArea.y + vArea.height - 40, { steps: 3 });
    await expect(o.frame.locator(".wb-cursor span").filter({ hasText: tag(watcher) })).toHaveCount(
      1,
      {
        timeout: 10_000,
      },
    );

    // The commenter drags the note: the owner sees it move before the drop, and it is saved.
    const note = c.frame.getByRole("group", { name: /^Note: Ship v2/ });
    const start = await leftOf(o.frame, /^Note: Ship v2/);
    const box = await note.boundingBox();
    if (!box) throw new Error("no note");
    await c.page.mouse.move(box.x + 30, box.y + 30);
    await c.page.mouse.down();
    await c.page.mouse.move(box.x + 60, box.y + 50, { steps: 4 });
    await c.page.mouse.move(box.x + 90, box.y + 70, { steps: 4 });
    await expect.poll(() => leftOf(o.frame, /^Note: Ship v2/), { timeout: 10_000 }).not.toBe(start);
    await c.page.mouse.up();
    const dropped = await leftOf(c.frame, /^Note: Ship v2/);
    expect(dropped).toBeGreaterThan(start);
    await expect
      .poll(
        async () => {
          const r = await tool(client, "list_artifact_data", {
            id,
            collection: "blocks",
            doc_id: "goal",
          });
          return r.data.doc?.data?.x;
        },
        { timeout: 15_000 },
      )
      .toBe(dropped);

    // An agent adds a block: it shows on the open boards.
    const added = await tool(client, "write_artifact_data", {
      id,
      ops: [
        {
          op: "set",
          collection: "blocks",
          doc_id: "agent-note",
          data: { kind: "note", x: 480, y: 0, w: 200, h: 140, text: "From the agent" },
          if_rev: 0,
        },
      ],
    });
    expect(added.data.results?.[0]?.ok, added.text).toBe(true);
    await expect(o.frame.getByRole("group", { name: /^Note: From the agent/ })).toHaveCount(1, {
      timeout: 20_000,
    });

    // Editors only: the commenter's socket reconnects (4410) and their board turns read-only.
    const current = await tool(client, "get_artifact", { id });
    const updated = await tool(client, "update_artifact", {
      id,
      content: '{"v":1,"edit":"editors"}',
      base_version: current.data.version,
    });
    expect(updated.isError, updated.text).toBe(false);
    // Each open page follows the new version at a moment of its own, into a new frame, so from
    // here on the checks find each person's current board instead of the frame they opened.
    const cBoard = c.page.frameLocator(CURRENT_FRAME);
    const oBoard = o.page.frameLocator(CURRENT_FRAME);
    await expect(cBoard.locator("html")).toHaveAttribute("data-readonly", "true", {
      timeout: 15_000,
    });
    await expect(cBoard.locator("html")).toHaveAttribute("data-room", "open", {
      timeout: 15_000,
    });
    await expect(cBoard.getByRole("button", { name: "Add note" })).toBeHidden();
    expect(
      await write(await boardFrame(c.page), "PUT", "/data/blocks/agent-note", { data: block }),
    ).toBe(403);
    // Their presence still shows for the owner. The pointer moves again on each try, since a
    // board that has just followed the new version has not sent a cursor yet.
    let nudge = 0;
    await expect(async () => {
      const cArea = await c.page.locator(CURRENT_FRAME).boundingBox();
      if (!cArea) throw new Error("no frame");
      nudge = (nudge + 1) % 10;
      await c.page.mouse.move(cArea.x + cArea.width - 60 - nudge, cArea.y + cArea.height - 60);
      await c.page.mouse.move(cArea.x + cArea.width - 50 - nudge, cArea.y + cArea.height - 50, {
        steps: 3,
      });
      await expect(oBoard.locator(".wb-cursor span").filter({ hasText: tag(guest) })).toHaveCount(
        1,
        {
          timeout: 2_000,
        },
      );
    }).toPass({ timeout: 20_000 });
    // The owner still edits.
    await expect(oBoard.getByRole("button", { name: "Add note" })).toBeEnabled();
  } finally {
    await client.close();
    await c.page.context().close();
    await v.page.context().close();
  }
});

/** Pick an item in the artifact's ⋯ menu. */
async function menuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("export from the menu, the keyboard, zoom, phone width and axe", async ({ page }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("wb-export");
  const { client, id, slug } = await publishBoard(page, owner);
  try {
    await page.goto(`/a/${slug}`);
    let frame = await boardFrame(page);
    await expect(frame.locator(".wb-block")).toHaveCount(3);

    // One way to change a board: on its page. The menu has no source editor, and the editor's
    // address goes back to the board.
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await expect(page.getByRole("menuitem", { name: /^Edit/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    if (test.info().project.name !== "mobile") {
      await page.goto(`/a/${slug}/edit`);
      await expect(page).toHaveURL(new RegExp(`/a/${slug}$`), { timeout: 15_000 });
      frame = await boardFrame(page);
      await expect(frame.locator(".wb-block")).toHaveCount(3);
    }

    // SVG: a file with the board's text, escaped, and nothing that runs or loads.
    const svgDownload = page.waitForEvent("download");
    await menuItem(page, "Download as SVG");
    const svgFile = await svgDownload;
    expect(svgFile.suggestedFilename()).toBe("launch-board.svg");
    const svg = await readFile(await svgFile.path(), "utf8");
    expect(svg).toContain("Ship v2");
    expect(svg).toContain("&lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(svg).not.toMatch(/<script|foreignObject|href=/i);
    const parsed = await page.evaluate((text) => {
      const d = new DOMParser().parseFromString(text, "image/svg+xml");
      return { error: d.querySelector("parsererror") !== null, root: d.documentElement.nodeName };
    }, svg);
    expect(parsed).toEqual({ error: false, root: "svg" });

    // PNG: a real PNG file.
    const pngDownload = page.waitForEvent("download");
    await menuItem(page, "Download as PNG");
    const pngFile = await pngDownload;
    expect(pngFile.suggestedFilename()).toBe("launch-board.png");
    const png = await readFile(await pngFile.path());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // The keyboard moves the focused block 10 units, and the move is saved.
    const plan = frame.getByRole("group", { name: /^Ellipse: Plan/ });
    await plan.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(
        async () =>
          (await tool(client, "list_artifact_data", { id, collection: "blocks", doc_id: "plan" }))
            .data.doc?.data?.x,
        { timeout: 15_000 },
      )
      .toBe(10);

    // Zoom in with the keyboard, then fit: the world layer's scale follows.
    const scale = () =>
      frame.locator(".wb-world").evaluate((el) => (el as HTMLElement).style.transform);
    const before = await scale();
    await frame.locator(".wb-viewport").focus();
    await page.keyboard.press("+");
    await expect.poll(scale).not.toBe(before);
    await frame.getByRole("button", { name: "Fit the board" }).click();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    // At 390 px, with a block selected: its controls take the add buttons' place, the bar stays
    // one row (the colours scroll inside it), Delete and Fit are in view, and the page itself
    // never scrolls sideways.
    await page.setViewportSize({ width: 390, height: 800 });
    await frame.getByRole("group", { name: /^Note: Ship v2/ }).focus();
    await expect(frame.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Add note" })).toBeHidden();
    await expect
      .poll(() =>
        frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    const row = await frame.locator(".wb-toolbar").evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      const fit = bar.querySelector('[aria-label="Fit the board"]')?.getBoundingClientRect();
      const del = [...bar.querySelectorAll("button")]
        .find((b) => b.textContent === "Delete")
        ?.getBoundingClientRect();
      return {
        oneRow: box.height <= 48,
        inView: !!fit && !!del && fit.right <= innerWidth && del.right <= innerWidth,
      };
    });
    expect(row).toEqual({ oneRow: true, inView: true });
  } finally {
    await client.close();
  }
});

test("Board settings: one Settings item; the owner's page and the editor's dialog save versions, a newer one is shown", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("wb-settings");
  const editor = uniqueEmail("wb-settings-ed");
  const { token, client, id, slug } = await publishBoard(page, owner);
  const shared = await apiPut(
    page.request,
    `/artifacts/${id}/sharing`,
    { grants: [{ email: editor, role: "editor" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  const editorPage = await (await browser.newContext()).newPage();
  try {
    // The owner: the ⋯ menu has one Settings item, the settings page, and no source editor.
    await page.goto(`/a/${slug}`);
    const frame = await boardFrame(page);
    await expect(frame.locator(".wb-viewport")).toHaveAttribute("data-bg", "dots");
    await page.getByRole("button", { name: "Artifact actions" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /settings/i })).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: /^Edit/ })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(new RegExp(`/a/${slug}/settings$`));

    // Its Board section saves v2 with the new background.
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Board", exact: true }),
    });
    await expect(section.getByRole("radio", { name: "Dots" })).toBeChecked();
    // The default: only editors change the board.
    await expect(section.getByRole("radio", { name: "Editors only" })).toBeChecked();
    await section.getByRole("radio", { name: "Grid" }).check();
    await section.getByRole("button", { name: "Save board" }).click();
    await expect(page.getByText("Saved as v2")).toBeVisible();
    const v2 = await tool(client, "get_artifact", { id });
    expect(v2.data.version).toBe(2);
    expect(JSON.parse(v2.data.content)).toEqual({ v: 1, background: "grid", edit: "editors" });

    // The editor: one Settings item, which opens the dialog over the board.
    await seedSession(editorPage.context(), editor);
    await editorPage.goto(`/a/${slug}`);
    const edFrame = await boardFrame(editorPage);
    await expect(edFrame.locator(".wb-viewport")).toHaveAttribute("data-bg", "grid");
    // The blocks stay: a settings version never touches the board's shared data.
    await expect(edFrame.locator(".wb-block")).toHaveCount(3);
    await editorPage.getByRole("button", { name: "Artifact actions" }).click();
    const edMenu = editorPage.getByRole("menu");
    await expect(edMenu.getByRole("menuitem", { name: /settings/i })).toHaveCount(1);
    await edMenu.getByRole("menuitem", { name: "Settings" }).click();
    const dialog = editorPage.getByRole("dialog", { name: "Board settings" });
    await expect(dialog.getByRole("radio", { name: "Grid" })).toBeChecked();
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    // Let the dialog's entrance animation settle so axe sees its final colours.
    await editorPage.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== "running"),
    );
    const results = await new AxeBuilder({ page: editorPage }).include('[role="dialog"]').analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    // An agent publishes v3 meanwhile; the save is refused, the dialog shows v3's settings, and
    // the page behind it loads v3 (its version and its background).
    const v3 = await tool(client, "update_artifact", {
      id,
      content: '{"v":1,"background":"plain","edit":"commenters"}',
      base_version: 2,
    });
    expect(v3.isError, v3.text).toBe(false);
    await dialog.getByRole("radio", { name: "Dots" }).check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(
      dialog.getByText("v3 was published meanwhile. These are its settings."),
    ).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Plain" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Commenters and editors" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(editorPage.getByTitle("Launch board, version 3")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(editorPage.frameLocator(CURRENT_FRAME).locator(".wb-viewport")).toHaveAttribute(
      "data-bg",
      "plain",
      { timeout: 15_000 },
    );
    expect((await tool(client, "get_artifact", { id })).data.version).toBe(3);

    // Saving again goes against v3.
    await dialog.getByRole("radio", { name: "Editors only" }).check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    const v4 = await tool(client, "get_artifact", { id });
    expect(v4.data.version).toBe(4);
    expect(JSON.parse(v4.data.content)).toEqual({ v: 1, background: "plain", edit: "editors" });
  } finally {
    await editorPage.context().close();
    await client.close();
  }
});
