// Dictation run by the app (docs/spec.md "Voice: dictation and text to speech"), on the e2e Worker
// with ALLOW_DICTATION=true and origin isolation. The artifact frame never gets the microphone,
// even with a microphone grant for the app's origin; the app runs a (fake) recognizer after the
// viewer's click and consent, the page receives only words, and the viewer can always stop it.
import { expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import {
  artifactFrame,
  fakeRecognizer,
  MIC_PROBE_PAGE,
  SLOW_IMAGE,
  VOICE_TITLE,
  voicePage,
} from "../support/voice.ts";

const FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const consent = (page: Page) => page.getByRole("dialog", { name: "Allow dictation on this page?" });
const inFrame = (page: Page, id: string) => page.frameLocator(FRAME).locator(`#${id}`);

async function owner(page: Page, html: string, visibility = "allowlist") {
  const email = uniqueEmail("voice-owner");
  const { token } = await seedToken(email, { label: "Voice agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, { title: VOICE_TITLE, html, visibility });
  return { email, art };
}

// A fake audio device, so getUserMedia can succeed where the policy allows it (the app).
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

test.describe("with a microphone", () => {
  test("the artifact frame never gets it, even with a grant for the app", async ({
    page,
    context,
  }) => {
    const { email, art } = await owner(page, MIC_PROBE_PAGE);
    await context.grantPermissions(["microphone"], { origin: APP_ORIGIN });
    await seedSession(context, email);
    const res = await page.goto(art.url);
    // The app's own ceiling allows the microphone to the app's origin only, and the app gets it.
    expect(res?.headers()["permissions-policy"]).toContain("microphone=(self)");
    const app = await page.evaluate(async () => {
      const p = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } })
        .featurePolicy;
      let gum: string;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of s.getTracks()) t.stop();
        gum = "granted";
      } catch (e) {
        gum = (e as Error).name;
      }
      return { policy: p ? p.allowsFeature("microphone") : null, gum };
    });
    expect(app).toEqual({ policy: app.policy === null ? null : true, gum: "granted" });
    // The frame, with the same grant in the same browser: refused, and no recognizer hears it.
    const frame = await artifactFrame(page, "data-policy");
    const framePolicy = await frame.evaluate(() => document.body.dataset.policy);
    expect(framePolicy).toBe(app.policy === null ? "none" : "false");
    await page.frameLocator(FRAME).getByRole("button", { name: "Probe" }).click();
    await page.frameLocator(FRAME).locator("body[data-probe]").waitFor({ timeout: 10_000 });
    const probe = JSON.parse((await frame.evaluate(() => document.body.dataset.probe)) ?? "{}");
    expect(probe.gum).toBe("NotAllowedError");
    expect(probe.rec).not.toBe("audiostart");
  });
});

