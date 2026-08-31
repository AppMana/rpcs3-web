/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

type GameRequest =
  | { type: "start"; canvas: OffscreenCanvas }
  | { type: "pad"; digital1: number; digital2: number; leftX: number; leftY: number; rightX: number; rightY: number }
  | { type: "stop" };

type GuestModule = {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _rpcs3_web_probe_elf(data: number, size: number, instructionLimit: number): number;
  _rpcs3_web_probe_elf_steps(): number;
  _rpcs3_web_probe_elf_hle_calls(): number;
  _rpcs3_web_probe_gcm_flip_count(): number;
  _rpcs3_web_probe_gcm_command_words(): number;
  _rpcs3_web_probe_gcm_clear_color(): number;
  _rpcs3_web_probe_gcm_draw_count(): number;
  _rpcs3_web_probe_gcm_draw_primitive(draw: number): number;
  _rpcs3_web_probe_gcm_draw_vertex_count(draw: number): number;
  _rpcs3_web_probe_gcm_draw_vertex_component(draw: number, vertex: number, component: number): number;
  _rpcs3_web_probe_gcm_draw_vertex_color(draw: number, vertex: number): number;
  _rpcs3_web_session_run_until_flip(instructionLimit: number): number;
  _rpcs3_web_session_set_pad(digital1: number, digital2: number, leftX: number, leftY: number, rightX: number, rightY: number): void;
};

type GuestFactory = (options?: Record<string, unknown>) => Promise<GuestModule>;
type Vertex = [number, number, number, number, number, number, number, number];

const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;
let guest: GuestModule | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function floatFromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

function readVertex(module: GuestModule, draw: number, vertex: number): Vertex {
  const packed = module._rpcs3_web_probe_gcm_draw_vertex_color(draw, vertex) >>> 0;
  const raw0 = (packed >>> 24) & 0xff;
  const raw1 = (packed >>> 16) & 0xff;
  const raw2 = (packed >>> 8) & 0xff;
  return [
    floatFromBits(module._rpcs3_web_probe_gcm_draw_vertex_component(draw, vertex, 0)),
    floatFromBits(module._rpcs3_web_probe_gcm_draw_vertex_component(draw, vertex, 1)),
    floatFromBits(module._rpcs3_web_probe_gcm_draw_vertex_component(draw, vertex, 2)),
    floatFromBits(module._rpcs3_web_probe_gcm_draw_vertex_component(draw, vertex, 3)),
    raw1 / 255,
    raw2 / 255,
    raw0 / 255,
    1,
  ];
}

function append(target: number[], vertices: Vertex[], indices: number[]): void {
  for (const index of indices) target.push(...vertices[index]!);
}

type PixelSample = { x: number; y: number; red: number; green: number; blue: number };

function translatedFrame(module: GuestModule): {
  triangles: Float32Array; lines: Float32Array; draws: number; sourceVertices: number; samples: PixelSample[];
  activeCenterX?: number; activeCenterY?: number;
} {
  const triangles: number[] = [];
  const lines: number[] = [];
  const samples: PixelSample[] = [];
  const activeCenters: Array<[number, number]> = [];
  const draws = module._rpcs3_web_probe_gcm_draw_count();
  let sourceVertices = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const primitive = module._rpcs3_web_probe_gcm_draw_primitive(draw);
    const count = module._rpcs3_web_probe_gcm_draw_vertex_count(draw);
    const vertices = Array.from({ length: count }, (_, vertex) => readVertex(module, draw, vertex));
    sourceVertices += count;
    if (primitive === 2) {
      for (let index = 0; index + 1 < count; index += 2) append(lines, vertices, [index, index + 1]);
    } else if (primitive === 3) {
      for (let index = 0; index < count; index += 1) append(lines, vertices, [index, (index + 1) % count]);
      const ndc = vertices.map((item) => [item[0] / item[3], item[1] / item[3]] as const);
      const width = Math.max(...ndc.map(([x]) => x)) - Math.min(...ndc.map(([x]) => x));
      if (width < 0.2) {
        activeCenters.push([
          ndc.reduce((sum, [x]) => sum + x, 0) / ndc.length,
          ndc.reduce((sum, [, y]) => sum + y, 0) / ndc.length,
        ]);
      }
    } else if (primitive === 4) {
      for (let index = 0; index + 1 < count; index += 1) append(lines, vertices, [index, index + 1]);
    } else if (primitive === 5) {
      for (let index = 0; index + 2 < count; index += 3) append(triangles, vertices, [index, index + 1, index + 2]);
    } else if (primitive === 6) {
      for (let index = 0; index + 2 < count; index += 1) append(triangles, vertices,
        index % 2 === 0 ? [index, index + 1, index + 2] : [index + 1, index, index + 2]);
    } else if (primitive === 7) {
      for (let index = 1; index + 1 < count; index += 1) append(triangles, vertices, [0, index, index + 1]);
    } else if (primitive === 8) {
      for (let index = 0; index + 3 < count; index += 4) {
        append(triangles, vertices, [index, index + 1, index + 2, index, index + 2, index + 3]);
        const quad = vertices.slice(index, index + 4);
        const color = quad[0]!;
        samples.push({
          x: quad.reduce((sum, item) => sum + item[0] / item[3], 0) / 4,
          y: quad.reduce((sum, item) => sum + item[1] / item[3], 0) / 4,
          red: Math.round(color[4] * 255),
          green: Math.round(color[5] * 255),
          blue: Math.round(color[6] * 255),
        });
      }
    } else if (primitive === 9) {
      for (let index = 0; index + 3 < count; index += 2) append(triangles, vertices,
        [index, index + 1, index + 3, index, index + 3, index + 2]);
    }
  }
  return {
    triangles: new Float32Array(triangles),
    lines: new Float32Array(lines),
    draws,
    sourceVertices,
    samples,
    activeCenterX: activeCenters.length === 0 ? undefined : activeCenters.reduce((sum, [x]) => sum + x, 0) / activeCenters.length,
    activeCenterY: activeCenters.length === 0 ? undefined : activeCenters.reduce((sum, [, y]) => sum + y, 0) / activeCenters.length,
  };
}

