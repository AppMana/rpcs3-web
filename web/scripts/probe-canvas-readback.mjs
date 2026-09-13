// Diagnose browser GPU interop independently of RPCS3. No emulator is booted.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const variants = {
  default: [],
  vulkan: ["--enable-features=Vulkan", "--use-angle=vulkan"],
  gl: ["--use-angle=gl"],
  no_surface: ["--enable-features=Vulkan", "--use-angle=vulkan", "--disable-vulkan-surface"],
  shared_angle: ["--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE", "--use-angle=vulkan"],
  vulkan_gl: ["--enable-features=Vulkan", "--use-angle=gl"],
  graphite: ["--enable-features=Vulkan,SkiaGraphite", "--use-angle=vulkan"],
};
const reports = [];
for (const [name, flags] of Object.entries(variants)) {
  if (process.env.RPCS3_PROBE_VARIANTS && !process.env.RPCS3_PROBE_VARIANTS.split(",").includes(name)) continue;
  const browser = await chromium.launch({ headless: false, executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "--ignore-gpu-blocklist", ...flags] });
  try {
    const page = await browser.newPage();
    await page.goto("https://rpcs3.appmana.com/storage.html");
    const report = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return { error: "no adapter" };
      const device = await adapter.requestDevice();
      const canvas = new OffscreenCanvas(4, 4);
      const context = canvas.getContext("webgpu");
      context.configure({ device, format: "bgra8unorm", alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const texture = context.getCurrentTexture();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [1, 0, 0, 1] }] });
      pass.end();
      const buffer = device.createBuffer({ size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 4]);
      device.queue.submit([encoder.finish()]);
      // Snapshot before an await can present and discard the source texture.
      const bitmap = canvas.transferToImageBitmap();
      const scratch = new OffscreenCanvas(4, 4).getContext("2d");
      scratch.drawImage(bitmap, 0, 0);
      const canvasPixel = [...scratch.getImageData(0, 0, 1, 1).data];
      await buffer.mapAsync(GPUMapMode.READ);
      const rawBgra = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
      buffer.unmap(); buffer.destroy(); bitmap.close(); device.destroy();
      return { canvasPixel, rawBgra, adapter: { vendor: adapter.info.vendor, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } };
    });
    const session = await browser.newBrowserCDPSession();
    const gpu = (await session.send("SystemInfo.getInfo")).gpu;
    reports.push({ name, flags, ...report, featureStatus: gpu.featureStatus });
  } catch (error) { reports.push({ name, flags, error: error.stack }); }
  finally { await browser.close(); }
  console.log(JSON.stringify(reports.at(-1)));
}
await writeFile(process.argv[2] || "canvas-readback.json", JSON.stringify(reports, null, 2));
