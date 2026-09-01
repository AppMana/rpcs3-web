import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const bootPath = process.argv[2];
if (!bootPath?.startsWith("/opfs/")) {
  process.stderr.write("usage: npm run commercial:headless -- /opfs/games/<disc.iso> [result.json]\n");
  process.exit(2);
}

const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const profilePath = process.env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");
const baseURL = process.env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
const timeoutMs = Number(process.env.RPCS3_COMMERCIAL_TIMEOUT_MS || 120_000);
const frameCount = Math.max(1, Math.min(3_600, Number(process.env.RPCS3_COMMERCIAL_FRAMES || 1)));
const stopAtFirstDraw = process.env.RPCS3_COMMERCIAL_UNTIL_DRAW === "1";
const renderEvery = Math.max(0, Number(process.env.RPCS3_COMMERCIAL_RENDER_EVERY ?? 1));
const debugAddresses = (process.env.RPCS3_COMMERCIAL_DEBUG_ADDRESSES || "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 0))
  .filter(Number.isFinite)
  .map((value) => value >>> 0);
const tracePc = Number.parseInt(process.env.RPCS3_COMMERCIAL_TRACE_PC || "0", 0) >>> 0;
const traceDelayPc = Number.parseInt(process.env.RPCS3_COMMERCIAL_TRACE_DELAY_PC || "0", 0) >>> 0;
const traceDelayMs = Math.max(0, Math.min(10_000, Number(process.env.RPCS3_COMMERCIAL_TRACE_DELAY_MS) || 0));
const watchAddress = Number.parseInt(process.env.RPCS3_COMMERCIAL_WATCH_ADDRESS || "0", 0) >>> 0;
const clockScale = Math.max(0, Math.min(3_000, Number(process.env.RPCS3_COMMERCIAL_CLOCK_SCALE) || 0));
const captureRgba = process.env.RPCS3_COMMERCIAL_CAPTURE_RGBA === "1";
const captureShaders = process.env.RPCS3_COMMERCIAL_CAPTURE_SHADERS === "1";
const replayCount = Math.max(1, Math.min(10, Number(process.env.RPCS3_COMMERCIAL_REPLAY_COUNT) || 1));
const headed = process.env.RPCS3_HEADED === "1";

const chromeArgs = [
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--enable-webgpu-developer-features",
  "--ignore-gpu-blocklist",
];
if (headed) {
  chromeArgs.push("--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--use-angle=vulkan");
}

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: !headed,
  args: chromeArgs,
});

