import { decodeDrawPacket, PacketKind, SectionKind } from "./rpcs3-webgpu-packet.mjs";
import { prepareWebGPU, releaseWebGPU, renderPacketsToWebGPU, stopWebGPUPresentation } from "./rpcs3-webgpu-renderer.mjs";

let active;
let activeWorker;
// Keep the device/context alive after run() resolves. A WebGPU canvas is a
// presentation surface, not a retained bitmap; allowing the last device
// reference to be collected can clear the compositor surface even though the
// submitted texture readback was correct.
let activeGpu;
let currentPad = { digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };

function setPad(state = {}) {
  currentPad = { ...currentPad, ...state };
  activeWorker?.postMessage({ type: "pad", state: currentPad });
}

function run(fixture = "fixtures/gs_gcm_basic_triangle.elf", options = {}) {
  if (active) return active;
  activeWorker?.terminate();
  active = new Promise((resolve, reject) => {
    const dispatchCompletion = options.completion === "dispatch";
    const requestedFrames = dispatchCompletion
      ? 1
      : Number.isInteger(options.frames) ? Math.max(1, Math.min(60, options.frames)) : 1;
    const canvas = document.querySelector("#gpu-output");
    if (options.render && !(canvas instanceof HTMLCanvasElement)) {
      reject(new Error("GPU output canvas is unavailable"));
      return;
    }
    if (options.render && Number.isInteger(options.width) && Number.isInteger(options.height)) {
      canvas.width = options.width;
      canvas.height = options.height;
    }
    // Keep the DOM canvas on the main thread. Chromium headless executes and
    // reads back WebGPU correctly from a transferred OffscreenCanvas, but does
    // not composite that one-shot worker surface into screenshots. Main-thread
    // ownership proves both the hardware render and the displayed frame.
    const preparedGpu = options.render ? prepareWebGPU(canvas) : undefined;
    const worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
    activeWorker = worker;
    const events = [];
    const frames = [];
    let firstResult;
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`real RPCS3 runtime timed out; events=${JSON.stringify(events)}`));
    }, 120_000);
    let frameRequestedAt = performance.now();
    worker.addEventListener("message", async (event) => {
      const { packetBuffers = [], ...eventWithoutPackets } = event.data ?? {};
      events.push(eventWithoutPackets);
      if (event.data?.type === "runtime-result" || event.data?.type === "runtime-frame") {
        const receivedAt = performance.now();
        try {
          if (!event.data.ok) throw new Error(`${event.data.detail}; events=${JSON.stringify(events)}`);
          let gpu;
          if (preparedGpu) {
            activeGpu = await preparedGpu;
            const decodedPackets = packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer)));
            if (options.scissorOverride) {
              const { x, y, width, height } = options.scissorOverride;
              if (![x, y, width, height].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) {
                throw new Error("scissorOverride must contain unsigned 32-bit x, y, width, and height");
              }
              for (const packet of decodedPackets.filter((candidate) => candidate.kind === PacketKind.draw)) {
                const bytes = packet.sections[SectionKind.rasterEnvironment].bytes;
                if (bytes.byteLength !== 16) throw new Error("draw packet has no raster environment");
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                [x, y, width, height].forEach((value, index) => view.setUint32(index * 4, value, true));
              }
            }
            let vertexBackendComparison;
            if (options.compareVertexBackends === true) {
              const oracle = await renderPacketsToWebGPU(activeGpu, decodedPackets, {
                captureRgba: Boolean(options.captureRgba),
                replayPresentation: false,
                vertexBackend: "cpu-oracle",
                vertexDiagnostics: true,
              });
              vertexBackendComparison = {
                oracleBackend: oracle.vertexBackend,
                oracleFrameHash: oracle.frameHash,
                oracleChangedPixels: oracle.changedPixels,
                oracleTimings: oracle.timings,
              };
            }
            gpu = await renderPacketsToWebGPU(
              activeGpu,
              decodedPackets,
              {
                captureRgba: Boolean(options.captureRgba),
                vertexDiagnostics: options.vertexDiagnostics === true,
              },
            );
            if (vertexBackendComparison) {
              gpu.vertexBackendComparison = {
                ...vertexBackendComparison,
                frameHashMatch: vertexBackendComparison.oracleFrameHash === gpu.frameHash,
                changedPixelsMatch: vertexBackendComparison.oracleChangedPixels === gpu.changedPixels,
              };
            }
          }
          const frame = {
            ...eventWithoutPackets,
            gpu,
            hostTimings: { waitForPacketsMs: receivedAt - frameRequestedAt, renderMs: performance.now() - receivedAt },
          };
          frames.push(frame);
          firstResult ??= frame;
          if (!dispatchCompletion && frames.length < requestedFrames) {
            frameRequestedAt = performance.now();
            worker.postMessage({ type: "next-frame" });
            return;
          }
          clearTimeout(timeout);
          const result = { ...firstResult, gpu, events, frames: requestedFrames > 1 ? frames : undefined };
          document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
          const shutdownTimer = setTimeout(() => {
            worker.terminate();
            if (activeWorker === worker) activeWorker = undefined;
            resolve(result);
          }, 5_000);
          const onShutdown = (shutdownEvent) => {
            if (shutdownEvent.data?.type !== "runtime-shutdown") return;
            clearTimeout(shutdownTimer);
            worker.removeEventListener("message", onShutdown);
            if (activeWorker === worker) activeWorker = undefined;
            resolve(result);
          };
          worker.addEventListener("message", onShutdown);
          worker.postMessage({ type: "shutdown" });
        } catch (error) {
          clearTimeout(timeout);
          worker.terminate();
          reject(error);
        }
      }
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "real RPCS3 runtime worker failed"));
    }, { once: true });
    worker.postMessage({
      type: "boot",
      fixture,
      returnPackets: Boolean(options.render),
      diagnostics: options.diagnostics === true,
      debugAddresses: Array.isArray(options.debugAddresses) ? options.debugAddresses : [],
      pad: options.pad ?? currentPad,
      completion: dispatchCompletion ? "dispatch" : "frame",
      expectedVerdict: options.expectedVerdict ?? "",
      dispatchTimeoutMs: options.dispatchTimeoutMs ?? 30_000,
      ppuAot: options.ppuAot === true,
      spuAot: options.spuAot === true,
      // RPCS3's WebGPU RSX backend always produces packets; page-side WebGPU
      // rendering is separately gated by options.render. Only an explicit
      // renderer: "null" selects NullGSRender (dispatch-only fixtures).
      renderer: options.renderer ?? "webgpu",
    });
  }).finally(() => { active = undefined; });
  return active;
}

// Ask the running worker for a thread/stack snapshot; it arrives as a
// runtime-progress event in the final result's event list.
function snapshot() {
  activeWorker?.postMessage({ type: "snapshot" });
}

function stop() {
  stopWebGPUPresentation();
  const worker = activeWorker;
  worker?.postMessage({ type: "shutdown" });
  if (worker) setTimeout(() => worker.terminate(), 5_000);
  activeWorker = undefined;
  releaseWebGPU(activeGpu);
  activeGpu = undefined;
}

window.__rpcs3Runtime = { run, stop, setPad, snapshot };
