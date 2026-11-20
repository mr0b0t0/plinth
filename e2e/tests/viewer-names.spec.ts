// Who is viewing (docs/spec.md "Who is viewing: names and the people list"), end to end: the owner
// sets a name from the account menu; a page that declares `data viewer people` shows the viewer's
// name, lists everyone with access for the owner and an editor, and names the authors of its
// sign-ups; a viewer confirmed by code (no account) has no name and gets `forbidden` from the list
// but is told about it; an anonymous link viewer sees no viewer, no authors and no list; and in a
// live room a peer's cursor is labelled with their name.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type FrameLocator, type Page, test } from "@playwright/test";
import { apiPatch, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { latestCode } from "../support/mail.ts";
import { ROOT } from "../support/paths.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PEOPLE_CLAUSE = "the owner and editors see who has access.";
const ENTRIES = "People with access see entries and who wrote them;";

const TEAM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="plinth-capabilities" content="data viewer people">
<title>Team list</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; margin: 16px; background: Canvas; color: CanvasText; }</style>
<script src="/__plinth/runtime.js"></script>
</head>
<body>
<main>
  <h1>Team list</h1>
  <p>Signed in as <span id="me">-</span></p>
  <h2>People with access</h2>
  <ul id="people"></ul>
  <p id="people-error"></p>
  <button type="button" id="join">Sign up</button>
  <h2>Signed up</h2>
  <ul id="signups"></ul>
