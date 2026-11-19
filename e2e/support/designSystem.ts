// The design system fixture the Worker tests use (apps/worker/test/fixtures/design-systems/acme.json),
// with real image and font bytes, for the design system specs.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ROOT } from "./paths.ts";

export const ACME = JSON.parse(
  readFileSync(
    path.join(ROOT, "apps", "worker", "test", "fixtures", "design-systems", "acme.json"),
    "utf8",
  ),
) as Record<string, any>;

/** A 1x1 PNG: the Card example shows it as img/logo.png. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const ACME_ASSETS = [
  { path: "img/logo.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
  // Not a real font: enough for the file to exist, which is all these tests need.
  { path: "fonts/acme-mono.woff2", content: "d09GMgABAAAAAA==", encoding: "base64" },
];

/** The fixture with a change, as JSON text. */
export function acmeWith(f: (ds: Record<string, any>) => void = () => undefined): string {
  const ds = JSON.parse(JSON.stringify(ACME));
  f(ds);
  return JSON.stringify(ds, null, 2);
}

/**
 * Answer Google Fonts requests locally, so the specs never reach the internet. The design system's
 * font link is allowed by the content CSP; this only keeps tests offline and fast.
 */
export async function stubGoogleFonts(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route("https://fonts.googleapis.com/**", (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
  return asked;
}
