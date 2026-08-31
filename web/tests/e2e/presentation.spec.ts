import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

test("presents a WebGPU swapchain texture to the browser compositor", async ({ page }, testInfo) => {
  test.skip(process.env.RPCS3_HEADED !== "1", "compositor capture is a headed-browser acceptance test");
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.id = "presentation-proof";
    canvas.width = 64;
    canvas.height = 64;
    canvas.style.display = "block";
    document.body.prepend(canvas);
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false, detail: "no adapter" };
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) return { ok: false, detail: "no context" };
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const retained = { device, context, frames: 0 };
    (window as Window & { __presentationProof?: typeof retained }).__presentationProof = retained;
    const draw = () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 1, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }] });
      pass.end();
      device.queue.submit([encoder.finish()]);
      retained.frames += 1;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    const info = (adapter.info ?? {}) as GPUAdapterInfo & { backend?: string; type?: string };
    return { ok: true, format, adapter: [info.vendor, info.architecture, info.device, info.description, info.backend, info.type].filter(Boolean).join(" · ") };
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.adapter).not.toMatch(/SwiftShader|llvmpipe|software|CPU/i);
  await expect.poll(() => page.evaluate(() => (window as Window & { __presentationProof?: { frames: number } }).__presentationProof?.frames ?? 0)).toBeGreaterThan(2);
  const capture = await page.locator("#presentation-proof").screenshot({ path: testInfo.outputPath("webgpu-compositor.png") });
  const image = PNG.sync.read(capture);
  let redPixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset]! > 240 && image.data[offset + 1]! < 16 && image.data[offset + 2]! < 16 && image.data[offset + 3] === 255) redPixels += 1;
  }
  expect(redPixels).toBeGreaterThan(4_000);
});
