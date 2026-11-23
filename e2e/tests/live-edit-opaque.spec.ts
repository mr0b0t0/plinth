// On-page editing and live rooms under opaque content isolation (#36): artifact documents have an
// opaque origin and no cookies, so neither exists there. A doc's owner gets no Edit toggle (only
// the source editor, still called "Edit"), and a page that declares `room` is told why at once:
// plinth.room.ready resolves "opaque_isolation" without any request.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const ROOM_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="plinth-capabilities" content="room"><title>Board</title>
<script src="/__plinth/runtime.js"></script></head>
<body><h1>Board</h1><p id="out">waiting</p>
<script>
plinth.room.ready.then(function (r) {
  document.getElementById("out").textContent = r.available ? "live" : r.reason;
});
</script></body></html>`;

async function publish(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const art = (await res.json()) as { slug: string; id: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  return art;
}

test("no on-page editing of a doc, and rooms report opaque_isolation without a request", async ({
  page,
}) => {
  const email = uniqueEmail("opaque-live");
  const { token } = await seedToken(email, { origin: OPAQUE_APP_ORIGIN });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);

  const doc = await publish(token, { title: "Plan", type: "doc", content: "# Plan\n\nText.\n" });
  await page.goto(`/a/${doc.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("Plan", {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  // No frame key either: nothing on the page is an editing channel.
  expect(await page.locator(CURRENT_FRAME).getAttribute("src")).not.toContain("#plinth-k=");
  // The page is just read-only: no source editor item (people never see source) and no edit
  // entry, nor a save status.
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Edit on the page" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Editing on the page" })).toHaveCount(0);

  const roomCalls: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/__plinth/room/") || u.includes("/__plinth/api/v1/room")) roomCalls.push(u);
  });
  const board = await publish(token, { title: "Board", html: ROOM_PAGE });
  await page.goto(`/a/${board.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("#out")).toHaveText("opaque_isolation", {
    timeout: 15_000,
  });
  expect(roomCalls).toEqual([]);
});
