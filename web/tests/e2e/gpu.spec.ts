import { expect, test } from "@playwright/test";

test("renders a sustained Tetris session through headless hardware WebGPU", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect.poll(async () => page.evaluate(() => window.__rpcs3Web.gameStatus().state)).toBe("running");
  await expect.poll(async () => page.evaluate(() => window.__rpcs3Web.gameStatus().flips ?? 0)).toBeGreaterThanOrEqual(30);

  const status = await page.evaluate(() => window.__rpcs3Web.gameStatus());
  expect(status.instructions).toBeGreaterThan(500_000);
  expect(status.commandWords).toBeGreaterThan(100);
  expect(status.draws).toBeGreaterThanOrEqual(9);
  expect(status.vertices).toBeGreaterThanOrEqual(36);
  expect(status.format).toBeTruthy();
  expect(status.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  expect(status.adapter).toMatch(/NVIDIA|AMD|Intel|discrete|integrated/i);
  expect(status.frameHash).toBeGreaterThan(0);
  expect(status.changedPixels).toBeGreaterThan(100);
  expect(status.clearPixels).toBeGreaterThan(100);
  expect(status.expectedSamples).toBeGreaterThanOrEqual(4);
  expect(status.matchedSamples).toBe(status.expectedSamples);
  expect(status.activeCenterX).toBeDefined();
  await testInfo.attach("tetris-status.json", {
    body: JSON.stringify(status, null, 2),
    contentType: "application/json",
  });

  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => page.evaluate(() => window.__rpcs3Web.gameStatus().flips ?? 0))
    .toBeGreaterThanOrEqual((status.flips ?? 0) + 30);
  await page.keyboard.up("ArrowRight");
  const moved = await page.evaluate(() => window.__rpcs3Web.gameStatus());
  expect(moved.activeCenterX).toBeGreaterThan((status.activeCenterX ?? 0) + 0.02);
  await testInfo.attach("tetris-after-input.json", {
    body: JSON.stringify(moved, null, 2),
    contentType: "application/json",
  });
  await expect(page.locator("#game-preview")).toBeVisible();
  await page.locator("#game-preview").screenshot({ path: testInfo.outputPath("tetris-webgpu.png") });
});
