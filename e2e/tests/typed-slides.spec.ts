// Slides (type "slides"): an agent publishes a deck's Markdown over MCP and Plinth renders it with
// its fixed renderer on the artifact's own origin. Checked here: the deck runs none of its
// Markdown and reaches no other host; paging, deep links and #N links; the overview grid; Present
// (full screen of the app's own frame, or presenter view) with an audience window kept in step
// that shows the deck alone; printing, with the notes from presenter view; phones, the dark
// scheme, the editor with its overview preview, history and restore; and a version published
// mid-talk that waits. The opaque case is in opaque.spec.ts.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { APP_ORIGIN, apiGet, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';
const WIDE = { width: 1280, height: 860 };

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PIXEL = {
  path: "pixel.png",
  content: PIXEL_PNG,
  encoding: "base64",
  content_type: "image/png",
};

const TITLE = "Quarterly review";
const DECK = [
  "---",
  "aspect: 4:3",
  "theme: auto",
  "footer: Quarterly review",
  "---",
  "",
  `# ${TITLE}`,
  "",
  "Revenue, hiring and what comes next",
  "",
  "Note: Welcome everyone. Keep this under a minute.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "![A tiny square](pixel.png)",
  "",
  "Note: The September dip was a billing change.",
  "",
  "---",
  "",
  "## Risks",
  "",
  "- Never [click this](javascript:window.__pwned=1)",
  "",
  "<script>window.__pwned = 1; alert('pwned')</script>",
  "",
  "---",
  "",
  "## Plan",
  "",
  "- Hire two engineers",
  "",
  "---",
  "",
  "## Thank you",
  "",
  "Back to [the start](#1).",
  "",
].join("\n");

interface Published {
  id: string;
  slug: string;
  type: string;
  version: number;
}

async function publishDeck(page: Page, content = DECK) {
  const email = uniqueEmail("deck");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title: TITLE,
    type: "slides",
    content,
    assets: [PIXEL],
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.type).toBe("slides");
  return { client, artifact: r.data };
}

async function deckFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  const locator = page.frameLocator(selector);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

const slideOf = (frame: Frame) => frame.evaluate(() => document.documentElement.dataset.slide);
const modeOf = (frame: Frame) =>
  frame.evaluate(() => document.getElementById("__plinth-slides")?.dataset.mode);

/** Clicks the middle of the frame (which pages nothing) so keys go to the deck. */
async function focusDeck(page: Page) {
  const box = await page.locator(CURRENT_FRAME).boundingBox();
  if (!box) throw new Error("no frame box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function stubFramePrint(frame: Frame) {
  await frame.evaluate(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    window.print = () => {
      w.__printed += 1;
    };
  });
}
const printed = (frame: Frame) =>
  frame.evaluate(() => (window as unknown as { __printed: number }).__printed);

async function openMenuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

