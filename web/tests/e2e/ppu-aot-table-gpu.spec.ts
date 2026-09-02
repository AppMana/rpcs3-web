import { expect, test } from "@playwright/test";

// Hardware-GPU lane: the deterministic Tetris title screen must render the
// same frame whether the PPU code is interpreted or dispatched as compiled
// blocks on the PPU threads (rpcs3-ppu-aot-table.mjs + rpcs3_web_pre.js).

type Runtime = { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };

async function runFixture(page: import("@playwright/test").Page, fixture: string, options: Record<string, unknown>) {
  return page.evaluate(async ([fixtureName, runOptions]) => {
    const runtime = (window as Window & { __rpcs3Runtime?: Runtime }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run(fixtureName as string, runOptions as Record<string, unknown>);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  }, [fixture, options] as const);
}

test("renders the Tetris title identically with compiled PPU blocks", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.goto("/runtime.html");
  const options = { frames: 20, render: true, width: 320, height: 180, readback: true };
  const interpreted = await runFixture(page, "fixtures/gs_gcm_tetris.elf", options);
  const compiled = await runFixture(page, "fixtures/gs_gcm_tetris.elf", {
    ...options,
    ppuAotBundle: "fixtures/gs-gcm-tetris-aot.manifest.json",
  });
  await testInfo.attach("ppu-aot-table-tetris.json", {
    body: JSON.stringify({ interpreted: { ...interpreted, gpu: { ...(interpreted.gpu as object), rgbaBase64: undefined } }, compiled: { ...compiled, gpu: { ...(compiled.gpu as object), rgbaBase64: undefined } } }, null, 2),
    contentType: "application/json",
  });
  for (const result of [interpreted, compiled]) {
    expect(result.ok, JSON.stringify(result.detail ?? result, null, 2).slice(0, 4000)).toBe(true);
    expect((result.gpu as { adapter: string }).adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  }
  const before = interpreted.gpu as { frameHash: number; draws: number; changedPixels: number };
  const after = compiled.gpu as { frameHash: number; draws: number; changedPixels: number };
  expect(after.draws).toBe(before.draws);
  expect(after.changedPixels).toBe(before.changedPixels);
  expect(after.frameHash).toBe(before.frameHash);
  const table = compiled.ppuAotTable as { blocks: number; dispatches: number };
  expect(table.blocks).toBeGreaterThan(0);
  expect(table.dispatches).toBeGreaterThan(0);
});
