// Whiteboards (type "whiteboard") in the browser: a board published over MCP with a starting set of
// blocks and an arrow, its blocks in shared data. The owner and a commenter see each other's
// cursors, a drag shows live and is saved; a person with view access gets a read-only board whose
// direct writes the server refuses; a settings version that makes the board editors-only turns
// the commenter's board read-only as their socket reconnects; an agent's block shows up; export
// downloads a PNG and an SVG; the keyboard moves a block; the page fits a phone; and the editor's
// preview draws only the draft, with no write and no room.
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Frame, type Page, test } from "@playwright/test";
import { apiPut, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';

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

async function publishBoard(page: Page, owner: string) {
  const { token } = await seedToken(owner, { label: "Board agent", clientType: "claude" });
  const client = await mcpClient(token);
  const r = await tool(client, "publish_artifact", {
    title: "Launch board",
    type: "whiteboard",
    content: BOARD,
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
  const { token, client, id, slug } = await publishBoard(page, owner);
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

    // The viewer: read-only, and the server refuses a direct write from their frame.
    await expect(v.frame.getByRole("button", { name: "Add note" })).toBeDisabled();
    await expect(v.frame.locator("html")).toHaveAttribute("data-readonly", "true");
    const block = { kind: "note", x: 0, y: 480, w: 200, h: 140, text: "x" };
    expect(await write(v.frame, "POST", "/data/blocks", { data: block })).toBe(403);

    // Cursors: the owner's shows on the commenter's board, the viewer's on the owner's.
    const area = await o.page.locator(CURRENT_FRAME).boundingBox();
    if (!area) throw new Error("no frame");
    await o.page.mouse.move(area.x + area.width - 40, area.y + area.height - 40);
    await o.page.mouse.move(area.x + area.width - 30, area.y + area.height - 30, { steps: 3 });
    await expect(c.frame.locator(".wb-cursor span").filter({ hasText: owner })).toHaveCount(1, {
      timeout: 10_000,
    });
    const vArea = await v.page.locator(CURRENT_FRAME).boundingBox();
    if (!vArea) throw new Error("no frame");
    await v.page.mouse.move(vArea.x + vArea.width - 50, vArea.y + vArea.height - 50);
    await v.page.mouse.move(vArea.x + vArea.width - 40, vArea.y + vArea.height - 40, { steps: 3 });
    await expect(o.frame.locator(".wb-cursor span").filter({ hasText: watcher })).toHaveCount(1, {
      timeout: 10_000,
    });

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
    await expect(cBoard.getByRole("button", { name: "Add note" })).toBeDisabled();
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
      await expect(oBoard.locator(".wb-cursor span").filter({ hasText: guest })).toHaveCount(1, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });
    // The owner still edits.
    await expect(oBoard.getByRole("button", { name: "Add note" })).toBeEnabled();
  } finally {
    await client.close();
    await c.page.context().close();
    await v.page.context().close();
  }
});

test("export, the keyboard, zoom, phone width and axe", async ({ page }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("wb-export");
  const { client, id, slug } = await publishBoard(page, owner);
  try {
    await page.goto(`/a/${slug}`);
    const frame = await boardFrame(page);
    await expect(frame.locator(".wb-block")).toHaveCount(3);

    // SVG: a file with the board's text, escaped, and nothing that runs or loads.
    const svgDownload = page.waitForEvent("download");
    await frame.getByRole("button", { name: "Export as SVG" }).click();
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
    await frame.getByRole("button", { name: "Export as PNG" }).click();
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

    // Zoom in and fit: the world layer's scale follows.
    const scale = () =>
      frame.locator(".wb-world").evaluate((el) => (el as HTMLElement).style.transform);
    const before = await scale();
    await frame.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(scale).not.toBe(before);
    await frame.getByRole("button", { name: "Fit the board" }).click();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    // At 390 px: the toolbar wraps and nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect
      .poll(() =>
        frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    const toolbar = await frame.locator(".wb-toolbar").boundingBox();
    expect(toolbar?.height ?? 0).toBeGreaterThan(48);
  } finally {
    await client.close();
  }
});

test("the editor preview draws only the draft and never writes or joins the room", async ({
  page,
}) => {
  test.setTimeout(90_000);
  test.skip(test.info().project.name === "mobile", "the editor needs a wide screen");
  const owner = uniqueEmail("wb-editor");
  const { client, id, slug } = await publishBoard(page, owner);
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/api/") && r.method() !== "GET") {
      seen.push(`${r.method()} ${r.url()}`);
    }
  });
  page.on("websocket", (ws) => {
    if (ws.url().includes("/__plinth/room/")) seen.push(`ws ${ws.url()}`);
  });
  try {
    const before = await tool(client, "list_artifact_data", { id });
    await page.goto(`/a/${slug}/edit`);
    await expect(page.getByText("Editing v1")).toBeVisible({ timeout: 15_000 });
    const preview = page.frameLocator(PREVIEW_FRAME);
    await expect(preview.locator(".wb-banner")).toHaveText(
      "Preview: the board's blocks are not shown here; settings apply.",
      { timeout: 15_000 },
    );
    // The stored board.json has settings only, so the live blocks never appear here.
    await expect(preview.locator(".wb-block")).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Add note" })).toBeDisabled();
    await page.waitForTimeout(1500);
    expect(seen).toEqual([]);
    const after = await tool(client, "list_artifact_data", { id });
    expect(after.data.usage).toEqual(before.data.usage);
  } finally {
    await client.close();
  }
});
