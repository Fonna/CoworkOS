import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    ...(process.env.COWORK_TEST_BROWSER_CHANNEL ? { channel: process.env.COWORK_TEST_BROWSER_CHANNEL } : {}),
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure"
  },
  reporter: "list"
});
