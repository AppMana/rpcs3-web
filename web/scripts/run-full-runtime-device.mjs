// Transfers the local RPCS3 runtime build to an attached iPad through WebKit
// Inspector (the kit's injected lane), boots a fixture on the device, and
// judges the cube animation or Tetris gameplay evidence in Node. The page
// side is RPCS3's own driver: the packet renderer and the runtime worker
// wired through Blob URLs.
//
//   node scripts/run-full-runtime-device.mjs [outputDir] [fixture]
//   RPCS3_DEVICE_HARD_RESET=1  WIP_DISCOVERY_URL  WIP_TIMEOUT_MS
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyRewrites, runInjectedLane } from "@appmana-public/web-emulator-harness/device-lanes";
import { connectCurrentPage, delay, openPage } from "@appmana-public/web-emulator-harness/webkit-inspector";

const outputDirectory = path.resolve(process.argv[2] || "device-runtime-evidence");
const fixtureName = process.argv[3] || "gs_gcm_cube.elf";
const discoveryURL = process.env.WIP_DISCOVERY_URL;
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 180_000);
const isTetris = fixtureName.includes("tetris");
const log = (line) => process.stdout.write(`${line}\n`);
const inspector = { discoveryURL, timeoutMs, commandTimeoutMs: timeoutMs, log };
const root = path.resolve(import.meta.dirname, "..");
const source = (relative) => readFile(path.join(root, "public", relative));

