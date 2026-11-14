// Comments on the artifact page: pin a comment to an element, mention the owner's agent, let the
// agent complete the request over MCP, and see the reply, the "done → v2" chip and the new version.
// Also: hostile comment text renders inert, permissions come from the API, axe passes.
//
// Contract with the artifact page (/a/:slug): a button named "Comments" toggles the panel (a region
// named "Comments"); the artifact iframe is the page's only iframe once loaded (a reload briefly
// keeps the outgoing frame on top), and it reloads in review mode when the panel first opens.
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import { apiPost, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { signInApi } from "../support/auth.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const SHOTS = shotsDir("comments");

const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch plan</title>
<style>body{font-family:system-ui,sans-serif;margin:48px;color:#222;background:#fff}h1{font-size:40px}</style>
</head>
<body><h1>Launch plan</h1><p>Three steps to a calm launch.</p><ol><li>Draft</li><li>Review</li><li>Ship</li></ol></body>
</html>`;

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

async function openComments(page: Page, slug: string): Promise<Locator> {
  await page.goto(`/a/${slug}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel).toBeVisible();
  return panel;
}

/** The artifact frame, once its review-mode document has loaded. */
async function artifactFrame(page: Page) {
  const frame = page.frameLocator("iframe").first();
  await expect(frame.locator("h1")).toBeVisible({ timeout: 15_000 });
  return frame;
}

test("an editor pins a mention, the owner's agent completes it, the panel shows done → v2", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const ownerEmail = uniqueEmail("owner");
  const editorEmail = uniqueEmail("editor");
  const { token } = await seedToken(ownerEmail, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(request, token, { title: "Launch plan", html: ARTIFACT_HTML });
  const shared = await apiPut(
    request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: editorEmail, role: "editor" }] },
    { token },
  );
  expect(shared.status).toBe(200);

  await signInApi(page.request, editorEmail);
  const panel = await openComments(page, art.slug);
  const frame = await artifactFrame(page);

  // Pin to the heading through the review-mode bridge.
  await panel.getByRole("button", { name: "Pin to an element" }).click();
  await expect(panel.getByText("Click an element in the artifact (Esc to cancel)")).toBeVisible();
  await shot(page, info, "picking");
  await frame.locator("h1").click();
  await expect(panel.getByText("Pinned to")).toBeVisible();
  await expect(panel.getByText("Launch plan", { exact: false }).first()).toBeVisible();

  const box = panel.getByRole("textbox", { name: "New comment" });
  await box.fill("Please ");
  await box.press("End");
  await box.pressSequentially("@cl");
  // The suggestion list offers the agents; Enter picks the highlighted one.
  await expect(panel.getByRole("option", { name: "@claude" })).toBeVisible();
  await box.press("Enter");
  await box.pressSequentially("make the heading red");
  await expect(box).toHaveValue("Please @claude make the heading red");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = panel.locator("article").filter({ hasText: "make the heading red" });
  await expect(thread).toBeVisible();
  const chip = thread.locator('[data-state="pending"]');
  await expect(chip).toContainText("@claude");
  await expect(chip).toContainText("pending");
  // The pin lands over the frame, not over the whole page.
  const pin = page.getByTestId("comment-pins").getByRole("button", { name: /^Comment 1/ });
  if (info.project.name !== "mobile") {
    await expect(pin).toBeVisible();
    await expect(page.getByTestId("comment-pins")).toHaveCSS("pointer-events", "none");
  }
  await shot(page, info, "pending");

  // The owner's agent picks it up through MCP.
  const client = await mcpClient(token);
  try {
    const listed = await tool<{
      items: { id: string; comment_id: string; artifact_id: string; comment_body: string }[];
    }>(client, "list_mentions", {});
    expect(listed.isError).toBe(false);
    const items = listed.data.items;
    const task = items.find((t) => t.artifact_id === art.id);
    expect(task?.comment_body).toContain("make the heading red");
    if (!task) throw new Error("no mention task");

    const claimed = await tool(client, "claim_mention", { task_id: task.id });
    expect(claimed.isError).toBe(false);
    await panel.getByRole("button", { name: "Refresh comments" }).click();
    await expect(thread.locator('[data-state="claimed"]')).toContainText("claimed");

    const got = await tool<{ html: string; version: number }>(client, "get_artifact", {
      id: art.id,
    });
    expect(got.isError).toBe(false);
    const html = got.data.html.replace("</head>", "<style>h1{color:rgb(200,0,0)}</style></head>");
    const updated = await tool<{ version: number }>(client, "update_artifact", {
      id: art.id,
      html,
      note: "Heading in red, as asked",
      base_version: 1,
    });
    expect(updated.isError).toBe(false);
    expect(updated.data.version).toBe(2);

    const replied = await tool(client, "reply_comment", {
      comment_id: task.comment_id,
      body: "Made the heading red in v2.",
      result_version: 2,
    });
    expect(replied.isError).toBe(false);
  } finally {
    await client.close();
  }

  await panel.getByRole("button", { name: "Refresh comments" }).click();
  await expect(thread.getByText("Made the heading red in v2.")).toBeVisible();
  await expect(thread.getByText("Work Claude")).toBeVisible();
  const done = thread.locator('[data-state="done"]');
  await expect(done).toContainText("done");
  const v2 = done.getByRole("link", { name: "v2" });
  await expect(v2).toHaveAttribute("href", `/a/${art.slug}/v/2`);
  await shot(page, info, "done");

  // The frame shows the new version after a reload.
  await page.reload();
  const fresh = await artifactFrame(page);
  await expect(fresh.locator("h1")).toHaveCSS("color", "rgb(200, 0, 0)");
});

