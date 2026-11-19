// Every example page in docs/examples (docs/examples/README.md) keeps the page contract: a real
// title, a viewport, light and dark colours, no external requests, text-only rendering of stored
// values, no native form posts, and a page that still renders when Plinth's runtime does not load.
// Each one publishes over MCP without warnings, declares what the table below says (the server is
// the parser), and renders as its owner without errors or a horizontal scroll at phone width. A new
// example joins by adding a row to DECLARED.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { CONTENT_HOST, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { readyFrame } from "../support/viewer.ts";

const DIR = path.join(ROOT, "docs/examples");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();

/** What get_artifact reports as `capabilities` for each example (sorted). */
const DECLARED: Record<string, string[]> = {
  "approval-signoff.html": ["data", "viewer"],
  "ask-agent.html": ["requests"],
  "canvas-comments.html": ["comments"],
  "client-checklist.html": ["data", "viewer"],
  "intake-form.html": ["data", "viewer"],
  "whiteboard.html": ["data", "room", "viewer"],
};

const source = (file: string) => readFileSync(path.join(DIR, file), "utf8");
/** The source without HTML and JS comments, so a link written in prose does not count. */
const code = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

test("every example has a declaration row", () => {
  expect(FILES.length).toBeGreaterThan(0);
  expect(Object.keys(DECLARED).sort()).toEqual(FILES);
});

for (const file of FILES) {
  test.describe(file, () => {
    test("follows the page contract in its source", () => {
      const html = source(file);
      const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
      expect(titles).toHaveLength(1);
      expect(titles[0]?.[1]?.trim()).not.toBe("");
      expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
      expect(html).toContain("prefers-color-scheme: dark");
      if (html.includes('name="plinth-capabilities"')) {
        expect(html).toContain('<script src="/__plinth/runtime.js"></script>');
        expect(html).toContain("window.plinth");
      }
      const body = code(html);
      for (const banned of [
        /\.innerHTML\b/,
        /\.outerHTML\b/,
        /insertAdjacentHTML/,
        /document\.write/,
        /\beval\(/,
        /new Function\b/,
      ]) {
        expect(body, `${file}: ${banned}`).not.toMatch(banned);
      }
      // No request to another host: nothing in src, href, action, fetch() or url() starts with
      // http(s). (createElementNS takes a namespace URI, which is not a request.)
      expect(body).not.toMatch(/\b(?:src|href|action)\s*=\s*["']?\s*(?:https?:)?\/\//i);
      expect(body).not.toMatch(/fetch\(\s*["'`]\s*(?:https?:)?\/\//i);
      expect(body).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
      // A form never posts natively (the content host has nothing to receive it).
      if (/<form\b|createElement\("form"\)/.test(body)) expect(body).toContain("preventDefault");
    });

    test("publishes cleanly and renders for its owner", async ({ page }) => {
      const owner = uniqueEmail("example-owner");
      const { token } = await seedToken(owner, { label: "Examples agent", clientType: "claude" });
      const client = await mcpClient(token);
      try {
        const html = source(file);
        const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? file;
        const pub = await tool<{ id: string; slug: string; warnings: unknown[] }>(
          client,
          "publish_artifact",
          { title, html },
        );
        expect(pub.isError, pub.text).toBe(false);
        expect(pub.data.warnings, JSON.stringify(pub.data.warnings)).toEqual([]);
        const got = await tool<{ capabilities: string[] }>(client, "get_artifact", {
          id: pub.data.id,
        });
        expect(got.isError, got.text).toBe(false);
        expect([...got.data.capabilities].sort()).toEqual(DECLARED[file]);

        const errors = watchErrors(page);
        await seedSession(page.context(), owner);
        await page.goto(`/a/${pub.data.slug}`);
        const frame = await readyFrame(page);
        expect(await noSideScroll(frame)).toBe(true);
        await page.emulateMedia({ colorScheme: "light" });
        const light = await background(frame);
        await page.emulateMedia({ colorScheme: "dark" });
        const dark = await background(frame);
        await page.emulateMedia({ colorScheme: null });
        expect(dark).not.toBe(light);
        expect(errors).toEqual([]);

        // Without the runtime (the staging path fallback, where /__plinth/runtime.js resolves to
        // the app host), the page still renders and settles, without throwing. The failed load
        // itself is logged by the browser, so only uncaught errors count here.
        errors.length = 0;
        const thrown: string[] = [];
        page.on("pageerror", (e) => thrown.push(e.message));
        await page.route("**/__plinth/runtime.js", (r) => r.fulfill({ status: 404, body: "" }));
        await page.reload();
        const bare = await readyFrame(page);
        expect(await bare.evaluate(() => "plinth" in window)).toBe(false);
        expect(await noSideScroll(bare)).toBe(true);
        expect(thrown).toEqual([]);
      } finally {
        await client.close();
      }
    });
  });
}

/**
 * Uncaught errors anywhere, and console errors from the artifact's own documents. A 404 for one
 * shared-data document is not one: `get` and `mine()` resolve null for a document that does not
 * exist yet, and the browser logs the response anyway.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    const url = m.location().url;
    if (m.type() !== "error" || !url.includes(CONTENT_HOST)) return;
    if (/\/__plinth\/api\/v1\/data\/[^/]+\/[^/?]+$/.test(url) && m.text().includes("404")) return;
    errors.push(`${m.text()} (${url})`);
  });
  return errors;
}

const noSideScroll = (frame: Frame) =>
  frame.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );

const background = async (frame: Frame) => {
  // Colour changes are not animated, but give the media query a frame to apply.
  await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
};
