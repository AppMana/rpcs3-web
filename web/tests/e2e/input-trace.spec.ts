import { expect, test } from "@playwright/test";

// Frame-indexed input replay: pad states scheduled by guest flip index are
// applied on the RSX thread at that flip. The Tetris homebrew's fall timer and
// piece selection depend on real time, so the oracle is the observable effect
// of the input (the active block's column), not a whole-frame hash.
test("replays a frame-indexed input trace at the recorded guest frames", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/runtime.html");
  const run = (trace: Array<Record<string, number>>) => page.evaluate(async (entries) => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) throw new Error("runtime acceptance API is unavailable");
    const result = await runtime.run("fixtures/gs_gcm_tetris.elf", {
      frames: 500, renderEvery: 500, render: true, width: 320, height: 180, inputTrace: entries, captureRgba: true,
    });
    const frames = result.frames as Array<{ padScheduleApplied: number }>;
    const gpu = result.gpu as { draws: number; adapter: string; rgbaBase64: string; width: number; height: number };
    const rgba = Uint8Array.from(atob(gpu.rgbaBase64), (character) => character.charCodeAt(0));
    let sum = 0;
    let count = 0;
    for (let y = 0; y < gpu.height; y += 1) {
      for (let x = 0; x < gpu.width; x += 1) {
        const offset = (y * gpu.width + x) * 4;
        const red = rgba[offset] ?? 0, green = rgba[offset + 1] ?? 0, blue = rgba[offset + 2] ?? 0;
        if (green > red * 1.4 && green > blue * 1.15) { sum += x; count += 1; }
      }
    }
    return { ok: result.ok, draws: gpu.draws, adapter: gpu.adapter, applied: frames.at(-1)?.padScheduleApplied, blockCentroidX: count ? sum / count : NaN, blockPixels: count };
  }, trace);
  // The homebrew moves one cell per press, so tap the direction six times
  // during the gameplay window. Its fall timer is real time, so the number of
  // taps that land in the window varies; the oracle is the direction of the
  // block's displacement (two cells or more), not the exact cell count.
  const taps = (bit: number) => Array.from({ length: 6 }, (_, tap) => [
    { frame: 432 + tap * 8, digital1: bit },
    { frame: 436 + tap * 8, digital1: 0 },
  ]).flat();
  const right = await run(taps(0x20));
  const left = await run(taps(0x80));
  for (const result of [right, left]) {
    expect(result.ok).toBe(true);
    expect(result.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
    expect(result.draws).toBe(9);
    expect(result.applied).toBe(12);
    expect(result.blockPixels).toBeGreaterThan(100);
  }
  expect(right.blockCentroidX).toBeGreaterThan(left.blockCentroidX + 15);
});

test("applies frame-indexed input traces deterministically on NullGSRender and saves/resumes savestates", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/runtime.html");
  const outcome = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) throw new Error("runtime acceptance API is unavailable");

    const entries = [
      { frame: 5, digital2: 0x40 },
      { frame: 6, digital2: 0x00 },
      { frame: 10, digital1: 0x08 },
      { frame: 11, digital1: 0x00 },
    ];
    const nullRun = await runtime.run("fixtures/gs_gcm_cube.elf", {
      frames: 15,
      nullRenderer: true,
      inputTrace: entries,
      saveState: true,
      saveStatePath: "/opfs/test-cube.SAVESTAT.zst",
    });
    const nullFrames = (nullRun.frames ?? []) as Array<{ padScheduleApplied: number }>;
    const shutdown = nullRun.shutdown as { savestatePath?: string; savestateBytes?: number } | undefined;

    const resumedRun = await runtime.run("/opfs/test-cube.SAVESTAT.zst", {
      frames: 10,
      render: true,
      renderEvery: 10,
      captureRgba: true,
      inputTrace: [
        { frame: 2, digital2: 0x40 },
        { frame: 4, digital2: 0x00 },
      ],
    });
    const resumedFrames = (resumedRun.frames ?? []) as Array<{ padScheduleApplied: number }>;
    const gpu = resumedRun.gpu as { draws?: number; nonBlackPixels?: number } | undefined;
    return {
      nullOk: nullRun.ok,
      nullApplied: nullFrames.at(-1)?.padScheduleApplied ?? 0,
      savestatePath: shutdown?.savestatePath ?? "",
      savestateBytes: shutdown?.savestateBytes ?? 0,
      resumedOk: resumedRun.ok,
      resumedApplied: resumedFrames.at(-1)?.padScheduleApplied ?? 0,
      resumedDraws: gpu?.draws ?? 0,
    };
  });

  expect(outcome.nullOk).toBe(true);
  expect(outcome.nullApplied).toBe(4);
  expect(outcome.savestatePath).toBe("/opfs/test-cube.SAVESTAT.zst");
  expect(outcome.savestateBytes).toBeGreaterThan(1000);
  expect(outcome.resumedOk).toBe(true);
  expect(outcome.resumedApplied).toBe(2);
  expect(outcome.resumedDraws).toBeGreaterThan(0);
});
