// The example pages for people outside the owner's team (docs/examples/README.md), end to end:
// an approval sign-off, a client intake form and a client checklist, each published by the owner's
// agent and shared by email with people who have no account yet and confirm by code. What the
// owner's side decides is in the HTML and changes by a new version; what participants contribute
// is shared data, and each page counts only what the server's stamps vouch for.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Frame, type Page, test } from "@playwright/test";
import { uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";
import { shotsDir } from "../support/shots.ts";
import { CURRENT_FRAME, confirmByCode, readyFrame } from "../support/viewer.ts";

const SHOTS = shotsDir("outsider-templates");

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({
    path: path.join(SHOTS, `${test.info().project.name}-${name}.png`),
    fullPage: true,
  });
}

const example = (file: string) => readFileSync(path.join(ROOT, "docs/examples", file), "utf8");
const APPROVAL = example("approval-signoff.html");
const INTAKE = example("intake-form.html");
const CHECKLIST = example("client-checklist.html");

type Client = Awaited<ReturnType<typeof mcpClient>>;

interface Published {
  id: string;
  slug: string;
  url: string;
}

const inFrame = (page: Page) => page.frameLocator(CURRENT_FRAME);

async function openAs(browser: Browser, email: string, url: string, base?: Page): Promise<Page> {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(url);
  await readyFrame(page);
  return page;
}

/**
 * An invited person. In the light project the first approver confirms by emailed code, with no
 * account, as an outside participant does. Everyone else is signed in by the seed endpoint: the
 * e2e Worker counts every code request in one hourly bucket (no client IP in development), which
 * the other specs already use most of, and a grant is matched by email either way.
 */
async function invitee(browser: Browser, url: string, email: string, byCode = false) {
  if (byCode && test.info().project.name === "light") return confirmByCode(browser, url, email);
  return openAs(browser, email, url);
}

async function reopen(page: Page): Promise<Frame> {
  await page.reload();
  return readyFrame(page);
}

/** Publish an example as the owner's agent and share it by email (set_visibility replaces the list). */
async function publishFor(client: Client, title: string, html: string, emails: string[]) {
  const pub = await tool<Published>(client, "publish_artifact", { title, html });
  expect(pub.isError, pub.text).toBe(false);
  const shared = await tool(client, "set_visibility", {
    id: pub.data.id,
    visibility: "allowlist",
    emails,
  });
  expect(shared.isError, shared.text).toBe(false);
  return pub.data;
}

/** A new version from the agent: read, edit, publish on top of what it read. */
async function agentEdit(client: Client, id: string, edit: (html: string) => string, note: string) {
  const got = await tool<{ html: string; version: number }>(client, "get_artifact", { id });
  expect(got.isError, got.text).toBe(false);
  const html = edit(got.data.html);
  expect(html).not.toBe(got.data.html);
  const up = await tool(client, "update_artifact", {
    id,
    html,
    base_version: got.data.version,
    note,
  });
  expect(up.isError, up.text).toBe(false);
}

