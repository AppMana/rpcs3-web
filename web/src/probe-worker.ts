/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import { runDynamicWasmProbe } from "./wasm-probes";
import type { CheckResult, GpuLimits, GuestFrameResult, WorkerProbeResult } from "./types";

type ProbeRequest = { type: "probe"; canvas?: OffscreenCanvas };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const pass = (detail: string): CheckResult => ({ state: "passed", detail });
const fail = (detail: string): CheckResult => ({ state: "failed", detail });
const unsupported = (detail: string): CheckResult => ({ state: "unsupported", detail });

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function probeOpfs(): Promise<CheckResult> {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    return unsupported("navigator.storage.getDirectory is unavailable");
  }

  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle("rpcs3-web-opfs-probe.bin", { create: true });
  if (typeof file.createSyncAccessHandle !== "function") {
    await root.removeEntry("rpcs3-web-opfs-probe.bin");
    return unsupported("synchronous OPFS access handles are unavailable");
  }

  const handle = await file.createSyncAccessHandle();
  const expected = new Uint8Array([0x52, 0x50, 0x43, 0x53, 0x33]);
  const actual = new Uint8Array(expected.length);
  try {
    handle.truncate(0);
    const written = handle.write(expected, { at: 0 });
    handle.flush();
    const read = handle.read(actual, { at: 0 });
    if (written !== expected.length || read !== expected.length || !actual.every((v, i) => v === expected[i])) {
      return fail(`OPFS round trip differed (write=${written}, read=${read})`);
    }
    return pass("worker synchronous OPFS round trip succeeded");
  } finally {
    handle.close();
    await root.removeEntry("rpcs3-web-opfs-probe.bin");
  }
}

function selectedLimits(limits: GPUSupportedLimits): GpuLimits {
  return {
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
  };
}

type GuestProbeModule = {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _rpcs3_web_probe_elf(data: number, size: number, instructionLimit: number): number;
  _rpcs3_web_probe_elf_steps(): number;
  _rpcs3_web_probe_elf_hle_calls(): number;
  _rpcs3_web_probe_gcm_flip_count(): number;
  _rpcs3_web_probe_gcm_command_words(): number;
  _rpcs3_web_probe_gcm_vertex_count(): number;
  _rpcs3_web_probe_gcm_width(): number;
  _rpcs3_web_probe_gcm_height(): number;
  _rpcs3_web_probe_gcm_clear_color(): number;
  _rpcs3_web_probe_gcm_primitive(): number;
  _rpcs3_web_probe_gcm_vertex_component(vertex: number, component: number): number;
  _rpcs3_web_probe_gcm_vertex_color(vertex: number): number;
};

type GuestProbeFactory = (options?: Record<string, unknown>) => Promise<GuestProbeModule>;

function floatFromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

