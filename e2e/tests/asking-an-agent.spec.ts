// Asking an agent (docs/spec.md "Asking an agent"): comments are the one way in. A commenter pins a
// comment to a heading and mentions @claude; the owner's Claude lists, claims and answers it with
// a version, and the thread shows it done. There is no Ask an agent button, menu item or dialog.
// An owner whose only agent is neither Claude nor Codex is offered @agent:other, which that
// connection lists and claims. The opaque-isolation case is in asking-an-agent-opaque.spec.ts.
import { expect, type Page, test } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Launch plan</title>
<style>body{font-family:system-ui,sans-serif;margin:48px}h1{font-size:40px}</style></head>
<body><h1>Launch plan</h1><p>Three steps to a calm launch.</p></body></html>`;

interface MentionItem {
  id: string;
  comment_id: string;
  artifact_id: string;
  target: string;
  comment_body: string;
  comment_author_role: string | null;
  anchor: Record<string, unknown> | null;
}

/** Open the comments panel from the bar, once the frame has reloaded in review mode. */
async function openComments(page: Page) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel).toBeVisible();
  await expect(page.frameLocator(CURRENT_FRAME).locator("script[data-plinth-bridge]")).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  return panel;
}

/** Nothing asks an agent outside the comments: no bar button and no ⋯ item. */
async function expectNoAskEntry(page: Page) {
  await expect(page.getByRole("button", { name: "Ask an agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await expect(page.getByRole("menuitem", { name: /Ask an agent/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test("a commenter pins a comment to a heading and mentions @claude; the owner's Claude claims it and the thread shows done → v2", async ({
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
  await expectNoAskEntry(page);
  const panel = await openComments(page);
  await expect(panel).not.toContainText("Work Claude");

  await panel.getByRole("button", { name: "Pin to an element" }).click();
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(async () => {
    await frame.locator("h1").click();
    await expect(panel.getByText("Pinned to")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  const box = panel.getByRole("textbox", { name: "New comment" });
  await box.pressSequentially("@cl");
  await expect(panel.getByRole("option", { name: "@claude" })).toBeVisible();
  await box.press("Enter");
  await box.pressSequentially("make the heading red");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  const thread = panel.locator("article").filter({ hasText: "make the heading red" });
  await expect(thread.locator('[data-state="pending"]')).toContainText("@claude");

  const client = await mcpClient(token);
  try {
    const listed = await tool<{ items: MentionItem[] }>(client, "list_mentions", {});
    const task = listed.data.items.find((t) => t.artifact_id === art.id);
    if (!task) throw new Error("no mention task");
    expect(task).toMatchObject({
      target: "@claude",
      comment_body: "@claude make the heading red",
      comment_author_role: "commenter",
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

test("an owner whose only agent is another client is offered @agent:other, and that connection claims it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const owner = uniqueEmail("ask-other");
  const { token } = await seedToken(owner, { label: "ChatGPT", clientType: "other" });
  const art = await publishArtifact(page.request, token, { title: "Launch plan", html: PAGE_HTML });
  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toBeVisible({ timeout: 15_000 });
  // An HTML page has nothing for editing in the bar, and no way to ask but the comments.
  await expectNoAskEntry(page);
  const panel = await openComments(page);
  const box = panel.getByRole("textbox", { name: "New comment" });
  await box.pressSequentially("@ag");
  const option = panel.getByRole("option", { name: /@agent:other/ });
  await expect(option).toContainText("ChatGPT, Cursor, Gemini");
  await box.press("Enter");
  await box.pressSequentially("add a footer");
  await expect(box).toHaveValue("@agent:other add a footer");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  const thread = panel.locator("article").filter({ hasText: "add a footer" });
  await expect(thread.locator('[data-state="pending"]')).toContainText("The owner's other agent");

  const client = await mcpClient(token);
  try {
    const listed = await tool<{ items: MentionItem[] }>(client, "list_mentions", {});
    const task = listed.data.items.find((t) => t.artifact_id === art.id);
    expect(task?.target).toBe("@agent:other");
    if (!task) throw new Error("no task");
    const claimed = await tool<{ state: string }>(client, "claim_mention", { task_id: task.id });
    expect(claimed.data.state).toBe("claimed");
  } finally {
    await client.close();
  }
});
