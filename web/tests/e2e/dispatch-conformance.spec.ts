import { expect, test } from "@playwright/test";

test("matches the native PPU/SPU dispatch oracle in the full Wasm runtime", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture: string, options: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/web_dispatch_conformance.self", {
        completion: "dispatch",
        renderer: "null",
        expectedVerdict: "76ec98ba0e352b1c",
        dispatchTimeoutMs: 60_000,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  });
  await testInfo.attach("dispatch-conformance.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  expect(result.dispatchLines).toEqual([
    "RPCS3-DISPATCH/1 BEGIN",
    "RPCS3-DISPATCH/1 CHECK ppu-control d8f0f90119313940",
    "RPCS3-DISPATCH/1 CHECK ppu-page-edge 0000000086a2b1c5",
    "RPCS3-DISPATCH/1 CHECK ppu-scheduler a55ab60d01135757",
    "RPCS3-DISPATCH/1 CHECK spu-group 02022f2bcd8b3b2d",
    "RPCS3-DISPATCH/1 PASS 76ec98ba0e352b1c",
  ]);
  expect(result.ppuInstructions).toBeGreaterThan(0);
  expect(result.spuInstructions).toBeGreaterThan(0);
  expect(result.spuLsBoundaryCount).toBe(0);
  expect(result.sparseVmProbe).toBe(1);
});

test("matches the native oracle through RPCS3 LLVM PPU blocks compiled to Wasm", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture: string, options: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/web_dispatch_conformance.self", {
        completion: "dispatch",
        renderer: "null",
        ppuAot: true,
        expectedVerdict: "76ec98ba0e352b1c",
        dispatchTimeoutMs: 60_000,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  });
  await testInfo.attach("rpcs3-ppu-aot-dispatch-conformance.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.ok).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  expect(result.dispatchLines).toHaveLength(6);
  expect((result.ppuAot as { compiledBlocks?: number })?.compiledBlocks).toBeGreaterThan(0);
  expect((result.ppuAot as { syscallBoundaries?: number })?.syscallBoundaries).toBeGreaterThan(0);
  expect((result.ppuAot as { reservationLoads?: number })?.reservationLoads).toBeGreaterThan(0);
  expect((result.ppuAot as { reservationStores?: number })?.reservationStores).toBeGreaterThan(0);
  expect(result.spuInstructions).toBeGreaterThan(0);
});

test("matches the native oracle through an RPCS3 LLVM SPU block compiled to Wasm", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture: string, options: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/web_dispatch_conformance.self", {
        completion: "dispatch",
        renderer: "null",
        spuAot: true,
        expectedVerdict: "76ec98ba0e352b1c",
        dispatchTimeoutMs: 60_000,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  });
  await testInfo.attach("rpcs3-spu-aot-dispatch-conformance.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  expect(result.dispatchLines).toHaveLength(6);
  expect((result.spuAot as { compiledBlocks?: number })?.compiledBlocks).toBeGreaterThan(0);
  expect((result.spuAot as { patchpointBoundaries?: number })?.patchpointBoundaries).toBeGreaterThan(0);
  expect((result.spuAot as { interpreterSteps?: number })?.interpreterSteps).toBeGreaterThan(0);
  expect(result.spuAotAbi).toEqual([315584, 20, 24, 48, 8, 3592, 3608]);
});