test("hostile comment text renders inert, and signed-out viewers are asked to sign in", async ({
  page,
  request,
}, info) => {
  const ownerEmail = uniqueEmail("owner");
  const { token } = await seedToken(ownerEmail, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(request, token, { title: "Hostile", html: ARTIFACT_HTML });
  const posted = await apiPost(
    request,
    `/artifacts/${art.id}/comments`,
    {
      body: "<img src=x onerror=alert(1)> and [x](javascript:alert(1)) **still bold**",
      anchor: { selector: "h1", text: "<img src=y onerror=alert(2)>", x: 0.5, y: 0.5 },
    },
    { token },
  );
  expect(posted.status).toBe(201);

  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  // Anyone with the link can read comments (unlisted).
  const panel = await openComments(page, art.slug);
  await expect(panel.getByText("still bold")).toBeVisible();
  await expect(panel.getByText("<img src=x onerror=alert(1)>", { exact: false })).toBeVisible();
  expect(await panel.locator("img").count()).toBe(0);
  expect(await panel.locator('a[href^="javascript:" i]').count()).toBe(0);
  expect(await page.locator('[data-testid="comment-pins"] img').count()).toBe(0);
  expect(dialogs).toBe(0);

  // Writing needs an account: the panel says so before anything is typed.
  await expect(panel.getByRole("textbox", { name: "New comment" })).toHaveCount(0);
  const signInLink = panel.getByRole("link", { name: "Sign in to comment" });
  await expect(signInLink).toBeVisible();
  await expect(signInLink).toHaveAttribute(
    "href",
    `/login?next=${encodeURIComponent(`/a/${art.slug}`)}`,
  );
  await shot(page, info, "signed-out");
});

test("a signed-in person without a role can read but not comment", async ({ page, request }) => {
  const { token } = await seedToken(uniqueEmail("owner"), { clientType: "claude" });
  const art = await publishArtifact(request, token, { title: "Read only", html: ARTIFACT_HTML });
  await signInApi(page.request, uniqueEmail("stranger"));
  const panel = await openComments(page, art.slug);
  await expect(panel.getByText("You can view this artifact but not comment on it")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "New comment" })).toHaveCount(0);
});

test("the comments panel is keyboard friendly and passes axe", async ({ page, request }, info) => {
  const ownerEmail = uniqueEmail("owner");
  const { token } = await seedToken(ownerEmail, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(request, token, { title: "Axe", html: ARTIFACT_HTML });
  await apiPost(
    request,
    `/artifacts/${art.id}/comments`,
    { body: "A first note with `code` and a [link](https://example.com)." },
    { token },
  );
  await signInApi(page.request, ownerEmail);
  const panel = await openComments(page, art.slug);
  await expect(panel.getByText("A first note with")).toBeVisible();
  await artifactFrame(page);
  // Focus moves into the panel on open.
  await expect(panel.getByRole("heading", { name: "Comments" })).toBeFocused();
  await shot(page, info, "open");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  // Escape closes the panel and focus returns to the toggle.
  await panel.getByRole("textbox", { name: "New comment" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toBeFocused();
});
