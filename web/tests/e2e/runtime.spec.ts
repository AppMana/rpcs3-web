import { expect, test } from "@playwright/test";
import { validateReport } from "@appmana-public/web-emulator-harness/report";

test("boots PS3 homebrew through the complete RPCS3 Wasm runtime", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & { __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> } }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/gs_gcm_basic_triangle.elf", { diagnostics: true });
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
      };
    }
  });
  await testInfo.attach("rpcs3-runtime-boot.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.ok).toBe(true);
  expect(validateReport(result)).toEqual({ ok: true, errors: [] });
  expect(result.schema).toBe(1);
  expect(result.emulator).toBe("rpcs3");
  expect(result.frames).toHaveLength(1);
  const emu = result.emu as Record<string, unknown>;
  expect(emu.initialized).toBe(1);
  expect(result.bootResult).toBe(0);
  expect(emu.atomicNotifyReentry).toBe(1);
  expect(emu.sparseVmProbe).toBe(1);
  expect(emu.fixtureBytes).toBeGreaterThan(10_000);
  expect((result.events as Array<{ type?: string }>).some((event) => event.type === "rpcs3-running")).toBe(true);
  expect((emu.logs as string[]).some((line) => line.includes("thread pool is exhausted"))).toBe(false);
  expect(emu.packetCount).toBeGreaterThan(0);
  const workingSet = result.workingSet as {
    liveThreads: number; peakThreads: number; poolTotal: number; poolBusy: number;
    vmMappedPages: number; vmBackingBytes: number; stackMaxUsedBytes: number; flipCounter: number;
  };
  expect(workingSet.liveThreads).toBeGreaterThan(0);
  expect(workingSet.peakThreads).toBeGreaterThanOrEqual(workingSet.liveThreads);
  expect(workingSet.poolTotal).toBeGreaterThanOrEqual(workingSet.poolBusy);
  expect(workingSet.vmMappedPages).toBeGreaterThan(0);
  expect(workingSet.vmBackingBytes).toBeGreaterThan(0);
  expect(workingSet.stackMaxUsedBytes).toBeGreaterThan(0);
  expect(workingSet.flipCounter).toBeGreaterThanOrEqual(1);
  expect((emu.stackReport as Array<{ name: string; usedBytes: number; stackBytes: number }>).length).toBeGreaterThan(0);
  expect(emu.drawPacketCount).toBeGreaterThan(0);
  expect((emu.packetSummaries as Array<{ kind: number; vertexCount: number }>).some(
    (packet) => packet.kind === 1 && packet.vertexCount >= 3,
  )).toBe(true);
});
