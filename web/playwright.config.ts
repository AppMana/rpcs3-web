import { defineConfig } from "@playwright/test";
import { defineHarnessConfig } from "@appmana-public/web-emulator-harness/playwright";

// Specs that need the dedicated GPU lane (playwright.gpu.config.ts): the
// default/CI lane does not assume a WebGPU adapter.
export const GPU_SPECS = [
  "ppu-aot-table-gpu.spec.ts",
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
  "input-trace.spec.ts",
];

// Ports come from the environment so several checkouts can run their lanes
// beside a deployed preview (RPCS3_PREVIEW_PORT, RPCS3_GPU_PREVIEW_PORT,
// RPCS3_LIBRARY_PORT; vite.config.ts proxies /library/ to RPCS3_LIBRARY_PROXY).
const libraryPort = Number(process.env.RPCS3_LIBRARY_PORT) || 4181;
export const harness = defineHarnessConfig({
  apiGlobal: "__rpcs3Runtime",
  previewPort: Number(process.env.RPCS3_PREVIEW_PORT) || 4173,
  gpuPreviewPort: Number(process.env.RPCS3_GPU_PREVIEW_PORT) || 4174,
  libraryPort,
  // Same-origin library for the OPFS import tests; the preview server proxies
  // /library/ to it. A running rpcs3-web-library.service is reused.
  libraryCommand: `node scripts/serve-library.mjs --port ${libraryPort} --dir public/fixtures`,
  gpuSpecs: GPU_SPECS,
  headedEnv: "RPCS3_HEADED",
  basePath: process.env.BASE_PATH,
});

export default defineConfig(harness.default);
