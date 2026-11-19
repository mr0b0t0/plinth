// Ask an agent (docs/spec.md "Ask an agent"): a person points at something on an HTML page or a
// design board, describes the change and picks the owner's agent; the request is an ordinary
// mention (`request_to`), which that agent lists, claims and answers with a version, and the
// thread shows it done. Also: a request to an owner whose only agent is neither Claude nor Codex,
// the dashboard card's item, and the Ask dialog in edit mode, which publishes first only when
// asked. The opaque-isolation case is in ask-agent-opaque.spec.ts.
import { expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Launch plan</title>
<style>body{font-family:system-ui,sans-serif;margin:48px}h1{font-size:40px}</style></head>
<body><h1>Launch plan</h1><p>Three steps to a calm launch.</p></body></html>`;

const DESIGN = [
  "<title>Launch kit</title>",
  "",
  '<!-- artboard id="home" name="Home" size="iphone" section="Mobile" -->',
  '<main style="padding: 24px"><h1>Ship faster</h1></main>',
  "",
  '<!-- artboard id="post" name="Launch post" size="instagram-post" section="Social" -->',
  '<div style="font-size: 96px; padding: 80px">Now live</div>',
  "",
].join("\n");

interface MentionItem {
  id: string;
  comment_id: string;
  artifact_id: string;
  target: string;
  comment_body: string;
  comment_author_role: string | null;
  anchor: Record<string, unknown> | null;
  source: string;
}

/** Ask an agent: the bar's button where it is shown, else the ⋯ item (commenters, phone width). */
async function openAsk(page: Page) {
  const button = page.getByRole("button", { name: "Ask an agent", exact: true });
  if (await button.isVisible()) await button.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Ask an agent" }).click();
  }
}

/** The request composer in the comments panel, once the frame has reloaded in review mode. */
async function requestForm(page: Page) {
  const panel = page.getByRole("region", { name: "Comments" });
  const form = panel.getByRole("form", { name: "Ask an agent to change this page" });
  await expect(form).toBeVisible();
  await expect(page.frameLocator(CURRENT_FRAME).locator("script[data-plinth-bridge]")).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  return { panel, form };
}

test("a commenter points at a heading and asks Claude; the owner's Claude claims it and the thread shows done → v2", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("ask-owner");
  const commenter = uniqueEmail("ask-commenter");
  const { token } = await seedToken(owner, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Launch plan",
    html: PAGE_HTML,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: commenter, role: "commenter" }] },
    { token },
  );
  expect(shared.status).toBe(200);

  await seedSession(page.context(), commenter);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toBeVisible({ timeout: 15_000 });
  // Commenters never get it in the bar.
  await expect(page.getByRole("button", { name: "Ask an agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Ask an agent" }).click();
  const { panel, form } = await requestForm(page);
  // Only the client type is shown, never the connection's label.
  await expect(form.getByRole("radio", { name: "Claude" })).toBeChecked();
  await expect(panel).not.toContainText("Work Claude");

  await form.getByRole("button", { name: "Point at something" }).click();
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(async () => {
    await frame.locator("h1").click();
    await expect(form.getByText("Pointing at")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await form.getByRole("textbox", { name: "What should change?" }).fill("Make the heading red");
  await form.getByRole("button", { name: "Send request" }).click();

  const thread = panel.locator("article").filter({ hasText: "Make the heading red" });
  await expect(thread.locator('[data-state="pending"]')).toContainText("@claude");

  const client = await mcpClient(token);
  try {
    const listed = await tool<{ items: MentionItem[] }>(client, "list_mentions", {});
    const task = listed.data.items.find((t) => t.artifact_id === art.id);
    if (!task) throw new Error("no mention task");
    expect(task).toMatchObject({
      target: "@claude",
      comment_body: "Make the heading red",
      comment_author_role: "commenter",
      source: "comment",
    });
    expect(task.anchor).toMatchObject({ selector: expect.any(String), text: "Launch plan" });
    expect((await tool(client, "claim_mention", { task_id: task.id })).isError).toBe(false);
    const got = await tool<{ html: string }>(client, "get_artifact", { id: art.id });
    const updated = await tool<{ version: number }>(client, "update_artifact", {
      id: art.id,
      html: got.data.html.replace("</head>", "<style>h1{color:rgb(200,0,0)}</style></head>"),
      base_version: 1,
    });
    expect(updated.data.version).toBe(2);
    expect(
      (
        await tool(client, "reply_comment", {
          comment_id: task.comment_id,
          body: "Done in v2.",
          result_version: 2,
        })
      ).isError,
    ).toBe(false);
  } finally {
    await client.close();
  }
  await panel.getByRole("button", { name: "Refresh comments" }).click();
  const done = thread.locator('[data-state="done"]');
  await expect(done).toContainText("published");
  await expect(done.getByRole("link", { name: "v2" })).toBeVisible();
});

test("the owner asks about a design board from the bar, and the request names the board", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "the board pick is checked at desktop widths");
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  const owner = uniqueEmail("ask-design");
  const { token } = await seedToken(owner, { label: "Laptop Codex", clientType: "codex" });
  await seedSession(page.context(), owner);
  const client = await mcpClient(token);
  try {
    const r = await tool<{ id: string; slug: string }>(client, "publish_artifact", {
      title: "Launch kit",
      type: "design",
      content: DESIGN,
    });
    expect(r.isError, r.text).toBe(false);
    await page.goto(`/a/${r.data.slug}`);
    await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    // A design takes Ask an agent in the Edit slot; the source editor stays in the ⋯ menu.
    await openAsk(page);
    const { panel, form } = await requestForm(page);
    await expect(form.getByRole("radio", { name: "Codex" })).toBeChecked();
    await form.getByRole("button", { name: "Point at something" }).click();
    const shell = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
    if (!shell) throw new Error("no shell frame");
    await expect(shell.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
    await shell.locator("#__plinth-board-post").click();
    await expect(form.getByText("Pointing at")).toBeVisible();
    await form.getByRole("textbox", { name: "What should change?" }).fill("Bigger headline");
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(panel.locator("article").filter({ hasText: "Bigger headline" })).toBeVisible();

    const listed = await tool<{ items: MentionItem[] }>(client, "list_mentions", {});
    const task = listed.data.items.find((t) => t.artifact_id === r.data.id);
    expect(task).toMatchObject({ target: "@codex", comment_author_role: "owner" });
    expect(task?.anchor).toBeTruthy();
  } finally {
    await client.close();
  }
});

test("an owner whose only agent is another client sends to it, and that connection claims it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const owner = uniqueEmail("ask-other");
  const { token } = await seedToken(owner, { label: "ChatGPT", clientType: "other" });
  const art = await publishArtifact(page.request, token, { title: "Launch plan", html: PAGE_HTML });
  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}?ask`);
  const { form, panel } = await requestForm(page);
  // `?ask` is used once.
  expect(new URL(page.url()).search).toBe("");
  await expect(form.getByRole("radio", { name: /My other agent/ })).toBeChecked();
  await form.getByRole("textbox", { name: "What should change?" }).fill("Add a footer");
  await form.getByRole("button", { name: "Send request" }).click();
  const thread = panel.locator("article").filter({ hasText: "Add a footer" });
  await expect(thread.locator('[data-state="pending"]')).toContainText("The owner's other agent");

  const client = await mcpClient(token);
  try {
    const listed = await tool<{ items: MentionItem[] }>(client, "list_mentions", {});
    const task = listed.data.items.find((t) => t.artifact_id === art.id);
    expect(task?.target).toBe("@agent");
    if (!task) throw new Error("no task");
    const claimed = await tool<{ state: string }>(client, "claim_mention", { task_id: task.id });
    expect(claimed.data.state).toBe("claimed");
  } finally {
    await client.close();
  }
});

