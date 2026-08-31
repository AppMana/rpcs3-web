import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

type PlayStatus = {
  state: string;
  frames: number;
  fps: number;
  draws?: number;
  vertices?: number;
  activeCenterX?: number;
  ppuInstructions?: number;
  droppedPackets?: number;
  adapter?: string;
  renderMs?: number;
  pipelineCache?: { hits: number; misses: number; size: number };
};

test("plays unmodified Tetris through full RPCS3 with keyboard input", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/play.html");
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __rpcs3Playable?: { status(): PlayStatus } }
  ).__rpcs3Playable?.status().state)).toBe("running");

  const before = await page.evaluate(() => (
    window as Window & { __rpcs3Playable?: { status(): PlayStatus } }
  ).__rpcs3Playable!.status());
  expect(before.draws).toBe(9);
  expect(before.vertices).toBe(49);
  expect(before.ppuInstructions).toBeGreaterThan(300_000);
  expect(before.droppedPackets).toBe(0);
  expect(before.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  expect(before.activeCenterX).toBeDefined();

  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __rpcs3Playable?: { status(): PlayStatus } }
  ).__rpcs3Playable!.status().frames)).toBeGreaterThanOrEqual(before.frames + 20);
  await page.keyboard.up("ArrowRight");

  const after = await page.evaluate(() => (
    window as Window & { __rpcs3Playable?: { status(): PlayStatus } }
  ).__rpcs3Playable!.status());
  expect(after.activeCenterX).toBeGreaterThan((before.activeCenterX ?? 0) + 0.09);
  expect(after.ppuInstructions).toBeGreaterThan(before.ppuInstructions ?? 0);
  expect(after.droppedPackets).toBe(0);
  expect(after.fps).toBeGreaterThan(30);
  expect(after.renderMs).toBeLessThan(30);
  expect(after.pipelineCache?.hits).toBe(9);
  expect(after.pipelineCache?.misses).toBe(0);

  await testInfo.attach("playable-tetris-status.json", {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });

  if (process.env.RPCS3_HEADED === "1") {
    const capture = await page.locator("#gpu-output").screenshot({ path: testInfo.outputPath("playable-tetris.png") });
    const image = PNG.sync.read(capture);
    let backgroundPixels = 0;
    let blockPixels = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      backgroundPixels += red >= 160 && red <= 190 && green >= 160 && green <= 190 && blue >= 160 && blue <= 190 ? 1 : 0;
      blockPixels += green > red * 1.4 && green > blue * 1.15 ? 1 : 0;
    }
    expect(backgroundPixels).toBeGreaterThan(100_000);
    expect(blockPixels).toBeGreaterThan(500);
  }
});