class GuestRenderer {
  readonly shader: GPUShaderModule;
  readonly triangles: GPURenderPipeline;
  readonly lines: GPURenderPipeline;

  constructor(readonly device: GPUDevice, readonly context: GPUCanvasContext, readonly format: GPUTextureFormat,
    readonly width: number, readonly height: number) {
    this.shader = device.createShaderModule({
      label: "RSX DP4/color WebGPU translation",
      code: `
        struct VertexOut {
          @builtin(position) position: vec4f,
          @location(0) color: vec4f,
        };
        @vertex fn vertex_main(@location(0) position: vec4f, @location(1) color: vec4f) -> VertexOut {
          var output: VertexOut;
          output.position = vec4f(position.xy, 0.5 * position.w, position.w);
          output.color = color;
          return output;
        }
        @fragment fn fragment_main(input: VertexOut) -> @location(0) vec4f {
          return vec4f(input.color.rgb, 1.0);
        }
      `,
    });
    const descriptor = (topology: GPUPrimitiveTopology): GPURenderPipelineDescriptor => ({
      layout: "auto",
      vertex: {
        module: this.shader,
        entryPoint: "vertex_main",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        }],
      },
      fragment: { module: this.shader, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology },
    });
    this.triangles = device.createRenderPipeline(descriptor("triangle-list"));
    this.lines = device.createRenderPipeline(descriptor("line-list"));
  }

  async render(module: GuestModule, readPixels: boolean): Promise<{
    draws: number; sourceVertices: number; frameHash?: number; changedPixels?: number; clearPixels?: number;
    expectedSamples?: number; matchedSamples?: number; preview?: ArrayBuffer;
    activeCenterX?: number; activeCenterY?: number;
  }> {
    const frame = translatedFrame(module);
    const buffers: GPUBuffer[] = [];
    const upload = (data: Float32Array): GPUBuffer | undefined => {
      if (data.length === 0) return undefined;
      const buffer = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      buffers.push(buffer);
      return buffer;
    };
    const triangleBuffer = upload(frame.triangles);
    const lineBuffer = upload(frame.lines);
    const clear = module._rpcs3_web_probe_gcm_clear_color() >>> 0;
    const encoder = this.device.createCommandEncoder({ label: "translated RSX frame" });
    const texture = this.context.getCurrentTexture();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: texture.createView(),
      clearValue: { r: ((clear >>> 16) & 0xff) / 255, g: ((clear >>> 8) & 0xff) / 255, b: (clear & 0xff) / 255, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }] });
    if (triangleBuffer) {
      pass.setPipeline(this.triangles);
      pass.setVertexBuffer(0, triangleBuffer);
      pass.draw(frame.triangles.length / 8);
    }
    if (lineBuffer) {
      pass.setPipeline(this.lines);
      pass.setVertexBuffer(0, lineBuffer);
      pass.draw(frame.lines.length / 8);
    }
    pass.end();
    const bytesPerRow = this.width * 4;
    const readback = readPixels ? this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }) : undefined;
    if (readback) {
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow, rowsPerImage: this.height },
        { width: this.width, height: this.height });
    }
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    for (const buffer of buffers) buffer.destroy();
    if (!readback) return {
      draws: frame.draws,
      sourceVertices: frame.sourceVertices,
      activeCenterX: frame.activeCenterX,
      activeCenterY: frame.activeCenterY,
    };
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange());
    const red = (clear >>> 16) & 0xff;
    const green = (clear >>> 8) & 0xff;
    const blue = clear & 0xff;
    let hash = 2166136261;
    let changedPixels = 0;
    const bgra = this.format.startsWith("bgra");
    const rgba = new Uint8ClampedArray(pixels.length);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset + (bgra ? 2 : 0)]!;
      const g = pixels[offset + 1]!;
      const b = pixels[offset + (bgra ? 0 : 2)]!;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
      if (r !== red || g !== green || b !== blue) changedPixels += 1;
      hash ^= r;
      hash = Math.imul(hash, 16777619);
      hash ^= g;
      hash = Math.imul(hash, 16777619);
      hash ^= b;
      hash = Math.imul(hash, 16777619);
    }
    let matchedSamples = 0;
    for (const sample of frame.samples) {
      const x = Math.max(0, Math.min(this.width - 1, Math.floor((sample.x * 0.5 + 0.5) * this.width)));
      const y = Math.max(0, Math.min(this.height - 1, Math.floor((0.5 - sample.y * 0.5) * this.height)));
      const offset = (y * this.width + x) * 4;
      if (Math.abs(rgba[offset]! - sample.red) <= 1 && Math.abs(rgba[offset + 1]! - sample.green) <= 1 &&
        Math.abs(rgba[offset + 2]! - sample.blue) <= 1) matchedSamples += 1;
    }
    readback.unmap();
    readback.destroy();
    const previewCanvas = new OffscreenCanvas(this.width, this.height);
    const previewContext = previewCanvas.getContext("2d");
    if (!previewContext) throw new Error("2D context for GPU readback preview is unavailable");
    const image = previewContext.createImageData(this.width, this.height);
    image.data.set(rgba);
    previewContext.putImageData(image, 0, 0);
    const preview = await (await previewCanvas.convertToBlob({ type: "image/png" })).arrayBuffer();
    return {
      draws: frame.draws,
      sourceVertices: frame.sourceVertices,
      frameHash: hash >>> 0,
      changedPixels,
      clearPixels: this.width * this.height - changedPixels,
      expectedSamples: frame.samples.length,
      matchedSamples,
      preview,
      activeCenterX: frame.activeCenterX,
      activeCenterY: frame.activeCenterY,
    };
  }
}