test("the dashboard card offers Ask an agent on a page, and it opens request mode", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const owner = uniqueEmail("ask-card");
  const { token } = await seedToken(owner, { clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Card ask page",
    html: PAGE_HTML,
  });
  await seedSession(page.context(), owner);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Actions for Card ask page" }).first().click();
  await page.getByRole("menuitem", { name: "Ask an agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${art.slug}`));
  await requestForm(page);
});

test("in edit mode the Ask dialog keeps editing, and publishes first only when asked", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("ask-edit");
  const { token } = await seedToken(owner, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Plan",
    type: "doc",
    content: "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n",
    html: undefined,
    visibility: "allowlist",
  });
  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}`);
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(frame.locator("h1")).toContainText("Plan", { timeout: 15_000 });
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  const bar = page.getByRole("region", { name: "Editing on the page" });
  await expect(bar).not.toContainText("Connecting", { timeout: 10_000 });
  await frame.locator("p", { hasText: "First paragraph." }).click();
  const field = frame.locator('.plinth-doc__open [contenteditable="true"]');
  await field.press("End");
  await field.pressSequentially(" Mine.");
  await field.press("Escape");
  await expect(bar).toContainText("Draft saved");
  const src = await page.locator(CURRENT_FRAME).getAttribute("src");

  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Ask an agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Ask an agent" });
  const first = dialog.getByRole("checkbox", { name: /Publish my changes first/ });
  await expect(first).not.toBeChecked();
  await first.check();
  await dialog.getByRole("textbox", { name: "What should change?" }).fill("Add a summary");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Request sent to Claude. It is in Comments")).toBeVisible();

  // Still editing the same frame, the comments panel closed, and the changes are v2.
  await expect(bar).toBeVisible();
  await expect(page.getByRole("region", { name: "Comments" })).toHaveCount(0);
  expect(await page.locator(CURRENT_FRAME).getAttribute("src")).toBe(src);
  const detail = await apiGet(page.request, `/artifacts/${art.id}`);
  expect(detail.body.current_version).toBe(2);
  expect(detail.body.content).toContain("First paragraph. Mine.");
  const comments = await apiGet(page.request, `/artifacts/${art.id}/comments`);
  const posted = (comments.body.items as { body: string; version_number: number }[]).find(
    (c) => c.body === "Add a summary",
  );
  expect(posted?.version_number).toBe(2);
});
