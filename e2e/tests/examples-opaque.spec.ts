// The example pages for invited people under opaque content isolation (CONTENT_ISOLATION=opaque,
// the second e2e Worker): shared data is off there, so each page must show its static part, say in
// its banner that saving is not available, keep its inputs disabled and throw nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ROOT } from "../support/paths.ts";
import { CURRENT_FRAME, readyFrame } from "../support/viewer.ts";

const EXAMPLES = [
  { file: "approval-signoff.html", heading: "Website redesign proposal", input: "#approve" },
  { file: "intake-form.html", heading: "Tell us about your project", input: "#f-company" },
  { file: "client-checklist.html", heading: "Website launch", input: "#i-brand-assets" },
];

for (const ex of EXAMPLES) {
  test(`${ex.file} on an opaque instance says saving is off`, async ({ page }) => {
    const email = uniqueEmail("opaque-example");
    const { token } = await seedToken(email, {
      label: "Opaque agent",
      clientType: "claude",
      origin: OPAQUE_APP_ORIGIN,
    });
    const html = readFileSync(path.join(ROOT, "docs/examples", ex.file), "utf8");
    const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: ex.file, html }),
    });
    const art = (await res.json()) as { slug: string };
    expect(res.status, JSON.stringify(art)).toBe(201);
    await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const apiCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/__plinth/api")) apiCalls.push(r.url());
    });

    await page.goto(`/a/${art.slug}`);
    const frame = await readyFrame(page);
    expect(await frame.evaluate(() => self.origin)).toBe("null");
    const inFrame = page.frameLocator(CURRENT_FRAME);
    await expect(inFrame.locator("body")).toHaveAttribute("data-reason", "opaque_isolation");
    await expect(inFrame.locator("body")).toHaveAttribute("data-can-write", "false");
    await expect(inFrame.locator("h1")).toHaveText(ex.heading);
    await expect(inFrame.locator("#banner")).toContainText("not available on this server");
    await expect(inFrame.locator(ex.input)).toBeDisabled();
    expect(apiCalls).toEqual([]);
    expect(errors).toEqual([]);
  });
}
