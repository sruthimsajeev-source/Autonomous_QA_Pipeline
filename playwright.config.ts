import { defineConfig } from "@playwright/test";

const workersFromEnv = process.env.PLAYWRIGHT_WORKERS;
const workers = workersFromEnv ? Number(workersFromEnv) : 2;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 1,
  fullyParallel: false,
  workers: Number.isNaN(workers) ? 1 : workers,
  reporter: [
    ["list"],
    ["html", { outputFolder: "reports/playwright-html", open: "never" }],
    ["json", { outputFile: "reports/playwright-results.json" }]
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  }
});