test("dictation: ask, listen, words to the page, Stop, and no second question", async ({
  page,
}) => {
  const { email, art } = await owner(page, voicePage());
  await seedSession(page.context(), email);
  await fakeRecognizer(page, APP_ORIGIN);
  await page.goto(art.url);
  await artifactFrame(page, "data-ready");
  await expect(inFrame(page, "ready")).toHaveText("available");
  await expect(consent(page)).toHaveCount(0);

  await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
  const dialog = consent(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(VOICE_TITLE);
  // The owner by email, fetched when the dialog opens (the gate never carries it).
  await expect(dialog).toContainText(`by ${email}`);
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeFocused();
  await page.waitForTimeout(600);
  await dialog.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(inFrame(page, "result")).toHaveText("started");
  await expect(inFrame(page, "final")).toHaveText("hello world");
  const listening = page.locator(".pl-viewer__listening");
  await expect(listening.getByRole("status")).toHaveText("Listening");
  await listening.getByRole("button", { name: "Stop dictation" }).click();
  await expect(inFrame(page, "state")).toHaveText("idle:viewer_stopped");
  await expect(listening.getByRole("status")).toHaveText("");

  // The consent is kept for this page in this browser: a new load starts without the dialog.
  await page.reload();
  await artifactFrame(page, "data-ready");
  await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
  await expect(inFrame(page, "result")).toHaveText("started");
  await expect(consent(page)).toHaveCount(0);
  await expect(inFrame(page, "final")).toHaveText("hello world");
});

/**
 * The viewer allowed dictation on this artifact in this browser before (no dialog). The consent
 * is bound to the viewer's id on the page, which the gate gives the signed-in viewer.
 */
async function allowed(page: Page, artifactId: string) {
  const gate = await page.request.get(`${APP_ORIGIN}/api/v1/view/${artifactId}`);
  const viewer = (await gate.json()).voice?.viewer_id as string | undefined;
  expect(viewer).toMatch(/^u_/);
  await page.addInitScript(
    ([origin, key, value]) => {
      if (location.origin === origin) localStorage.setItem(key, value);
    },
    [APP_ORIGIN, `plinth:dictation:${artifactId}`, viewer ?? ""] as const,
  );
}

test("switching to another window with focus inside the page stops dictation", async ({ page }) => {
  const { email, art } = await owner(page, voicePage());
  await seedSession(page.context(), email);
  await fakeRecognizer(page, APP_ORIGIN);
  await allowed(page, art.id);
  await page.goto(art.url);
  await artifactFrame(page, "data-ready");
  await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
  await expect(inFrame(page, "final")).toHaveText("hello world");
  await expect(inFrame(page, "state")).toHaveText("listening");
  const listening = page.locator(".pl-viewer__listening");
  await expect(listening.getByRole("status")).toHaveText("Listening");
  // Focus is inside the frame, so a switch to another app blurs only the frame's window and the
  // app document gets no event; all it can see is that it no longer has focus.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
  await page.evaluate(() => {
    document.hasFocus = () => false;
  });
  await expect(inFrame(page, "state")).toHaveText("idle:blurred");
  await expect(listening.getByRole("status")).toHaveText("");
});

test("the page finishing its own load does not stop a dictation started before it", async ({
  page,
}) => {
  const { email, art } = await owner(page, voicePage({ slowImage: true }));
  await seedSession(page.context(), email);
  await fakeRecognizer(page, APP_ORIGIN);
  await allowed(page, art.id);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/${SLOW_IMAGE}`, async (route) => {
    await held;
    // A 1x1 transparent GIF.
    await route.fulfill({
      status: 200,
      contentType: "image/gif",
      body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    });
  });
  await page.goto(art.url);
  const frame = await artifactFrame(page, "data-ready");
  expect(await frame.evaluate(() => document.readyState)).not.toBe("complete");
  await expect(inFrame(page, "ready")).toHaveText("available");
  await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
  await expect(inFrame(page, "result")).toHaveText("started");
  await expect(inFrame(page, "state")).toHaveText("listening");
  release();
  await expect.poll(() => frame.evaluate(() => document.readyState)).toBe("complete");
  await page.waitForTimeout(300);
  await expect(inFrame(page, "state")).toHaveText("listening");
  await expect(page.locator(".pl-viewer__listening").getByRole("status")).toHaveText("Listening");
  // A real reload of the frame still ends it.
  await frame.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await expect(page.locator(".pl-viewer__listening").getByRole("status")).toHaveText("");
});

/**
 * The page asks (its `hello`) as its script runs, often before the app has its own config and
 * session. The app answers from the gate's voice part instead of missing the hello, which left the
 * page with no_host (and every start unavailable) for the whole load.
 */
test("a page that asks before the app has its config is answered from the gate", async ({
  page,
}) => {
  const { email, art } = await owner(page, voicePage());
  await seedSession(page.context(), email);
  await fakeRecognizer(page, APP_ORIGIN);
  await allowed(page, art.id);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${APP_ORIGIN}/api/v1/config`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(art.url);
    await artifactFrame(page, "data-ready");
    await expect(inFrame(page, "ready")).toHaveText("available");
    await page.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
    await expect(inFrame(page, "result")).toHaveText("started");
    await expect(inFrame(page, "final")).toHaveText("hello world");
    // The config arriving later changes nothing: the dictation goes on, and Stop still ends it.
    const me = page.waitForResponse(`${APP_ORIGIN}/api/v1/me`);
    release();
    await me;
    await expect(inFrame(page, "state")).toHaveText("listening");
    const listening = page.locator(".pl-viewer__listening");
    await expect(listening.getByRole("status")).toHaveText("Listening");
    await listening.getByRole("button", { name: "Stop dictation" }).click();
    await expect(inFrame(page, "state")).toHaveText("idle:viewer_stopped");
  } finally {
    release();
  }
});

test("a start without a click is refused and opens no dialog", async ({ page }) => {
  const { email, art } = await owner(page, voicePage({ auto: true }));
  await seedSession(page.context(), email);
  await fakeRecognizer(page, APP_ORIGIN);
  await page.goto(art.url);
  await artifactFrame(page, "data-ready");
  await expect(inFrame(page, "result")).toHaveText("no_activation");
  await expect(consent(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __recognizers?: number }).__recognizers)).toBe(
    undefined,
  );
});

test("an anonymous viewer of a link is not offered dictation", async ({ page, browser }) => {
  const { art } = await owner(page, voicePage(), "unlisted");
  const ctx = await browser.newContext();
  try {
    const anon = await ctx.newPage();
    await fakeRecognizer(anon, APP_ORIGIN);
    await anon.goto(art.url);
    await artifactFrame(anon, "data-ready");
    await expect(inFrame(anon, "ready")).toHaveText("not_identified");
    await anon.frameLocator(FRAME).getByRole("button", { name: "Speak" }).click();
    await expect(inFrame(anon, "result")).toHaveText("unavailable");
    await expect(consent(anon)).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