</main>
<script>
const $ = (id) => document.getElementById(id);
const who = (a) => (a ? a.name || a.email || "someone" : "someone");
function render(docs) {
  $("signups").replaceChildren(...docs.map((d) => {
    const li = document.createElement("li");
    li.textContent = who(d.createdBy);
    return li;
  }));
}
window.plinth?.ready.then(async (s) => {
  $("me").textContent = s.viewer ? s.viewer.name || s.viewer.email || "someone" : "anonymous";
  document.body.dataset.canList = String(!!s.canListPeople);
  try {
    for (const p of await plinth.people.list()) {
      const li = document.createElement("li");
      li.textContent = (p.name || p.email) + " · " + p.role + (p.you ? " · you" : "");
      $("people").append(li);
    }
    document.body.dataset.people = "ok";
  } catch (e) {
    $("people-error").textContent = e.code;
    document.body.dataset.people = "error";
  }
  const signups = plinth.db.collection("signups");
  if (s.available) signups.all().then(render);
  $("join").disabled = !s.canWrite;
  $("join").onclick = () => signups.setMine({ yes: true }).then(() => signups.all()).then(render);
  document.body.dataset.ready = "true";
});
</script>
</body>
</html>`;

const frame = (page: Page): FrameLocator => page.frameLocator(CURRENT_FRAME);
const notice = (page: Page) => page.getByRole("main").getByRole("note");

async function openPage(page: Page, url: string) {
  await page.goto(url);
  await expect(frame(page).locator("body")).toHaveAttribute("data-ready", "true", {
    timeout: 15_000,
  });
}

/** On phones the sidebar is a slide-over: open it before using the account menu. */
async function openNav(page: Page) {
  if (test.info().project.name !== "mobile") return;
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible();
}

/** Confirm a listed email by code on the allowlist gate, in a fresh browser context. */
async function listedViewer(browser: Browser, url: string, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
  const code = await latestCode(page.request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
  await expect(frame(page).locator("body")).toHaveAttribute("data-ready", "true", {
    timeout: 15_000,
  });
  return page;
}

test("names and the people list on a page shared with a team", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("names-owner");
  const editor = uniqueEmail("names-editor");
  const viewer = uniqueEmail("names-viewer");
  const { token } = await seedToken(owner, { label: "Team agent", clientType: "claude" });

  // 1. The owner sets a name from the account menu.
  await seedSession(page.context(), owner);
  await page.goto("/dashboard");
  await openNav(page);
  await page.getByRole("button", { name: `Account: ${owner}` }).click();
  await page.getByRole("menuitem", { name: "Your name…" }).click();
  const dialog = page.getByRole("dialog", { name: "Your name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Ana Owner");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Name saved")).toBeVisible();
  await expect(dialog).toBeHidden();
  // One layer at a time: on a phone the slide-over closed when the dialog opened.
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0);
  // The sidebar's account chip now shows the name; the menu keeps the email.
  await openNav(page);
  await page.getByRole("button", { name: "Account: Ana Owner" }).click();
  await expect(page.getByText(owner, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // 2. The owner's agent publishes the page and shares it: an editor, and a viewer with no account.
  const art = await publishArtifact(page.request, token, {
    title: "Team list",
    html: TEAM_HTML,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    {
      grants: [
        { email: editor, role: "editor" },
        { email: viewer, role: "viewer" },
      ],
    },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  // 3. The owner sees their name, everyone with access and their own row, and is told.
  await openPage(page, art.url);
  await expect(frame(page).locator("#me")).toHaveText("Ana Owner");
  await expect(frame(page).locator("body")).toHaveAttribute("data-can-list", "true");
  const ownerList = frame(page).locator("#people li");
  await expect(ownerList).toHaveCount(3);
  await expect(ownerList.nth(0)).toHaveText("Ana Owner · owner · you");
  await expect(frame(page).locator("#people")).toContainText(`${editor} · editor`);
  await expect(frame(page).locator("#people")).toContainText(`${viewer} · viewer`);
  await expect(notice(page)).toHaveText(
    `This page sees you as Ana Owner (${owner}) and saves what you enter. ${ENTRIES} ${PEOPLE_CLAUSE}`,
  );
  await frame(page).getByRole("button", { name: "Sign up" }).click();
  await expect(frame(page).locator("#signups")).toHaveText("Ana Owner");

  const pages: Page[] = [];
  try {
    // 4. The editor (signed in, with a name) sees the list and the owner's name on the sign-up.
    const ed = await (await browser.newContext()).newPage();
    pages.push(ed);
    await seedSession(ed.context(), editor);
    const named = await apiPatch(ed.request, "/me", { name: "Bo Editor" });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    await openPage(ed, art.url);
    await expect(frame(ed).locator("#me")).toHaveText("Bo Editor");
    await expect(frame(ed).locator("#people li")).toHaveCount(3);
    await expect(frame(ed).locator("#people")).toContainText("Bo Editor · editor · you");
    await expect(frame(ed).locator("#people")).toContainText("Ana Owner · owner");
    await expect(frame(ed).locator("#signups")).toHaveText("Ana Owner");

    // The owner typed the editor's address, so their name shows to the owner only once they
    // take part: here, by signing up.
    await openPage(page, art.url);
    await expect(frame(page).locator("#people")).toContainText(`${editor} · editor`);
    await expect(frame(page).locator("#people")).not.toContainText("Bo Editor");
    await frame(ed).getByRole("button", { name: "Sign up" }).click();
    await expect(frame(ed).locator("#signups li")).toHaveCount(2);
    await openPage(page, art.url);
    await expect(frame(page).locator("#people")).toContainText("Bo Editor · editor");
    await expect(frame(page).locator("#signups")).toContainText("Bo Editor");

    // 5. The viewer confirms by code: no account, so no name; no list, but they are told.
    const vw = await listedViewer(browser, art.url, viewer);
    pages.push(vw);
    await expect(frame(vw).locator("#me")).toHaveText(viewer);
    await expect(frame(vw).locator("body")).toHaveAttribute("data-can-list", "false");
    await expect(frame(vw).locator("#people-error")).toHaveText("forbidden");
    await expect(frame(vw).locator("#people li")).toHaveCount(0);
    await expect(frame(vw).locator("#signups li")).toHaveText(["Ana Owner", "Bo Editor"]);
    await expect(notice(vw)).toHaveText(
      `This page sees you as ${viewer} and saves what you enter. ${ENTRIES} ${PEOPLE_CLAUSE}`,
    );

    // 6. An unlisted copy opened anonymously: no viewer, no authors, no list.
    const link = await publishArtifact(page.request, token, {
      title: "Team list (link)",
      html: TEAM_HTML,
      visibility: "unlisted",
    });
    const own = await (await browser.newContext()).newPage();
    pages.push(own);
    await seedSession(own.context(), owner);
    await openPage(own, link.url);
    await frame(own).getByRole("button", { name: "Sign up" }).click();
    await expect(frame(own).locator("#signups")).toHaveText("Ana Owner");
    const anon = await (await browser.newContext()).newPage();
    pages.push(anon);
    await openPage(anon, link.url);
    await expect(frame(anon).locator("#me")).toHaveText("anonymous");
    await expect(frame(anon).locator("#people-error")).toHaveText("unavailable");
    await expect(frame(anon).locator("#signups")).toHaveText("someone");
    await expect(frame(anon).locator("body")).not.toContainText("Ana Owner");
    await expect(frame(anon).locator("body")).not.toContainText("@");
    await expect(frame(anon).getByRole("button", { name: "Sign up" })).toBeDisabled();
    await expect(notice(anon)).not.toContainText("who has access");
  } finally {
    for (const p of pages) await p.context().close();
  }
});

test("a live room labels a peer's cursor with their name", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("room-name-owner");
  const guest = uniqueEmail("room-name-guest");
  const { token } = await seedToken(owner, { label: "Board agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Team whiteboard",
    html: readFileSync(path.join(ROOT, "docs/examples/whiteboard.html"), "utf8"),
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: guest, role: "commenter" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  await seedSession(page.context(), owner);
  const named = await apiPatch(page.request, "/me", { name: "Ana Owner" });
  expect(named.status, JSON.stringify(named.body)).toBe(200);

  const open = async (p: Page) => {
    await p.goto(`/a/${art.slug}`);
    await expect(frame(p).locator("body")).toHaveAttribute("data-room", "open", {
      timeout: 15_000,
    });
  };
  await open(page);
  const other = await (await browser.newContext()).newPage();
  try {
    await seedSession(other.context(), guest);
    await open(other);
    await expect(frame(other).locator("#peers")).toContainText("Ana Owner");
    const area = await frame(page).locator("#viewport").boundingBox();
    if (!area) throw new Error("no board area");
    await page.mouse.move(area.x + 20, area.y + 20);
    await page.mouse.move(area.x + 30, area.y + 26, { steps: 3 });
    await expect(frame(other).locator(".cursor span").filter({ hasText: "Ana Owner" })).toHaveCount(
      1,
      { timeout: 10_000 },
    );
    // The guest has no name: the owner sees their email, as before.
    await expect(frame(page).locator("#peers")).toContainText(guest);
  } finally {
    await other.context().close();
  }
});
