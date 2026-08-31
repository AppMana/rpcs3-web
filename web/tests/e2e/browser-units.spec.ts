import { expect, test } from "@playwright/test";

test("original RPCS3 unit sources pass in Wasm", async ({ page }) => {
  await page.goto("/units.html");
  const result = await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __rpcs3UnitResult?: unknown }).__rpcs3UnitResult,
    undefined,
    { timeout: 60_000 },
  ).then((handle) => handle.jsonValue() as Promise<{
    ok: boolean;
    error?: string;
    report?: {
      target: string;
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      tests: Array<{ suite: string; name: string; status: string }>;
    };
  }>);

  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.report?.target).toBe("wasm32-emscripten");
  expect(result.report?.total).toBe(114);
  expect(result.report?.passed).toBe(114);
  expect(result.report?.failed).toBe(0);
  expect(result.report?.skipped).toBe(0);
  expect(result.report?.tests).toHaveLength(114);
});
