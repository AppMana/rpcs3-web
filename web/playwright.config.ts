import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: "gpu.spec.ts",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:4173${process.env.BASE_PATH ?? "/"}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview -- --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
