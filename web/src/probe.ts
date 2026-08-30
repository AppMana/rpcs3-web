import { runCoreProbe } from "./core-probe";
import type { CapabilityReport, WorkerProbeResult } from "./types";
import { supportsMemory64 } from "./wasm-probes";

function workerFailure(detail: string): WorkerProbeResult {
  const failed = { state: "failed" as const, detail };
  return {
    worker: failed,
    dynamicWasm: failed,
    sharedWasmMemory: failed,
    opfs: failed,
    webGpu: failed,
    offscreenWebGpu: failed,
    gpuFeatures: [],
    gpuLimits: {},
    errors: [detail],
  };
}

async function runWorkerProbe(canvas: HTMLCanvasElement): Promise<WorkerProbeResult> {
  const worker = new Worker(new URL("./probe-worker.ts", import.meta.url), { type: "module" });
  const result = new Promise<WorkerProbeResult>((resolve) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve(workerFailure("worker probe timed out after 20 seconds"));
    }, 20_000);
    worker.addEventListener("message", (event: MessageEvent<WorkerProbeResult>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    }, { once: true });
    worker.addEventListener("error", (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(workerFailure(event.message || "worker failed"));
    }, { once: true });
  });

  if (typeof canvas.transferControlToOffscreen === "function") {
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "probe", canvas: offscreen }, [offscreen]);
  } else {
    worker.postMessage({ type: "probe" });
  }
  return result;
}

export async function collectCapabilities(canvas: HTMLCanvasElement): Promise<CapabilityReport> {
  const [worker, coreProbe] = await Promise.all([
    runWorkerProbe(canvas),
    runCoreProbe(),
  ]);
  return {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    webAssembly: typeof WebAssembly === "object",
    memory64: supportsMemory64(),
    mainThreadWebGpu: "gpu" in navigator,
    offscreenCanvas: typeof OffscreenCanvas === "function" && typeof canvas.transferControlToOffscreen === "function",
    worker,
    coreProbe,
  };
}
