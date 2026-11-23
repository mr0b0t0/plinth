// Design systems (type "design_system"): an agent publishes tokens, guidelines and components as
// JSON, Plinth renders a reference site with live component previews on the artifact's own origin,
// and another agent reads it with get_design_system to build a page on it. Checked here: the site
// and its previews in light and dark, that example markup runs nothing and navigates nowhere, the
// JSON editor with its problems, and the version reference a page built on it carries. The
// opaque-isolation case is in typed-design-system-opaque.spec.ts.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { apiPut, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { ACME, ACME_ASSETS, acmeWith, stubGoogleFonts } from "../support/designSystem.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";
import { viewAsReader } from "../support/viewer.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const WIDE = { width: 1280, height: 900 };

interface Published {
  id: string;
  slug: string;
  type: string;
  version: number;
  warnings: { code: string }[];
}

/** A signed-in owner whose agent publishes `content` as a design system over MCP. */
async function publishDs(page: Page, content = acmeWith()) {
  const email = uniqueEmail("ds");
  const { token } = await seedToken(email, { label: "Design agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<Published>(client, "publish_artifact", {
    title: "Acme UI",
    type: "design_system",
    content,
    assets: ACME_ASSETS,
  });
  expect(r.isError, r.text).toBe(false);
  expect(r.data.type).toBe("design_system");
  return { client, token, artifact: r.data };
}

