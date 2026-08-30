/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import { runDynamicWasmProbe } from "./wasm-probes";
import type { CheckResult, GpuLimits, WorkerProbeResult } from "./types";

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

async function probeWebGpu(canvas?: OffscreenCanvas) {
  if (!("gpu" in navigator)) {
    return {
      webGpu: unsupported("WorkerNavigator.gpu is unavailable"),
      offscreenWebGpu: unsupported("WebGPU is unavailable"),
      gpuFeatures: [] as string[],
      gpuLimits: {} as GpuLimits,
    };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    return {
      webGpu: fail("requestAdapter returned null"),
      offscreenWebGpu: fail("no adapter for canvas"),
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

  return {
    webGpu: pass("worker adapter and device created"),
    offscreenWebGpu: pass(`rendered a triangle as ${format}`),
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
