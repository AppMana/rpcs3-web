import { expect, test } from "@playwright/test";

test("original RPCS3 unit sources pass in Wasm", async ({ page }) => {
  const browserOutput: string[] = [];
  const filter = process.env.RPCS3_GTEST_FILTER;
  page.on("console", (message) => browserOutput.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => browserOutput.push(`[pageerror] ${error.stack || error.message}`));
  await page.goto(filter ? `/units.html?gtest_filter=${encodeURIComponent(filter)}` : "/units.html");
  let result: {
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
  };
  try {
    result = await page.waitForFunction(
      () => (globalThis as typeof globalThis & { __rpcs3UnitResult?: unknown }).__rpcs3UnitResult,
      undefined,
      { timeout: 60_000 },
    ).then((handle) => handle.jsonValue() as Promise<typeof result>);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${browserOutput.join("\n")}`);
  }

  expect(result.error).toBeUndefined();
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.report?.target).toBe("wasm32-emscripten");
  if (!filter) expect(result.report?.total).toBe(124);
  if (!filter) expect(result.report?.passed).toBe(124);
  expect(result.report?.failed).toBe(0);
  expect(result.report?.skipped).toBe(0);
  if (!filter) expect(result.report?.tests).toHaveLength(124);
  if (!filter) expect(result.report?.tests.filter((test) => test.suite === "SpuWebDispatch")).toHaveLength(6);
});
