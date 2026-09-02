import { expect, test } from "@playwright/test";

type DepthState = {
  enabled: boolean;
  writeEnabled: boolean;
  comparison: string;
};

type TargetState = {
  blendEnabled: boolean;
  writeMask: number;
  blend?: {
    color: { srcFactor: string; dstFactor: string; operation: string };
    alpha: { srcFactor: string; dstFactor: string; operation: string };
  };
};

test("renders the RPCS3 textured cube with depth and alpha-blended text", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    return runtime.run("fixtures/gs_gcm_cube.elf", {
      render: true, captureRgba: true, width: 320, height: 180, compareVertexBackends: true,
    });
  });

  const gpu = result.gpu as {
    presented: boolean;
    adapter: string;
    width: number;
    height: number;
    draws: number;
    vertices: number;
    depthStates: DepthState[];
    targetStates: TargetState[];
    changedBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
    drawDiagnostics: Array<{ texture?: { channelMin: number[]; channelMax: number[] } }>;
    rgbaBase64: string;
    vertexBackend: string;
    vertexBackendComparison: {
      oracleBackend: string; oracleFrameHash: number; frameHashMatch: boolean; changedPixelsMatch: boolean;
      oracleTimings: { translateMs: number };
    };
  };
  const artifact = {
    ...result,
    gpu: gpu && { ...gpu, rgbaBase64: `<${Buffer.from(gpu.rgbaBase64 ?? "", "base64").length} raw RGBA bytes>` },
  };
  await testInfo.attach("rpcs3-runtime-cube-correctness.json", {
    body: JSON.stringify(artifact, null, 2),
    contentType: "application/json",
  });

  expect(result.ok, JSON.stringify(artifact, null, 2)).toBe(true);
  expect(result.bootResult).toBe(0);
  expect(result.droppedPackets).toBe(0);
  expect(gpu.presented).toBe(true);
  expect(gpu.vertexBackend).toBe("webgpu-wgsl");
  expect(gpu.vertexBackendComparison).toMatchObject({
    oracleBackend: "cpu-oracle",
    oracleFrameHash: 3_289_484_600,
    frameHashMatch: true,
    changedPixelsMatch: true,
  });
  expect(gpu.draws).toBe(2);
  expect(gpu.vertices).toBe(162);
  expect(gpu.depthStates).toEqual([
    { enabled: true, writeEnabled: true, comparison: "less" },
    { enabled: false, writeEnabled: false, comparison: "always" },
  ]);
  expect(gpu.targetStates[0]).toMatchObject({ blendEnabled: false, writeMask: 15 });
  expect(gpu.targetStates[1]).toMatchObject({
    blendEnabled: true,
    writeMask: 15,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  });
  // The B8 font atlas packet's 0x0201 remap selects zero for RGB and the
  // texture byte for alpha, matching the sampling semantics used by RPCS3.
  expect(gpu.drawDiagnostics[1]?.texture).toMatchObject({
    channelMin: [0, 0, 0, 0],
    channelMax: [0, 0, 0, 255],
  });

  const rgba = Buffer.from(gpu.rgbaBase64, "base64");
  expect(rgba).toHaveLength(gpu.width * gpu.height * 4);
  const colors = new Set<number>();
  let magentaPixels = 0;
  let textPixels = 0;
  let textClearPixels = 0;
  let lightTextPixels = 0;
  for (let y = 0; y < gpu.height; y += 1) {
    for (let x = 0; x < gpu.width; x += 1) {
      const offset = (y * gpu.width + x) * 4;
      const red = rgba[offset] ?? 0;
      const green = rgba[offset + 1] ?? 0;
      const blue = rgba[offset + 2] ?? 0;
      colors.add((red << 16) | (green << 8) | blue);
      magentaPixels += red > green + 20 && blue > green + 20 && red > 80 && blue > 80 ? 1 : 0;
      if (x < 140 && y < 40) {
        const clear = red === 32 && green === 32 && blue === 32;
        textPixels += clear ? 0 : 1;
        textClearPixels += clear ? 1 : 0;
        lightTextPixels += red > 96 && green > 96 && blue > 96 ? 1 : 0;
      }
    }
  }
  const imageEvidence = { colors: colors.size, magentaPixels, textPixels, textClearPixels, lightTextPixels };
  await testInfo.attach("rpcs3-runtime-cube-image-evidence.json", {
    body: JSON.stringify(imageEvidence, null, 2),
    contentType: "application/json",
  });
  expect(colors.size).toBeGreaterThan(128);
  expect(magentaPixels).toBeGreaterThan(1_000);
  expect(textPixels).toBeGreaterThan(100);
  expect(textPixels).toBeLessThan(1_000);
  expect(textClearPixels).toBeGreaterThan(4_000);
  expect(lightTextPixels).toBeGreaterThan(50);
  // Surfaces render at RPCS3's resolution scale (1280x720) and are presented into the 320x180 canvas with a
  // nearest blit, whose sample centres land one canvas pixel right of the text's left edge.
  expect(gpu.changedBounds).toMatchObject({ minX: 17 });
  expect(gpu.changedBounds?.maxX).toBeGreaterThan(180);
});
