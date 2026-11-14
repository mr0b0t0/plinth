// Editor: Monaco with a live preview on the artifact's own origin, save with a note, conflict
// handling (never overwrite, never merge), access for owners and editors only, the narrow-screen
// message, no CSP violations, and axe in both modes.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  type APIRequestContext,
  type ConsoleMessage,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { apiGet, apiPut, contentOrigin, newApiContext, uniqueEmail } from "../support/api.ts";
import { signInApi } from "../support/auth.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const SHOTS = shotsDir("editor");

const WIDE = { width: 1280, height: 860 };

/** A complete, accessible document, so axe has nothing to say about the artifact itself. */
const doc = (heading: string, extra = "") =>
  `<!doctype html>\n<html lang="en"><head><title>Doc</title></head><body><h1>${heading}</h1>${extra}</body></html>\n`;

interface Published {
  id: string;
  slug: string;
  version: number;
}

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

interface Owner {
  email: string;
  token: string;
  state: StorageState;
}

/**
 * One signed-in owner per Playwright worker (sign-in is rate limited per IP), whose session every
 * page in the worker starts with, and `publish` to give each test its own artifact over MCP.
 */
const editorTest = test.extend<
  {
    publish: (
      html?: string,
      title?: string,
      extra?: Record<string, unknown>,
    ) => Promise<{ client: Awaited<ReturnType<typeof mcpClient>>; artifact: Published }>;
  },
  { owner: Owner }
>({
  owner: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure
    async ({}, use) => {
      const email = uniqueEmail("editor");
      const { token } = await seedToken(email, { label: "Work agent", clientType: "claude" });
      const request = await newApiContext();
      await signInApi(request, email);
      const state = await request.storageState();
      await request.dispose();
      await use({ email, token, state });
    },
    { scope: "worker" },
  ],
  storageState: async ({ owner }, use) => use(owner.state),
  publish: async ({ owner }, use) => {
    await use(async (html = doc("Hello from v1"), title = "Editor test", extra = {}) => {
      const client = await mcpClient(owner.token);
      const published = await tool<Published>(client, "publish_artifact", {
        title,
        html,
        ...extra,
      });
      expect(published.isError).toBe(false);
      return { client, artifact: published.data };
    });
  },
});

/** Errors and CSP reports from the page and every frame in it. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    const text = msg.text();
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(text)) problems.push(text);
  };
  page.on("console", onConsole);
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function editorReady(page: Page) {
  await expect(page.locator(".pl-editor .monaco-editor .view-lines").first()).toBeVisible({
    timeout: 15_000,
  });
}

const preview = (page: Page) => page.frameLocator('iframe[title^="Preview of"]');

const TYPED_START = '<!doctype html><html lang="en"><head><title>Doc</title></head><body><h1>';
const TYPED_END = "</h1></body></html>";
/** The exact document typeDraft leaves in the editor. */
const typed = (heading: string) => `${TYPED_START}${heading}${TYPED_END}`;