async function renderGuestTriangle(device?: GPUDevice, context?: GPUCanvasContext, format?: GPUTextureFormat): Promise<GuestFrameResult> {
  const asset = "rpcs3-web-probe-v6";
  const imported = await import(/* @vite-ignore */ `${import.meta.env.BASE_URL}core/${asset}.mjs`) as { default?: GuestProbeFactory };
  if (typeof imported.default !== "function") throw new Error("guest core factory is unavailable");
  const module = await imported.default({ locateFile: (name: string) => `${import.meta.env.BASE_URL}core/${name}` });
  const response = await fetch(`${import.meta.env.BASE_URL}fixtures/gs_gcm_basic_triangle.elf`);
  if (!response.ok) throw new Error(`homebrew fixture fetch returned ${response.status}`);
  const image = new Uint8Array(await response.arrayBuffer());
  const pointer = module._malloc(image.byteLength);
  if (!pointer) throw new Error("homebrew Wasm allocation failed");
  let result: number;
  try {
    module.HEAPU8.set(image, pointer);
    result = module._rpcs3_web_probe_elf(pointer, image.byteLength, 100_000);
  } finally {
    module._free(pointer);
  }

  const flips = module._rpcs3_web_probe_gcm_flip_count();
  const vertexCount = module._rpcs3_web_probe_gcm_vertex_count();
  const commandWords = module._rpcs3_web_probe_gcm_command_words();
  const primitive = module._rpcs3_web_probe_gcm_primitive();
  if (result !== 0 || flips < 1 || commandWords < 1 || vertexCount < 3 || primitive !== 5) {
    throw new Error(`guest frame incomplete (result=${result}, flips=${flips}, words=${commandWords}, vertices=${vertexCount}, primitive=${primitive})`);
  }
  const frame: GuestFrameResult = {
    fixture: "gs_gcm_basic_triangle.elf",
    instructions: module._rpcs3_web_probe_elf_steps(),
    hleCalls: module._rpcs3_web_probe_elf_hle_calls(),
    flips,
    commandWords,
    vertices: vertexCount,
    primitive,
    width: module._rpcs3_web_probe_gcm_width(),
    height: module._rpcs3_web_probe_gcm_height(),
  };

  const vertices = new Float32Array(vertexCount * 8);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = vertex * 8;
    for (let component = 0; component < 4; component += 1) {
      vertices[base + component] = floatFromBits(module._rpcs3_web_probe_gcm_vertex_component(vertex, component));
    }
    const packed = module._rpcs3_web_probe_gcm_vertex_color(vertex) >>> 0;
    const raw0 = (packed >>> 24) & 0xff;
    const raw1 = (packed >>> 16) & 0xff;
    const raw2 = (packed >>> 8) & 0xff;
    vertices[base + 4] = raw1 / 255;
    vertices[base + 5] = raw2 / 255;
    vertices[base + 6] = raw0 / 255;
    vertices[base + 7] = 1;
  }
  if (!device || !context || !format) return frame;

  const shader = device.createShaderModule({
    label: "PS3 GCM homebrew translation",
    code: `
      struct VertexOut {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      };
      @vertex fn vertex_main(@location(0) position: vec4f, @location(1) color: vec4f) -> VertexOut {
        var output: VertexOut;
        output.position = vec4f(position.xy, 0.5, position.w);
        output.color = color;
        return output;
      }
      @fragment fn fragment_main(input: VertexOut) -> @location(0) vec4f {
        return vec4f(input.color.rgb, 1.0);
      }
    `,
  });
  const compilation = await shader.getCompilationInfo();
  const shaderErrors = compilation.messages.filter(({ type }) => type === "error");
  if (shaderErrors.length > 0) throw new Error(shaderErrors.map(({ message: detail }) => detail).join("; "));
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shader,
      entryPoint: "vertex_main",
      buffers: [{
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x4" },
          { shaderLocation: 1, offset: 16, format: "float32x4" },
        ],
      }],
    },
    fragment: { module: shader, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);
  const clear = module._rpcs3_web_probe_gcm_clear_color() >>> 0;
  const encoder = device.createCommandEncoder({ label: "translated PS3 frame" });
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: {
        r: ((clear >>> 16) & 0xff) / 255,
        g: ((clear >>> 8) & 0xff) / 255,
        b: (clear & 0xff) / 255,
        a: 1,
      },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  renderPass.setPipeline(pipeline);
  renderPass.setVertexBuffer(0, vertexBuffer);
  renderPass.draw(vertexCount);
  renderPass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  vertexBuffer.destroy();

  return frame;
}

async function probeGuestWithoutGpu(reason: string) {
  try {
    const guestFrame = await renderGuestTriangle();
    return {
      guestHomebrew: unsupported(`${reason}; guest PPU/GCM frame decoded without presentation`),
      guestFrame,
    };
  } catch (error) {
    return { guestHomebrew: fail(message(error)), guestFrame: undefined };
  }
}