// The release glue is whitespace-minified; match the pthread worker
// constructor with or without spaces.
let coreSource = (await source("core/rpcs3-web.mjs")).toString("utf8");
const pthreadConstructor = /new Worker\(new URL\("rpcs3-web\.mjs",\s*import\.meta\.url\),\s*\{/;
if (!pthreadConstructor.test(coreSource)) throw new Error("Emscripten pthread worker constructor changed");
coreSource = coreSource.replace(pthreadConstructor, "new Worker(import.meta.url, {");
// A Blob URL module cannot resolve relative specifiers, so every static import
// of the renderer and the worker is uploaded and rewritten to its own Blob URL.
const rendererSource = applyRewrites((await source("rpcs3-webgpu-renderer.mjs")).toString("utf8"), [
  { from: '"./rpcs3-webgpu-packet.mjs"', to: '"__DEVICE_PACKET_URL__"' },
]);
const workerSource = applyRewrites((await source("runtime-smoke-worker.mjs")).toString("utf8"), [
  { from: '"./rpcs3-webgpu-packet.mjs"', to: '"__DEVICE_PACKET_URL__"' },
  { from: '"./rpcs3-ppu-dispatcher.mjs"', to: '"__DEVICE_PPU_DISPATCHER_URL__"' },
  { from: '"./rpcs3-spu-dispatcher.mjs"', to: '"__DEVICE_SPU_DISPATCHER_URL__"' },
]);
for (const marker of ["event.data.coreUrl", "event.data.wasmUrl", "event.data.fixtureUrl"]) {
  if (!workerSource.includes(marker)) throw new Error(`worker no longer honours ${marker}`);
}

// A previous run's worker is shut down cooperatively, then a cross-origin
// round trip makes WebKit discard orphaned workers and release the 512 MiB
// Wasm reservation before reinjection.
const current = await connectCurrentPage(inspector);
const originalPageUrl = current.page.url;
let reset = process.env.RPCS3_DEVICE_HARD_RESET === "1";
if (await current.connection.evaluate("Boolean(globalThis.__rpcs3DeviceWorker || globalThis.__rpcs3FullDeviceResult)")) {
  await current.connection.evaluate(`new Promise((resolve) => {
    const worker = globalThis.__rpcs3DeviceWorker;
    if (!worker) { resolve(false); return; }
    const timer = setTimeout(() => resolve(false), 5_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "runtime-shutdown") return;
      clearTimeout(timer);
      resolve(Boolean(event.data.ok));
    }, { once: true });
    worker.postMessage({ type: "shutdown" });
  })`, true);
  reset = true;
}
current.connection.close();
if (reset) {
  const away = await openPage(`https://example.com/?rpcs3-reset=${Date.now()}`, inspector);
  away.connection.close();
  await delay(4_000);
  const back = await openPage(originalPageUrl, inspector);
  back.connection.close();
  await delay(5_000);
}

const { passed, evidence } = await runInjectedLane({
  emulator: "rpcs3",
  evidenceDir: outputDirectory,
  discoveryURL,
  timeoutMs,
  log,
  requiredPrerequisites: ["secureContext", "crossOriginIsolated", "sharedArrayBuffer", "webGpu"],
  uploadSlot: "__rpcs3DeviceUpload",
  urlsSlot: "__rpcs3DeviceUrls",
  modules: [
    { name: "packet", bytes: await source("rpcs3-webgpu-packet.mjs"), mime: "text/javascript" },
    { name: "ppuDispatcher", bytes: await source("rpcs3-ppu-dispatcher.mjs"), mime: "text/javascript" },
    { name: "spuDispatcher", bytes: await source("rpcs3-spu-dispatcher.mjs"), mime: "text/javascript" },
    { name: "renderer", bytes: Buffer.from(rendererSource), mime: "text/javascript", rewrites: [{ from: "__DEVICE_PACKET_URL__", toModule: "packet" }] },
    { name: "worker", bytes: Buffer.from(workerSource), mime: "text/javascript", rewrites: [
      { from: "__DEVICE_PACKET_URL__", toModule: "packet" },
      { from: "__DEVICE_PPU_DISPATCHER_URL__", toModule: "ppuDispatcher" },
      { from: "__DEVICE_SPU_DISPATCHER_URL__", toModule: "spuDispatcher" },
    ] },
    { name: "core", bytes: Buffer.from(coreSource), mime: "text/javascript" },
    { name: "wasm", bytes: await source("core/rpcs3-web.wasm"), mime: "application/wasm" },
    { name: "fixture", bytes: await source(`fixtures/${fixtureName}`), mime: "application/octet-stream" },
  ],
  driverContext: { fixtureName, timeoutMs, isTetris },
  driver: `async (urls, context) => {
    const { fixtureName, timeoutMs, isTetris } = context;
    document.querySelector("#full-rpcs3-device-test")?.remove();
    const panel = document.createElement("section");
    panel.id = "full-rpcs3-device-test";
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#202020;color:white;padding:12px;font:12px monospace;overflow:auto";
    panel.innerHTML = '<h2 style="margin:0 0 8px">Full RPCS3 Wasm → WebGPU · ' + fixtureName + '</h2><canvas id="full-rpcs3-device-output" width="320" height="180" style="width:min(100%,960px);image-rendering:auto"></canvas><pre id="full-rpcs3-device-log">booting…</pre>';
    document.body.append(panel);
    const canvas = panel.querySelector("canvas");
    const log = panel.querySelector("pre");
    const [{ decodeDrawPacket }, renderer] = await Promise.all([import(urls.packet), import(urls.renderer)]);
    const prepared = await renderer.prepareWebGPU(canvas);
    globalThis.__rpcs3DeviceGpu = prepared;

    const worker = new Worker(urls.worker, { type: "module" });
    globalThis.__rpcs3DeviceWorker = worker;
    let requestedAt = 0;
    const receiveFrame = (expectedType, captureRgba) => new Promise((resolve, reject) => {
      requestedAt = performance.now();
      const timer = setTimeout(() => reject(new Error("full RPCS3 device runtime timed out")), timeoutMs);
      const onError = (event) => {
        clearTimeout(timer);
        reject(new Error("full RPCS3 device worker failed: " + (event.message || "") + " " + (event.filename || "") + ":" + (event.lineno || 0) + " " + String(event.error || "")));
      };
      const onMessage = async (event) => {
        if (event.data?.type !== expectedType) return;
        clearTimeout(timer);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("message", onMessage);
        try {
          const { packetBuffers = [], ...runtimeResult } = event.data;
          if (!runtimeResult.ok) throw new Error(runtimeResult.detail);
          const receivedAt = performance.now();
          const gpu = await renderer.renderPacketsToWebGPU(
            prepared,
            packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer))),
            // The Tetris movement gate compares CPU clip bounds, which the WGSL
            // vertex path only computes when explicitly requested.
            { captureRgba, readback: captureRgba || !isTetris, replayPresentation: true, vertexDiagnostics: true },
          );
          const waitForPacketsMs = requestedAt ? receivedAt - requestedAt : 0;
          resolve({ ...runtimeResult, gpu, hostTimings: { waitForPacketsMs, renderMs: performance.now() - receivedAt } });
        } catch (error) { reject(error); }
      };
      worker.addEventListener("error", onError, { once: true });
      worker.addEventListener("message", onMessage);
    });
    const firstFrame = receiveFrame("runtime-result", false);
    worker.postMessage({ type: "boot", fixture: "fixtures/" + fixtureName, fixtureUrl: urls.fixture, coreUrl: urls.core, wasmUrl: urls.wasm, returnPackets: true, debugAddresses: [] });
    const frames = [await firstFrame];
    let runtime;
    if (isTetris) {
      // Queued frames arrive without a round trip now, so the title screen's
      // guest-time countdown spans several hundred flips of harness time.
      while (frames.at(-1).gpu.draws < 9 && frames.length < 900) {
        const nextFrame = receiveFrame("runtime-frame", false);
        worker.postMessage({ type: "next-frame" });
        frames.push(await nextFrame);
      }
      if (frames.at(-1).gpu.draws < 9) throw new Error("Tetris did not enter gameplay within " + frames.length + " guest flips: draws=" + JSON.stringify(frames.map((f) => f.gpu.draws)) + " ppu=" + JSON.stringify(frames.map((f) => f.ppuInstructions)) + " skips=" + JSON.stringify(frames.map((f) => f.presentedSkips)));
      const center = (frame) => frame.gpu.drawDiagnostics.slice(-4)
        .reduce((sum, draw) => sum + (draw.clipBounds.min[0] + draw.clipBounds.max[0]) / 2, 0) / 4;
      // Output-based movement evidence: the mean column of green block pixels
      // in the rendered frame, independent of CPU vertex diagnostics.
      const blockCentroidX = (frame) => {
        const rgba = Uint8Array.from(atob(frame.gpu.rgbaBase64), (character) => character.charCodeAt(0));
        let sum = 0;
        let count = 0;
        for (let y = 0; y < frame.gpu.height; y += 1) {
          for (let x = 0; x < frame.gpu.width; x += 1) {
            const offset = (y * frame.gpu.width + x) * 4;
            const red = rgba[offset], green = rgba[offset + 1], blue = rgba[offset + 2];
            if (green > red * 1.4 && green > blue * 1.15) { sum += x; count += 1; }
          }
        }
        return count ? sum / count : NaN;
      };
      // Capture one readback frame before input so the before/after
      // comparison uses the same output-based measurement.
      const beforeFrameCapture = receiveFrame("runtime-frame", true);
      worker.postMessage({ type: "next-frame" });
      frames.push(await beforeFrameCapture);
      const beforeInput = {
        frameSequence: frames.at(-1).frameSequence,
        ppuInstructions: frames.at(-1).ppuInstructions,
        activeCenterX: center(frames.at(-1)),
        blockCentroidX: blockCentroidX(frames.at(-1)),
      };
      delete frames.at(-1).gpu.rgbaBase64;
      const inputStartedAt = performance.now();
      worker.postMessage({ type: "pad", state: { digital1: 0x20 } });
      for (let index = 0; index < 20; index += 1) {
        const nextFrame = receiveFrame("runtime-frame", index === 19);
        worker.postMessage({ type: "next-frame" });
        frames.push(await nextFrame);
      }
      worker.postMessage({ type: "pad", state: { digital1: 0 } });
      const finalFrame = frames.at(-1);
      const frameTimings = frames.slice(-20).map((frame) => ({
        captureMs: frame.captureMs,
        waitForPacketsMs: frame.hostTimings?.waitForPacketsMs,
        renderMs: frame.hostTimings?.renderMs,
        gpu: frame.gpu.timings,
      }));
      runtime = {
        ...frames[0],
        gpu: finalFrame.gpu,
        workingSet: finalFrame.workingSet,
        stackReport: finalFrame.stackReport,
        tetris: {
          totalFrames: frames.length,
          beforeInput,
          afterInput: {
            frameSequence: finalFrame.frameSequence,
            ppuInstructions: finalFrame.ppuInstructions,
            activeCenterX: center(finalFrame),
            blockCentroidX: blockCentroidX(finalFrame),
          },
          inputWindowMs: performance.now() - inputStartedAt,
          frameTimings,
          elapsedMs: finalFrame.elapsedMs,
          droppedPackets: finalFrame.droppedPackets,
        },
      };
    } else {
      for (let index = 1; index < 3; index += 1) {
        const nextFrame = receiveFrame("runtime-frame", index === 2);
        worker.postMessage({ type: "next-frame" });
        frames.push(await nextFrame);
      }
      const animationFrames = frames.map((frame) => ({
        frameSequence: frame.frameSequence,
        ppuInstructions: frame.ppuInstructions,
        elapsedMs: frame.elapsedMs,
        droppedPackets: frame.droppedPackets,
        frameHash: frame.gpu.frameHash,
        timings: frame.gpu.timings,
        hostTimings: frame.hostTimings,
        captureMs: frame.captureMs,
        changedBounds: frame.gpu.changedBounds,
        cubeClipBounds: frame.gpu.drawDiagnostics[0]?.clipBounds,
      }));
      runtime = {
        ...frames[0],
        gpu: frames.at(-1).gpu,
        workingSet: frames.at(-1).workingSet,
        stackReport: frames.at(-1).stackReport,
        animationFrames,
      };
    }
    const rgba = Uint8Array.from(atob(runtime.gpu.rgbaBase64), (character) => character.charCodeAt(0));
    const colors = new Set();
    let magentaPixels = 0;
    let textPixels = 0;
    let lightTextPixels = 0;
    let backgroundPixels = 0;
    let blockPixels = 0;
    for (let y = 0; y < runtime.gpu.height; y += 1) {
      for (let x = 0; x < runtime.gpu.width; x += 1) {
        const offset = (y * runtime.gpu.width + x) * 4;
        const red = rgba[offset], green = rgba[offset + 1], blue = rgba[offset + 2];
        colors.add((red << 16) | (green << 8) | blue);
        backgroundPixels += red >= 160 && red <= 190 && green >= 160 && green <= 190 && blue >= 160 && blue <= 190 ? 1 : 0;
        blockPixels += green > red * 1.4 && green > blue * 1.15 ? 1 : 0;
        magentaPixels += red > green + 20 && blue > green + 20 && red > 80 && blue > 80 ? 1 : 0;
        if (x < 140 && y < 40 && (red !== 32 || green !== 32 || blue !== 32)) {
          textPixels += 1;
          lightTextPixels += red > 96 && green > 96 && blue > 96 ? 1 : 0;
        }
      }
    }
    runtime.rgbaBase64 = runtime.gpu.rgbaBase64;
    delete runtime.gpu.rgbaBase64;
    runtime.imageEvidence = { colors: colors.size, magentaPixels, textPixels, lightTextPixels, backgroundPixels, blockPixels };
    log.textContent = JSON.stringify(runtime, null, 2);
    globalThis.__rpcs3FullDeviceResult = runtime;
    return runtime;
  }`,
  // The raw frame becomes frame.png; it leaves the result so the report stays readable.
  frameOf: (result) => {
    const rgbaBase64 = result?.rgbaBase64;
    if (result) delete result.rgbaBase64;
    return rgbaBase64 && result.gpu?.width && result.gpu?.height ? { width: result.gpu.width, height: result.gpu.height, rgbaBase64 } : undefined;
  },
  judge: (result) => {
    const commonPassed = result?.ok
      && result.bootResult === 0
      && result.gpu?.adapter?.toLowerCase().includes("apple");
    const tetrisPassed = commonPassed
      && result.gpu?.draws === 9
      && result.gpu?.vertices === 49
      && result.tetris?.totalFrames >= 21
      && result.tetris?.afterInput?.ppuInstructions > result.tetris?.beforeInput?.ppuInstructions
      && result.tetris?.afterInput?.activeCenterX > result.tetris?.beforeInput?.activeCenterX + 0.09
      && result.tetris?.afterInput?.blockCentroidX > result.tetris?.beforeInput?.blockCentroidX
      && result.tetris?.droppedPackets === 0
      && result.gpu?.pipelineCache?.hits === 9
      && result.gpu?.pipelineCache?.misses === 0
      && result.imageEvidence?.backgroundPixels > 10_000
      && result.imageEvidence?.blockPixels > 100;
    const cubePassed = commonPassed
      && result.gpu?.draws === 2
      && result.gpu?.vertices === 162
      && result.gpu?.depthStates?.[0]?.comparison === "less"
      && result.gpu?.targetStates?.[1]?.blendEnabled === true
      && result.animationFrames?.length === 3
      // Frames may already be queued when requested (RSX runs ahead of the
      // harness), so consecutive captures can share a PPU count; the run as a
      // whole must still advance, and every frame must be a distinct guest frame.
      && result.animationFrames[1]?.ppuInstructions >= result.animationFrames[0]?.ppuInstructions
      && result.animationFrames[2]?.ppuInstructions >= result.animationFrames[1]?.ppuInstructions
      && result.animationFrames[2]?.ppuInstructions > result.animationFrames[0]?.ppuInstructions
      && new Set(result.animationFrames.map((frame) => frame.frameHash)).size === result.animationFrames.length
      && new Set(result.animationFrames.map((frame) => JSON.stringify(frame.cubeClipBounds))).size === result.animationFrames.length
      && result.animationFrames.every((frame) => frame.droppedPackets === 0)
      && result.imageEvidence?.colors > 128
      && result.imageEvidence?.magentaPixels > 1_000
      && result.imageEvidence?.textPixels > 100
      && result.imageEvidence?.textPixels < 1_000
      && result.imageEvidence?.lightTextPixels > 50;
    return Boolean(isTetris ? tetrisPassed : cubePassed);
  },
});
process.stdout.write(`${JSON.stringify({ ...evidence, fixture: fixtureName }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
