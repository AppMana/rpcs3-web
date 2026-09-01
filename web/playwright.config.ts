import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // The default/CI lane does not assume a WebGPU adapter. The dedicated GPU
  // config runs both correctness tests (software adapters allowed) and strict
  // hardware gates (software adapters rejected).
  testIgnore: [
    "frame-oracle.spec.ts",
    "gpu.spec.ts",
    "playable-tetris.spec.ts",
    "presentation.spec.ts",
    "runtime-cube-correctness.spec.ts",
    "runtime-cube.spec.ts",
    "runtime-animation.spec.ts",
    "runtime-gpu.spec.ts",
    "runtime-scissor.spec.ts",
    "runtime-sustained.spec.ts",
  ],
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