test("approval sign-off: two outside approvers, a new revision, moderation and a link viewer", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = uniqueEmail("approval-owner");
  const a = uniqueEmail("approver-a");
  const b = uniqueEmail("approver-b");
  const { token } = await seedToken(owner, { label: "Claude Code", clientType: "claude" });
  const client = await mcpClient(token);
  const pages: Page[] = [];
  try {
    expect(APPROVAL).toContain('data-required="2"');
    const art = await publishFor(client, "Approval: Website redesign proposal", APPROVAL, [a, b]);

    // A confirms by code (which signs them in) and approves with a note.
    const pageA = await invitee(browser, art.url, a, true);
    pages.push(pageA);
    await readyFrame(pageA);
    const fa = inFrame(pageA);
    await expect(fa.locator("body")).toHaveAttribute("data-can-write", "true");
    await expect(fa.locator("#me")).toHaveText(`Signing as ${a}`);
    await fa.getByLabel("Note (needed to request changes)").fill("Looks good to me.");
    await fa.getByRole("button", { name: "Approve" }).click();
    await expect(fa.locator("#status")).toHaveText("1 of 2 approvals on revision 1");
    await expect(fa.locator("#list li")).toHaveCount(1);
    await expect(fa.locator("#list li").first()).toContainText(a);

    // B cannot request changes without saying what; then does.
    const pageB = await invitee(browser, art.url, b);
    pages.push(pageB);
    await readyFrame(pageB);
    const fb = inFrame(pageB);
    await fb.getByRole("button", { name: "Request changes" }).click();
    await expect(fb.locator("#msg")).toHaveText(
      "Write what should change before you request changes.",
    );
    await fb.getByLabel("Note (needed to request changes)").fill("Lower the build price.");
    await fb.getByRole("button", { name: "Request changes" }).click();
    await expect(fb.locator("#status")).toHaveText("Changes requested by 1 person");
    await expect(fb.locator("#msg")).toHaveText("");
    await shot(pageB, "approval-approver");

    // The owner sees both, by email.
    await openAs(browser, owner, art.url, page);
    const fo = inFrame(page);
    await expect(fo.locator("#status")).toHaveText("Changes requested by 1 person");
    await expect(fo.locator("#list")).toContainText(a);
    await expect(fo.locator("#list")).toContainText(b);
    await expect(fo.locator("#list")).toContainText("Lower the build price.");

    // B withdraws, then approves: approved.
    await fb.getByRole("button", { name: "Withdraw" }).click();
    await expect(fb.locator("#list li")).toHaveCount(1);
    await expect(fb.getByRole("button", { name: "Withdraw" })).toBeDisabled();
    await fb.getByRole("button", { name: "Approve" }).click();
    await expect(fb.locator("#status")).toHaveText("Approved: 2 of 2 on revision 1");

    // The agent reads the results: two personal documents, stamped by the server.
    const listed = await tool<{ docs: any[] }>(client, "list_artifact_data", {
      id: art.id,
      collection: "signoffs",
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.docs).toHaveLength(2);
    expect(listed.data.docs.map((d) => d.created_by.email).sort()).toEqual([a, b].sort());
    for (const d of listed.data.docs) {
      expect(d.personal).toBe(true);
      expect(d.created_by.via).toBe("page");
      expect(d.data).toMatchObject({ decision: "approve", revision: 1 });
    }
    const docA = listed.data.docs.find((d) => d.created_by.email === a);

    // The agent changes the subject and bumps the revision: earlier sign-offs no longer count.
    await agentEdit(
      client,
      art.id,
      (html) =>
        html
          .replace('data-revision="1"', 'data-revision="2"')
          .replace("EUR 9,000", "EUR 8,000")
          .replace("EUR 17,000", "EUR 16,000"),
      "Revision 2: lower build price",
    );
    await reopen(page);
    await expect(fo.locator("#status")).toHaveText("0 of 2 approvals on revision 2");
    await expect(fo.locator("#list li", { hasText: "earlier revision" })).toHaveCount(2);

    // The owner moderates A's sign-off from the page: it shows who changed it, and stops counting.
    const frame = await readyFrame(page);
    const moderated = await frame.evaluate(
      (id) =>
        (window as any).plinth.db
          .collection("signoffs")
          .set(id, { decision: "approve", revision: 2, note: "Approved on the phone." })
          .then(
            () => "ok",
            (e: { code: string }) => e.code,
          ),
      docA.id as string,
    );
    expect(moderated).toBe("ok");
    await reopen(page);
    const rowA = fo.locator("#list li", { hasText: a });
    await expect(rowA).toContainText(`changed by ${owner} (owner)`);
    await expect(rowA).toHaveAttribute("data-counted", "false");
    await expect(fo.locator("#status")).toHaveText("0 of 2 approvals on revision 2");

    // A adds approvals that are not their personal document, through the runtime: the server
    // takes them (any writer may create a non-personal document), and the page counts none.
    const forged = await inFrame(pageA)
      .locator("body")
      .evaluate(async () => {
        const c = (window as any).plinth.db.collection("signoffs");
        const s = { decision: "approve", revision: 2, note: "" };
        try {
          await c.add(s);
          await c.add(s);
          await c.set("approval-b", s);
          return "ok";
        } catch (e) {
          return (e as { code: string }).code;
        }
      });
    expect(forged).toBe("ok");
    await reopen(page);
    await expect(fo.locator("#list li")).toHaveCount(5);
    // A's moderated sign-off and the three extra documents; B's own (earlier revision) is vouched.
    await expect(fo.locator('#list li[data-counted="false"]')).toHaveCount(4);
    await expect(
      fo.locator('#list li[data-counted="false"]', { hasText: "not a personal sign-off" }),
    ).toHaveCount(3);
    await expect(fo.locator("#status")).toHaveText("0 of 2 approvals on revision 2");
    await shot(page, "approval-owner");

    // A link viewer reads the decisions without names and cannot sign. Without stamps the page
    // cannot tell whose sign-offs these are, so it does not say whether the subject is approved.
    const unlisted = await tool(client, "set_visibility", { id: art.id, visibility: "unlisted" });
    expect(unlisted.isError, unlisted.text).toBe(false);
    const anon = await (await browser.newContext()).newPage();
    pages.push(anon);
    await anon.goto(art.url);
    await readyFrame(anon);
    const fx = inFrame(anon);
    await expect(fx.locator("body")).toHaveAttribute("data-can-write", "false");
    await expect(fx.locator("#list li")).toHaveCount(5);
    await expect(fx.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(await fx.locator("#list").textContent()).not.toContain("@");
    await expect(fx.locator("#status")).toHaveText(
      "Only people this page was shared with can see whether it is approved.",
    );
    await expect(fx.locator("#status")).toHaveAttribute("data-state", "unverified");
    await expect(fx.locator("#banner")).toHaveText(
      "You can see the sign-offs. Only people this page was shared with can sign.",
    );
  } finally {
    await client.close();
    for (const p of pages) await p.context().close();
  }
});

test("client intake: answers by code, the owner's responses, new questions, closing", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = uniqueEmail("intake-owner");
  const visitor = uniqueEmail("intake-client");
  const { token } = await seedToken(owner, { label: "Claude Code", clientType: "claude" });
  const client = await mcpClient(token);
  const pages: Page[] = [];
  try {
    const art = await publishFor(client, "Project intake: Acme", INTAKE, [visitor]);

    const pc = await invitee(browser, art.url, visitor);
    pages.push(pc);
    const frame = await readyFrame(pc);
    const fc = inFrame(pc);
    await expect(fc.locator("#me")).toHaveText(`Answering as ${visitor}`);
    await expect(fc.locator("#responses")).toBeHidden();
    // Over-long text is cut to the field's limit before it is written (the value is set by
    // script, which maxlength does not stop).
    await frame.evaluate(() => {
      (document.getElementById("f-company") as HTMLInputElement).value = `Acme ${"x".repeat(400)}`;
    });
    await fc.getByLabel("What should this project achieve?").fill("A faster site that sells more.");
    await fc.getByLabel("Budget range").selectOption("10-50k");
    await fc.getByLabel("You may email me with follow-up questions").check();
    await fc.getByRole("button", { name: "Send" }).click();
    await expect(fc.locator("#sent")).toContainText("Sent on");
    await expect(fc.locator("#sent")).toContainText(
      "You can change your answers until the form closes.",
    );

    // A reload restores the answers from the person's own document.
    await reopen(pc);
    await expect(fc.getByLabel("What should this project achieve?")).toHaveValue(
      "A faster site that sells more.",
    );
    await expect(fc.getByLabel("You may email me with follow-up questions")).toBeChecked();

    // The owner's view lists the response, by the server's stamp.
    await openAs(browser, owner, art.url, page);
    const fo = inFrame(page);
    await expect(fo.locator("#responses")).toBeVisible();
    await expect(fo.locator(".response")).toHaveCount(1);
    await expect(fo.locator(".response").first()).toContainText(visitor);
    await expect(fo.locator(".response").first()).toContainText("Sent");
    await expect(fo.locator(".response").first()).toContainText("10-50k");
    await shot(page, "intake-owner");

    const listed = await tool<{ docs: any[] }>(client, "list_artifact_data", {
      id: art.id,
      collection: "intake",
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.docs).toHaveLength(1);
    const doc = listed.data.docs[0];
    expect(doc.created_by).toMatchObject({ email: visitor, via: "page", role: "viewer" });
    expect(doc.data).toMatchObject({ submitted: true, formRevision: 1 });
    expect(doc.data.answers.company).toHaveLength(200);
    expect(doc.data.answers.contact_ok).toBe(true);

    // New questions: a new field and a bumped FORM_REVISION in a new version.
    await agentEdit(
      client,
      art.id,
      (html) =>
        html
          .replace("const FORM_REVISION = 1;", "const FORM_REVISION = 2;")
          .replace(
            '{ id: "contact_ok",',
            '{ id: "audience", label: "Who is the site for?", type: "text" },\n  { id: "contact_ok",',
          ),
      "Follow-up: who the site is for",
    );
    await reopen(pc);
    await expect(fc.locator("#changed")).toHaveText(
      "The questions changed since you answered; please check the new ones.",
    );
    await expect(fc.locator(".field:has(#f-audience)")).toHaveAttribute("data-unanswered", "true");
    await expect(fc.locator(".field:has(#f-goal)")).toHaveAttribute("data-unanswered", "false");

    // Closed: inputs off, answers still shown.
    await agentEdit(
      client,
      art.id,
      (html) => html.replace("const OPEN = true;", "const OPEN = false;"),
      "Intake closed",
    );
    await reopen(pc);
    await expect(fc.locator("#banner")).toHaveText("This form is closed.");
    await expect(fc.getByLabel("What should this project achieve?")).toBeDisabled();
    await expect(fc.getByLabel("What should this project achieve?")).toHaveValue(
      "A faster site that sells more.",
    );
    await expect(fc.getByRole("button", { name: "Send" })).toBeDisabled();
    await shot(pc, "intake-closed");
  } finally {
    await client.close();
    for (const p of pages) await p.context().close();
  }
});

test("client checklist: client ticks count, team ticks need the team, items change by version", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = uniqueEmail("checklist-owner");
  const visitor = uniqueEmail("checklist-client");
  const { token } = await seedToken(owner, { label: "Claude Code", clientType: "claude" });
  const client = await mcpClient(token);
  const pages: Page[] = [];
  try {
    const art = await publishFor(client, "Launch checklist: Acme", CHECKLIST, [visitor]);

    const pc = await invitee(browser, art.url, visitor);
    pages.push(pc);
    const frame = await readyFrame(pc);
    const fc = inFrame(pc);
    await expect(fc.locator("#progress")).toHaveText("0 of 7 done (client 0 of 4, team 0 of 3)");
    await fc.locator("#i-brand-assets").check();
    const brand = fc.locator('li[data-item="brand-assets"]');
    await expect(brand.locator(".state")).toContainText(`Done by ${visitor}`);
    await expect(fc.locator("#progress")).toHaveText("1 of 7 done (client 1 of 4, team 0 of 3)");
    // Team items are the team's: the client's checkbox is off.
    await expect(fc.locator("#i-kickoff-call")).toBeDisabled();
    // The collection is shared, so the server takes a forced tick; the page does not count it.
    const forced = await frame.evaluate(() =>
      (window as any).plinth.db
        .collection("ticks")
        .set("kickoff-call", { done: true })
        .then(
          () => "ok",
          (e: { code: string }) => e.code,
        ),
    );
    expect(forced).toBe("ok");

    await openAs(browser, owner, art.url, page);
    const fo = inFrame(page);
    const kickoff = fo.locator('li[data-item="kickoff-call"]');
    await expect(kickoff.locator(".state")).toHaveText(
      `Marked done by ${visitor}; waiting for the team to confirm`,
    );
    await expect(fo.locator("#progress")).toHaveText("1 of 7 done (client 1 of 4, team 0 of 3)");
    await expect(fo.locator('li[data-item="brand-assets"] .state')).toContainText(
      `Done by ${visitor}`,
    );
    await shot(page, "checklist-owner");

    // The owner confirms it: now it counts.
    await expect(fo.locator("#i-kickoff-call")).toBeEnabled();
    await fo.locator("#i-kickoff-call").check();
    await expect(kickoff.locator(".state")).toContainText(`Done by ${owner}`);
    await expect(fo.locator("#progress")).toHaveText("2 of 7 done (client 1 of 4, team 1 of 3)");

    // The client adds a note to that team item: notes are their own documents, so the tick keeps
    // the owner's stamp and still counts.
    await reopen(pc);
    const clientKickoff = fc.locator('li[data-item="kickoff-call"]');
    await clientKickoff.locator("summary").click();
    await clientKickoff.getByLabel("Note on Kickoff call booked").fill("Booked for Tuesday");
    await clientKickoff.getByRole("button", { name: "Save note" }).click();
    await expect(clientKickoff.locator(".note")).toHaveText("Note: Booked for Tuesday");
    await reopen(page);
    await expect(kickoff.locator(".state")).toContainText(`Done by ${owner}`);
    await expect(kickoff.locator(".note")).toHaveText("Note: Booked for Tuesday");
    await expect(kickoff).toContainText(`Note by ${visitor}`);
    await expect(fo.locator("#progress")).toHaveText("2 of 7 done (client 1 of 4, team 1 of 3)");

    // A tick the client forced on a team item stays unconfirmed when the owner only adds a note.
    const forcedLaunch = await (await readyFrame(pc)).evaluate(() =>
      (window as any).plinth.db
        .collection("ticks")
        .set("launch", { done: true })
        .then(
          () => "ok",
          (e: { code: string }) => e.code,
        ),
    );
    expect(forcedLaunch).toBe("ok");
    await reopen(page);
    const launch = fo.locator('li[data-item="launch"]');
    await expect(launch.locator(".state")).toHaveText(
      `Marked done by ${visitor}; waiting for the team to confirm`,
    );
    await launch.locator("summary").click();
    await launch.getByLabel("Note on Site launched").fill("Scheduled for Friday");
    await launch.getByRole("button", { name: "Save note" }).click();
    await expect(launch.locator(".note")).toHaveText("Note: Scheduled for Friday");
    await reopen(page);
    await expect(launch.locator(".state")).toHaveText(
      `Marked done by ${visitor}; waiting for the team to confirm`,
    );
    await expect(fo.locator("#progress")).toHaveText("2 of 7 done (client 1 of 4, team 1 of 3)");

    // The agent removes an item in a new version: its tick is ignored, the total drops.
    await agentEdit(
      client,
      art.id,
      (html) => html.replace(/^\s*\{ id: "brand-assets",[^\n]*\n/m, ""),
      "Brand assets already received",
    );
    await reopen(page);
    await expect(fo.locator('li[data-item="brand-assets"]')).toHaveCount(0);
    await expect(fo.locator("#progress")).toHaveText("1 of 6 done (client 0 of 3, team 1 of 3)");

    // The owner's agent ticks a team item when asked: stamped as the owner, via agent, counted.
    const written = await tool<{ results: { ok: boolean }[] }>(client, "write_artifact_data", {
      id: art.id,
      ops: [
        {
          op: "set",
          collection: "ticks",
          doc_id: "staging-site",
          data: { done: true },
          if_rev: 0,
        },
        {
          op: "set",
          collection: "notes",
          doc_id: "staging-site",
          data: { text: "Staging is up." },
          if_rev: 0,
        },
      ],
    });
    expect(written.isError, written.text).toBe(false);
    expect(written.data.results.map((r) => r.ok)).toEqual([true, true]);
    await reopen(page);
    const staging = fo.locator('li[data-item="staging-site"]');
    await expect(staging.locator(".state")).toContainText(`Done by ${owner}`);
    await expect(staging.locator(".state")).toContainText("via agent");
    await expect(staging.locator(".note")).toHaveText("Note: Staging is up.");
    await expect(fo.locator("#progress")).toHaveText("2 of 6 done (client 0 of 3, team 2 of 3)");

    // A link viewer gets no stamps, so the page cannot tell who ticked a team item: it counts only
    // the client items and says why.
    const unlisted = await tool(client, "set_visibility", { id: art.id, visibility: "unlisted" });
    expect(unlisted.isError, unlisted.text).toBe(false);
    const anon = await (await browser.newContext()).newPage();
    pages.push(anon);
    await anon.goto(art.url);
    await readyFrame(anon);
    const fx = inFrame(anon);
    await expect(fx.locator("body")).toHaveAttribute("data-can-write", "false");
    await expect(fx.locator("#progress")).toHaveText(
      "Client items: 0 of 3 done. Only people this checklist is shared with can see the team's progress.",
    );
    await expect(fx.locator('li[data-item="kickoff-call"] .state')).toHaveText(
      "Marked done. Only people this checklist is shared with can see whether the team confirmed it.",
    );
    expect(await fx.locator("#groups").textContent()).not.toContain("@");
  } finally {
    await client.close();
    for (const p of pages) await p.context().close();
  }
});

test("the Connections page shows the handle a label becomes", async ({ page }) => {
  const owner = uniqueEmail("handles");
  await seedToken(owner, { label: "Claude Code", clientType: "claude" });
  await seedToken(owner, { label: "claude-code", clientType: "other" });
  await seedToken(owner, { label: "Claude", clientType: "other" });
  await seedSession(page.context(), owner);
  await page.goto("/connections");
  const rows = page.locator(".pl-acct-conn");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Mention as @claude-code" })).toHaveCount(1);
  await expect(page.getByText("@claude-code reaches “Claude Code” instead")).toBeVisible();
  await expect(
    page.getByText("@claude always means your Claude connections, so this name does not reach it."),
  ).toBeVisible();
});
