// Files people add to a page under opaque content isolation (CONTENT_ISOLATION=opaque, the second
// e2e Worker, which runs with ALLOW_FILES=true): artifact documents have an opaque origin and no
// cookies, so the file store is off. The gallery says so cleanly: plinth.files.ready resolves
// opaque_isolation without any request, the app's notice says files are not available, and the
// page still renders without errors.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { GALLERY_HTML, GALLERY_TITLE } from "../support/files.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

test("a gallery on an opaque instance reports files unavailable and still renders", async ({
  page,
}) => {
  const email = uniqueEmail("opaque-gallery");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: GALLERY_TITLE, html: GALLERY_HTML }),
  });
  const art = (await res.json()) as { slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/api") || r.url().includes("/__plinth/files")) {
      apiCalls.push(r.url());
    }
  });

  await page.goto(`/a/${art.slug}`);
  const frame = await readyFrame(page);
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  const ready = await frame.evaluate(() => (window as any).plinth.files.ready);
  expect(ready).toEqual({
    available: false,
    reason: "opaque_isolation",
    canUpload: false,
    accept: [],
    limits: null,
    usage: null,
  });
  const inFrame = page.frameLocator(CURRENT_FRAME);
  await expect(inFrame.locator("body")).toHaveAttribute("data-reason", "opaque_isolation");
  await expect(inFrame.locator("#status")).toHaveText("Photos are not available here.");
  await expect(inFrame.locator("#pick")).toBeDisabled();
  await expect(page.getByRole("main").getByRole("note")).toHaveText(
    "Files people add are not available on this server.",
  );
  // An upload fails cleanly, still without a request.
  expect(
    await frame.evaluate(() =>
      (window as any).plinth.files
        .upload(new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }))
        .then(
          () => "ok",
          (e: { code: string }) => e.code,
        ),
    ),
  ).toBe("unavailable");
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});
