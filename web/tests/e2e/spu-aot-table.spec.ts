import { expect, test } from "@playwright/test";

// Compiled SPU programs placed in every worker's function table and called by
// the SPU pthreads themselves (rpcs3-spu-aot-table.mjs + rpcs3_web_pre.js).
// The oracle is the native dispatch verdict; the fixture's one program must
// run on the thread at least once.

type Runtime = { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };

test("matches the native oracle with compiled SPU programs dispatched on the SPU threads", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & { __rpcs3Runtime?: Runtime }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/web_dispatch_conformance.self", {
        completion: "dispatch",
        renderer: "null",
        spuAotBundle: "fixtures/web_dispatch_conformance-spu-aot.manifest.json",
        expectedVerdict: "76ec98ba0e352b1c",
        dispatchTimeoutMs: 60_000,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  });
  await testInfo.attach("spu-aot-table-conformance.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  const table = result.spuAotTable as { programs: number; dispatches: number; fallbacks: number; idleWorkersReady: number; idleWorkers: number };
  expect(table.programs).toBeGreaterThan(0);
  expect(table.dispatches, JSON.stringify(table)).toBeGreaterThan(0);
  expect(table.idleWorkersReady, JSON.stringify(table)).toBe(table.idleWorkers);
});
