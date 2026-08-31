import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "gpu.spec.ts",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4174/",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--enable-webgpu-developer-features",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
        "--use-angle=vulkan",
        "--disable-vulkan-surface",
      ],
    },
  },
  webServer: {
    command: "npm run preview -- --port 4174",
    port: 4174,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "gpu-chrome" }],
});
