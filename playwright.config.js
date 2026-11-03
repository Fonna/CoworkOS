import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  reporter: "list"
});