async function start(canvas: OffscreenCanvas): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable in this worker");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU requestAdapter returned null");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("OffscreenCanvas WebGPU context is unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

  const imported = await import(/* @vite-ignore */ `${import.meta.env.BASE_URL}core/rpcs3-web-probe-v7.mjs`) as { default?: GuestFactory };
  if (typeof imported.default !== "function") throw new Error("guest core factory is unavailable");
  guest = await imported.default({ locateFile: (name: string) => `${import.meta.env.BASE_URL}core/${name}` });
  const response = await fetch(`${import.meta.env.BASE_URL}fixtures/gs_gcm_tetris.elf`);
  if (!response.ok) throw new Error(`Tetris fixture fetch returned ${response.status}`);
  const image = new Uint8Array(await response.arrayBuffer());
  const pointer = guest._malloc(image.byteLength);
  if (!pointer) throw new Error("Tetris Wasm allocation failed");
  let result = 0;
  try {
    guest.HEAPU8.set(image, pointer);
    result = guest._rpcs3_web_probe_elf(pointer, image.byteLength, 500_000);
  } finally {
    guest._free(pointer);
  }
  if (result !== 0 || guest._rpcs3_web_probe_gcm_flip_count() < 1) {
    throw new Error(`Tetris did not reach its first flip (result=${result}, instructions=${guest._rpcs3_web_probe_elf_steps()})`);
  }

  const renderer = new GuestRenderer(device, context, format, canvas.width, canvas.height);
  const adapterInfo = adapter.info as GPUAdapterInfo & { backend?: string; type?: string };
  const adapterDetail = [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.device,
    adapterInfo.description, adapterInfo.backend, adapterInfo.type].filter(Boolean).join(" · ");
  running = true;
  while (running) {
    const flips = guest._rpcs3_web_probe_gcm_flip_count();
    const publish = flips === 1 || flips % 30 === 0;
    const translated = await renderer.render(guest, publish);
    if (publish) {
      const status = {
        type: "status",
        state: "running",
        flips,
        instructions: guest._rpcs3_web_probe_elf_steps(),
        hleCalls: guest._rpcs3_web_probe_elf_hle_calls(),
        commandWords: guest._rpcs3_web_probe_gcm_command_words(),
        draws: translated.draws,
        vertices: translated.sourceVertices,
        format,
        adapter: adapterDetail,
        frameHash: translated.frameHash,
        changedPixels: translated.changedPixels,
        clearPixels: translated.clearPixels,
        expectedSamples: translated.expectedSamples,
        matchedSamples: translated.matchedSamples,
        activeCenterX: translated.activeCenterX,
        activeCenterY: translated.activeCenterY,
        preview: translated.preview,
      };
      scope.postMessage(status, translated.preview ? [translated.preview] : []);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
    if (!running) break;
    const runResult = guest._rpcs3_web_session_run_until_flip(250_000);
    if (runResult === 2) throw new Error(`guest stopped at instruction ${guest._rpcs3_web_probe_elf_steps()}`);
  }
  device.destroy();
}

scope.addEventListener("message", (event: MessageEvent<GameRequest>) => {
  if (event.data.type === "start") {
    void start(event.data.canvas).catch((error) => {
      running = false;
      scope.postMessage({ type: "status", state: "failed", detail: errorMessage(error) });
    });
  } else if (event.data.type === "pad") {
    guest?._rpcs3_web_session_set_pad(event.data.digital1, event.data.digital2,
      event.data.leftX, event.data.leftY, event.data.rightX, event.data.rightY);
  } else if (event.data.type === "stop") {
    running = false;
  }
});
