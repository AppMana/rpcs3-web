import { expect, test } from "@playwright/test";

test("runs RPCS3-translated PPU code against the full sparse Wasm runtime", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/ppu-aot.html");
  const result = await page.evaluate(async () => {
    const acceptance = (window as Window & {
      __rpcs3PpuAot?: { run(): Promise<Record<string, unknown>> };
    }).__rpcs3PpuAot;
    if (!acceptance) return { ok: false, detail: "PPU AOT acceptance API is unavailable" };
    try {
      return await acceptance.run();
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
      };
    }
  });
  await testInfo.attach("rpcs3-ppu-aot.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  const { dispatcherTrace, hybridTrace, naturalBoundary, resolvedImports, ...summary } = result as Record<string, unknown> & {
    dispatcherTrace: Array<Record<string, unknown>>;
    hybridTrace: Array<Record<string, unknown>>;
    naturalBoundary: Record<string, unknown>;
    resolvedImports: Array<Record<string, unknown>>;
  };
  expect(summary).toMatchObject({
    ok: true,
    initialized: 1,
    sparseVmProbe: 1,
    bootResult: 0,
    bootStatus: 6,
    guestMapped: true,
    cia: "0x12345678",
    r2: "0x38b50",
    lr: "0x103a8",
    state: 0,
  });
  expect(dispatcherTrace).toHaveLength(3);
  expect(dispatcherTrace[0]).toMatchObject({ pc: "0x1022c", next: "0x10260" });
  expect(dispatcherTrace[1]).toMatchObject({ pc: "0x10260", next: "0x103a8" });
  expect(naturalBoundary.next).toBe(summary.originalImportTarget);
  expect(dispatcherTrace[2]).toMatchObject({ pc: "0x103a8" });
  expect(dispatcherTrace[2]?.next).toBe(
    resolvedImports.find((entry) => entry.slot === "0x30178")?.target,
  );
  expect(hybridTrace).toHaveLength(16);
  expect(hybridTrace[0]).toMatchObject({ kind: "aot", pc: "0x1022c" });
  expect(hybridTrace[0]?.next).toBe(summary.originalImportTarget);
  expect(hybridTrace[1]).toMatchObject({ kind: "interpreter", pc: summary.originalImportTarget, next: "0x103a8" });
  expect(hybridTrace[3]).toMatchObject({ kind: "interpreter", pc: "0x474d4", next: "0x19058" });
  expect(hybridTrace[4]).toMatchObject({ kind: "aot", pc: "0x19058", next: "0x1907c" });
  expect(hybridTrace[5]).toMatchObject({ kind: "interpreter", pc: "0x1907c", next: "0x19080", r3: "0x0" });
});
