import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLINTH_E2E_PORT ?? 8787);
const APP_ORIGIN = `http://app.localhost:${PORT}`;
// A second Worker with CONTENT_ISOLATION=opaque, for the "opaque" project (support/api.ts).
const OPAQUE_PORT = Number(process.env.PLINTH_E2E_OPAQUE_PORT ?? PORT + 100);
const OPAQUE_ORIGIN = `http://app.localhost:${OPAQUE_PORT}`;
/** Tests that need the opaque-isolation Worker; every other project skips them. */
const OPAQUE_SPECS = /opaque\.spec\.ts$/;

const server = (port: number, env: Record<string, string> = {}) => ({
  // Builds the web app if needed, wipes the server's state dir, migrates it, runs wrangler dev.
  command: `"${process.execPath}" support/server.ts`,
  url: `http://app.localhost:${port}/healthz`,
  env: { PLINTH_E2E_PORT: String(port), ...env },
  // Never reuse a running `pnpm dev`: tests seed the e2e state directly.
  reuseExistingServer: false,
  timeout: 180_000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
});

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  // One Worker and one database serve every test; keep the load modest.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "light",
      testIgnore: OPAQUE_SPECS,
      use: { ...devices["Desktop Chrome"], colorScheme: "light" },
    },
    {
      name: "dark",
      testIgnore: OPAQUE_SPECS,
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
    {
      name: "mobile",
      testIgnore: OPAQUE_SPECS,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
      },
    },
    {
      // CONTENT_ISOLATION=opaque: artifacts with an opaque origin (staging's mode, and any
      // instance whose content subdomain is not yet on the Public Suffix List). Chromium only.
      name: "opaque",
      testMatch: OPAQUE_SPECS,
      use: { ...devices["Desktop Chrome"], colorScheme: "light", baseURL: OPAQUE_ORIGIN },
    },
  ],
  webServer: [server(PORT), server(OPAQUE_PORT, { PLINTH_E2E_CONTENT_ISOLATION: "opaque" })],
});
