import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RECRUITAI_E2E_PORT || 4397);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun run scripts/e2e-server.ts",
    env: {
      RECRUITAI_NO_OPEN: "1",
      RECRUITAI_PORT: String(port),
    },
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 5_000,
    },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
    url: `${baseURL}/api/dashboard`,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
