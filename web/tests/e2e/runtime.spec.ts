import { expect, test } from "@playwright/test";

test("boots PS3 homebrew through the complete RPCS3 Wasm runtime", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & { __rpcs3Runtime?: { run(): Promise<Record<string, unknown>> } }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run();
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
  expect(result.initialized).toBe(1);
  expect(result.bootResult).toBe(0);
  expect(result.atomicNotifyReentry).toBe(1);
  expect(result.fixtureBytes).toBeGreaterThan(10_000);
  expect((result.events as Array<{ type?: string }>).some((event) => event.type === "rpcs3-running")).toBe(true);
  expect((result.logs as string[]).some((line) => line.includes("thread pool is exhausted"))).toBe(false);
  expect(result.packetCount).toBeGreaterThan(0);
  expect(result.drawPacketCount).toBeGreaterThan(0);
  expect((result.packetSummaries as Array<{ kind: number; vertexCount: number }>).some(
    (packet) => packet.kind === 1 && packet.vertexCount >= 3,
  )).toBe(true);
});
