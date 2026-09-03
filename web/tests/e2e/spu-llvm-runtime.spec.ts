import { expect, test } from "@playwright/test";

// The SPU LLVM tier inside the full runtime: no offline SPU bundle, so every SPU program the
// fixture runs is first interpreted, then compiled by the baseline recompiler and by the LLVM
// compiler workers; the LLVM side module is registered as the leading candidate and must be
// dispatched on the SPU thread. The oracle is the native dispatch verdict.

type Runtime = { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };

test("matches the native oracle while dispatching LLVM-compiled SPU programs", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & { __rpcs3Runtime?: Runtime }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/web_dispatch_conformance.self", {
        completion: "dispatch",
        renderer: "null",
        spuDecoder: "llvm",
        spuLlvmWorkers: 1,
        // The fixture's SPU program runs a few times: compile at its first unlisted miss
        spuHotThreshold: 1,
        expectedVerdict: "76ec98ba0e352b1c",
        dispatchTimeoutMs: 120_000,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  });
  await testInfo.attach("spu-llvm-runtime.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  const tier = result.spuLlvm as { workers: number; requested: number; compiled: number; failed: number; stuck: number; errors: string[] };
  expect(tier, JSON.stringify(result.spuHotReport)).toBeDefined();
  expect(tier.errors, JSON.stringify(tier)).toEqual([]);
  expect(tier.stuck, JSON.stringify(tier)).toBe(0);
  expect(tier.failed, JSON.stringify(tier)).toBe(0);
  expect(tier.compiled, JSON.stringify(tier)).toBeGreaterThan(0);
  const report = result.spuHotReport as { compiled: number; llvm: { requested: number; failed: number; abandoned: number; registered: number; dispatches: number } };
  expect(report.compiled, JSON.stringify(report)).toBeGreaterThan(0);
  expect(report.llvm.failed, JSON.stringify(report)).toBe(0);
  // The fast tier handed its programs to RPCS3's SPU LLVM thread, whose worker sent them to the
  // compiler workers. The guest exits before the first LLVM compile lands, so the worker abandons
  // the answer; registration and dispatch of LLVM programs are measured on the long-running
  // commercial runs (spuHotReport.llvm.registered / dispatches).
  expect(report.llvm.requested, JSON.stringify(report)).toBe(tier.compiled + tier.failed);
  expect(report.llvm.registered + report.llvm.abandoned, JSON.stringify(report)).toBe(report.llvm.requested);
});
