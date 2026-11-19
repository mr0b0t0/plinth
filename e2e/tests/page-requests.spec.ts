// Page requests, end to end (docs/spec.md "Page requests"), with the example report
// (docs/examples/ask-agent.html): a commenter asks the owner's agent for a change from the page;
// the agent claims it, publishes a new version and answers; the page shows the answer and the
// version, never the owner's typed reply and no one's name or address. A viewer-role person cannot
// ask, a link viewer is not identified, another commenter cannot see or reply into the request, the
// requester withdraws a second one, and another artifact's page cannot file one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  apiGet,
  apiPost,
  apiPut,
  contentOrigin,
  newApiContext,
  uniqueEmail,
} from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const HTML = readFileSync(path.join(ROOT, "docs/examples/ask-agent.html"), "utf8");
/** The page polls every 30 s while a request is open; allow two polls and a version swap. */
const POLL_WAIT = 75_000;

const inFrame = (page: Page) => page.frameLocator(CURRENT_FRAME);
const items = (page: Page) => inFrame(page).locator("#list li");
const notice = (page: Page) => page.getByRole("main").getByRole("note");

async function ask(page: Page, text: string) {
  await inFrame(page).locator("#body").fill(text);
  await inFrame(page).locator("#send").click();
  await expect(inFrame(page).locator("#status")).toHaveText(
    "Sent. The owner's agent answers when it next runs.",
  );
}

test("a commenter asks the owner's agent from the page, and sees only its answer", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = uniqueEmail("ask-owner");
  const requester = uniqueEmail("ask-requester");
  const other = uniqueEmail("ask-other");
  const viewer = uniqueEmail("ask-viewer");
  const { token } = await seedToken(owner, { label: "Report agent", clientType: "claude" });
  const client = await mcpClient(token);
  const api = await newApiContext();
  try {
    // 1. The owner's agent publishes the report and shares it with two commenters and a viewer.
    const pub = await tool<{ id: string; slug: string; url: string }>(client, "publish_artifact", {
      title: "Quarterly sales report",
      html: HTML,
      visibility: "allowlist",
    });
    expect(pub.isError, pub.text).toBe(false);
    const art = pub.data;
    const shared = await apiPut(
      api,
      `/artifacts/${art.id}/sharing`,
      {
        grants: [
          { email: requester, role: "commenter" },
          { email: other, role: "commenter" },
          { email: viewer, role: "viewer" },
        ],
      },
      { token },
    );
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);

    // 2. The requester opens it, is told which address requests go under, and asks.
    const reqCtx = await browser.newContext();
    await seedSession(reqCtx, requester);
    const pageR = await reqCtx.newPage();
    await pageR.goto(art.url);
    await readyFrame(pageR);
    await expect(inFrame(pageR).locator("body")).toHaveAttribute("data-can-file", "true");
    await expect(notice(pageR)).toHaveText(
      `This page can send requests to the owner's agent as ${requester}. The owner and editors see them, and so do you, under Comments.`,
    );
    await ask(pageR, "Add the Q3 numbers");
    await expect(items(pageR)).toHaveCount(1);
    await expect(items(pageR).first()).toHaveAttribute("data-state", "pending");

    // 3. The owner's agent finds it in its queue, claims it, publishes v2 and answers.
    const queued = await apiGet(api, "/mentions", { token });
    const task = (queued.body.items as any[]).find((t) => t.artifact_id === art.id);
    expect(task).toMatchObject({
      source: "page",
      comment_author_role: null,
      requester_role: "commenter",
      comment_body: "Add the Q3 numbers",
      target: "@claude",
    });
    expect((await apiPost(api, `/mentions/${task.id}/claim`, {}, { token })).status).toBe(200);
    const v2 = await tool<{ version: number }>(client, "update_artifact", {
      id: art.id,
      base_version: 1,
      html: HTML.replace(
        '<tr><td>West</td><td class="num">274,400</td><td class="num">289,800</td></tr>',
        '<tr><td>West</td><td class="num">274,400</td><td class="num">289,800</td></tr>\n      <tr><td>Total</td><td class="num">1,336,300</td><td class="num">1,400,300</td></tr>',
      ),
    });
    expect(v2.isError, v2.text).toBe(false);
    const answered = await apiPost(
      api,
      `/comments/${task.comment_id}/reply`,
      { body: "Added a totals row in version 2.", result_version: 2 },
      { token },
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(201);

    // The owner types a reply in the app: it stays in Comments, with the "Sent from the page" chip.
    await seedSession(page.context(), owner);
    await page.goto(art.url);
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = page.getByRole("region", { name: "Comments" });
    const thread = panel.locator("article.cm-thread", { hasText: "Add the Q3 numbers" });
    await expect(thread.getByText("Sent from the page")).toBeVisible();
    await thread.getByRole("button", { name: "Reply" }).click();
    await expect(
      thread.getByText("The page shows its requester only this request's state"),
    ).toBeVisible();
    await thread.getByRole("textbox", { name: "Reply" }).fill("OWNER-TYPED-NOTE");
    await thread.getByRole("button", { name: "Send reply" }).click();
    await expect(thread.getByText("OWNER-TYPED-NOTE")).toBeVisible();
    await expect(thread.getByRole("button", { name: "Dismiss request" })).toBeVisible();

    // 4. The requester's page shows done, v2 and the agent's answer, and nobody's name or address.
    await expect(items(pageR).first()).toHaveAttribute("data-state", "done", {
      timeout: POLL_WAIT,
    });
    await expect(items(pageR).first().locator(".answer")).toHaveText(
      "Added a totals row in version 2.",
    );
    await expect(items(pageR).first()).toContainText("answered in version 2");
    const text = (await inFrame(pageR).locator("main").textContent()) ?? "";
    expect(text).not.toContain("OWNER-TYPED-NOTE");
    expect(text).not.toContain("Report agent");
    expect(text).not.toMatch(/[\w.+-]+@[\w.-]+\.\w+/);

    // 5. A viewer-role person cannot ask; a link viewer of an unlisted copy is not identified.
    const viewCtx = await browser.newContext();
    await seedSession(viewCtx, viewer);
    const pageV = await viewCtx.newPage();
    await pageV.goto(art.url);
    await readyFrame(pageV);
    await expect(inFrame(pageV).locator("body")).toHaveAttribute("data-can-file", "false");
    await expect(inFrame(pageV).locator("#send")).toBeDisabled();
    const open = await tool<{ url: string }>(client, "publish_artifact", {
      title: "Quarterly sales report (link)",
      html: HTML,
      visibility: "unlisted",
    });
    const anonCtx = await browser.newContext();
    const pageA = await anonCtx.newPage();
    await pageA.goto(open.data.url);
    await readyFrame(pageA);
    await expect(inFrame(pageA).locator("body")).toHaveAttribute("data-reason", "not_identified");

    // 6. Another commenter neither sees the request nor replies into it.
    const { token: otherToken } = await seedToken(other, { label: "Other agent" });
    const theirs = await apiGet(api, `/artifacts/${art.id}/comments`, { token: otherToken });
    expect((theirs.body.items as any[]).map((c) => c.id)).not.toContain(task.comment_id);
    const sneaky = await apiPost(
      api,
      `/artifacts/${art.id}/comments`,
      { body: "Me too", parent_id: task.comment_id },
      { token: otherToken },
    );
    expect(sneaky.status).toBe(404);

    // 7. The requester asks again, then withdraws it in Comments; the queue drops it.
    await pageR.reload();
    await readyFrame(pageR);
    await ask(pageR, "Also split North by city");
    await expect(items(pageR)).toHaveCount(2);
    await pageR.getByRole("button", { name: "Comments", exact: true }).click();
    const panelR = pageR.getByRole("region", { name: "Comments" });
    const second = panelR.locator("article.cm-thread", { hasText: "Also split North by city" });
    await second.getByRole("button", { name: "Withdraw request" }).click();
    // Withdrawn, it leaves the panel's Open filter.
    await expect(second).toHaveCount(0);
    await expect
      .poll(async () => {
        const pending = await apiGet(api, "/mentions", { token });
        return (pending.body.items as any[]).filter((t) => t.artifact_id === art.id).length;
      })
      .toBe(0);
    await reqCtx.close();
    await viewCtx.close();
    await anonCtx.close();
  } finally {
    await client.close();
    await api.dispose();
  }
});

