// HTML decks (type "slides" with deck.json, Claude's slide format): an agent publishes the sample
// deck in docs/examples/plinth-deck over MCP, and Plinth renders it with the slides renderer on
// the artifact's own origin. Checked here: a deck that would run script is refused at publish;
// the sample renders its 11 slides in shadow roots with no CSP report and no host but its own and
// Google Fonts; fragments step before the deck moves on; the live embed runs in a frame of the
// fixed loader with allow-scripts only and no network; the overview, presenter view and print
// layout; and the source editor is not offered. With PLINTH_E2E_SHOTS set it saves screenshots of
// each view, and a PDF of the print layout.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { readPptx } from "../support/pptx.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const DECK_DIR = path.join(ROOT, "docs/examples/plinth-deck");
const WIDE = { width: 1440, height: 900 };

interface Published {
  id: string;
  slug: string;
  version: number;
  warnings: { code: string; file: string; message: string }[];
}

/** Every file of the sample deck as publish_artifact takes it: deck.json is the content. */
function sampleDeck(): { content: string; assets: Record<string, unknown>[] } {
  const assets: Record<string, unknown>[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(DECK_DIR, full).split(path.sep).join("/");
      if (rel === "deck.json") continue;
      const binary = /\.(png|jpe?g|gif|webp|woff2?)$/.test(rel);
      assets.push(
        binary
          ? { path: rel, content: readFileSync(full).toString("base64"), encoding: "base64" }
          : { path: rel, content: readFileSync(full, "utf8") },
      );
    }
  };
  walk(DECK_DIR);
  return { content: readFileSync(path.join(DECK_DIR, "deck.json"), "utf8"), assets };
}

async function agent(page: Page) {
  const email = uniqueEmail("htmldeck");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  return mcpClient(token);
}

async function deckFrame(page: Page): Promise<Frame> {
  const locator = page.frameLocator(CURRENT_FRAME);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no deck frame");
  return frame;
}

const slideOf = (frame: Frame) => frame.evaluate(() => document.documentElement.dataset.slide);

/** The shown fragments of the current slide. */
const visibleSteps = (frame: Frame) =>
  frame.evaluate(() => {
    const n = document.documentElement.dataset.slide;
    const host = document.querySelector(
      `.plinth-slides__frame[data-n="${n}"] .plinth-slides__slide`,
    );
    return host?.shadowRoot?.querySelectorAll(".fragment.visible").length ?? -1;
  });

