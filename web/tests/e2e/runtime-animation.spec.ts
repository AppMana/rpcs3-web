import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

test("advances successive full-RPCS3 cube frames instead of repainting one capture", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    return runtime.run("fixtures/gs_gcm_cube.elf", { render: true, frames: 3, width: 320, height: 180 });
  });
  const artifactPath = testInfo.outputPath("rpcs3-runtime-animation.json");
  writeFileSync(artifactPath, JSON.stringify(result, null, 2));
  await testInfo.attach("rpcs3-runtime-animation.json", { path: artifactPath, contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  const frames = result.frames as Array<{
    frameSequence: number;
    ppuInstructions: number;
    droppedPackets: number;
    drawPacketCount: number;
    flipPacketCount: number;
    gpu: {
      frameHash: number;
      draws: number;
      vertices: number;
      drawDiagnostics: Array<{ clipBounds: { min: number[]; max: number[] } }>;
      timings: {
        translateMs: number;
        resourceAndPipelineMs: number;
        submitAndMappedReadbackMs: number;
        readbackScanMs: number;
        totalMs: number;
      };
    };
  }>;
  expect(frames).toHaveLength(3);
  expect(frames.map((frame) => frame.frameSequence)).toEqual([1, 2, 3]);
  expect(frames.every((frame) => frame.drawPacketCount === 2 && frame.flipPacketCount === 1)).toBe(true);
  expect(frames.every((frame) => frame.gpu.draws === 2 && frame.gpu.vertices === 162)).toBe(true);
  expect(frames[1]!.ppuInstructions).toBeGreaterThan(frames[0]!.ppuInstructions);
  expect(frames[2]!.ppuInstructions).toBeGreaterThan(frames[1]!.ppuInstructions);
  expect(new Set(frames.map((frame) => frame.gpu.frameHash)).size).toBe(frames.length);
  const cubeClipBounds = frames.map((frame) => frame.gpu.drawDiagnostics[0]?.clipBounds);
  expect(new Set(cubeClipBounds.map((bounds) => JSON.stringify(bounds))).size).toBe(frames.length);
  expect(frames.every((frame) => frame.gpu.timings.totalMs > 0)).toBe(true);
  expect(frames.at(-1)!.droppedPackets).toBe(0);
});
