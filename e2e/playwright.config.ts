import { defineConfig, devices } from "@playwright/test";

const APP_ORIGIN = `http://app.localhost:${process.env.PLINTH_E2E_PORT ?? 8787}`;

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
    { name: "light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
    { name: "dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
      },
    },
  ],
  webServer: {
    // Builds the web app if needed, wipes e2e/.wrangler-state, migrates it, runs wrangler dev.
    command: `"${process.execPath}" support/server.ts`,
    url: `${APP_ORIGIN}/healthz`,
    // Never reuse a running `pnpm dev`: tests seed e2e/.wrangler-state directly.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