async function focusDeck(page: Page) {
  const box = await page.locator(CURRENT_FRAME).boundingBox();
  if (!box) throw new Error("no frame box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function goto(page: Page, frame: Frame, n: number) {
  await focusDeck(page);
  await page.keyboard.type(String(n));
  await page.keyboard.press("Enter");
  await expect.poll(() => slideOf(frame)).toBe(String(n));
}

test.describe("an HTML deck", () => {
  test("is refused at publish when a slide would run script or load another host", async ({
    page,
  }) => {
    const client = await agent(page);
    const index = JSON.stringify({ title: "Bad deck", order: ["a"] });
    const bad = [
      '<section id="a"><p onclick="alert(1)">Hi</p></section>',
      '<section id="a"><script>alert(1)</script></section>',
      '<section id="a"><img src="https://example.com/x.png" alt=""></section>',
      '<section id="a"><iframe src="https://example.com"></iframe></section>',
      '<section id="a"><svg><foreignObject></foreignObject></svg></section>',
      '<section id="a"><a href="javascript:alert(1)">x</a></section>',
    ];
    for (const html of bad) {
      const r = await tool(client, "publish_artifact", {
        title: "Bad deck",
        type: "slides",
        content: index,
        assets: [{ path: "slides/a.html", content: html }],
      });
      expect(r.isError, html).toBe(true);
      expect(r.text).toContain("slides/a.html");
    }
    const css = await tool(client, "publish_artifact", {
      title: "Bad deck",
      type: "slides",
      content: index,
      assets: [
        { path: "slides/a.html", content: '<section id="a"><p>Hi</p></section>' },
        { path: "deck.css", content: "@import url(https://evil.example/x.css);" },
      ],
    });
    expect(css.isError).toBe(true);
    expect(css.text).toContain("@import");
    await client.close();
  });

  test("renders the sample deck with fragments, an embed, the overview and presenter view", async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    const shots = shotsDir("slides-html");
    const problems: string[] = [];
    page.on("console", (msg) => {
      if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const client = await agent(page);
    const deck = sampleDeck();
    const r = await tool<Published>(client, "publish_artifact", {
      title: "Plinth: a home for what your agents make",
      type: "slides",
      ...deck,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.warnings.filter((w) => w.code !== "not_scanned")).toEqual([]);
    const got = await tool<{ source_path: string; content: string; files: { path: string }[] }>(
      client,
      "get_artifact",
      { id: r.data.id },
    );
    expect(got.data.source_path).toBe("deck.json");
    expect(got.data.files.map((f) => f.path)).toContain("slides/cover.html");

    const hosts = new Set<string>();
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
    });
    if (info.project.name !== "mobile") await page.setViewportSize(WIDE);
    await page.goto(`/a/${r.data.slug}`);
    const frame = await deckFrame(page);
    expect(new URL(frame.url()).host).toBe(`${r.data.id}.${CONTENT_HOST}`);
    await expect(frame.locator(".plinth-slides__frame")).toHaveCount(11);
    await expect(frame.locator(".plinth-slides__slide[data-format='html']")).toHaveCount(11);
    // The author's markup is in each slide's shadow root, never in the shell's own DOM.
    expect(await frame.evaluate(() => document.querySelector("section#cover"))).toBeNull();
    const cover = await frame.evaluate(
      () =>
        document.querySelector(".plinth-slides__slide")?.shadowRoot?.querySelector("section")?.id,
    );
    expect(cover).toBe("cover");
    await page.waitForTimeout(1500);
    if (shots) await page.screenshot({ path: path.join(shots, `deck-${info.project.name}.png`) });

    if (info.project.name !== "mobile") {
      // Fragments: the publish slide's steps come before slide 6.
      await goto(page, frame, 5);
      expect(await visibleSteps(frame)).toBe(0);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => visibleSteps(frame)).toBeGreaterThan(0);
      expect(await slideOf(frame)).toBe("5");
      for (let i = 0; i < 8 && (await slideOf(frame)) === "5"; i++) {
        await page.keyboard.press("ArrowRight");
      }
      await expect.poll(() => slideOf(frame)).toBe("6");
      // Back on slide 5 it shows whole.
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => slideOf(frame)).toBe("5");
      expect(await visibleSteps(frame)).toBeGreaterThan(0);

      // The live embed on slide 6: the fixed loader, allow-scripts only, and no network.
      await goto(page, frame, 6);
      const embed = await frame.evaluate(() => {
        const host = document.querySelector(
          '.plinth-slides__frame[data-n="6"] .plinth-slides__slide',
        );
        const f = host?.shadowRoot?.querySelector("x-embed iframe");
        return f ? { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src") } : null;
      });
      expect(embed?.sandbox).toBe("allow-scripts");
      expect(embed?.src).toMatch(/\/__plinth\/frames\/slides\/embed\.html$/);
      await expect
        .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
        .toBeGreaterThan(0);
      const embedFrame = page.frames().find((f) => f.url().endsWith("/embed.html"));
      await expect
        .poll(() => embedFrame?.evaluate(() => document.body?.childElementCount ?? 0))
        .toBeGreaterThan(0);
      const reach = await embedFrame?.evaluate(() =>
        fetch("/").then(
          () => "fetched",
          () => "blocked",
        ),
      );
      expect(reach).toBe("blocked");
      // The browser reports the refused fetch above; that report is the point, not a problem.
      await expect.poll(() => problems.filter((m) => /connect/i.test(m)).length).toBeGreaterThan(0);
      problems.splice(0, problems.length, ...problems.filter((m) => !/connect/i.test(m)));
      await page.waitForTimeout(1200);
      if (shots)
        await page.screenshot({ path: path.join(shots, `embed-${info.project.name}.png`) });

      // The overview: every slide whole and still.
      await page.keyboard.press("o");
      await expect(frame.locator(".plinth-slides[data-mode='overview']")).toHaveCount(1);
      await page.waitForTimeout(800);
      // A fixed canvas clipped like Claude's: a picture that bleeds off the edge on purpose (the
      // gallery slide) is never marked as overflowing.
      await expect(frame.locator(".plinth-slides__slide[data-overflow]")).toHaveCount(0);
      if (shots) {
        await page.screenshot({ path: path.join(shots, `overview-${info.project.name}.png`) });
      }
      await page.keyboard.press("Escape");

      // Presenter view: current, next and the notes.
      await goto(page, frame, 2);
      await page.keyboard.press("s");
      await expect(frame.locator(".plinth-slides__presenter")).toHaveCount(1);
      await expect(frame.locator(".plinth-slides__notes")).not.toBeEmpty();
      await page.waitForTimeout(1200);
      if (shots) {
        await page.screenshot({ path: path.join(shots, `presenter-${info.project.name}.png`) });
      }
      await page.keyboard.press("Escape");

      // No source editor for an HTML deck.
      await page.getByRole("button", { name: "Artifact actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
      if (shots) await page.screenshot({ path: path.join(shots, `menu-${info.project.name}.png`) });

      // The .pptx, built from the slides as rendered: editable text and shapes, the screenshot
      // and drawings as pictures, the notes, and the live embed left out and said so.
      const downloaded = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "Download .pptx" }).click();
      const file = await readPptx(await downloaded);
      expect(file.slides).toHaveLength(11);
      expect(file.slides[0]).toContain("A home for what your");
      expect(file.slides[1]).toContain("<p:sp>");
      expect(file.slides[2]).toContain("<a:tbl>");
      expect(file.media.length).toBeGreaterThan(1);
      expect(file.notes.join("")).toContain("three jobs");
      await expect(page.getByText("1 live embed was left out.")).toBeVisible();
      if (shots) {
        const out = path.join(shots, "deck.pptx");
        writeFileSync(out, readFileSync(await (await downloaded).path()));
      }
    }

    expect(dialogs).toEqual([]);
    expect(problems).toEqual([]);
    const allowed = new Set([
      new URL(page.url()).host,
      `${r.data.id}.${CONTENT_HOST}`,
      "fonts.googleapis.com",
      "fonts.gstatic.com",
    ]);
    expect([...hosts].filter((h) => !allowed.has(h))).toEqual([]);

    if (shots && info.project.name === "light") {
      // The print layout as a PDF: the shell opened at the top, as a thumbnail capture opens it
      // (a still), every request answered with what the deck's own frame reads, printed with the
      // deck's own @page size.
      const printPage = await page.context().newPage();
      await printPage.route(`http://${r.data.id}.${CONTENT_HOST}/**`, async (route) => {
        const got = await frame.evaluate(async (url) => {
          const res = await fetch(url, { credentials: "include" });
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = "";
          for (const b of bytes) bin += String.fromCharCode(b);
          return {
            status: res.status,
            type: res.headers.get("content-type") ?? "",
            body: btoa(bin),
          };
        }, route.request().url());
        await route.fulfill({
          status: got.status,
          contentType: got.type,
          body: Buffer.from(got.body, "base64"),
        });
      });
      await printPage.goto(frame.url());
      await expect(printPage.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
      await printPage.waitForTimeout(1500);
      const pdf = await printPage.pdf({ preferCSSPageSize: true, printBackground: true });
      writeFileSync(path.join(shots, "deck.pdf"), pdf);
      await printPage.close();
    }
    await client.close();
  });
});
