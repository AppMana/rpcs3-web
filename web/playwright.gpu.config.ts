import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["browser-units.spec.ts", "gpu.spec.ts", "runtime-gpu.spec.ts", "runtime-cube.spec.ts", "runtime-cube-correctness.spec.ts", "runtime-animation.spec.ts", "presentation.spec.ts", "frame-oracle.spec.ts"],
  // These tests intentionally share one physical GPU. Running independent
  // RPCS3/WebGPU instances in parallel can starve the packet consumer and
  // measures cross-test contention rather than backend correctness.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4174/",
    trace: "retain-on-failure",
    headless: process.env.RPCS3_HEADED !== "1",
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--enable-webgpu-developer-features",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
        "--use-angle=vulkan",
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
