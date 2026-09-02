// Capability probe: WebGPU from a dedicated worker rendering into a transferred OffscreenCanvas.
// This is the configuration a direct (non-packet) RSX backend needs: the RSX pthread owns the
// device and presents itself. Reports timings and a pixel readback so a green triangle is proven.
const TRIANGLE_WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0.0, 0.8));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }
`;
self.onmessage = async ({ data }) => {
  const result = { where: "worker", startedAt: Date.now() };
  try {
    result.workerNavigatorGpu = "gpu" in navigator;
    result.rafInWorker = typeof requestAnimationFrame === "function";
    result.atomicsWaitAsync = typeof Atomics.waitAsync === "function";
    result.crossOriginIsolated = Boolean(self.crossOriginIsolated);
    result.sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
    result.jspi = { suspending: typeof WebAssembly.Suspending === "function", promising: typeof WebAssembly.promising === "function" };
    result.offscreenCanvasReceived = data.canvas instanceof OffscreenCanvas;
    if (!result.workerNavigatorGpu) throw new Error("navigator.gpu is unavailable in the worker");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("requestAdapter returned null in the worker");
    const info = adapter.info ?? {};
    result.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
      isFallbackAdapter: adapter.isFallbackAdapter, features: [...adapter.features],
      limits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxColorAttachments: adapter.limits.maxColorAttachments, maxBindGroups: adapter.limits.maxBindGroups } };
    const device = await adapter.requestDevice();
    device.addEventListener("uncapturederror", (event) => { result.uncapturedError = String(event.error?.message ?? event.error); });
    const canvas = data.canvas;
    const context = canvas.getContext("webgpu");
    result.offscreenWebGPUContext = Boolean(context);
    if (!context) throw new Error("OffscreenCanvas.getContext('webgpu') returned null in the worker");
    const format = navigator.gpu.getPreferredCanvasFormat();
    result.canvasFormat = format;
    context.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const module = device.createShaderModule({ code: TRIANGLE_WGSL });
    const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } });
    const frames = data.frames ?? 120;
    const times = [];
    const nextFrame = () => new Promise((resolve) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 0)));
    let last = performance.now();
    for (let i = 0; i < frames; i += 1) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, storeOp: "store" }] });
      pass.setPipeline(pipeline); pass.draw(3); pass.end();
      device.queue.submit([encoder.finish()]);
      await nextFrame();
      const now = performance.now(); times.push(now - last); last = now;
    }
    // Readback of the centre pixel from an owned texture rendered the same way
    const owned = device.createTexture({ size: { width: 64, height: 64 }, format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const rbPipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    const buffer = device.createBuffer({ size: 256 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: owned.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
    pass.setPipeline(rbPipeline); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: owned }, { buffer, bytesPerRow: 256 }, { width: 64, height: 64 });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    result.centrePixel = [...pixels.subarray(32 * 256 + 32 * 4, 32 * 256 + 32 * 4 + 4)];
    buffer.unmap();
    const sorted = [...times].sort((a, b) => a - b);
    result.frames = frames;
    result.frameMs = { p50: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], min: sorted[0], max: sorted[sorted.length - 1] };
    result.ok = result.centrePixel[1] > 200 && result.centrePixel[0] < 50;
  } catch (error) {
    result.ok = false;
    result.error = String(error && error.stack ? error.stack : error);
  }
  result.finishedAt = Date.now();
  self.postMessage(result);
};
