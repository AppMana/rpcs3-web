import { expect, test } from "@playwright/test";

test("publishes a machine-readable capability report", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("PS3 browser bring-up");
  const report = await page.evaluate(async () => window.__rpcs3Web.runSmokeTest());
  expect(report.schemaVersion).toBe(1);
  expect(report.webAssembly).toBe(true);
  expect(report.worker.worker.state).toBe("passed");
  expect(report.worker.dynamicWasm.state).toBe("passed");
  expect(report.crossOriginIsolated).toBe(true);
  expect(report.sharedArrayBuffer).toBe(true);
  expect(report.coreProbe?.loaded).toBe(true);
  expect(report.coreProbe?.memoryTestMask).toBe(0);
  expect(report.coreProbe?.mappedPages).toBe(5);
  expect(report.coreProbe?.residentPages).toBe(2);

  const repeated = await page.evaluate(async () => window.__rpcs3Web.runSmokeTest());
  expect(repeated.coreProbe?.memoryTestMask).toBe(0);
  await expect(page.locator("#evidence")).toContainText('"schemaVersion": 1');
});