async function probeWebGpu(canvas?: OffscreenCanvas) {
  if (!("gpu" in navigator)) {
    const guest = await probeGuestWithoutGpu("WebGPU is unavailable");
    return {
      webGpu: unsupported("WorkerNavigator.gpu is unavailable"),
      offscreenWebGpu: unsupported("WebGPU is unavailable"),
      ...guest,
      gpuFeatures: [] as string[],
      gpuLimits: {} as GpuLimits,
    };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    const guest = await probeGuestWithoutGpu("requestAdapter returned null");
    return {
      webGpu: fail("requestAdapter returned null"),
      offscreenWebGpu: fail("no adapter for canvas"),
      ...guest,
      gpuFeatures: [] as string[],
      gpuLimits: {} as GpuLimits,
    };
  }

  const device = await adapter.requestDevice();
  const features = [...adapter.features].sort();
  const limits = selectedLimits(adapter.limits);
  if (!canvas) {
    device.destroy();
    return {
      webGpu: pass("worker adapter and device created"),
      offscreenWebGpu: unsupported("no OffscreenCanvas was transferred"),
      guestHomebrew: unsupported("no OffscreenCanvas was transferred"),
      gpuFeatures: features,
      gpuLimits: limits,
    };
  }

  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return {
      webGpu: pass("worker adapter and device created"),
      offscreenWebGpu: fail("OffscreenCanvas.getContext('webgpu') returned null"),
      guestHomebrew: fail("OffscreenCanvas WebGPU context is unavailable"),
      gpuFeatures: features,
      gpuLimits: limits,
    };
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const shader = device.createShaderModule({
    label: "RPCS3 web probe triangle",
    code: `
      @vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
        var positions = array<vec2f, 3>(
          vec2f(0.0, 0.72), vec2f(-0.72, -0.62), vec2f(0.72, -0.62)
        );
        return vec4f(positions[index], 0.0, 1.0);
      }
      @fragment fn fragment_main() -> @location(0) vec4f {
        return vec4f(0.18, 0.55, 1.0, 1.0);
      }
    `,
  });
  const compilation = await shader.getCompilationInfo();
  const shaderErrors = compilation.messages.filter(({ type }) => type === "error");
  if (shaderErrors.length > 0) {
    device.destroy();
    return {
      webGpu: pass("worker adapter and device created"),
      offscreenWebGpu: fail(shaderErrors.map(({ message }) => message).join("; ")),
      guestHomebrew: fail("WebGPU shader setup failed"),
      gpuFeatures: features,
      gpuLimits: limits,
    };
  }

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vertex_main" },
    fragment: { module: shader, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const encoder = device.createCommandEncoder();
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0.025, g: 0.035, b: 0.065, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  renderPass.setPipeline(pipeline);
  renderPass.draw(3);
  renderPass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  let guestFrame: GuestFrameResult | undefined;
  let guestHomebrew: CheckResult;
  try {
    guestFrame = await renderGuestTriangle(device, context, format);
    guestHomebrew = pass(`${guestFrame.instructions} PPU instructions → ${guestFrame.commandWords} GCM words → ${guestFrame.vertices} WebGPU vertices`);
  } catch (error) {
    guestHomebrew = fail(message(error));
  }
  device.destroy();

  return {
    webGpu: pass("worker adapter and device created"),
    offscreenWebGpu: pass(`rendered through ${format}`),
    guestHomebrew,
    guestFrame,
    gpuFeatures: features,
    gpuLimits: limits,
  };
}

scope.addEventListener("message", async (event: MessageEvent<ProbeRequest>) => {
  if (event.data.type !== "probe") return;
  const errors: string[] = [];
  let dynamicWasm: CheckResult;
  let sharedWasmMemory: CheckResult;
  let opfs: CheckResult;

  try {
    const answer = await runDynamicWasmProbe();
    dynamicWasm = answer === 42 ? pass("runtime WebAssembly compilation returned 42") : fail(`returned ${answer}`);
  } catch (error) {
    dynamicWasm = fail(message(error));
    errors.push(`dynamic-wasm: ${message(error)}`);
  }

  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    sharedWasmMemory = memory.buffer instanceof SharedArrayBuffer
      ? pass("shared WebAssembly.Memory created")
      : fail("memory buffer is not SharedArrayBuffer");
  } catch (error) {
    sharedWasmMemory = fail(message(error));
    errors.push(`shared-memory: ${message(error)}`);
  }

  try {
    opfs = await probeOpfs();
  } catch (error) {
    opfs = fail(message(error));
    errors.push(`opfs: ${message(error)}`);
  }

  let gpu;
  try {
    gpu = await probeWebGpu(event.data.canvas);
  } catch (error) {
    const detail = message(error);
    gpu = {
      webGpu: fail(detail),
      offscreenWebGpu: fail(detail),
      guestHomebrew: fail(detail),
      gpuFeatures: [] as string[],
      gpuLimits: {} as GpuLimits,
    };
    errors.push(`webgpu: ${detail}`);
  }

  const result: WorkerProbeResult = {
    worker: pass("dedicated module worker responded"),
    dynamicWasm,
    sharedWasmMemory,
    opfs,
    ...gpu,
    errors,
  };
  scope.postMessage(result);
});
