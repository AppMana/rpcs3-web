import { expect, test } from "@playwright/test";

type GpuResult = {
  frameHash: number;
  changedPixels: number;
  changedBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  scissorStates: Array<{
    x: number; y: number; width: number; height: number;
    scaled: { x: number; y: number; width: number; height: number };
  }>;
  vertexBackendComparison: { frameHashMatch: boolean; changedPixelsMatch: boolean };
};

test("applies RPCS3's resolved RSX scissor to WebGPU draws", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    const full = await runtime.run("fixtures/gs_gcm_basic_triangle.elf", {
      render: true, width: 320, height: 180, compareVertexBackends: true,
    });
    const clipped = await runtime.run("fixtures/gs_gcm_basic_triangle.elf", {
      render: true,
      width: 320,
      height: 180,
      compareVertexBackends: true,
      scissorOverride: { x: 0, y: 0, width: 640, height: 720 },
    });
    return { ok: true, full: full.gpu, clipped: clipped.gpu };
  });
  await testInfo.attach("rpcs3-runtime-scissor.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });

  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  const full = result.full as GpuResult;
  const clipped = result.clipped as GpuResult;
  expect(full.scissorStates[0]).toEqual({
    x: 0, y: 0, width: 1280, height: 720,
    // RPCS3's resolution scale (100%) leaves the scissor in surface pixels; the canvas only sees the presented blit
    scaled: { x: 0, y: 0, width: 1280, height: 720 },
  });
  expect(clipped.scissorStates[0]).toEqual({
    x: 0, y: 0, width: 640, height: 720,
    scaled: { x: 0, y: 0, width: 640, height: 720 },
  });
  expect(full.frameHash).toBe(2_769_363_428);
  expect(clipped.frameHash).not.toBe(full.frameHash);
  expect(clipped.changedPixels).toBeGreaterThan(0);
  expect(clipped.changedPixels).toBeLessThan(full.changedPixels);
  expect(clipped.changedBounds?.maxX).toBeLessThanOrEqual(159);
  expect(full.vertexBackendComparison).toMatchObject({ frameHashMatch: true, changedPixelsMatch: true });
  expect(clipped.vertexBackendComparison).toMatchObject({ frameHashMatch: true, changedPixelsMatch: true });
});
