import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

test("boots the textured/depth gs_gcm_cube fixture through the complete RPCS3 Wasm runtime", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run("fixtures/gs_gcm_cube.elf", {
        render: true,
        diagnostics: true, debugAddresses: [
          0x14a4c0,
          0x49458,
        ],
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  });
  await testInfo.attach("rpcs3-runtime-cube.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.bootResult).toBe(0);
  expect(result.fixtureBytes).toBe(356_532);
  expect(result.drawPacketCount).toBeGreaterThan(0);
  const draws = (result.packetSummaries as Array<{
    kind: number;
    flags: number;
    vertexCount: number;
    sectionSizes: number[];
    textures?: Array<{
      stage: number;
      slot: number;
      address: number;
      format: number;
      width: number;
      height: number;
      dataSize: number;
      hash: string;
      nonzeroBytes: number;
    }>;
  }>).filter(
    (packet) => packet.kind === 1,
  );
  expect(draws.some((packet) => packet.vertexCount >= 3)).toBe(true);
  expect(draws.some((packet) => (packet.flags & (1 << 2)) !== 0)).toBe(true);
  const firstDraw = draws[0]!;
  expect(firstDraw.textures).toHaveLength(1);
  const firstTexture = firstDraw.textures![0]!;
  expect(firstDraw.sectionSizes[10]).toBeGreaterThanOrEqual(48);
  expect(firstDraw.flags & (1 << 4)).toBe(0);
  expect(firstTexture).toMatchObject({ stage: 0, slot: 0, address: 0xc0b50000, format: 0xa5, width: 256, height: 256, dataSize: 262_144 });
  expect(firstTexture.nonzeroBytes).toBeGreaterThan(1_000);
  expect(result.debugWords).toMatchObject({ "0x14a4c0": 65_536, "0x49458": 196_608 });
  const gpu = result.gpu as {
    presented: boolean;
    adapter: string;
    draws: number;
    vertices: number;
    vertexOpcodes: number[];
    fragmentOpcodes: number[];
    changedPixels: number;
    clearPixels: number;
    frameHash: number;
    depthStates: Array<{ enabled: boolean; writeEnabled: boolean; comparison: string }>;
    targetStates: Array<{
      blendEnabled: boolean;
      writeMask: number;
      blend?: {
        color: { srcFactor: string; dstFactor: string; operation: string };
        alpha: { srcFactor: string; dstFactor: string; operation: string };
      };
    }>;
  };
  expect(gpu.presented).toBe(true);
  expect(gpu.draws).toBe(2);
  expect(gpu.vertices).toBe(162);
  expect(gpu.vertexOpcodes).toEqual(expect.arrayContaining([1]));
  expect(gpu.fragmentOpcodes).toContain(0x17);
  expect(gpu.changedPixels).toBeGreaterThan(100);
  expect(gpu.clearPixels).toBeGreaterThan(100);
  expect(gpu.frameHash).toBeGreaterThan(0);
  expect(gpu.depthStates).toEqual([
    { enabled: true, writeEnabled: true, comparison: "less" },
    { enabled: false, writeEnabled: false, comparison: "always" },
  ]);
  expect(gpu.targetStates[1]).toMatchObject({
    blendEnabled: true,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  });
  expect(gpu.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  expect(gpu.adapter).toMatch(/NVIDIA|AMD|Intel|discrete|integrated/i);
  expect(result.droppedPackets).toBe(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  if (process.env.RPCS3_HEADED === "1") {
    const capture = await page.locator("#gpu-output").screenshot({ path: testInfo.outputPath("rpcs3-cube-webgpu.png") });
    const image = PNG.sync.read(capture);
    let clearPixels = 0;
    let renderedPixels = 0;
    let transparentPixels = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      const alpha = image.data[offset + 3];
      clearPixels += red === 32 && green === 32 && blue === 32 && alpha === 255 ? 1 : 0;
      renderedPixels += alpha === 255 && (red !== 32 || green !== 32 || blue !== 32) ? 1 : 0;
      transparentPixels += alpha === 0 ? 1 : 0;
    }
    const surface = { width: image.width, height: image.height, clearPixels, renderedPixels, transparentPixels };
    await testInfo.attach("rpcs3-cube-presented-surface.json", {
      body: JSON.stringify(surface, null, 2),
      contentType: "application/json",
    });
    expect(surface.width).toBe(320);
    expect(surface.height).toBeGreaterThanOrEqual(180);
    expect(surface.transparentPixels).toBe(0);
    expect(surface.clearPixels).toBeGreaterThan(100);
    expect(surface.renderedPixels).toBeGreaterThan(100);
  }
});
