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
  expect(result).toMatchObject({
    ok: true,
    initialized: 1,
    sparseVmProbe: 1,
    bootResult: 0,
    guestMapped: true,
    cia: "0x12345678",
    r2: "0x38b50",
    lr: "0x103a8",
    state: 0,
  });
});
