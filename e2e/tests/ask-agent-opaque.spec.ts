// Ask an agent under opaque content isolation (docs/spec.md "Ask an agent"): there is no editing on
// the page, so a doc's owner gets Ask an agent in the Edit slot with the reason, `?edit` lands on
// the viewer with the same reason as a notice, and a request posted from it reaches the owner's
// agent. No editing message is ever exchanged with a frame whose origin is "null".
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const REASON = "Editing on the page isn't available with this instance's content isolation.";

test("a doc's owner gets Ask an agent with the reason instead of Edit, and the request reaches Claude", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("opaque-ask");
  const { token } = await seedToken(email, {
    origin: OPAQUE_APP_ORIGIN,
    clientType: "claude",
    label: "Work Claude",
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Plan", type: "doc", content: "# Plan\n\nText.\n" }),
  });
  const doc = (await res.json()) as { slug: string; id: string };
  expect(res.status, JSON.stringify(doc)).toBe(201);

  await page.goto(`/a/${doc.slug}?edit`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("Plan", {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  const notice = page.getByRole("status").filter({ hasText: REASON });
  await expect(notice).toContainText("Ask an agent to make the change.");
  expect(new URL(page.url()).search).toBe("");
  const ask = page.getByRole("button", { name: "Ask an agent", exact: true }).first();
  await ask.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: REASON })).toBeVisible();
  // Out of the way of the notice under it.
  await page.mouse.move(10, 600);
  await expect(page.getByRole("tooltip").filter({ hasText: REASON })).toBeHidden();

  await notice.getByRole("button", { name: "Ask an agent" }).click();
  const panel = page.getByRole("region", { name: "Comments" });
  const form = panel.getByRole("form", { name: "Ask an agent to change this page" });
  await expect(form.getByRole("radio", { name: "Claude" })).toBeChecked();
  await form.getByRole("textbox", { name: "What should change?" }).fill("Add a summary");
  await form.getByRole("button", { name: "Send request" }).click();
  await expect(panel.locator("article").filter({ hasText: "Add a summary" })).toBeVisible();

  const client = await mcpClient(token, OPAQUE_APP_ORIGIN);
  try {
    const listed = await tool<{ items: { artifact_id: string; target: string }[] }>(
      client,
      "list_mentions",
      {},
    );
    expect(listed.data.items.find((t) => t.artifact_id === doc.id)?.target).toBe("@claude");
  } finally {
    await client.close();
  }
  // The frame never got a key: nothing on the page is an editing channel.
  expect(await page.locator(CURRENT_FRAME).getAttribute("src")).not.toContain("#plinth-k=");
});
