// The design canvas beyond fixed boards: a fluid page board (height="auto") grows to its content's
// height as its loader measures it, boards and notes placed with x and y, title and sticky notes
// shown as text, a #board= link in the board in use moving the canvas to another board (a
// prototype flow), and the board on view kept in the app's address (#board=<id>) across a
// reload. The opaque case of the board frames is in typed-design-opaque.spec.ts.
import path from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

/** A responsive page: 30 rows of 100 px plus its padding, whatever the board's width. */
const PAGE_ROWS = Array.from(
  { length: 30 },
  (_, i) =>
    `  <section style="height: 100px; border-bottom: 1px solid #ddd">Section ${i + 1}</section>`,
).join("\n");

const DESIGN = [
  "<title>Checkout flow</title>",
  "<style>body { font: 16px system-ui, sans-serif; } main { padding: 40px; }</style>",
  '<!-- note kind="title" -->',
  "Checkout",
  '<!-- artboard id="cart" name="Cart" size="iphone" section="Flow" -->',
  '<main><h1>Cart</h1><a id="pay" href="#board=pay">Pay now</a></main>',
  '<!-- artboard id="pay" name="Pay" size="iphone" section="Flow" -->',
  '<main><h1>Pay</h1><a id="back" href="#board=cart">Back to cart</a></main>',
  '<!-- note color="pink" -->',
  "Card errors still to design",
  '<!-- note kind="title" -->',
  "Marketing site",
  '<!-- artboard id="site" name="Site" width="1280" height="auto" -->',
  "<main>",
  "  <h1>Acme</h1>",
  PAGE_ROWS,
  "</main>",
].join("\n");

interface Published {
  id: string;
  slug: string;
}

async function publish(page: Page, content = DESIGN) {
  const email = uniqueEmail("canvas");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title: "Checkout flow",
    type: "design",
    content,
  });
  expect(r.isError, r.text).toBe(false);
  return { client, artifact: r.data };
}

async function shellFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no shell frame");
  return frame;
}

async function boardFrame(shell: Frame, id: string): Promise<Frame> {
  await expect(shell.locator(`.plinth-design__board[data-board="${id}"][data-loaded]`)).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  const frame = await (
    await shell.locator(`.plinth-design__board[data-board="${id}"] iframe`).elementHandle()
  )?.contentFrame();
  if (!frame) throw new Error(`no board ${id}`);
  return frame;
}

test("a fluid board, notes, a flow between boards and a deep link to one board", async ({
  page,
}, info) => {
  // Desktop projects at a laptop size; the phone project at 390 px.
  await page.setViewportSize(
    info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 860 },
  );
  const { artifact, client } = await publish(page);
  try {
    await page.goto(`/a/${artifact.slug}`);
    const shell = await shellFrame(page);
    await expect(shell.locator("html")).toHaveAttribute("data-boards-loaded", "3", {
      timeout: 15_000,
    });

    // The fluid page is as tall as its content (30 x 100 px rows, a heading, padding), not its
    // starting 800 px (10/16 of 1280), and its frame shows all of it.
    const site = shell.locator('.plinth-design__board[data-board="site"]');
    await expect.poll(async () => (await site.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    await expect
      .poll(() => site.evaluate((el) => (el as HTMLElement).offsetHeight))
      .toBeGreaterThan(3000);
    const board = await boardFrame(shell, "site");
    const docHeight = await board.evaluate(() =>
      Math.ceil(document.documentElement.getBoundingClientRect().height),
    );
    expect(await site.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(docHeight);
    expect(
      await shell.locator('.plinth-design__board[data-board="site"] iframe').getAttribute("height"),
    ).toBe(String(docHeight));

    // Notes are text on the canvas, in source order.
    await expect(shell.locator(".plinth-design__note")).toHaveText([
      "Checkout",
      "Card errors still to design",
      "Marketing site",
    ]);

    const dir = shotsDir("design");
    const shot = async (name: string) => {
      if (dir) await page.screenshot({ path: path.join(dir, `${name}-${info.project.name}.png`) });
    };
    await shot("canvas");

    // A flow: in the cart board, Pay now moves the canvas to the Pay board and puts it in use.
    await shell
      .locator('.plinth-design__label[data-board="cart"] .plinth-design__label-name')
      .click();
    await expect(page).toHaveURL(/#board=cart$/);
    await shell
      .locator('.plinth-design__label[data-board="cart"] .plinth-design__label-interact')
      .click();
    const cart = await boardFrame(shell, "cart");
    await cart.locator("#pay").click();
    await expect(shell.locator('.plinth-design__board[data-board="pay"]')).toHaveAttribute(
      "data-interacting",
      "",
    );
    await expect(page).toHaveURL(/#board=pay$/);
    // The cart board's link was not followed: its frame still shows the cart.
    await expect(cart.locator("h1")).toHaveText("Cart");
    await shot("flow");
    const pay = await boardFrame(shell, "pay");
    await pay.locator("#back").click();
    await expect(page).toHaveURL(/#board=cart$/);
    await shell.locator(".plinth-design__done").click();

    // A deep link opens on that board.
    await shell
      .locator('.plinth-design__label[data-board="site"] .plinth-design__label-name')
      .click();
    await expect(page).toHaveURL(/#board=site$/);
    await page.reload();
    const again = await shellFrame(page);
    await expect(again.locator('.plinth-design__label[data-board="site"]')).toHaveAttribute(
      "data-active",
      "",
    );
    await shot("deep-link");
    // Fit takes the board out of the address.
    await again.locator('.plinth-design__btn[aria-label="Fit all boards"]').click();
    await expect(page).toHaveURL(new RegExp(`/a/${artifact.slug}$`));
  } finally {
    await client.close();
  }
});
