import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

test("renders an authentic RPCS3 RSX draw through hardware WebGPU", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    return runtime.run(undefined, { render: true, compareVertexBackends: true });
  });
  await testInfo.attach("rpcs3-runtime-webgpu.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  const gpu = result.gpu as {
    presented: boolean; adapter: string; draws: number; vertices: number; vertexOpcodes: number[];
    fragmentOpcodes: number[]; changedPixels: number; clearPixels: number; frameHash: number; vertexBackend: string;
    vertexBackendComparison: {
      oracleBackend: string; oracleFrameHash: number; frameHashMatch: boolean; changedPixelsMatch: boolean;
      oracleTimings: { translateMs: number };
    };
  };
  expect(result.bootResult).toBe(0);
  expect(result.drawPacketCount).toBeGreaterThan(0);
  expect(gpu.presented).toBe(true);
  expect(gpu.vertexBackend).toBe("webgpu-wgsl");
  expect(gpu.vertexBackendComparison).toMatchObject({
    oracleBackend: "cpu-oracle",
    oracleFrameHash: 1_129_836_632,
    frameHashMatch: true,
    changedPixelsMatch: true,
  });
  expect(gpu.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  expect(gpu.adapter).toMatch(/NVIDIA|AMD|Intel|discrete|integrated/i);
  expect(gpu.draws).toBeGreaterThan(0);
  expect(gpu.vertices).toBeGreaterThanOrEqual(3);
  expect(gpu.vertexOpcodes).toEqual(expect.arrayContaining([1, 7]));
  expect(gpu.fragmentOpcodes).toEqual([1]);
  expect(gpu.changedPixels).toBeGreaterThan(100);
  expect(gpu.clearPixels).toBeGreaterThan(100);
  expect(gpu.frameHash).toBe(1_129_836_632);
  // The worker posts its result before Chromium's compositor necessarily
  // presents that task's OffscreenCanvas frame. Yield two browser paints so
  // the screenshot verifies the displayed surface, not just GPU readback.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  if (process.env.RPCS3_HEADED === "1") {
    const capture = await page.locator("#gpu-output").screenshot({ path: testInfo.outputPath("rpcs3-rsx-webgpu.png") });
    const image = PNG.sync.read(capture);
    let clearPixels = 0;
    let coloredPixels = 0;
    let transparentPixels = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      const alpha = image.data[offset + 3];
      clearPixels += red === 64 && green === 64 && blue === 64 && alpha === 255 ? 1 : 0;
      coloredPixels += alpha === 255 && (red !== 64 || green !== 64 || blue !== 64) ? 1 : 0;
      transparentPixels += alpha === 0 ? 1 : 0;
    }
    const surface = { width: image.width, height: image.height, clearPixels, coloredPixels, transparentPixels };
    await testInfo.attach("rpcs3-presented-surface.json", {
      body: JSON.stringify(surface, null, 2),
      contentType: "application/json",
    });
    expect(surface.width).toBe(320);
    expect(surface.height).toBeGreaterThanOrEqual(180);
    expect(surface.transparentPixels).toBe(0);
    expect(surface.clearPixels).toBeGreaterThan(100);
    expect(surface.coloredPixels).toBeGreaterThan(100);
  }
});
