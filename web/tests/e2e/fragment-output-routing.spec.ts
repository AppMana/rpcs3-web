import { expect, test } from "@playwright/test";

test("sparse RSX color exports reach their retained GPU attachments", async ({ page }) => {
  await page.goto("/runtime.html");
  const pixels = await page.evaluate(async () => {
    const url = "/rpcs3-webgpu-renderer.mjs";
    const { translateRsxProgram } = await import(/* @vite-ignore */ url);
    const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const results: number[][][] = [];
    try {
      for (const drawBufferGroup of [0, 1]) for (const half of [false, true]) for (const outputs of [[1], [0, 2, 3]]) {
        // Four MOVs from separate inline constants to the four RSX color exports.
        const bytes = new Uint8Array(128), view = new DataView(bytes.buffer);
        const registers = half ? [0, 4, 6, 8] : [0, 2, 3, 4];
        for (let i = 0; i < 4; i++) {
          const words = [(1 << 24) | (registers[i]! << 1) | (half ? 128 : 0) | (15 << 9) | (i === 3 ? 1 : 0),
            2 | (0xe4 << 9) | (7 << 18), 0, 0];
          words.forEach((word, j) => view.setUint32(i * 32 + j * 4,
            (((word & 0x00ff00ff) << 8) | ((word & 0xff00ff00) >>> 8)) >>> 0, true));
        }
        const translated = translateRsxProgram({ vertexProgram: new Uint8Array(0), vertexProgramEntry: 0,
          fragmentProgram: bytes, fragmentProgramControl: half ? 0 : 0x40,
          colorTargetCount: outputs.length, colorOutputIndices: outputs, drawBufferGroup });
        const code = translated.code + `
          @vertex fn fullscreen(@builtin(vertex_index) i: u32) -> VertexOut {
            var o: VertexOut;
            let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
            o.position = vec4f(p[i], 0., 1.); return o;
          }`;
        const module = device.createShaderModule({ code });
        const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
        if (errors.length) throw new Error(errors.map((m) => m.message).join("\n"));
        const pipeline = await device.createRenderPipelineAsync({ layout: "auto",
          vertex: { module, entryPoint: "fullscreen" }, fragment: { module, entryPoint: "fragment_main",
            targets: outputs.map(() => ({ format: "rgba8unorm" as GPUTextureFormat })) } });
        const uniform = device.createBuffer({ size: 32 + 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniform, 32, new Float32Array([1,0,0,1, 0,1,0,1, 0,0,1,1, 1,1,0,1]));
        const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(drawBufferGroup), entries: [{ binding: 33, resource: { buffer: uniform } }] });
        const textures = outputs.map(() => device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
        const readback = device.createBuffer({ size: outputs.length * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: textures.map((texture) => ({ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0,0,0,0] })) });
        pass.setPipeline(pipeline);
        if (drawBufferGroup) pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [] }));
        pass.setBindGroup(drawBufferGroup, bind); pass.draw(3); pass.end();
        textures.forEach((texture, i) => encoder.copyTextureToBuffer({ texture }, { buffer: readback, offset: i * 256, bytesPerRow: 256 }, [1,1]));
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const raw = new Uint8Array(readback.getMappedRange());
        results.push(outputs.map((_, i) => [...raw.slice(i * 256, i * 256 + 4)]));
        readback.unmap(); readback.destroy(); uniform.destroy(); textures.forEach((t) => t.destroy());
      }
      return results;
    } finally { device.destroy(); }
  });
  const expected = [
    [[0,255,0,255]], [[255,0,0,255], [0,0,255,255], [255,255,0,255]],
    [[0,255,0,255]], [[255,0,0,255], [0,0,255,255], [255,255,0,255]],
  ];
  expect(pixels).toEqual([...expected, ...expected]);
});
