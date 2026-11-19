// Dictation and text to speech under opaque content isolation (CONTENT_ISOLATION=opaque, the
// second e2e Worker, which also runs with ALLOW_DICTATION=true): dictation is off, the app keeps
// microphone=(), the page learns opaque_isolation without a message, and speechSynthesis still
// works after a click.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { artifactFrame, fakeRecognizer, SPEAK_PAGE, voicePage } from "../support/voice.ts";

const FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

async function publish(email: string, title: string, html: string) {
  const { token } = await seedToken(email, {
    label: "Opaque voice agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, html }),
  });
  const art = (await res.json()) as { slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  return art;
}

test("dictation is unavailable under opaque isolation, and the app keeps the microphone off", async ({
  page,
}) => {
  const email = uniqueEmail("opaque-voice");
  const art = await publish(email, "Voice notes", voicePage());
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  await fakeRecognizer(page, OPAQUE_APP_ORIGIN);
  const res = await page.goto(`/a/${art.slug}`);
  expect(res?.headers()["permissions-policy"]).toContain("microphone=()");
  const frame = await artifactFrame(page, "data-ready");
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  await expect(page.frameLocator(FRAME).locator("#ready")).toHaveText("opaque_isolation");
  await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
  await expect(page.frameLocator(FRAME).locator("#result")).toHaveText("unavailable");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("speechSynthesis works in an opaque frame after a click", async ({ page }) => {
  const email = uniqueEmail("opaque-tts");
  const art = await publish(email, "Speak", SPEAK_PAGE);
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  await page.goto(`/a/${art.slug}`);
  const frame = await artifactFrame(page, "data-onload");
  expect(await frame.evaluate(() => document.body.dataset.onload)).toBe("error:not-allowed");
  await page.frameLocator(FRAME).getByRole("button", { name: "Read aloud" }).click();
  await page.frameLocator(FRAME).locator("body[data-clicked]").waitFor({ timeout: 10_000 });
  expect(await frame.evaluate(() => document.body.dataset.clicked)).not.toBe("error:not-allowed");
});
