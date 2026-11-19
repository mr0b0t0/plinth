// Files people add to a page, end to end (docs/spec.md "Files people add to a page"): an invited
// viewer adds a photo, which renders in the frame and reaches the owner's
// open page; markup is refused; a 12 MiB video goes up in three parts and serves byte ranges; an
// anonymous link viewer sees the files but cannot add any; the owner deletes one from the Share
// dialog; a takedown makes the file URLs 404.
import { expect, type Frame, type Page, test } from "@playwright/test";
import { apiPost, contentOrigin, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { GALLERY_HTML, GALLERY_TITLE, mp4Bytes, PNG_1X1 } from "../support/files.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const ADMIN = "admin@plinth.local";
/** Changes made elsewhere arrive on the next poll (15 s): wait up to three of them. */
const POLL_WAIT = 45_000;

interface Published {
  id: string;
  slug: string;
  url: string;
}

const isMobile = () => test.info().project.name === "mobile";
const inFrame = (page: Page) => page.frameLocator(CURRENT_FRAME);
const items = (page: Page) => inFrame(page).locator("#list li");
const notice = (page: Page) => page.getByRole("main").getByRole("note");

async function choose(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await inFrame(page).locator("#pick").setInputFiles({ name, mimeType, buffer });
}

async function openShareDialog(page: Page) {
  if (isMobile()) {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
  } else {
    await page.getByRole("button", { name: "Share" }).click();
  }
  return page.getByRole("dialog", { name: "Share this artifact" });
}

const statusOf = (frame: Frame) =>
  frame.evaluate(() => {
    const s = document.getElementById("status") as HTMLElement;
    return { text: s.textContent, error: s.dataset.error ?? null };
  });

test("people add photos and video to a page, the owner moderates, a takedown removes them", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const owner = uniqueEmail("gallery-owner");
  const viewer = uniqueEmail("gallery-viewer");
  const { token } = await seedToken(owner, { label: "Gallery agent", clientType: "claude" });
  const client = await mcpClient(token);
  const pages: Page[] = [];
  try {
    // 1. The owner's agent publishes the gallery for one person; the owner keeps it open.
    const pub = await tool<Published>(client, "publish_artifact", {
      title: GALLERY_TITLE,
      html: GALLERY_HTML,
      visibility: "allowlist",
      emails: [viewer],
    });
    expect(pub.isError, pub.text).toBe(false);
    const art = pub.data;
    await seedSession(page.context(), owner);
    await page.goto(art.url);
    await readyFrame(page);
    await expect(inFrame(page).locator("body")).toHaveAttribute("data-can-upload", "true");
    await expect(notice(page)).toHaveText(
      "This page keeps files people add. People with access can see them and who added them. Files are kept as added, with any details saved inside them, such as where and when a photo was taken.",
    );

    // 2. The invited viewer, signed in, adds a photo; it renders inside the frame. (Signed in
    // rather than confirmed by code: viewer codes share one per-address budget across the suite.)
    const viewerCtx = await browser.newContext();
    await seedSession(viewerCtx, viewer);
    const pageV = await viewerCtx.newPage();
    await pageV.goto(art.url);
    pages.push(pageV);
    const frameV = await readyFrame(pageV);
    await choose(pageV, "photo.png", "image/png", PNG_1X1);
    await expect(inFrame(pageV).locator("#status")).toHaveText("Added photo.png");
    await expect(items(pageV)).toHaveCount(1);
    await expect(inFrame(pageV).locator("#list .name")).toHaveText(`photo.png by ${viewer}`);
    await expect
      .poll(() =>
        frameV.evaluate(
          () => (document.querySelector("#list img") as HTMLImageElement | null)?.naturalWidth,
        ),
      )
      .toBe(1);

    // 3. The owner's open page shows it after a poll.
    await expect(items(page)).toHaveCount(1, { timeout: POLL_WAIT });

    // 4. Markup never goes up: SVG and HTML are refused before an upload starts, and bytes that
    // do not prove the declared type are refused by the server.
    await choose(
      pageV,
      "logo.svg",
      "image/svg+xml",
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    );
    await expect.poll(async () => (await statusOf(frameV)).error).toBe("unsupported_type");
    await choose(pageV, "page.html", "text/html", Buffer.from("<script>alert(1)</script>"));
    await expect.poll(async () => (await statusOf(frameV)).error).toBe("unsupported_type");
    await choose(pageV, "fake.png", "image/png", Buffer.from("<!doctype html><script>1</script>"));
    await expect.poll(async () => (await statusOf(frameV)).error).toBe("type_mismatch");
    await expect(items(pageV)).toHaveCount(1);

    // 5. A 12 MiB video goes up in three parts with progress, and serves byte ranges.
    const size = 12 * 1024 * 1024;
    await choose(pageV, "clip.mp4", "video/mp4", mp4Bytes(size));
    await expect(inFrame(pageV).locator("#status")).toHaveText("Added clip.mp4", {
      timeout: 60_000,
    });
    await expect(inFrame(pageV).locator("body")).toHaveAttribute(
      "data-progress",
      `${size}/${size}`,
    );
    const videoId = await inFrame(pageV)
      .locator('#list li[data-type="video/mp4"]')
      .getAttribute("data-id");
    expect(videoId).toMatch(/^[a-z0-9]{20}$/);
    const range = await frameV.evaluate(async (id) => {
      const r = await fetch(`/__plinth/files/${id}`, { headers: { Range: "bytes=0-11" } });
      return {
        status: r.status,
        range: r.headers.get("content-range"),
        type: r.headers.get("content-type"),
        bytes: [...new Uint8Array(await r.arrayBuffer())],
      };
    }, videoId);
    expect(range).toEqual({
      status: 206,
      range: `bytes 0-11/${size}`,
      type: "video/mp4",
      bytes: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
    });

    // The agent sees both files, with their uploader, and never the bytes.
    const listed = await tool<{
      files: { id: string; name: string; uploaded_by: { email: string } }[];
    }>(client, "list_artifact_files", { id: art.id });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.files.map((f) => f.name)).toEqual(["photo.png", "clip.mp4"]);
    expect(listed.data.files.every((f) => f.uploaded_by.email === viewer)).toBe(true);

    // 6. Unlisted: an anonymous link viewer sees the files but cannot add any.
    const unlisted = await tool(client, "set_visibility", { id: art.id, visibility: "unlisted" });
    expect(unlisted.isError, unlisted.text).toBe(false);
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    pages.push(anon);
    await anon.goto(art.url);
    await readyFrame(anon);
    await expect(inFrame(anon).locator("body")).toHaveAttribute("data-can-upload", "false");
    await expect(items(anon)).toHaveCount(2);
    await expect(inFrame(anon).locator("#list .name").first()).toHaveText("photo.png");
    await expect(notice(anon)).toHaveText(
      "This page shows files added by people it is shared with.",
    );

    // 7. The owner deletes the photo from the Share dialog; the open page drops it.
    await page.reload();
    await readyFrame(page);
    await expect(items(page)).toHaveCount(2);
    const dialog = await openShareDialog(page);
    await expect(dialog.getByText("Uploaded files: 2 files")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete photo.png" }).click();
    await expect(page.getByText("File deleted")).toBeVisible();
    await expect(dialog.getByText("Uploaded files: 1 file")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(items(anon)).toHaveCount(1, { timeout: POLL_WAIT });

    // 8. A takedown: the file URLs answer 404.
    const report = await apiPost<{ id: string }>(request, `/artifacts/${art.slug}/report`, {
      reason: "Checking that a takedown removes the files people added.",
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
    const gone = await request.get(`${contentOrigin(art.id)}/__plinth/files/${videoId}`, {
      headers: { "sec-fetch-dest": "video" },
    });
    expect(gone.status()).toBe(404);
  } finally {
    for (const p of pages) await p.context().close();
    await client.close();
  }
});
