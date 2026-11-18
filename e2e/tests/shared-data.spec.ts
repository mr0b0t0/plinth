// Shared data end to end (docs/spec.md "Shared data and viewer identity"): a poll among invited
// people. Two listed viewers confirm by code and vote; the owner's open page sees the votes; an
// anonymous link viewer can read the tally but not write and never sees who voted; removing a
// person ends their writes; the owner clears the data; a takedown wipes it.
import path from "node:path";
import { type Browser, expect, type Frame, type Page, test } from "@playwright/test";
import { apiPost, uniqueEmail } from "../support/api.ts";
import { dataCounts, seedSession } from "../support/db.ts";
import { latestCode } from "../support/mail.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { CURRENT_FRAME, POLL_HTML, POLL_TITLE, pollFrame } from "../support/poll.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const SHOTS = shotsDir("shared-data");
const ADMIN = "admin@plinth.local";

interface Published {
  id: string;
  slug: string;
  url: string;
}

const isMobile = () => test.info().project.name === "mobile";
/** Changes made elsewhere arrive on the next /changes poll (15 s): wait up to three of them. */
const POLL_WAIT = 45_000;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`) });
}

const tally = (page: Page) => page.frameLocator(CURRENT_FRAME).locator("#total");
const note = (page: Page) => page.frameLocator(CURRENT_FRAME).locator("#note");
const notice = (page: Page) => page.getByRole("main").getByRole("note");

/** Confirm a listed email by code on the allowlist gate, in a fresh browser context. */
async function listedViewer(browser: Browser, a: Published, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(a.url);
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
  const code = await latestCode(page.request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
  return page;
}

async function vote(page: Page, choice: "Tacos" | "Ramen") {
  await page.frameLocator(CURRENT_FRAME).getByRole("button", { name: choice }).click();
  await expect(note(page)).toHaveText(`Saved: ${choice.toLowerCase()}`);
}

/** A write from inside the page, resolving to "ok" or the PlinthError code. */
const forcedWrite = (frame: Frame) =>
  frame.evaluate(() =>
    (window as unknown as { plinth: any }).plinth.db
      .collection("votes")
      .setMine({ choice: "ramen" })
      .then(
        () => "ok",
        (e: { code: string }) => e.code,
      ),
  );

async function openShareDialog(page: Page) {
  if (isMobile()) {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
  } else {
    await page.getByRole("button", { name: "Share" }).click();
  }
  return page.getByRole("dialog", { name: "Share this artifact" });
}

test("a poll among invited people, from first vote to takedown", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const owner = uniqueEmail("poll-owner");
  const a = uniqueEmail("voter-a");
  const b = uniqueEmail("voter-b");
  const { token } = await seedToken(owner, { label: "Poll agent", clientType: "claude" });
  const client = await mcpClient(token);
  const pages: Page[] = [];
  try {
    // 1. The owner's agent publishes the poll for two people.
    const pub = await tool<Published>(client, "publish_artifact", {
      title: POLL_TITLE,
      html: POLL_HTML,
      visibility: "allowlist",
      emails: [a, b],
    });
    expect(pub.isError, pub.text).toBe(false);
    const art = pub.data;

    // The owner keeps the poll open the whole time.
    await seedSession(page.context(), owner);
    await page.goto(art.url);
    await pollFrame(page);
    await expect(tally(page)).toHaveText("0");
    await expect(notice(page)).toHaveText(
      `This page can see that you are ${owner} and saves what you enter. People with access can see the entries and who wrote them.`,
    );

    // 2. A confirms by code and votes; B does the same in a second context.
    const pageA = await listedViewer(browser, art, a);
    pages.push(pageA);
    const frameA = await pollFrame(pageA);
    await expect(notice(pageA)).toHaveText(
      `This page can see that you are ${a} and saves what you enter. People with access can see the entries and who wrote them.`,
    );
    expect(await frameA.evaluate(() => (window as any).plinth.viewer)).toMatchObject({
      email: a,
      role: "viewer",
    });
    await expect(pageA.frameLocator(CURRENT_FRAME).locator("#me")).toHaveText(`Voting as ${a}`);
    await vote(pageA, "Tacos");
    await expect(tally(pageA)).toHaveText("1");

    const pageB = await listedViewer(browser, art, b);
    pages.push(pageB);
    const frameB = await pollFrame(pageB);
    expect(await frameB.evaluate(() => (window as any).plinth.viewer?.email)).toBe(b);
    await vote(pageB, "Ramen");
    await expect(tally(pageB)).toHaveText("2");
    await shot(pageB, "voter");

    // 3. The owner's open page picks both votes up by polling (every 15 s; the margin leaves room
    // for three projects sharing one Worker).
    await expect(tally(page)).toHaveText("2", { timeout: POLL_WAIT });
    await shot(page, "owner");

    // 4. B changes their vote: still one document per person.
    await vote(pageB, "Tacos");
    await expect(pageB.frameLocator(CURRENT_FRAME).locator("#tacos")).toHaveText("2");
    await expect(tally(pageB)).toHaveText("2");

    // 5. The agent reads both votes, stamped by the server with each voter's email.
    const listed = await tool<{ docs: any[]; untrusted: string }>(client, "list_artifact_data", {
      id: art.id,
      collection: "votes",
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.untrusted).toBeTruthy();
    expect(listed.data.docs).toHaveLength(2);
    const byEmail = Object.fromEntries(listed.data.docs.map((d) => [d.created_by.email, d]));
    expect(Object.keys(byEmail).sort()).toEqual([a, b].sort());
    for (const d of listed.data.docs) {
      expect(d.created_by).toMatchObject({ via: "page", role: "viewer" });
      expect(d.personal).toBe(true);
      expect(d.data).toEqual({ choice: "tacos" });
    }
    // Revs grow across the artifact: A's vote (1), B's vote (2), B's change (3).
    expect(byEmail[a].rev).toBe(1);
    expect(byEmail[b].rev).toBe(3);
    expect(byEmail[b].updated_by).toMatchObject({ email: b, via: "page" });

    // 6. Unlisted: an anonymous link viewer sees the tally, but cannot vote or see who voted.
    const unlisted = await tool(client, "set_visibility", { id: art.id, visibility: "unlisted" });
    expect(unlisted.isError, unlisted.text).toBe(false);
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    pages.push(anon);
    await anon.goto(art.url);
    const anonFrame = await pollFrame(anon);
    await expect(tally(anon)).toHaveText("2");
    await expect(note(anon)).toHaveText("Only people this poll was shared with can vote.");
    await expect(anon.frameLocator(CURRENT_FRAME).locator("body")).toHaveAttribute(
      "data-can-write",
      "false",
    );
    await expect(
      anon.frameLocator(CURRENT_FRAME).getByRole("button", { name: "Tacos" }),
    ).toBeDisabled();
    await expect(notice(anon)).toHaveText(
      "This page shows entries saved by people it is shared with. You can view them but not add your own.",
    );
    expect(await anonFrame.evaluate(() => (window as any).plinth.viewer)).toBeNull();
    expect(await forcedWrite(anonFrame)).toBe("read_only");
    const anonList = await anonFrame.evaluate(() =>
      (window as any).plinth.db.collection("votes").list(),
    );
    expect(anonList.docs).toHaveLength(2);
    for (const d of anonList.docs) {
      expect(d.mine).toBe(false);
      expect(d.createdBy).toBeUndefined();
      expect(d.updatedBy).toBeUndefined();
    }
    expect(JSON.stringify(anonList)).not.toContain("@");
    await shot(anon, "anonymous");

    // 7. B, still on the list, reloads and may vote; once the owner removes B, B's next write
    // is refused because the content pass ended with the access change.
    await pageB.reload();
    const frameB2 = await pollFrame(pageB);
    expect(await frameB2.evaluate(() => (window as any).plinth.canWrite)).toBe(true);
    const removed = await tool(client, "set_visibility", {
      id: art.id,
      visibility: "unlisted",
      emails: [a],
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(await forcedWrite(frameB2)).toBe("expired");

    // 8. The owner deletes all shared data from the share dialog; the open page empties.
    await page.reload();
    await pollFrame(page);
    await expect(tally(page)).toHaveText("2");
    const dialog = await openShareDialog(page);
    // The dialog also shows the open count, in its own status line.
    await expect(dialog.getByRole("status").filter({ hasText: "Shared data" })).toContainText(
      "Shared data: 2 entries",
    );
    await dialog.getByRole("button", { name: "Delete all shared data" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete all shared data?" });
    await confirm.getByRole("button", { name: "Delete 2 entries" }).click();
    await expect(page.getByText("Shared data deleted")).toBeVisible();
    await expect(tally(page)).toHaveText("0", { timeout: POLL_WAIT });
    const after = await tool<{ docs: unknown[] }>(client, "list_artifact_data", {
      id: art.id,
      collection: "votes",
    });
    expect(after.data.docs).toEqual([]);

    // 9. New data, then an admin takedown: the data goes with it.
    const seeded = await tool<{ results: { ok: boolean }[] }>(client, "write_artifact_data", {
      id: art.id,
      ops: [
        {
          op: "set",
          collection: "votes",
          doc_id: "agent-seed",
          data: { choice: "ramen" },
          if_rev: 0,
        },
      ],
    });
    expect(seeded.isError, seeded.text).toBe(false);
    expect(seeded.data.results[0]?.ok).toBe(true);
    expect(await dataCounts(art.id)).toEqual({ docs: 1, usage_rows: 1 });

    const report = await apiPost<{ id: string }>(request, `/artifacts/${art.slug}/report`, {
      reason: "Checking that a takedown wipes shared data.",
    });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const adminCtx = await browser.newContext();
    try {
      await seedSession(adminCtx, ADMIN);
      const decided = await apiPost(adminCtx.request, `/admin/reports/${report.body.id}`, {
        state: "actioned",
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    } finally {
      await adminCtx.close();
    }
    expect(await dataCounts(art.id)).toEqual({ docs: 0, usage_rows: 0 });
    const gone = await tool(client, "list_artifact_data", { id: art.id });
    expect(gone.isError).toBe(true);
  } finally {
    await client.close();
    for (const p of pages) await p.context().close();
  }
});
