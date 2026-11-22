// The whiteboard's wider element set in the browser: an agent publishes a board with a section,
// Claude's shapes, sized text with inline marks and a link, a table and arrows that run from given
// sides with a dot and a head. The page draws each (a section behind, shapes as outlines, marks as
// styled words, never markup), a selected shape shows one Shape list whose pick is saved, a table
// cell is written in place, an agent's merge op changes one field, and the PNG and SVG exports
// carry the new kinds.
import { readFile } from "node:fs/promises";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const BOARD = {
  v: 1,
  blocks: [
    { id: "s1", kind: "container", x: -40, y: 40, w: 780, h: 300, text: "Flow", color: "blue" },
    { id: "t1", kind: "text", x: 0, y: -80, w: 700, h: 64, text: "Release flow", size: "title" },
    {
      id: "b1",
      kind: "rounded",
      x: 0,
      y: 100,
      w: 200,
      h: 110,
      text: "**Draft** <b>x</b> [spec](https://example.com/spec)",
      color: "yellow",
    },
    { id: "b2", kind: "diamond", x: 280, y: 90, w: 180, h: 130, text: "Review?", color: "#2f5fb3" },
    { id: "b3", kind: "database", x: 540, y: 100, w: 160, h: 110, text: "Store", stroke: "green" },
    {
      id: "tb",
      kind: "table",
      x: 0,
      y: 400,
      w: 300,
      h: 96,
      cols: { c1: { at: 1, w: 180 }, c2: { at: 2, w: 120 } },
      rows: {
        r1: { at: 1, c1: "Plan", c2: "Price" },
        r2: { at: 2, c1: "Pro", c2: "$20" },
        r3: { at: 3, c1: "Team", c2: "$40" },
      },
      heat: { cols: { c2: "green" } },
    },
  ],
  arrows: [
    { id: "a1", from: "b1", to: "b2", fromSide: "right", toSide: "left" },
    { id: "a2", from: "b2", to: "b3", heads: ["circle", "arrow"], label: "yes" },
  ],
};

async function boardFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no board frame");
  return frame;
}

async function menuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("a board of sections, shapes, marks, a table and routed arrows: drawn, changed and exported", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("wb-elements");
  const { token } = await seedToken(owner, { label: "Board agent", clientType: "claude" });
  const client = await mcpClient(token);
  try {
    const r = await tool(client, "publish_artifact", {
      title: "Release flow",
      type: "whiteboard",
      content: JSON.stringify(BOARD),
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.board).toEqual({ blocks: 6, arrows: 2 });
    const { id, slug } = r.data as { id: string; slug: string };
    await seedSession(page.context(), owner);
    await page.goto(`/a/${slug}`);
    const frame = await boardFrame(page);

    // Drawn: the section behind, shapes as outlines, the table's cells, marks as styled words.
    await expect(frame.locator(".wb-block")).toHaveCount(6);
    await expect(frame.locator(".wb-block[data-kind='container'] > .wb-text")).toHaveText("Flow");
    await expect(frame.locator(".wb-shape")).toHaveCount(3);
    await expect(frame.locator(".wb-cell")).toHaveCount(6);
    await expect(frame.locator(".wb-arrow")).toHaveCount(2);
    const draft = frame.getByRole("group", { name: /^Rounded box: / });
    await expect(draft.locator(".wb-b")).toHaveText("Draft");
    await expect(draft.locator("b")).toHaveCount(0);
    await expect(draft.locator("a.wb-link")).toHaveAttribute("href", "https://example.com/spec");
    await expect(draft.locator("a.wb-link")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    const z = (name: RegExp) =>
      frame.getByRole("group", { name }).evaluate((el) => Number((el as HTMLElement).style.zIndex));
    expect(await z(/^Section: Flow/)).toBeLessThan(await z(/^Diamond: Review/));
    await frame.getByRole("button", { name: "Fit the board" }).click();

    // A selected shape shows one Shape list; the pick is saved.
    const store = frame.getByRole("group", { name: /^Database: Store/ });
    await store.focus();
    const list = frame.getByRole("combobox", { name: "Shape" });
    await expect(list).toBeVisible();
    await expect(list).toHaveValue("database");
    await list.selectOption("cloud");
    await expect
      .poll(
        async () =>
          (await tool(client, "list_artifact_data", { id, collection: "blocks", doc_id: "b3" }))
            .data.doc?.data?.kind,
        { timeout: 15_000 },
      )
      .toBe("cloud");
    // Every other field stayed as the agent wrote it.
    const b3 = (
      await tool(client, "list_artifact_data", { id, collection: "blocks", doc_id: "b3" })
    ).data.doc;
    expect(b3.data).toMatchObject({ stroke: "green", text: "Store" });

    // A table cell is written in place, and the row saved with it.
    const cell = frame.locator(".wb-cell").filter({ hasText: "$20" });
    await cell.dblclick();
    const editor = frame.getByRole("textbox", { name: "Cell text" });
    await editor.fill("$25");
    await editor.press("Control+Enter");
    await expect(frame.locator(".wb-cell").filter({ hasText: "$25" })).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await tool(client, "list_artifact_data", { id, collection: "blocks", doc_id: "tb" }))
            .data.doc?.data?.rows?.r2?.c2,
        { timeout: 15_000 },
      )
      .toBe("$25");

    // An agent's merge changes one field; the board follows.
    const b2 = (
      await tool(client, "list_artifact_data", { id, collection: "blocks", doc_id: "b2" })
    ).data.doc;
    const merged = await tool(client, "write_artifact_data", {
      id,
      ops: [
        {
          op: "merge",
          collection: "blocks",
          doc_id: "b2",
          data: { kind: "hexagon" },
          if_rev: b2.rev,
        },
      ],
    });
    expect(merged.data.results[0]).toMatchObject({ ok: true });
    await expect(frame.getByRole("group", { name: /^Hexagon: Review/ })).toBeVisible({
      timeout: 15_000,
    });

    // The SVG carries the new kinds as paths and text, and nothing that loads or links.
    const svgDownload = page.waitForEvent("download");
    await menuItem(page, "Download as SVG");
    const svg = await readFile(await (await svgDownload).path(), "utf8");
    expect(svg).toContain("Release flow");
    expect(svg).toContain(">Draft<");
    expect(svg).toContain("$25");
    expect(svg).not.toMatch(/<script|foreignObject|href=|<image/i);
    const pngDownload = page.waitForEvent("download");
    await menuItem(page, "Download as PNG");
    const png = await readFile(await (await pngDownload).path());
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await client.close();
  }
});
