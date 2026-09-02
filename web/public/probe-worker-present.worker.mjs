// Presentation probe: a worker that never yields to its event loop renders frames into a
// transferred OffscreenCanvas and hands each frame to the page with transferToImageBitmap.
// This is how an RSX pthread that blocks in Atomics.wait could present without Asyncify.
const WGSL = `
struct U { t: f32 };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0.0, 0.8));
  return vec4f(p[i].x + sin(u.t) * 0.2, p[i].y, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(u.t / 6.28, 1.0 - u.t / 6.28, 0.2, 1.0); }
`;
self.onmessage = async ({ data }) => {
  const result = { startedAt: Date.now() };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();
    const canvas = data.canvas;
    const context = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } });
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const frames = data.frames ?? 300;
    // No await inside the loop: the worker's event loop does not run until the loop ends.
    const started = performance.now();
    let previousTexture = null;
    let distinctTextures = 0;
    let bitmaps = 0;
    const sizes = new Set();
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < frames; i += 1) {
      device.queue.writeBuffer(uniform, 0, new Float32Array([(i / frames) * 6.28, 0, 0, 0]));
      const texture = context.getCurrentTexture();
      if (texture !== previousTexture) distinctTextures += 1;
      previousTexture = texture;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", clearValue: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, storeOp: "store" }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      device.queue.submit([encoder.finish()]);
      const bitmap = canvas.transferToImageBitmap();
      sizes.add(`${bitmap.width}x${bitmap.height}`);
      bitmaps += 1;
      if (i % 5 === 0) self.postMessage({ bitmap, frame: i }, [bitmap]); else bitmap.close();
      // Pace like a 60 Hz guest while still never yielding: a blocking wait
      Atomics.wait(wait, 0, 0, 16);
    }
    result.frames = frames;
    result.loopMs = performance.now() - started;
    result.distinctTextures = distinctTextures;
    result.bitmaps = bitmaps;
    result.bitmapSizes = [...sizes];
    result.ok = distinctTextures === frames && bitmaps === frames;
  } catch (error) {
    result.ok = false; result.error = String(error && error.stack ? error.stack : error);
  }
  self.postMessage({ result });
};
