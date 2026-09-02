import { defineConfig } from "@playwright/test";
import { GPU_SPECS, harness } from "./playwright.config";

// The dedicated GPU lane: one worker (these tests share one physical GPU;
// parallel RPCS3/WebGPU instances measure cross-test contention rather than
// backend correctness), Chrome flags that expose the physical adapter, and
// the correctness specs that run here as well as in the default lane.
export default defineConfig({
  ...harness.gpu,
  testMatch: [...GPU_SPECS, "browser-units.spec.ts", "packet-replay.spec.ts"],
});
