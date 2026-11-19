// Text to speech (docs/spec.md "Voice: dictation and text to speech"): the browser's own
// speechSynthesis works in every artifact frame, and nothing in Plinth's headers turns it off. The
// browser refuses to speak before the viewer's first click (not-allowed); after a click it speaks,
// or, on a host without voices, fails for that reason and never with not-allowed.
import { expect, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { artifactFrame, SPEAK_PAGE } from "../support/voice.ts";

const FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

test("speechSynthesis needs a click in the frame, then is not refused", async ({ page }) => {
  const email = uniqueEmail("tts-owner");
  const { token } = await seedToken(email, { label: "TTS agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, { title: "Speak", html: SPEAK_PAGE });
  await seedSession(page.context(), email);
  await page.goto(art.url);
  const frame = await artifactFrame(page, "data-onload");
  const before = await frame.evaluate(() => document.body.dataset.onload);
  // Chromium refuses a speak() before the frame has had a click.
  expect(before).toBe("error:not-allowed");
  await page.frameLocator(FRAME).getByRole("button", { name: "Read aloud" }).click();
  await page.frameLocator(FRAME).locator("body[data-clicked]").waitFor({ timeout: 10_000 });
  const after = await frame.evaluate(() => document.body.dataset.clicked);
  expect(after).not.toBe("error:not-allowed");
});
