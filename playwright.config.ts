import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
  },
  webServer: {
    command: "PORT=3100 pnpm dev:full",
    url: "http://localhost:3100",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
