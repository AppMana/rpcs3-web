import { expect, test } from "@playwright/test";

// Compiled PPU blocks placed in every worker's function table and called by
// the PPU pthreads themselves (rpcs3-ppu-aot-table.mjs + rpcs3_web_pre.js).
// The oracle is the same program run by the interpreter: identical dispatch
// verdict, and identical frames for the deterministic Tetris title screen.

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

test("matches the native oracle with compiled PPU blocks dispatched on the PPU threads", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await runFixture(page, "fixtures/web_dispatch_conformance.self", {
    completion: "dispatch",
    renderer: "null",
    ppuAotBundle: "fixtures/web_dispatch_conformance-aot.manifest.json",
    expectedVerdict: "76ec98ba0e352b1c",
    dispatchTimeoutMs: 60_000,
  });
  await testInfo.attach("ppu-aot-table-conformance.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  const table = result.ppuAotTable as { blocks: number; dispatches: number; idleWorkersReady: number; idleWorkers: number };
  expect(table.blocks).toBeGreaterThan(0);
  expect(table.dispatches).toBeGreaterThan(0);
  expect(table.idleWorkersReady, JSON.stringify(table)).toBe(table.idleWorkers);
});
