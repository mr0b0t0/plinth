// A multiplayer page with plinth.room (#36): the example whiteboard (docs/examples/whiteboard.html)
// open in three contexts. One person's cursor shows in the other's board, a note a commenter drags
// moves in the owner's board before it is dropped, the dropped position is saved in shared data and
// survives a reload, a person with view access joins the room read-only (they never emit, but their
// cursor shows and the board follows the others live), removing the grants closes their sockets and
// ends in plinth:expired, and an anonymous link viewer gets the board read-only without the room.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type FrameLocator, type Page, test } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ROOT } from "../support/paths.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const WHITEBOARD = readFileSync(path.join(ROOT, "docs/examples/whiteboard.html"), "utf8");

const board = (page: Page): FrameLocator => page.frameLocator(CURRENT_FRAME);

async function open(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(board(page).locator("h1")).toHaveText("Team whiteboard", { timeout: 15_000 });
}

async function signedIn(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await open(page, slug);
  await expect(board(page).locator("body")).toHaveAttribute("data-room", "open", {
    timeout: 15_000,
  });
  return page;
}

const left = (page: Page) =>
  board(page)
    .locator(".note")
    .first()
    .evaluate((el) => Number.parseInt((el as HTMLElement).style.left, 10));

test("a shared whiteboard: live cursors, a note moving as it is dragged, saved on drop", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("board-owner");
  const guest = uniqueEmail("board-guest");
  const watcher = uniqueEmail("board-watcher");
  const { token } = await seedToken(owner, { label: "Board agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Team whiteboard",
    html: WHITEBOARD,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    {
      grants: [
        { email: guest, role: "commenter" },
        { email: watcher, role: "viewer" },
      ],
    },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  await signedIn(browser, owner, art.slug, page);
  const other = await signedIn(browser, guest, art.slug);
  const viewer = await signedIn(browser, watcher, art.slug);
  try {
    // Both see each other in the people list (emails, because the page declares viewer).
    await expect(board(page).locator("#peers")).toContainText(guest);
    await expect(board(other).locator("#peers")).toContainText(owner);
    await expect(board(page).locator("#banner")).toHaveText("");
    await expect(board(other).locator("#banner")).toHaveText("");
    // A viewer joins the room but may not emit, so their board is read-only.
    await expect(board(viewer).locator("#peers")).toContainText(owner);
    await expect(board(viewer).locator("#banner")).toHaveText(
      "You can view this board and see who is here. Only people who can comment or edit can change it.",
    );
    await expect(board(viewer).getByRole("button", { name: "Add note" })).toBeDisabled();

    // The owner adds a note; the guest's board picks it up from the note.saved event.
    await board(page).getByRole("button", { name: "Add note" }).click();
    await board(page).getByLabel("Note text").fill("Ship the beta");
    await expect(board(other).locator(".note")).toHaveCount(1, { timeout: 10_000 });
    await expect(board(other).getByLabel("Note text")).toHaveValue("Ship the beta", {
      timeout: 10_000,
    });

    // The owner's cursor shows on the guest's board, labelled with the owner's email.
    const area = await board(page).locator("#viewport").boundingBox();
    if (!area) throw new Error("no board area");
    await page.mouse.move(area.x + 20, area.y + 20);
    await page.mouse.move(area.x + 30, area.y + 26, { steps: 3 });
    await expect(board(other).locator(".cursor span").filter({ hasText: owner })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(board(viewer).getByLabel("Note text")).toHaveValue("Ship the beta", {
      timeout: 10_000,
    });
    await expect(board(viewer).getByLabel("Note text")).toHaveJSProperty("readOnly", true);
    await expect(board(viewer).locator(".note .grip")).toBeDisabled();

    // The viewer's cursor is presence, which they may set: the owner sees it.
    const seen = await board(viewer).locator("#viewport").boundingBox();
    if (!seen) throw new Error("no board area");
    await viewer.mouse.move(seen.x + 40, seen.y + 40);
    await viewer.mouse.move(seen.x + 50, seen.y + 46, { steps: 3 });
    await expect(board(page).locator(".cursor span").filter({ hasText: watcher })).toHaveCount(1, {
      timeout: 10_000,
    });

    // The guest (a commenter) drags the note; the owner and the viewer see it move before the drop.
    const start = await left(other);
    const grip = await board(other).locator(".note .grip").first().boundingBox();
    if (!grip) throw new Error("no grip");
    const gx = grip.x + grip.width / 2;
    const gy = grip.y + grip.height / 2;
    await other.mouse.move(gx, gy);
    await other.mouse.down();
    await other.mouse.move(gx + 30, gy + 20, { steps: 4 });
    await other.mouse.move(gx + 60, gy + 40, { steps: 4 });
    await expect.poll(() => left(page), { timeout: 10_000 }).not.toBe(start);
    await expect.poll(() => left(viewer), { timeout: 10_000 }).not.toBe(start);
    await other.mouse.up();
    const dropped = await left(other);
    expect(dropped).toBeGreaterThan(start);
    await expect.poll(() => left(page), { timeout: 10_000 }).toBe(dropped);

    // The drop was saved: a reload (a late joiner) reads the position from shared data.
    await expect
      .poll(
        async () => {
          await page.reload();
          await expect(board(page).locator(".note")).toHaveCount(1, { timeout: 10_000 });
          return left(page);
        },
        { timeout: 20_000 },
      )
      .toBe(dropped);

    // Removing the grants closes their sockets; the pages hear plinth:expired.
    const removed = await apiPut(
      page.request,
      `/artifacts/${art.id}/sharing`,
      { grants: [] },
      { token },
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await expect(board(other).locator("body")).toHaveAttribute("data-expired", "true", {
      timeout: 20_000,
    });
    await expect(board(other).locator("#banner")).toHaveText(
      "Your access changed. Reload the page.",
    );
    await expect(board(other).getByRole("button", { name: "Add note" })).toBeDisabled();
    await expect(board(viewer).locator("body")).toHaveAttribute("data-expired", "true", {
      timeout: 20_000,
    });

    // An anonymous link viewer sees the board read-only, without the room.
    const unlisted = await apiPut(
      page.request,
      `/artifacts/${art.id}/visibility`,
      { visibility: "unlisted" },
      { token },
    );
    expect(unlisted.status, JSON.stringify(unlisted.body)).toBe(200);
    const anon = await (await browser.newContext()).newPage();
    try {
      await open(anon, art.slug);
      await expect(board(anon).locator("body")).toHaveAttribute(
        "data-room-reason",
        "not_identified",
        {
          timeout: 15_000,
        },
      );
      await expect(board(anon).locator("#banner")).toContainText(
        "You can view this board. Only people it is shared with can change it.",
      );
      await expect(board(anon).locator("#banner")).toContainText("Live cursors are off here");
      await expect(board(anon).locator(".note")).toHaveCount(1);
      await expect(board(anon).getByRole("button", { name: "Add note" })).toBeDisabled();
      await expect(board(anon).locator("#peers")).not.toContainText("@");
    } finally {
      await anon.context().close();
    }
  } finally {
    await other.context().close();
    await viewer.context().close();
  }
});
