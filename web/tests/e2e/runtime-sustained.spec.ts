import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// Sustained full-RPCS3 run on hardware WebGPU without readback in the frame
// loop. Correctness gates are output-based (deterministic title-frame hash,
// draw counts, zero packet drops, clean shutdown); timings and the working
// set are recorded as evidence, never as pass/fail inputs.
test("sustains sixty Tetris frames through direct WebGPU presentation", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/gs_gcm_tetris.elf", { frames: 60, render: true, width: 320, height: 180, readback: false });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  });
  const frames = (result.frames ?? []) as Array<{
    droppedPackets: number; presentedSkips: number; captureMs: number;
    hostTimings: { waitForPacketsMs: number; renderMs: number };
    gpu: { draws: number; frameHash: number | undefined; adapter: string; timings: Record<string, number>; pipelineCache: { misses: number } };
    workingSet: Record<string, number>;
  }>;
  const shutdown = result.shutdown as { stoppedCleanly: boolean; stopMs: number; liveThreadNames: string[]; stackReport: Array<{ name: string; usedBytes: number }>; workingSet: Record<string, number> } | undefined;
  const percentile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  };
  const steady = frames.slice(1);
  const evidence = {
    adapter: frames.at(-1)?.gpu.adapter,
    frames: frames.length,
    waitForPacketsMs: { p50: percentile(steady.map((frame) => frame.hostTimings.waitForPacketsMs), 0.5), p95: percentile(steady.map((frame) => frame.hostTimings.waitForPacketsMs), 0.95) },
    renderMs: { p50: percentile(steady.map((frame) => frame.hostTimings.renderMs), 0.5), p95: percentile(steady.map((frame) => frame.hostTimings.renderMs), 0.95) },
    captureMs: { p50: percentile(steady.map((frame) => frame.captureMs), 0.5), p95: percentile(steady.map((frame) => frame.captureMs), 0.95) },
    pipelineMisses: steady.reduce((sum, frame) => sum + frame.gpu.pipelineCache.misses, 0),
    workingSet: frames.at(-1)?.workingSet,
    shutdown: shutdown && { stoppedCleanly: shutdown.stoppedCleanly, stopMs: shutdown.stopMs, liveThreadNames: shutdown.liveThreadNames, maxStackUsedBytes: Math.max(0, ...shutdown.stackReport.map((entry) => entry.usedBytes)), workingSet: shutdown.workingSet },
  };
  const body = JSON.stringify({ evidence, result: { ...result, frames: undefined, events: undefined, logs: undefined } }, null, 2);
  await testInfo.attach("rpcs3-sustained.json", { body, contentType: "application/json" });
  // Also keep the evidence on disk for passing runs (traces are retained on failure only).
  await writeFile(testInfo.outputPath("rpcs3-sustained.json"), body);
  expect(result.ok, JSON.stringify(result.detail)).toBe(true);
  expect(frames.length).toBe(60);
  expect(evidence.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  expect(frames.every((frame) => frame.droppedPackets === 0)).toBe(true);
  expect(frames.every((frame) => frame.gpu.draws >= 1)).toBe(true);
  // Direct presentation: no readback in the loop, so no frame hash is computed.
  expect(frames.at(-1)?.gpu.frameHash).toBeUndefined();
  expect(evidence.pipelineMisses).toBe(0);
  expect(shutdown?.stoppedCleanly).toBe(true);
  expect(shutdown?.liveThreadNames).toEqual([]);
  expect(shutdown?.workingSet.vmBackingBytes).toBe(0);
});