/** The artifact frame, once the site has rendered. */
async function siteFrame(page: Page, selector = CURRENT_FRAME): Promise<Frame> {
  await expect(page.frameLocator(selector).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const frame = await (await page.locator(selector).elementHandle())?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

/** A preview frame inside the site, by its title, once it has loaded. */
async function previewFrame(site: Frame, title: string): Promise<Frame> {
  const handle = site.locator(`iframe[title="${title}"]`);
  await handle.scrollIntoViewIfNeeded();
  await expect(handle).toHaveCount(1);
  let frame: Frame | null = null;
  await expect
    .poll(async () => {
      frame = (await (await handle.elementHandle())?.contentFrame()) ?? null;
      return frame ? await frame.locator("body").count() : 0;
    })
    .toBe(1);
  if (!frame) throw new Error(`no preview ${title}`);
  return frame;
}

/** CSP reports and page errors in the page and its frames. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test.describe("a published design system", () => {
  test.use({ viewport: WIDE });

  test("renders its tokens and previews the Button with the token background, light and dark", async ({
    page,
  }) => {
    const problems = watchConsole(page);
    const fonts = await stubGoogleFonts(page);
    const { artifact, client, token } = await publishDs(page);
    // As people view it: the owner is always in edit mode.
    await viewAsReader(page.context(), page.request, artifact.id, token);
    try {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`/a/${artifact.slug}`);
      const site = await siteFrame(page);
      await expect(site.locator(".ds-header h1")).toHaveText("Acme UI");

      // Color swatches show the fixture's values, light and dark.
      const bg = site.locator('.ds-token[data-path="color.bg"]');
      await expect(bg.locator(".ds-token__var")).toHaveText("var(--acme-color-bg)");
      const swatches = await bg
        .locator(".ds-sample")
        .evaluateAll((els) =>
          els.map((e) => (e as HTMLElement).style.getPropertyValue("--ds-sample")),
        );
      expect(swatches).toEqual(["#ffffff", "#0d1117"]);

      // The Button preview: real CSS from the design system, in its own frame, in the reader's
      // color scheme, and it follows a change of scheme.
      const light = await previewFrame(site, "Button: Primary (light)");
      await expect(light.locator("button")).toHaveCSS("background-color", "rgb(51, 85, 255)");
      await page.emulateMedia({ colorScheme: "dark" });
      const dark = await previewFrame(site, "Button: Primary (dark)");
      await expect(dark.locator("button")).toHaveCSS("background-color", "rgb(107, 140, 255)");
      await expect(dark.locator("html")).toHaveAttribute("data-theme", "dark");

      // People see the rendered examples, never their source: no code disclosures or blocks.
      await expect(site.locator("#ds-components-button :is(details, pre)")).toHaveCount(0);

      // The preview frames run no script: sandboxed with allow-same-origin only.
      const sandboxes = await site
        .locator("iframe.ds-preview__frame")
        .evaluateAll((els) => els.map((e) => e.getAttribute("sandbox")));
      expect(new Set(sandboxes)).toEqual(new Set(["allow-same-origin"]));
      expect(
        fonts.some((u) => u.startsWith("https://fonts.googleapis.com/css2?family=Inter")),
      ).toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("example markup runs nothing and cannot navigate its preview off the content origin", async ({
    page,
  }) => {
    await stubGoogleFonts(page);
    const content = acmeWith((ds) => {
      ds.components.push({
        id: "trap",
        name: "Trap",
        examples: [
          {
            name: "Handlers",
            html: "<img src=\"x\" onerror=\"parent.postMessage('pwned','*');window.__pwned=1\"><script>window.__pwned=2;parent.postMessage('pwned','*')</script><p>Trap</p>",
          },
          { name: "Link", html: '<a id="out" href="https://example.com/">Leave</a>' },
        ],
      });
    });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const { artifact, client } = await publishDs(page, content);
    try {
      // Previews follow the color scheme; the titles below name the light ones.
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`/a/${artifact.slug}`);
      await page.evaluate(() => {
        (window as unknown as { __messages: unknown[] }).__messages = [];
        window.addEventListener("message", (e) => {
          if (e.data === "pwned")
            (window as unknown as { __messages: unknown[] }).__messages.push(e.data);
        });
      });
      const site = await siteFrame(page);
      const trap = await previewFrame(site, "Trap: Handlers (light)");
      await expect(trap.locator("p")).toHaveText("Trap");
      await expect(trap.locator("script, [onerror]")).toHaveCount(0);
      const link = await previewFrame(site, "Trap: Link (light)");
      await expect(link.locator("#out")).toHaveAttribute("href", "#");
      await link.locator("#out").click();
      await page.waitForTimeout(300);
      for (const f of [page.mainFrame(), ...page.frames()]) {
        expect(await f.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
          undefined,
        );
        expect(f.url()).not.toContain("example.com");
      }
      expect(
        await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages),
      ).toEqual([]);
      expect(dialogs).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("edits the JSON: the preview follows, Save makes v2, and problems block Save", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await stubGoogleFonts(page);
    const { artifact, client, token } = await publishDs(page, JSON.stringify(ACME));
    try {
      await page.goto(`/a/${artifact.slug}/edit`);
      await expect(page.getByText("Editing v1")).toBeVisible();
      const lines = page.locator(".pl-editor .monaco-editor .view-lines").first();
      await expect(lines).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".pl-editor-pane__label").first()).toHaveText("Design system JSON");

      // Pasted, as a person replacing the JSON would: typed text would get Monaco's auto-closing.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const replaceAll = async (text: string) => {
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
        // The JSON is one line: End, then Shift+Home selects all of it on every platform.
        await lines.click();
        await page.keyboard.press("End");
        await page.keyboard.press("Shift+Home");
        await page.keyboard.press("ControlOrMeta+V");
      };

      // A problem shows under the editor with its path, and Save stays off.
      await replaceAll(JSON.stringify(ACME).replace('"#ffffff"', '"#ffffff; }"'));
      const notice = page.locator(".pl-editor__problems");
      await expect(notice).toContainText("tokens.color.bg.$value");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      // The server refuses the same JSON when it is sent anyway.
      const forced = await apiPut(
        page.request,
        `/artifacts/${artifact.id}`,
        { content: JSON.stringify(ACME).replace('"#ffffff"', '"#ffffff; }"'), base_version: 1 },
        { token },
      );
      expect(forced.status).toBe(400);
      expect(forced.body.error.details.errors[0].path).toBe("tokens.color.bg.$value");

      // A valid change: the preview's site follows, and Save publishes v2.
      const fixed = JSON.stringify(ACME).replace('"#ffffff"', '"#fafafa"');
      await replaceAll(fixed);
      await expect(notice).toHaveCount(0);
      const preview = page.frameLocator('iframe[title^="Preview of"]');
      await expect(
        preview.locator('.ds-token[data-path="color.bg"] .ds-token__values code').first(),
      ).toHaveText("#fafafa", { timeout: 15_000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved as v2")).toBeVisible();
      const got = await tool<{ version: number; content: string }>(client, "get_artifact", {
        id: artifact.id,
      });
      expect(got.data).toMatchObject({ version: 2, content: fixed });
    } finally {
      await client.close();
    }
  });
});

test("an agent builds a page on the design system, and is told when it is outdated", async ({
  page,
}) => {
  const { artifact: ds, client } = await publishDs(page);
  try {
    const read = await tool<{ css: string; version: number; prefix: string; untrusted: boolean }>(
      client,
      "get_design_system",
      { id: ds.id, include: ["css"] },
    );
    expect(read.isError, read.text).toBe(false);
    expect(read.data).toMatchObject({ version: 1, prefix: "acme", untrusted: true });
    expect(read.data.css).toContain("--acme-color-accent:var(--acme-color-brand-500);");

    const pageHtml = (v: number) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Built on Acme</title>` +
      `<meta name="plinth-design-system" content="${ds.id}@${v}">` +
      `<style>${read.data.css}\nbody{background:var(--acme-color-bg);color:var(--acme-color-fg)}</style>` +
      "</head><body><h1>Built on Acme</h1></body></html>";
    const built = await tool<Published>(client, "publish_artifact", {
      title: "Built on Acme",
      html: pageHtml(1),
    });
    expect(built.data.warnings).toEqual([]);

    const v2 = await tool<Published>(client, "update_artifact", {
      id: ds.id,
      base_version: 1,
      content: acmeWith((d) => {
        d.tokens.color.bg.$value = "#fafafa";
      }),
    });
    expect(v2.data.version).toBe(2);

    const again = await tool<Published>(client, "update_artifact", {
      id: built.data.id,
      base_version: 1,
      html: pageHtml(1),
    });
    expect(again.data.warnings.map((w) => w.code)).toEqual(["design_system_outdated"]);
    const detail = await tool<{ design_system: Record<string, unknown> }>(client, "get_artifact", {
      id: built.data.id,
    });
    expect(detail.data.design_system).toEqual({
      id: ds.id,
      title: "Acme UI",
      version: 1,
      current_version: 2,
    });
  } finally {
    await client.close();
  }
});
