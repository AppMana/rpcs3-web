import { decodeDrawPacket, PacketKind, SectionKind } from "./rpcs3-webgpu-packet.mjs";
import { prepareWebGPU, releaseWebGPU, renderPacketsToWebGPU, stopWebGPUPresentation } from "./rpcs3-webgpu-renderer.mjs";
import { encodePacketFixture } from "./rpcs3-webgpu-fixture.mjs";

function base64Of(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
  }
  return btoa(binary);
}

// A frame record kept for long runs: counts, progress, timings, and the GPU
// summary, without per-frame logs, stack reports, or packet summaries.
function compactFrame(frame, keepDetail) {
  if (keepDetail) return frame;
  const { logs: _logs, stackReport: _stack, packetSummaries: _summaries, textureWords: _words, gpu, ...rest } = frame;
  return { ...rest, gpu: gpu && { ...gpu, drawDiagnostics: undefined, shaderPrograms: undefined, surfaceDumps: undefined, rgbaBase64: undefined, depthStates: undefined, rasterStates: undefined, scissorStates: undefined, targetStates: undefined } };
}

let active;
let activeWorker;
let persistentWorker;
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

// target: a fixture path relative to this page ("fixtures/x.elf") or an
// absolute guest boot path in origin-private storage ("/opfs/games/x.iso").
// This one API serves the desktop lanes, the hosted-origin iPad runner, and
// the hardware/commercial runner; runners differ only in how they launch a
// browser and where they write evidence.
function run(target = "fixtures/gs_gcm_basic_triangle.elf", options = {}) {
  if (active) return active;
  // A kept runtime (options.keepRuntime) is reused instead of terminated: Safari does not release a
  // finished run's 512 MiB shared memory in time to allocate the next one.
  if (activeWorker && activeWorker !== persistentWorker) activeWorker.terminate();
  active = new Promise((resolve, reject) => {
    const dispatchCompletion = options.completion === "dispatch";
    const bootPath = typeof target === "string" && target.startsWith("/") ? target : undefined;
    const fixture = bootPath ? undefined : target;
    const untilDraw = options.untilDraw === true;
    const requestedFrames = dispatchCompletion
      ? 1
      : Number.isInteger(options.frames) ? Math.max(1, Math.min(3600, options.frames)) : (untilDraw ? 3600 : 1);
    const renderEvery = Number.isInteger(options.renderEvery) ? Math.max(1, options.renderEvery) : 1;
    // Frames that are neither rendered nor final are discarded in the worker
    // (no packet copy, no transfer); RSX still executes them.
    const needsPackets = (frameNumber) => untilDraw || frameNumber % renderEvery === 0 || frameNumber === requestedFrames;
    // Runs up to the classic 60-frame cap keep every frame's full detail
    // (diagnostics, logs); longer runs keep it for the first and final frame.
    const keepDetail = (index, finalFrame) => requestedFrames <= 60 || index === 0 || finalFrame;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, options.timeoutMs) : 120_000;
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
    // Direct backend: the runtime's RSX worker renders into an OffscreenCanvas and hands each
    // frame back as an ImageBitmap; the DOM canvas only displays it.
    const direct = options.directRenderer === true;
    const preparedGpu = options.render && !direct ? prepareWebGPU(canvas) : undefined;
    const reuse = options.keepRuntime === true && Boolean(persistentWorker);
    const directCanvas = direct && !reuse ? new OffscreenCanvas(canvas.width, canvas.height) : undefined;
    const directView = direct ? canvas.getContext("bitmaprenderer") : undefined;
    const directScratch = direct ? document.createElement("canvas") : undefined;
    let presentedFrames = 0;
    let presentedHash = 0;
    const frameImages = [];
    const captureEvery = Number.isInteger(options.captureEvery) && options.captureEvery > 0 ? options.captureEvery : 0;
    if (directScratch) { directScratch.width = canvas.width; directScratch.height = canvas.height; }
    const worker = reuse ? persistentWorker : new Worker("./runtime-smoke-worker.mjs", { type: "module" });
    persistentWorker = undefined;
    if (reuse && worker.__rpcs3Handler) worker.removeEventListener("message", worker.__rpcs3Handler);
    activeWorker = worker;
    const events = [];
    const frames = [];
    let firstResult;
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`real RPCS3 runtime timed out; events=${JSON.stringify(events.slice(-40))}`));
    }, timeoutMs);
    let frameRequestedAt = performance.now();
    worker.addEventListener("message", worker.__rpcs3Handler = async (event) => {
      if (event.data?.type === "runtime-present") {
        const bitmap = event.data.bitmap;
        presentedFrames += 1;
        // Keep a copy for the end-of-run hash and image; hashing every present would cost more than the frame
        directScratch?.getContext("2d", { willReadFrequently: true }).drawImage(bitmap, 0, 0);
        directView?.transferFromImageBitmap(bitmap);
        return;
      }
      const { packetBuffers = [], ...eventWithoutPackets } = event.data ?? {};
      if (events.length < 4_000) events.push(compactFrame(eventWithoutPackets, requestedFrames <= 60 || events.length < 8));
      if (event.data?.type === "runtime-result" || event.data?.type === "runtime-frame") {
        const receivedAt = performance.now();
        try {
          if (!event.data.ok) throw new Error(`${event.data.detail}; events=${JSON.stringify(events.slice(-40))}`);
          let gpu;
          let packetFixture;
          let renderError;
          if (preparedGpu && packetBuffers.length > 0) {
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
            if (options.capturePacketFixture) {
              // The exact packet bytes of this frame, captured before rendering
              // so an unsupported draw still leaves a replayable artifact for
              // first-bad-draw bisection. Only the final frame is kept.
              const encoded = encodePacketFixture(packetBuffers.map((buffer) => new Uint8Array(buffer)));
              packetFixture = {
                base64: base64Of(encoded),
                bytes: encoded.byteLength,
                packetCount: packetBuffers.length,
                drawPacketCount: decodedPackets.filter((packet) => packet.kind === PacketKind.draw).length,
                frameSequence: event.data.frameSequence,
              };
            }
            let vertexBackendComparison;
            if (options.compareVertexBackends === true) {
              const oracle = await renderPacketsToWebGPU(activeGpu, decodedPackets, {
                captureRgba: Boolean(options.captureRgba),
                dumpSurfaces: Boolean(options.dumpSurfaces),
                skipDraws: options.skipDraws,
                carriedSurfaceOps: event.data.carriedSurfaceOps,
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
            const renderOnce = () => renderPacketsToWebGPU(
              activeGpu,
              decodedPackets,
              {
                captureRgba: Boolean(options.captureRgba),
                dumpSurfaces: Boolean(options.dumpSurfaces),
                skipDraws: options.skipDraws,
                carriedSurfaceOps: event.data.carriedSurfaceOps,
                captureShaders: Boolean(options.captureShaders),
                vertexDiagnostics: options.vertexDiagnostics === true,
                textureCacheBytes: options.textureCacheBytes,
                // Readback (frame hash, changed pixels) stays on for the
                // deterministic acceptance gates; sustained runs turn it off.
                readback: options.readback !== false || Boolean(options.captureRgba),
              },
            );
            if (options.tolerateRenderErrors === true) {
              // Commercial bring-up: an unsupported RSX feature ends the run
              // with the frame's packets and the error recorded, not a throw.
              try { gpu = await renderOnce(); } catch (error) {
                renderError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
              }
            } else {
              gpu = await renderOnce();
            }
            if (gpu?.missingTextures?.length) {
              // Payloads the renderer never received (dropped or skipped packets): let the
              // packet builder forget them so the next reference carries the data again.
              worker.postMessage({ type: "texture-forget", textures: gpu.missingTextures });
            }
            if (gpu && vertexBackendComparison) {
              gpu.vertexBackendComparison = {
                ...vertexBackendComparison,
                frameHashMatch: vertexBackendComparison.oracleFrameHash === gpu.frameHash,
                changedPixelsMatch: vertexBackendComparison.oracleChangedPixels === gpu.changedPixels,
              };
            }
          }
          if (direct) {
            gpu = { direct: true, presented: presentedFrames, frameHash: presentedHash, device: event.data.directGpu, stats: event.data.directStats, width: directScratch.width, height: directScratch.height };
            const finalFrameExpected = frames.length + 1 >= requestedFrames;
            if (captureEvery && presentedFrames > 0 && (frames.length + 1) % captureEvery === 0) {
              frameImages.push({ frame: frames.length + 1, presented: presentedFrames, png: directScratch.toDataURL("image/png") });
            }
            if (frameImages.length && finalFrameExpected) gpu.frameImages = frameImages;
            if (presentedFrames > 0 && (finalFrameExpected || options.captureRgba)) {
              const pixels = directScratch.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, directScratch.width, directScratch.height).data;
              let hash = 0x811c9dc5;
              for (let i = 0; i < pixels.length; i += 1) { hash ^= pixels[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
              presentedHash = hash >>> 0;
              gpu.frameHash = presentedHash;
              if (options.captureRgba) gpu.rgbaBase64 = base64Of(pixels);
            }
          }
          const frame = {
            ...eventWithoutPackets,
            gpu,
            renderError,
            hostTimings: { waitForPacketsMs: receivedAt - frameRequestedAt, renderMs: performance.now() - receivedAt },
          };
          const finalFrame = dispatchCompletion || frames.length + 1 >= requestedFrames || Boolean(renderError)
            || (untilDraw && (frame.drawPacketCount ?? 0) > 0 && packetBuffers.length > 0);
          frames.push(compactFrame(frame, keepDetail(frames.length, finalFrame)));
          firstResult ??= frames[0];
          if (!finalFrame) {
            frameRequestedAt = performance.now();
            worker.postMessage({ type: "next-frame", discardPackets: !needsPackets(frames.length + 1), untilDraw });
            return;
          }
          clearTimeout(timeout);
          const result = { ...firstResult, ...frames.at(-1), gpu, renderError, packetFixture, events, frames: requestedFrames > 1 || untilDraw ? frames : undefined };
          document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
          // The worker waits up to 5 s for RPCS3's threads to exit and then
          // reports; allow that report to arrive before giving up on it.
          const shutdownTimer = setTimeout(() => {
            worker.terminate();
            if (activeWorker === worker) activeWorker = undefined;
            result.shutdown = { stoppedCleanly: false, detail: "no shutdown report within 8 s" };
            resolve(result);
          }, 8_000);
          const onShutdown = (shutdownEvent) => {
            if (shutdownEvent.data?.type !== "runtime-shutdown") return;
            clearTimeout(shutdownTimer);
            worker.removeEventListener("message", onShutdown);
            if (activeWorker === worker) activeWorker = undefined;
            // Stack high-water marks and the final working set are known only
            // after RPCS3's threads have exited.
            const { type: _type, ...shutdown } = shutdownEvent.data;
            result.shutdown = shutdown;
            if (shutdown.kept) {
              worker.removeEventListener("message", worker.__rpcs3Handler);
              persistentWorker = worker;
            }
            resolve(result);
          };
          worker.addEventListener("message", onShutdown);
          // A host (the acceptance runner) may need the pthread workers alive a moment longer,
          // e.g. to stop CPU profilers attached to them, before RPCS3 releases them.
          if (typeof window.__rpcs3BeforeShutdown === "function") {
            try { await window.__rpcs3BeforeShutdown(); } catch (_) {}
          }
          worker.postMessage({ type: "shutdown", keepRuntime: options.keepRuntime === true });
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
      reject(new Error(`real RPCS3 runtime worker failed: ${event.message || ""} ${event.filename || ""}:${event.lineno || 0} ${String(event.error ?? "")}; events=${JSON.stringify(events.slice(-40))}`.trim()));
    }, { once: true });
    worker.postMessage({
      type: "boot",
      directRenderer: direct,
      gpuCanvas: directCanvas,
      reuse,
      fixture,
      path: bootPath,
      returnPackets: Boolean(options.render),
      discardPackets: !needsPackets(1) && !dispatchCompletion,
      untilDraw: untilDraw && !dispatchCompletion,
      diagnostics: options.diagnostics === true,
      dumpSurfaces: options.dumpSurfaces === true,
      skipDraws: Array.isArray(options.skipDraws) ? options.skipDraws : undefined,
      vertexDiagnostics: options.vertexDiagnostics === true,
      presentLatestOnly: options.presentLatestOnly === true,
      debugAddresses: Array.isArray(options.debugAddresses) ? options.debugAddresses : [],
      pad: options.pad ?? currentPad,
      completion: dispatchCompletion ? "dispatch" : "frame",
      expectedVerdict: options.expectedVerdict ?? "",
      dispatchTimeoutMs: options.dispatchTimeoutMs ?? 30_000,
      ppuAot: options.ppuAot === true,
      ppuAotBundle: typeof options.ppuAotBundle === "string" ? options.ppuAotBundle : undefined,
      spuAotBundle: typeof options.spuAotBundle === "string" ? options.spuAotBundle : undefined,
      spuTraceRange: Array.isArray(options.spuTraceRange) ? options.spuTraceRange : undefined,
      spuFallbackHistogram: options.spuFallbackHistogram === true,
      spuAot: options.spuAot === true,
      clockScale: options.clockScale,
      resolutionScalePercent: typeof options.resolutionScale === "number" ? Math.round(options.resolutionScale * 100) : undefined,
      accurateSpuDma: options.accurateSpuDma,
      packetCaptureLevel: options.packetCaptureLevel,
      tracePc: options.tracePc,
      traceDelayPc: options.traceDelayPc,
      traceDelayMs: options.traceDelayMs,
      watchAddress: options.watchAddress,
      packetTimeoutMs: options.packetTimeoutMs ?? Math.max(1_000, timeoutMs - 5_000),
      progressIntervalMs: options.progressIntervalMs,
      pthreadPoolSize: options.pthreadPoolSize,
      coreUrl: options.coreUrl,
      inputTrace: Array.isArray(options.inputTrace) ? options.inputTrace : undefined,
      recordInputs: options.recordInputs === true,
      // RPCS3's WebGPU RSX backend always produces packets; page-side WebGPU
      // rendering is separately gated by options.render. Only an explicit
      // renderer: "null" selects NullGSRender (dispatch-only fixtures).
      renderer: options.renderer ?? "webgpu",
    }, directCanvas ? [directCanvas] : []);
  }).finally(() => { active = undefined; });
  return active;
}

// Ask the running worker for a thread/stack snapshot; it arrives as a
// runtime-progress event in the final result's event list.
function snapshot() {
  activeWorker?.postMessage({ type: "snapshot" });
}

// Frame-indexed pad states recorded from setPad() during this run.
function exportInputTrace() {
  const worker = activeWorker;
  if (!worker) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onTrace = (event) => {
      if (event.data?.type !== "input-trace") return;
      worker.removeEventListener("message", onTrace);
      resolve(event.data);
    };
    worker.addEventListener("message", onTrace);
    worker.postMessage({ type: "export-input-trace" });
  });
}

// Resolves with the worker's shutdown report (stack high-water marks per
// thread name and the final working set) once RPCS3 has stopped.
function stop() {
  stopWebGPUPresentation();
  const worker = activeWorker;
  const shutdown = new Promise((resolve) => {
    if (!worker) { resolve(undefined); return; }
    const timer = setTimeout(() => resolve(undefined), 5_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "runtime-shutdown") return;
      clearTimeout(timer);
      resolve(event.data);
    });
  });
  worker?.postMessage({ type: "shutdown" });
  if (worker) setTimeout(() => worker.terminate(), 5_000);
  activeWorker = undefined;
  releaseWebGPU(activeGpu);
  activeGpu = undefined;
  return shutdown;
}

window.__rpcs3Runtime = { run, stop, setPad, snapshot, exportInputTrace };
