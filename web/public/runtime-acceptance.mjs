import { decodeDrawPacket } from "./rpcs3-webgpu-packet.mjs";
import { prepareWebGPU, renderPacketsToWebGPU, stopWebGPUPresentation } from "./rpcs3-webgpu-renderer.mjs";

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
    const requestedFrames = Number.isInteger(options.frames) ? Math.max(1, Math.min(60, options.frames)) : 1;
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
    worker.addEventListener("message", async (event) => {
      const { packetBuffers = [], ...eventWithoutPackets } = event.data ?? {};
      events.push(eventWithoutPackets);
      if (event.data?.type === "runtime-result" || event.data?.type === "runtime-frame") {
        try {
          if (!event.data.ok) throw new Error(`${event.data.detail}; events=${JSON.stringify(events)}`);
          let gpu;
          if (preparedGpu) {
            activeGpu = await preparedGpu;
            gpu = await renderPacketsToWebGPU(
              activeGpu,
              packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer))),
              { captureRgba: Boolean(options.captureRgba) },
            );
          }
          const frame = { ...eventWithoutPackets, gpu };
          frames.push(frame);
          firstResult ??= frame;
          if (frames.length < requestedFrames) {
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
      debugAddresses: Array.isArray(options.debugAddresses) ? options.debugAddresses : [],
      pad: options.pad ?? currentPad,
    });
  }).finally(() => { active = undefined; });
  return active;
}

function stop() {
  stopWebGPUPresentation();
  const worker = activeWorker;
  worker?.postMessage({ type: "shutdown" });
  if (worker) setTimeout(() => worker.terminate(), 5_000);
  activeWorker = undefined;
  activeGpu = undefined;
}

window.__rpcs3Runtime = { run, stop, setPad };