/** Picks an item of the bar's Present control. */
async function present(page: Page, name: string) {
  await page.getByRole("button", { name: "Present" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test.describe("a published deck", () => {
  test("renders slide 1 at 4:3 with its image, and runs none of the Markdown", async ({
    page,
  }, info) => {
    const problems = watchConsole(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const { artifact, client } = await publishDeck(page);
    const artifactHost = `${artifact.id}.${CONTENT_HOST}`;
    const hosts = new Set<string>();
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    try {
      await page.goto(`/a/${artifact.slug}`);
      const frame = await deckFrame(page);
      expect(new URL(frame.url()).host).toBe(artifactHost);
      expect(await slideOf(frame)).toBe("1");
      await expect(frame.locator(".plinth-slides__frame")).toHaveCount(5);
      const first = frame.locator('.plinth-slides__frame[data-n="1"] .plinth-slides__canvas');
      await expect(first).toContainText(TITLE);
      const box = await first.boundingBox();
      expect(box && Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.02);
      await expect(first.locator(".plinth-slides__footer")).toHaveText("Quarterly review");

      if (info.project.name === "mobile") {
        // A phone in portrait shows every slide stacked and never scrolls sideways.
        expect(await modeOf(frame)).toBe("overview");
        const widths = await frame.evaluate(() => ({
          view: window.innerWidth,
          page: document.documentElement.scrollWidth,
          root: (document.getElementById("__plinth-slides") as HTMLElement).scrollWidth,
        }));
        expect(widths.page).toBeLessThanOrEqual(widths.view);
        expect(widths.root).toBeLessThanOrEqual(widths.view);
      } else {
        expect(await modeOf(frame)).toBe("deck");
      }

      const img = frame.locator('img[alt="A tiny square"]');
      await expect(img).toHaveAttribute("src", "pixel.png");
      await expect
        .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0);

      const background = await first
        .locator(".plinth-slides__slide")
        .evaluate((s) => getComputedStyle(s).backgroundColor);
      expect(background).toBe(
        info.project.name === "dark" ? "rgb(21, 24, 28)" : "rgb(255, 255, 255)",
      );

      expect(await frame.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();
      const hrefs = await frame.evaluate(() =>
        Array.from(document.querySelectorAll("[href], [src]")).map(
          (e) => e.getAttribute("href") ?? e.getAttribute("src") ?? "",
        ),
      );
      expect(hrefs.filter((u) => /^\s*javascript:/i.test(u))).toEqual([]);
      await expect(frame.locator("main script")).toHaveCount(0);
      await expect(frame.locator("main")).toContainText("<script>window.__pwned = 1;");
      expect(dialogs).toEqual([]);
      expect([...hosts].sort()).toEqual([new URL(APP_ORIGIN).host, artifactHost].sort());
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test.describe("at desktop width", () => {
    test.skip(({ isMobile }) => isMobile, "a phone shows the overview");
    test.use({ viewport: WIDE });

    test("pages with keys, opens deep links, and follows #N links", async ({ page }) => {
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}`);
        const frame = await deckFrame(page);
        await focusDeck(page);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => slideOf(frame)).toBe("2");
        await expect.poll(() => new URL(page.url()).hash).toBe("#slide=2");
        // The slides show their own numbers, so the pill has no count of its own.
        await expect(frame.locator(".plinth-slides__number").nth(1)).toHaveText("2");
        await expect(frame.locator(".plinth-slides__controls .plinth-slides__counter")).toHaveCount(
          0,
        );

        await page.goto(`/a/${artifact.slug}#slide=4`);
        await page.reload();
        const again = await deckFrame(page);
        await expect.poll(() => slideOf(again)).toBe("4");

        await focusDeck(page);
        await page.keyboard.press("End");
        await expect.poll(() => slideOf(again)).toBe("5");
        await again.getByRole("link", { name: "the start" }).click();
        await expect.poll(() => slideOf(again)).toBe("1");
      } finally {
        await client.close();
      }
    });

    test("shows the overview as a grid of thumbnails, with the selected one open on Enter", async ({
      page,
    }) => {
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}`);
        const frame = await deckFrame(page);
        await focusDeck(page);
        await page.keyboard.press("o");
        await expect.poll(() => modeOf(frame)).toBe("overview");
        const boxes = await frame.evaluate(() =>
          Array.from(document.querySelectorAll(".plinth-slides__canvas")).map((c) => {
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
          }),
        );
        // Four across at 1280 px: slides 1 to 4 share a row, slide 5 starts the next.
        expect(new Set(boxes.slice(0, 4).map((b) => b.y)).size).toBe(1);
        expect(boxes[4]?.y).toBeGreaterThan(boxes[0]?.y ?? 0);
        expect(boxes[0]?.w).toBeLessThan(400);
        await expect(frame.getByRole("button", { name: "Overview" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await expect.poll(() => modeOf(frame)).toBe("deck");
        expect(await slideOf(frame)).toBe("3");
      } finally {
        await client.close();
      }
    });

    test("Present puts the app's own frame full screen", async ({ page }) => {
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}`);
        await deckFrame(page);
        // The frame itself gets no fullscreen permission.
        await expect(page.locator(CURRENT_FRAME)).toHaveAttribute("allow", "");
        await present(page, "Full screen");
        await expect
          .poll(() =>
            page.evaluate(() => document.fullscreenElement?.classList.contains("pl-viewer-frame")),
          )
          .toBe(true);
        await page.evaluate(() => document.exitFullscreen());
      } finally {
        await client.close();
      }
    });

    test("Present after the comments panel was open leaves review mode, then presents", async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const { artifact, client } = await publishDeck(page);
      const current = page.frameLocator(CURRENT_FRAME);
      const comments = page.getByRole("button", { name: "Comments", exact: true });
      const panel = page.getByRole("region", { name: "Comments" });
      try {
        await page.goto(`/a/${artifact.slug}`);
        await deckFrame(page);
        // Opening comments loads the review frame: every slide stacked, in a fixed overview.
        await comments.click();
        await expect(panel).toBeVisible();
        await expect(current.locator("#__plinth-slides[data-fixed]")).toHaveCount(1, {
          timeout: 15_000,
        });
        // Closing the panel keeps review mode (no reload); Present still works from there.
        await comments.click();
        await expect(panel).toBeHidden();
        await present(page, "Presenter view");
        await expect(current.locator('#__plinth-slides[data-mode="presenter"]')).toHaveCount(1, {
          timeout: 15_000,
        });
        await expect(current.locator("#__plinth-slides[data-fixed]")).toHaveCount(0);
        await expect(current.locator(".plinth-slides__notes")).toHaveText(
          "Welcome everyone. Keep this under a minute.",
        );
        await current.getByRole("button", { name: "Exit presenter view" }).click();
        await expect(current.locator('#__plinth-slides[data-mode="deck"]')).toHaveCount(1);

        // With the panel open, Full screen closes it and puts the deck (not the overview) full
        // screen.
        await comments.click();
        await expect(panel).toBeVisible();
        await expect(current.locator("#__plinth-slides[data-fixed]")).toHaveCount(1, {
          timeout: 15_000,
        });
        await present(page, "Full screen");
        await expect(panel).toBeHidden();
        await expect
          .poll(() =>
            page.evaluate(() => document.fullscreenElement?.classList.contains("pl-viewer-frame")),
          )
          .toBe(true);
        await expect(current.locator('#__plinth-slides[data-mode="deck"]')).toHaveCount(1);
        await expect(current.locator("#__plinth-slides[data-fixed]")).toHaveCount(0);
        await page.evaluate(() => document.exitFullscreen());
      } finally {
        await client.close();
      }
    });

    test("presenter view shows the notes and the next slide, and an audience window follows", async ({
      page,
      context,
    }) => {
      test.setTimeout(60_000);
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}`);
        const frame = await deckFrame(page);
        // The ⋯ menu has no present item: Present is the one way in.
        await page.getByRole("button", { name: "Artifact actions" }).click();
        await expect(page.getByRole("menuitem", { name: "Presenter view" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await present(page, "Presenter view");
        await expect.poll(() => modeOf(frame)).toBe("presenter");
        const presenter = frame.locator(".plinth-slides__presenter");
        await expect(presenter.locator(".plinth-slides__notes")).toHaveText(
          "Welcome everyone. Keep this under a minute.",
        );
        await expect(presenter.locator(".plinth-slides__pane--next")).toContainText("Revenue");
        await expect(presenter.locator(".plinth-slides__count")).toHaveText("1 / 5");
        // No strip under the bar: presenter view is in the frame, the audience window in Present.
        await expect(page.getByRole("region", { name: "Presenter view" })).toHaveCount(0);
        // Two columns that fit the frame: the bar right under the current slide; Next at the top
        // of the other column, level with the current slide, and the notes down to the bar's
        // bottom; the whole, with the "Next" caption's row above it, centred in the height.
        const layout = await frame.evaluate(() => {
          const box = (s: string) => {
            const r = (document.querySelector(s) as HTMLElement).getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          };
          return {
            current: box(".plinth-slides__pane--current .plinth-slides__canvas"),
            bar: box(".plinth-slides__pbar"),
            next: box(".plinth-slides__pane--next .plinth-slides__canvas"),
            caption: box(".plinth-slides__caption--next"),
            notes: box(".plinth-slides__notes"),
            height: window.innerHeight,
          };
        });
        expect(Math.abs(layout.bar.y - layout.current.bottom - 12)).toBeLessThan(2);
        expect(layout.next.x).toBeGreaterThan(layout.current.right);
        expect(Math.abs(layout.next.y - layout.current.y)).toBeLessThan(1.5);
        expect(layout.caption.bottom).toBeLessThanOrEqual(layout.next.y);
        expect(layout.notes.y).toBeGreaterThan(layout.next.bottom);
        expect(Math.abs(layout.notes.bottom - layout.bar.bottom)).toBeLessThan(1.5);
        const above = layout.current.y - 24;
        const below = layout.height - layout.bar.bottom;
        expect(Math.min(above, below)).toBeGreaterThanOrEqual(16 - 1);
        expect(Math.abs(above - below)).toBeLessThan(2);
        // Its own previous and next page it (touch screens have no keys and no swipes here).
        await presenter.getByRole("button", { name: "Next slide" }).click();
        await expect.poll(() => slideOf(frame)).toBe("2");
        await presenter.getByRole("button", { name: "Previous slide" }).click();
        await expect.poll(() => slideOf(frame)).toBe("1");

        const opened = context.waitForEvent("page");
        await present(page, "Audience window");
        const audience = await opened;
        await audience.waitForLoadState();
        // On the presenter's version, so a version published mid-talk does not reach it by itself.
        expect(new URL(audience.url()).pathname).toBe(`/a/${artifact.slug}/v/1`);
        expect(new URL(audience.url()).hash).toMatch(/^#present=audience&pair=/);
        const audienceFrame = await deckFrame(audience);
        // Paired with its presenter, the audience window shows the deck alone.
        await expect(audience.locator(".pl-viewer--audience")).toHaveCount(1);
        await expect(audience.getByRole("banner")).toBeHidden();
        await expect(audience.getByRole("button", { name: "Artifact actions" })).toBeHidden();
        await expect(audience.getByText("Report this artifact")).toBeHidden();

        await focusDeck(page);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => slideOf(frame)).toBe("3");
        await expect(presenter.locator(".plinth-slides__count")).toHaveText("3 / 5");
        await expect.poll(() => slideOf(audienceFrame), { timeout: 10_000 }).toBe("3");
        await audience.close();

        await presenter.getByRole("button", { name: "Exit presenter view" }).click();
        await expect.poll(() => modeOf(frame)).toBe("deck");
        const menuOffers = async (name: string) => {
          await page.getByRole("button", { name: "Present" }).click();
          await expect(page.getByRole("menuitem", { name })).toBeVisible();
          await page.keyboard.press("Escape");
        };
        await menuOffers("Presenter view");

        // The frame's own s key and Escape switch the app's menu too.
        await focusDeck(page);
        await page.keyboard.press("s");
        await expect.poll(() => modeOf(frame)).toBe("presenter");
        await menuOffers("Audience window");
        await focusDeck(page);
        await page.keyboard.press("Escape");
        await expect.poll(() => modeOf(frame)).toBe("deck");
        await menuOffers("Presenter view");
      } finally {
        await client.close();
      }
    });

    test("an audience window shows the presenter's slide and version, fitted at any size", async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      const { artifact, client } = await publishDeck(page);
      try {
        await page.clock.install();
        await page.goto(`/a/${artifact.slug}#slide=2`);
        const frame = await deckFrame(page);
        await expect.poll(() => slideOf(frame)).toBe("2");
        await present(page, "Presenter view");
        await expect.poll(() => modeOf(frame)).toBe("presenter");
        const opened = context.waitForEvent("page");
        await present(page, "Audience window");
        const audience = await opened;
        // A phone-sized window in portrait, where a deck on its own shows the stacked overview.
        await audience.setViewportSize({ width: 360, height: 640 });
        await audience.waitForLoadState();
        const audienceFrame = await deckFrame(audience);
        await expect(audience.locator(".pl-viewer--audience")).toHaveCount(1, { timeout: 10_000 });
        await expect.poll(() => modeOf(audienceFrame)).toBe("deck");
        await expect.poll(() => slideOf(audienceFrame)).toBe("2");
        const fitted = await audienceFrame.evaluate(() => {
          const r = (
            document.querySelector(
              ".plinth-slides__frame[data-active] .plinth-slides__canvas",
            ) as HTMLElement
          ).getBoundingClientRect();
          return { x: r.x, right: r.right, width: window.innerWidth };
        });
        expect(Math.round(fitted.x)).toBe(16);
        expect(Math.round(fitted.width - fitted.right)).toBe(16);
        // Its own keys page nothing away from the presenter's slide.
        await audience.mouse.click(180, 320);
        await audience.keyboard.press("ArrowRight");
        await audience.keyboard.press("o");
        await expect.poll(() => slideOf(audienceFrame)).toBe("2");
        await expect.poll(() => modeOf(audienceFrame)).toBe("deck");

        // A version published mid-talk reaches neither window.
        const up = await tool(client, "update_artifact", {
          id: artifact.id,
          content: DECK.replace("## Revenue", "## Revenue, updated"),
          base_version: 1,
        });
        expect(up.isError, up.text).toBe(false);
        await page.clock.fastForward(16_000);
        await expect(page.getByText("You are viewing v1")).toBeVisible();
        await audience.waitForTimeout(1_000);
        await expect(audience.locator('iframe[title$="version 1"]')).toHaveCount(1);
        await focusDeck(page);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => slideOf(frame)).toBe("3");
        await expect.poll(() => slideOf(audienceFrame), { timeout: 10_000 }).toBe("3");

        // The presenter's window catches up when presenter view ends; the audience follows it there.
        await frame
          .locator(".plinth-slides__presenter")
          .getByRole("button", { name: "Exit presenter view" })
          .click();
        await expect(page.locator('iframe[title$="version 2"]')).toHaveCount(1, {
          timeout: 15_000,
        });
        await expect
          .poll(() => new URL(audience.url()).pathname, { timeout: 15_000 })
          .toBe(`/a/${artifact.slug}/v/2`);
        const following = await deckFrame(audience, 'iframe[title$="version 2"]');
        await expect.poll(() => slideOf(following), { timeout: 10_000 }).toBe("3");
        await expect.poll(() => modeOf(following)).toBe("deck");
        await expect(audience.locator(".pl-viewer--audience")).toHaveCount(1, { timeout: 10_000 });
        await audience.close();
      } finally {
        await client.close();
      }
    });

    test("prints one page-sized slide per page, and a handout with the notes", async ({ page }) => {
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}`);
        const frame = await deckFrame(page);
        await stubFramePrint(frame);
        await page.evaluate(() => {
          window.print = () => {
            throw new Error("the app page was printed");
          };
        });
        await openMenuItem(page, "Print or save as PDF");
        await expect.poll(() => printed(frame)).toBe(1);
        expect(await frame.locator("#__plinth-slides-page").textContent()).toBe(
          "@page { size: 10.667in 8in; margin: 0; }",
        );
        await page.emulateMedia({ media: "print" });
        const pages = await frame.evaluate(() =>
          Array.from(document.querySelectorAll(".plinth-slides__frame")).map((f) => {
            const c = (
              f.querySelector(".plinth-slides__canvas") as HTMLElement
            ).getBoundingClientRect();
            return {
              w: Math.round(c.width),
              h: Math.round(c.height),
              after: getComputedStyle(f).breakAfter,
            };
          }),
        );
        expect(pages).toHaveLength(5);
        for (const p of pages) expect([p.w, p.h]).toEqual([1024, 768]);
        expect(pages.slice(0, -1).every((p) => p.after === "page")).toBe(true);
        await page.emulateMedia({ media: "screen" });

        // From presenter view, the same item prints the handout.
        await present(page, "Presenter view");
        await expect.poll(() => modeOf(frame)).toBe("presenter");
        await openMenuItem(page, "Print or save as PDF");
        await expect.poll(() => printed(frame)).toBe(2);
        await expect(frame.locator("#__plinth-slides")).toHaveAttribute("data-print", "handout");
        await page.emulateMedia({ media: "print" });
        await expect(
          frame.locator('.plinth-slides__frame[data-n="1"] .plinth-slides__handout'),
        ).toHaveText("Welcome everyone. Keep this under a minute.");
        await page.emulateMedia({ media: "screen" });
      } finally {
        await client.close();
      }
    });

    test("a version published while presenting waits until presenter view ends", async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const { artifact, client } = await publishDeck(page);
      try {
        await page.clock.install();
        await page.goto(`/a/${artifact.slug}#slide=2`);
        const frame = await deckFrame(page);
        await expect.poll(() => slideOf(frame)).toBe("2");
        await present(page, "Presenter view");
        await expect.poll(() => modeOf(frame)).toBe("presenter");

        const up = await tool(client, "update_artifact", {
          id: artifact.id,
          content: DECK.replace("## Revenue", "## Revenue, updated"),
          base_version: 1,
        });
        expect(up.isError, up.text).toBe(false);
        await page.clock.fastForward(16_000);
        // The bar's version notice says v1 is on view; the frame is still version 1, same slide.
        await expect(page.getByText("You are viewing v1")).toBeVisible();
        await expect(page.locator('iframe[title$="version 1"]')).toHaveCount(1);
        expect(await slideOf(frame)).toBe("2");

        await frame
          .locator(".plinth-slides__presenter")
          .getByRole("button", { name: "Exit presenter view" })
          .click();
        await expect(page.locator('iframe[title$="version 2"]')).toHaveCount(1, {
          timeout: 15_000,
        });
        const next = await deckFrame(page, 'iframe[title$="version 2"]');
        await expect.poll(() => slideOf(next)).toBe("2");
        await expect(next.locator('.plinth-slides__frame[data-n="2"]')).toContainText(
          "Revenue, updated",
        );
      } finally {
        await client.close();
      }
    });

    test("the editor previews every slide, saves v2, Compare lists the new slide, restores v1 as v3", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const problems = watchConsole(page);
      const { artifact, client } = await publishDeck(page);
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await expect(page.getByText("Editing v1")).toBeVisible();
        const lines = page.locator(".pl-editor .monaco-editor .view-lines").first();
        await expect(lines).toBeVisible({ timeout: 15_000 });
        const preview = page.frameLocator(PREVIEW_FRAME);
        await expect(preview.locator(".plinth-slides__frame")).toHaveCount(5, { timeout: 15_000 });
        await expect(preview.locator('[data-mode="overview"]')).toHaveCount(1);

        await lines.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.press("Enter");
        await page.keyboard.type("---", { delay: 25 });
        await page.keyboard.press("Enter");
        await page.keyboard.type("## Appendix", { delay: 25 });
        await expect(page.getByText("Unsaved changes")).toBeVisible();
        await expect(preview.locator(".plinth-slides__frame")).toHaveCount(6);

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Saved as v2")).toBeVisible();
        const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body).toMatchObject({
          version: 2,
          type: "slides",
          source_path: "slides.md",
        });
        expect(current.body.content).toContain("## Appendix");

        await page.goto(`/a/${artifact.slug}/compare?from=1&to=2`);
        const changes = page.getByRole("region", { name: "What changed from v1 to v2" });
        // Where Monaco put the typed lines varies with the platform's End key; the list names the
        // slide that the "## Appendix" line starts, wherever it landed.
        await expect(
          changes.getByRole("listitem").filter({ hasText: /^Slide \d “Appendix.*” added$/ }),
        ).toHaveCount(1);
        await expect(page.locator("main")).not.toContainText("## Appendix");

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
        expect(restored.body).toMatchObject({ version: 3, type: "slides", content: DECK });
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    });
  });
});