test("another artifact's page cannot file a request on this one", async ({ page }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("ask-target");
  const { token } = await seedToken(owner, { label: "Target agent", clientType: "claude" });
  const client = await mcpClient(token);
  const api = await newApiContext();
  try {
    const a = await tool<{ id: string; url: string }>(client, "publish_artifact", {
      title: "Quarterly sales report",
      html: HTML,
      visibility: "allowlist",
    });
    // The owner opens A, so the browser holds A's content cookie.
    await seedSession(page.context(), owner);
    await page.goto(a.data.url);
    await readyFrame(page);
    const target = `${contentOrigin(a.data.id)}/__plinth/api/v1/requests`;
    const attacker = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Innocent</title></head>
<body><h1>Innocent</h1><pre id="out">running</pre>
<iframe name="sink" title="sink" hidden></iframe>
<form id="form" method="POST" action="${target}" target="sink" enctype="text/plain">
  <input type="hidden" name='{"body":"forged","pad":"' value='"}'>
</form>
<script>
const r = {};
const body = JSON.stringify({ body: "forged" });
(async () => {
  try {
    const res = await fetch(${JSON.stringify(target)}, { method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-plinth-data": "1" }, body });
    r.fetch = "status:" + res.status;
  } catch (e) { r.fetch = "error:" + e.name; }
  try { r.beacon = String(navigator.sendBeacon(${JSON.stringify(target)}, new Blob([body], { type: "text/plain" }))); }
  catch (e) { r.beacon = "error:" + e.name; }
  try { document.getElementById("form").submit(); r.form = "sent"; } catch (e) { r.form = "error:" + e.name; }
  document.getElementById("out").textContent = JSON.stringify(r);
  document.body.dataset.ready = "1";
})();
</script></body></html>`;
    const b = await tool<{ url: string }>(client, "publish_artifact", {
      title: "Innocent",
      html: attacker,
      visibility: "allowlist",
    });
    await page.goto(b.data.url);
    await readyFrame(page);
    await expect(page.frameLocator(CURRENT_FRAME).locator("#out")).not.toHaveText("running");
    // Give the beacon and the form time to land, then check that A has no request.
    await page.waitForTimeout(1500);
    const queue = await apiGet(api, "/mentions", { token });
    expect((queue.body.items as any[]).filter((t) => t.artifact_id === a.data.id)).toEqual([]);
    const comments = await apiGet(api, `/artifacts/${a.data.id}/comments`, { token });
    expect(comments.body.items).toEqual([]);
  } finally {
    await client.close();
    await api.dispose();
  }
});
