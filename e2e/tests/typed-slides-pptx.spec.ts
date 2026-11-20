// Download a deck as .pptx (origin isolation): the app's menu asks the frame, the frame loads the
// lazy writer from its own origin under the shell's script-src 'self', builds the file from the
// slides it shows and downloads it. Checked here: a download event with the deck's title as the
// file name; the file unzips with one slide per slide, the deck's text, the notes and both images
// (the PNG as is, the SVG drawn to PNG); no CSP violation and no request to another host; and no
// notice for a clean export, from the app or the frame: the browser shows the download. The opaque
// case, where the app's toast says images were left out, is in typed-slides-pptx-opaque.spec.ts.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { APP_ORIGIN, CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { readPptx } from "../support/pptx.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const TITLE = "Quarterly review";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0a58ca"/></svg>',
).toString("base64");

const DECK = [
  "---",
  "aspect: 16:9",
  "footer: Quarterly review",
  "---",
  "",
  `# ${TITLE}`,
  "",
  "Revenue, hiring and *what comes next*",
  "",
  "Note: Welcome everyone. Keep this under a minute.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "![A tiny square](pixel.png)",
  "",
  "---",
  "",
  "## Diagram",
  "",
  "![A blue bar](bar.svg)",
  "",
  "---",
  "",
  "## Plan",
  "",
  "- Hire two engineers",
  "  - One in sales",
  "- Never [click this](javascript:window.__pwned=1)",
  "",
  "| Region | Revenue |",
  "|---|--:|",
  "| EU | 1.2M |",
  "",
  "---",
  "",
  "## Thank you",
  "",
  "Back to [the start](#1) or [the site](https://example.com/).",
].join("\n");

async function publishDeck(page: Page) {
  const email = uniqueEmail("deck-pptx");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<{ id: string; slug: string; type: string }>(client, "publish_artifact", {
    title: TITLE,
    type: "slides",
    content: DECK,
    assets: [
      { path: "pixel.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
      { path: "bar.svg", content: SVG, encoding: "base64", content_type: "image/svg+xml" },
    ],
  });
  expect(r.isError, r.text).toBe(false);
  return { client, artifact: r.data };
}

async function deckFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no deck frame");
  return frame;
}

test("Download .pptx gives the deck as an editable file, built in the frame", async ({ page }) => {
  test.setTimeout(60_000);
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  const { artifact, client } = await publishDeck(page);
  const hosts = new Set<string>();
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.host);
  });
  try {
    await page.goto(`/a/${artifact.slug}`);
    const frame = await deckFrame(page);
    await frame.evaluate(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    // The writer is not part of the first view.
    expect(
      await frame.evaluate(() =>
        performance.getEntriesByType("resource").some((r) => r.name.includes("slides-pptx.js")),
      ),
    ).toBe(false);

    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Download .pptx" }).click();
    const download = await downloaded;
    // The export is over (the menu item works again), and a clean one adds no notice of its own:
    // the browser shows the download.
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Download .pptx" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pl-toast")).toHaveCount(0);

    const file = await readPptx(download);
    expect(file.name).toBe(`${TITLE}.pptx`);
    expect(file.slides).toHaveLength(5);
    expect(file.slides[0]).toContain(`<a:t>${TITLE}</a:t>`);
    expect(file.slides[0]).toContain("<a:t>what comes next</a:t>");
    expect(file.slides[0]).toContain("<a:t>Quarterly review</a:t>");
    expect(file.notes.join("\n")).toContain("Welcome everyone. Keep this under a minute.");
    // The PNG as it is, and the SVG drawn to PNG: both are in the file.
    expect(file.media.filter((m) => m.endsWith(".png"))).toHaveLength(2);
    expect(file.slides[3]).toContain("<a:t>Hire two engineers</a:t>");
    expect(file.slides[3]).toContain('lvl="1"');
    expect(file.slides[3]).toContain("<a:tbl>");
    const rels = file.files
      .filter((f) => f.startsWith("ppt/slides/_rels/"))
      .map((f) => file.text(f))
      .join("\n");
    expect(rels).toContain('Target="https://example.com/"');
    expect(rels).not.toMatch(/javascript:/i);
    const size = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(file.text("ppt/presentation.xml"));
    expect(Number(size?.[2])).toBe(6858000);

    // The writer came from the artifact's own origin, and nothing went anywhere else.
    expect(
      await frame.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((r) => r.name.includes("slides-pptx.js"))
          .map((r) => new URL(r.name).pathname),
      ),
    ).toEqual(["/__plinth/types/slides/slides-pptx.js"]);
    expect([...hosts].sort()).toEqual(
      [new URL(APP_ORIGIN).host, `${artifact.id}.${CONTENT_HOST}`].sort(),
    );
    expect(await frame.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
      [],
    );
    expect(await frame.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();

    // The frame shows no notice of its own either.
    await expect(
      page.frameLocator(CURRENT_FRAME).getByRole("button", { name: "Download" }),
    ).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await client.close();
  }
});

test("the .pptx is offered for decks only", async ({ page }) => {
  const email = uniqueEmail("doc-no-pptx");
  const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  try {
    const r = await tool<{ slug: string }>(client, "publish_artifact", {
      title: "Notes",
      type: "doc",
      content: "# Notes\n\nPlain prose.",
    });
    expect(r.isError, r.text).toBe(false);
    await page.goto(`/a/${r.data.slug}`);
    await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("Notes", {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Print or save as PDF" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Download .pptx" })).toHaveCount(0);
  } finally {
    await client.close();
  }
});
