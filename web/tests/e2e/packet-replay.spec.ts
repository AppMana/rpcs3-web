import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";

test("replays a captured commercial RSX packet frame", async ({ page }, testInfo) => {
  const fixtureURL = process.env.RPCS3_PACKET_FIXTURE_URL;
  test.skip(!fixtureURL, "set RPCS3_PACKET_FIXTURE_URL to a local .wgpf.gz capture");
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const captureRgba = process.env.RPCS3_PACKET_FIXTURE_CAPTURE === "1";
  const captureShaders = process.env.RPCS3_PACKET_FIXTURE_CAPTURE_SHADERS === "1";
  const drawLimit = Number(process.env.RPCS3_PACKET_FIXTURE_DRAW_LIMIT) || 0;
  const gpu = await page.evaluate(async ({ url, capture, shaders, maxDraws }) => {
    const fixtureModuleURL = "/rpcs3-webgpu-fixture.mjs";
    const rendererModuleURL = "/rpcs3-webgpu-renderer.mjs";
    const [{ loadPacketFixture }, { prepareWebGPU, renderPacketsToWebGPU }] = await Promise.all([
      import(fixtureModuleURL),
      import(rendererModuleURL),
    ]);
    const fixturePackets = await loadPacketFixture(url);
    let drawCount = 0;
    const packets = maxDraws > 0
      ? fixturePackets.filter((packet: { kind: number }) => packet.kind !== 1 || ++drawCount <= maxDraws)
      : fixturePackets;
    const dimensions = packets.find((packet: { width: number; height: number }) => packet.width > 0 && packet.height > 0);
    if (!dimensions) throw new Error("packet fixture has no framebuffer dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const prepared = await prepareWebGPU(canvas, { presentation: false });
    return renderPacketsToWebGPU(prepared, packets, { replayPresentation: false, captureRgba: capture, captureShaders: shaders });
  }, { url: fixtureURL, capture: captureRgba, shaders: captureShaders, maxDraws: drawLimit });
  const rgba = Buffer.from(gpu.rgbaBase64 ?? "", "base64");
  if (captureRgba) {
    const image = new PNG({ width: gpu.width, height: gpu.height });
    image.data.set(rgba);
    const imagePath = testInfo.outputPath("packet-replay.png");
    writeFileSync(imagePath, PNG.sync.write(image));
    await testInfo.attach("packet-replay.png", { path: imagePath, contentType: "image/png" });
  }
  const reportPath = testInfo.outputPath("packet-replay.json");
  writeFileSync(reportPath, JSON.stringify({ ...gpu, rgbaBase64: captureRgba ? `<${rgba.byteLength} raw RGBA bytes>` : undefined }, null, 2));
  await testInfo.attach("packet-replay.json", { path: reportPath, contentType: "application/json" });
  expect(gpu.presented).toBe(true);
  expect(gpu.draws).toBeGreaterThan(0);
  expect(gpu.vertices).toBeGreaterThan(2);
  if (drawLimit === 0) expect(gpu.changedPixels).toBeGreaterThan(100);
  const expectedHash = Number(process.env.RPCS3_PACKET_FIXTURE_HASH);
  if (Number.isInteger(expectedHash)) expect(gpu.frameHash).toBe(expectedHash);
});