/** Replace the whole draft: select all, then type it (the heading text key by key). */
async function typeDraft(page: Page, heading: string) {
  await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
  // Monaco picks its shortcuts from the user agent (the test devices report Windows).
  const mac = await page.evaluate(() => /Macintosh/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+A" : "Control+A");
  // Clear first: typing "<" over a selection would wrap it (Monaco's auto-surround).
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(TYPED_START);
  await page.keyboard.type(heading);
  await page.keyboard.insertText(TYPED_END);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const project = test.info().project.name;
  await page.screenshot({ path: path.join(SHOTS, `${project}-${name}.png`) });
}

editorTest.describe("editor at desktop width", () => {
  editorTest.use({ viewport: WIDE });

  editorTest(
    "edit in Monaco, see it in the preview, save with a note",
    async ({ page, publish }) => {
      const problems = watchConsole(page);
      const workers: string[] = [];
      page.on("worker", (w) => workers.push(w.url()));
      const { artifact, client } = await publish();
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await expect(page).toHaveTitle("Edit Editor test · Plinth");
        await expect(page.getByRole("heading", { level: 1, name: "Editor test" })).toBeVisible();
        await expect(page.getByText("Editing v1")).toBeVisible();
        await editorReady(page);

        // The preview runs on the artifact's own subdomain, sandboxed, without top navigation.
        const frame = page.locator('iframe[title^="Preview of"]');
        await expect(frame).toHaveAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
        );
        await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
        await expect(preview(page).locator("h1")).toHaveText("Hello from v1");
        const frameUrl = page.frames().find((f) => f.url().startsWith(contentOrigin(artifact.id)));
        expect(frameUrl, "preview frame on the artifact origin").toBeTruthy();

        await typeDraft(page, "Typed in Monaco");
        await expect(page.getByText("Unsaved changes")).toBeVisible();
        await expect(preview(page).locator("h1")).toHaveText("Typed in Monaco");
        await shot(page, "editing");

        await page.getByLabel("What changed? (optional)").fill("Retitled the heading");
        // Cmd/Ctrl+S from inside Monaco saves.
        await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
        await page.keyboard.press("ControlOrMeta+s");
        await expect(page.getByText("Saved as v2")).toBeVisible();
        await expect(page.getByText("Editing v2")).toBeVisible();
        await expect(page.getByText("No unsaved changes")).toBeVisible();
        await expect(page.getByLabel("What changed? (optional)")).toHaveValue("");

        const versions = await apiGet(page.request, `/artifacts/${artifact.id}/versions`);
        expect(versions.status).toBe(200);
        expect(versions.body.items[0]).toMatchObject({ number: 2, note: "Retitled the heading" });
        const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body.version).toBe(2);
        expect(current.body.html).toBe(typed("Typed in Monaco"));
        // The draft is gone from this tab once saved.
        const drafts = await page.evaluate(() =>
          Object.keys(sessionStorage).filter((k) => k.startsWith("plinth-draft:")),
        );
        expect(drafts).toEqual([]);

        // Monaco's workers came from the app's own origin.
        expect(workers.some((u) => /editor\.worker|html\.worker/.test(u))).toBe(true);
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );

  editorTest(
    "a reload keeps the unsaved draft and warns before leaving",
    async ({ page, publish }) => {
      const { artifact, client } = await publish();
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await editorReady(page);
        await typeDraft(page, "Draft that survives");
        await expect(preview(page).locator("h1")).toHaveText("Draft that survives");
        let warned = false;
        page.on("dialog", (d) => {
          if (d.type() === "beforeunload") warned = true;
          void d.accept();
        });
        await page.reload();
        expect(warned).toBe(true);
        await editorReady(page);
        await expect(page.getByText("Restored your unsaved draft")).toBeVisible();
        await expect(page.getByText("Unsaved changes")).toBeVisible();
        await expect(preview(page).locator("h1")).toHaveText("Draft that survives");
        // Nothing was published by the reload.
        const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body.version).toBe(1);
      } finally {
        await client.close();
      }
    },
  );

  editorTest(
    "saving against a stale version shows the diff and never overwrites",
    async ({ page, publish }) => {
      const problems = watchConsole(page);
      const { artifact, client } = await publish();
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await editorReady(page);
        await typeDraft(page, "My browser draft");
        await expect(preview(page).locator("h1")).toHaveText("My browser draft");

        // An agent publishes v2 behind the editor's back.
        const agentHtml = doc("Agent version");
        const updated = await tool<{ version: number }>(client, "update_artifact", {
          id: artifact.id,
          html: agentHtml,
          note: "Agent change",
        });
        expect(updated.data.version).toBe(2);

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(
          page.getByRole("heading", {
            name: "v2 was published while you were editing (by Work agent)",
          }),
        ).toBeVisible();
        await expect(page.locator(".pl-conflict .monaco-diff-editor")).toBeVisible();
        await expect(page.locator(".pl-conflict")).toContainText("Agent version");
        await expect(page.locator(".pl-conflict")).toContainText("My browser draft");
        await shot(page, "conflict");

        // Nothing was overwritten.
        let current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body.version).toBe(2);
        expect(current.body.html).toBe(agentHtml);

        // Saving on top needs an explicit confirmation that the diff was reviewed.
        await page.getByRole("button", { name: "Save as new version on top of v2" }).click();
        const dialog = page.getByRole("dialog", { name: "Save your draft as v3?" });
        await expect(dialog).toBeVisible();
        const confirm = dialog.getByRole("button", { name: "Save as v3" });
        await expect(confirm).toBeDisabled();
        await dialog.getByLabel("I reviewed the differences between v2 and my draft").check();
        await confirm.click();
        await expect(page.getByText("Saved as v3")).toBeVisible();
        await expect(page.getByText("Editing v3")).toBeVisible();

        current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body.version).toBe(3);
        expect(current.body.html).toBe(typed("My browser draft"));
        expect(current.body.html).not.toContain("Agent version");
        const v2 = await apiGet(page.request, `/artifacts/${artifact.id}/versions/2`);
        expect(v2.body.html).toBe(agentHtml);
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );

  editorTest(
    "load latest and reapply keeps the draft beside the newer version",
    async ({ page, publish }) => {
      const { artifact, client } = await publish();
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await editorReady(page);
        await typeDraft(page, "Draft to reapply");
        await tool(client, "update_artifact", { id: artifact.id, html: doc("Newer from agent") });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("button", { name: "Load latest and reapply manually" }).click();

        await expect(page.getByText("Editing v2")).toBeVisible();
        await expect(page.getByText(/Reapplying your draft on top of v2/)).toBeVisible();
        const diff = page.locator(".pl-editor__work .monaco-diff-editor");
        await expect(diff).toContainText("Draft to reapply");
        await expect(diff).toContainText("Newer from agent");
        await page.getByRole("radio", { name: "Split" }).check();
        await expect(preview(page).locator("h1")).toHaveText("Newer from agent");
        await shot(page, "reapply");

        // Still only the agent's version: loading the latest never saves anything.
        const current = await apiGet(page.request, `/artifacts/${artifact.id}`);
        expect(current.body.version).toBe(2);
      } finally {
        await client.close();
      }
    },
  );

  editorTest(
    "the preview loads the artifact's own files from relative URLs",
    async ({ page, publish }) => {
      const problems = watchConsole(page);
      const html =
        '<!doctype html>\n<html lang="en"><head><title>Doc</title><link rel="stylesheet" href="style.css"></head><body><h1>Styled</h1></body></html>';
      const { artifact, client } = await publish(html, "With assets", {
        assets: [{ path: "style.css", content: "h1 { color: rgb(1, 2, 3); }" }],
      });
      try {
        await page.goto(`/a/${artifact.slug}/edit`);
        await editorReady(page);
        const h1 = preview(page).locator("h1");
        await expect(h1).toHaveText("Styled");
        await expect(h1).toHaveCSS("color", "rgb(1, 2, 3)");
        // After an edit the re-rendered draft still resolves them against the artifact root.
        await typeDraft(page, "Restyled");
        await expect(h1).toHaveText("Restyled");
        await page.locator(".pl-editor .monaco-editor .view-lines").first().click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.insertText('<link rel="stylesheet" href="style.css">');
        await expect(h1).toHaveCSS("color", "rgb(1, 2, 3)");
        const where = await preview(page)
          .locator("body")
          .evaluate(() => location.pathname);
        expect(where).toBe("/");
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );

  editorTest("a viewer sees that they cannot edit", async ({ page }) => {
    const owner = await seedToken(uniqueEmail("owner"));
    const client = await mcpClient(owner.token);
    try {
      const { data: artifact } = await tool<Published>(client, "publish_artifact", {
        title: "Not yours",
        html: doc("Read only"),
        visibility: "allowlist",
      });
      const viewer = uniqueEmail("viewer");
      const shared = await apiPut(
        page.request,
        `/artifacts/${artifact.id}/sharing`,
        { grants: [{ email: viewer, role: "viewer" }] },
        { token: owner.token },
      );
      expect(shared.status).toBe(200);
      await signInApi(page.request, viewer);
      await page.goto(`/a/${artifact.slug}/edit`);
      await expect(
        page.getByRole("heading", { level: 1, name: "You can't edit this" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "View artifact" })).toHaveAttribute(
        "href",
        `/a/${artifact.slug}`,
      );
      await expect(page.locator(".monaco-editor")).toHaveCount(0);
      await shot(page, "forbidden");
    } finally {
      await client.close();
    }
  });

  editorTest("signed out, the page links to sign-in and comes back", async ({ page }) => {
    const { token } = await seedToken(uniqueEmail("owner"));
    const client = await mcpClient(token);
    await page.context().clearCookies();
    try {
      const { data: artifact } = await tool<Published>(client, "publish_artifact", {
        title: "Signed out",
        html: doc("Hi"),
      });
      await page.goto(`/a/${artifact.slug}/edit`);
      await expect(page.getByRole("heading", { level: 1, name: "Sign in to edit" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Sign in" }).last()).toHaveAttribute(
        "href",
        `/login?next=${encodeURIComponent(`/a/${artifact.slug}/edit`)}`,
      );
    } finally {
      await client.close();
    }
  });

  editorTest(
    "no CSP violations and no axe violations, in both modes",
    async ({ page, publish }) => {
      const problems = watchConsole(page);
      const { artifact, client } = await publish();
      try {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.goto(`/a/${artifact.slug}/edit`);
          await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
          await editorReady(page);
          // The second pass opens with the draft kept from the first one.
          await expect(preview(page).locator("h1")).toHaveText(
            mode === "light" ? "Hello from v1" : "Checked in light mode",
          );
          await typeDraft(page, `Checked in ${mode} mode`);
          await expect(preview(page).locator("h1")).toHaveText(`Checked in ${mode} mode`);
          const results = await new AxeBuilder({ page }).analyze();
          expect(
            results.violations,
            `${mode}: ${JSON.stringify(results.violations, null, 2)}`,
          ).toEqual([]);
          await shot(page, `editor-${mode}`);
          page.once("dialog", (d) => void d.accept());
        }
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );
});

editorTest.describe("editor on a narrow screen", () => {
  editorTest.use({ viewport: { width: 360, height: 740 } });

  editorTest(
    "says the editor needs a wider screen and links to the artifact and history",
    async ({ page, publish }) => {
      const problems = watchConsole(page);
      const { artifact, client } = await publish(doc("Small"), "Narrow test");
      try {
        for (const mode of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: mode });
          await page.goto(`/a/${artifact.slug}/edit`);
          await expect(
            page.getByRole("heading", { level: 1, name: "The editor needs a wider screen" }),
          ).toBeVisible();
          await expect(page.getByRole("link", { name: "View artifact" })).toHaveAttribute(
            "href",
            `/a/${artifact.slug}`,
          );
          await expect(page.getByRole("link", { name: "Version history" })).toHaveAttribute(
            "href",
            `/a/${artifact.slug}/history`,
          );
          // Monaco is never loaded here.
          await expect(page.locator(".monaco-editor")).toHaveCount(0);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          expect(overflow).toBe(false);
          const results = await new AxeBuilder({ page }).analyze();
          expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
          await shot(page, `narrow-${mode}`);
        }
        expect(problems).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );
});