try {
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  const browserConsole = [];
  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    browserConsole.push(line);
    process.stderr.write(`${line}\n`);
  });
  page.on("pageerror", (error) => {
    const line = `[pageerror] ${error.stack || error.message}`;
    browserConsole.push(line);
    process.stderr.write(`${line}\n`);
  });

  await page.goto(`${baseURL}/storage.html`, { waitUntil: "domcontentloaded" });
  const execution = await page.evaluate(async ({ bootPath: guestPath, timeout, requestedFrames, presentToCanvas, untilDraw, renderInterval, captureFrameRgba, captureShaderPrograms, repeatedRenders, watchedAddresses, tracedPc, tracedDelayPc, tracedDelayMs, watchedWriteAddress, guestClockScale }) => {
    const [{ decodeDrawPacket }, { prepareWebGPU, renderPacketsToWebGPU }] = await Promise.all([
      import("./rpcs3-webgpu-packet.mjs"),
      import("./rpcs3-webgpu-renderer.mjs"),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    document.body.prepend(canvas);
    const gpu = await prepareWebGPU(canvas, { presentation: presentToCanvas });
    const info = gpu.adapter.info;
    const capabilities = {
      crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      webGpu: true,
      adapter: {
        vendor: info?.vendor || "",
        architecture: info?.architecture || "",
        device: info?.device || "",
        description: info?.description || "",
        isFallbackAdapter: Boolean(info?.isFallbackAdapter),
        features: [...gpu.adapter.features].sort(),
      },
      userAgent: navigator.userAgent,
    };
    const run = await new Promise((resolve) => {
      const worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
      const events = [];
      const frames = [];
      let lastProgress;
      let lastFrame;
      const finish = (terminal) => {
        clearTimeout(timer);
        worker.terminate();
        resolve({ terminal, lastProgress, lastFrame, events, frames });
      };
      let timer = setTimeout(() => {
        worker.postMessage({ type: "snapshot" });
        timer = setTimeout(() => finish({
          type: "timeout",
          detail: `commercial boot exceeded ${timeout} ms`,
          lastProgress,
          lastFrame,
        }), 1_000);
      }, timeout);
      worker.addEventListener("message", async (event) => {
        const { packetBuffers = [], ...serializable } = event.data ?? {};
        events.push(serializable);
        if (serializable.type === "runtime-progress") lastProgress = serializable;
        if (serializable.type === "runtime-log") console.log(serializable.line);
        if (serializable.type === "runtime-fatal") {
          finish(serializable);
          return;
        }
        if (serializable.type === "runtime-result" || serializable.type === "runtime-frame") {
          try {
            const shouldRender = serializable.drawPacketCount > 0 || (renderInterval > 0 && frames.length % renderInterval === 0);
            const decodedPackets = shouldRender
              ? packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer)))
              : [];
            const rendered = shouldRender
              ? await renderPacketsToWebGPU(gpu, decodedPackets, {
                  replayPresentation: false,
                  captureRgba: captureFrameRgba,
                  captureShaders: captureShaderPrograms,
                })
              : { presented: false, skipped: true };
            if (shouldRender && repeatedRenders > 1) {
              rendered.replays = [];
              for (let replay = 1; replay < repeatedRenders; replay += 1) {
                const repeated = await renderPacketsToWebGPU(gpu, decodedPackets, { replayPresentation: false });
                rendered.replays.push({
                  changedPixels: repeated.changedPixels,
                  frameHash: repeated.frameHash,
                  timings: repeated.timings,
                  pipelineCache: repeated.pipelineCache,
                  textureCache: repeated.textureCache,
                });
              }
            }
            const frame = { ...serializable, gpu: rendered };
            frames.push(frame);
            lastFrame = frame;
            if (serializable.ok && frames.length < requestedFrames && (!untilDraw || serializable.drawPacketCount === 0)) {
              worker.postMessage({ type: "next-frame" });
            } else {
              finish(frame);
            }
          } catch (error) {
            finish({ type: "runtime-render-error", detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), runtime: serializable });
          }
        }
      });
      worker.addEventListener("error", (event) => {
        finish({
          type: "worker-error",
          detail: `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
          error: event.error?.stack ?? String(event.error ?? ""),
        });
      }, { once: true });
      worker.postMessage({
        type: "boot",
        path: guestPath,
        returnPackets: true,
        packetTimeoutMs: Math.max(1_000, timeout - 5_000),
        progressIntervalMs: 1_000,
        debugAddresses: watchedAddresses,
        tracePc: tracedPc,
        traceDelayPc: tracedDelayPc,
        traceDelayMs: tracedDelayMs,
        watchAddress: watchedWriteAddress,
        clockScale: guestClockScale,
      });
    });
    return { capabilities, run };
  }, {
    bootPath,
    timeout: timeoutMs,
    requestedFrames: frameCount,
    presentToCanvas: headed,
    untilDraw: stopAtFirstDraw,
    renderInterval: renderEvery,
    captureFrameRgba: captureRgba,
    captureShaderPrograms: captureShaders,
    repeatedRenders: replayCount,
    watchedAddresses: debugAddresses,
    tracedPc: tracePc,
    tracedDelayPc: traceDelayPc,
    tracedDelayMs: traceDelayMs,
    watchedWriteAddress: watchAddress,
    guestClockScale: clockScale,
  });

  const { capabilities, run } = execution;
  const report = { bootPath, capabilities, run, browserConsole };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json);
  }
  if (!["runtime-result", "runtime-frame", "runtime-fatal"].includes(run.terminal.type)) process.exitCode = 1;
} finally {
  await context.close();
}
