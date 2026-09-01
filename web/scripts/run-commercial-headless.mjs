import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { encodePacketFixture } from "../public/rpcs3-webgpu-fixture.mjs";

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
const accurateSpuDma = process.env.RPCS3_COMMERCIAL_ACCURATE_SPU_DMA === "1"
  ? true
  : process.env.RPCS3_COMMERCIAL_ACCURATE_SPU_DMA === "0" ? false : undefined;
const renderer = process.env.RPCS3_COMMERCIAL_RENDERER === "null" ? "null" : "webgpu";
const packetCaptureLevel = Math.max(0, Math.min(4, Number(process.env.RPCS3_COMMERCIAL_PACKET_CAPTURE_LEVEL ?? 4)));
const captureRgba = process.env.RPCS3_COMMERCIAL_CAPTURE_RGBA === "1";
const captureShaders = process.env.RPCS3_COMMERCIAL_CAPTURE_SHADERS === "1";
const replayCount = Math.max(1, Math.min(10, Number(process.env.RPCS3_COMMERCIAL_REPLAY_COUNT) || 1));
const packetFixturePath = process.env.RPCS3_COMMERCIAL_PACKET_FIXTURE
  ? path.resolve(process.env.RPCS3_COMMERCIAL_PACKET_FIXTURE)
  : undefined;
const cpuProfilePath = process.env.RPCS3_COMMERCIAL_CPU_PROFILE
  ? path.resolve(process.env.RPCS3_COMMERCIAL_CPU_PROFILE)
  : undefined;
const cpuSamplingIntervalUs = Math.max(1_000, Math.min(100_000,
  Number(process.env.RPCS3_COMMERCIAL_CPU_INTERVAL_US) || 10_000));
const tracePath = process.env.RPCS3_COMMERCIAL_TRACE
  ? path.resolve(process.env.RPCS3_COMMERCIAL_TRACE)
  : undefined;
const headed = process.env.RPCS3_HEADED === "1";
// RPCS3_COMMERCIAL_CORE=profile selects the symbolized build staged by
// `RPCS3_WEB_PROFILE=1 npm run build:runtime` for CPU profiles and traces.
const coreVariant = process.env.RPCS3_COMMERCIAL_CORE === "profile" ? "profile" : "release";
const coreUrl = coreVariant === "profile" ? "./core/profile/rpcs3-web.mjs" : "./core/rpcs3-web.mjs";

// Match playwright.gpu.config.ts in both headed and headless mode so a
// headless commercial report never silently measures SwiftShader.
const chromeArgs = [
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--enable-webgpu-developer-features",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
  "--use-angle=vulkan",
];
// Same rejection rule as the hardware Playwright lane.
const softwareAdapterPattern = /SwiftShader|llvmpipe|software|CPU/i;

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: !headed,
  args: chromeArgs,
});
let capturedPacketFrame;
let workerProfiler;
let traceSession;
let traceComplete;
let activePage;

function workSampleCount(profile) {
  const waitNodes = new Set(profile.nodes
    .filter(({ callFrame }) => ["(idle)", "emscripten_futex_wait"].includes(callFrame.functionName))
    .map(({ id }) => id));
  return (profile.samples || []).reduce((count, id) => count + !waitNodes.has(id), 0);
}

async function writeCpuProfiles(targets) {
  if (!cpuProfilePath) return;
  const ranked = targets
    .filter(({ profile }) => profile)
    .sort((left, right) => workSampleCount(right.profile) - workSampleCount(left.profile));
  await mkdir(path.dirname(cpuProfilePath), { recursive: true });
  const profilePaths = new Map();
  await Promise.all(ranked.map(async (target, index) => {
    const profilePath = index === 0 ? cpuProfilePath : `${cpuProfilePath}.${index}`;
    profilePaths.set(target, profilePath);
    await writeFile(profilePath, `${JSON.stringify(target.profile)}\n`);
  }));
  await writeFile(`${cpuProfilePath}.targets.json`, `${JSON.stringify({
    samplingIntervalUs: cpuSamplingIntervalUs,
    selected: ranked[0]?.targetInfo,
    targets: targets.map((target) => ({
      targetInfo: target.targetInfo,
      profilePath: profilePaths.get(target),
      samples: target.profile?.samples?.length || 0,
      workSamples: target.profile ? workSampleCount(target.profile) : 0,
      started: Boolean(target.started),
      recursiveAttachError: target.recursiveAttachError,
      error: target.error,
    })),
  }, null, 2)}\n`);
}

function createWorkerProfiler(session, samplingIntervalUs) {
  let commandId = 0;
  const pending = new Map();
  const targets = new Map();
  const parents = new Map();
  const starts = [];

  const send = async (sessionId, method, params = {}) => {
    const id = ++commandId;
    const key = `${sessionId}:${id}`;
    const response = new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
    response.catch(() => {});
    const message = JSON.stringify({ id, method, params });
    try {
      const parentSessionId = parents.get(sessionId);
      if (parentSessionId) {
        await send(parentSessionId, "Target.sendMessageToTarget", { sessionId, message });
      } else {
        await session.send("Target.sendMessageToTarget", { sessionId, message });
      }
    } catch (error) {
      pending.delete(key);
      throw error;
    }
    return response;
  };

  const handleDetached = (sessionId) => {
    const target = targets.get(sessionId);
    if (target && !target.profile) target.error ??= "target detached before profile collection";
    for (const [key, waiter] of pending) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      pending.delete(key);
      waiter.reject(new Error("target detached"));
    }
  };

  const handleAttached = (sessionId, targetInfo, parentSessionId) => {
    if (targetInfo.type !== "worker" || targets.has(sessionId)) return;
    parents.set(sessionId, parentSessionId);
    const target = { sessionId, targetInfo };
    targets.set(sessionId, target);
    starts.push((async () => {
      try {
        await send(sessionId, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: false,
        });
      } catch (error) {
        target.recursiveAttachError = error instanceof Error ? error.message : String(error);
      }
      try {
        await send(sessionId, "Profiler.enable");
        await send(sessionId, "Profiler.setSamplingInterval", { interval: samplingIntervalUs });
        await send(sessionId, "Profiler.start");
        target.started = true;
      } catch (error) {
        target.error = error instanceof Error ? error.message : String(error);
      }
    })());
  };

  const handleMessage = (sessionId, message) => {
    const payload = JSON.parse(message);
    if (payload.id) {
      const waiter = pending.get(`${sessionId}:${payload.id}`);
      if (!waiter) return;
      pending.delete(`${sessionId}:${payload.id}`);
      if (payload.error) waiter.reject(new Error(`${payload.error.code}: ${payload.error.message}`));
      else waiter.resolve(payload.result || {});
      return;
    }
    if (payload.method === "Target.receivedMessageFromTarget") {
      handleMessage(payload.params.sessionId, payload.params.message);
    } else if (payload.method === "Target.attachedToTarget") {
      handleAttached(payload.params.sessionId, payload.params.targetInfo, sessionId);
    } else if (payload.method === "Target.detachedFromTarget") {
      handleDetached(payload.params.sessionId);
    }
  };
  session.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    handleMessage(sessionId, message);
  });
  session.on("Target.detachedFromTarget", ({ sessionId }) => handleDetached(sessionId));
  session.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    handleAttached(sessionId, targetInfo, undefined);
  });

  return {
    async start() {
      await session.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
    },
    async stop() {
      await Promise.allSettled(starts);
      await Promise.all([...targets.values()].map(async (target) => {
        if (!target.started) return;
        try {
          const { profile } = await send(target.sessionId, "Profiler.stop");
          target.profile = profile;
        } catch (error) {
          target.error = error instanceof Error ? error.message : String(error);
        }
      }));
      await session.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
      return [...targets.values()];
    },
  };
}

async function stopTrace() {
  if (!traceSession || !traceComplete) return;
  await traceSession.send("Tracing.end");
  const { stream } = await traceComplete;
  let trace = "";
  while (true) {
    const chunk = await traceSession.send("IO.read", { handle: stream });
    trace += chunk.data;
    if (chunk.eof) break;
  }
  await traceSession.send("IO.close", { handle: stream });
  await mkdir(path.dirname(tracePath), { recursive: true });
  await writeFile(tracePath, trace);
  traceSession = undefined;
  traceComplete = undefined;
}

try {
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  activePage = page;
  if (packetFixturePath) {
    await page.exposeFunction("__rpcs3CapturePacketFrame", (packetBase64, metadata) => {
      capturedPacketFrame = {
        metadata,
        packets: packetBase64.map((encoded) => new Uint8Array(Buffer.from(encoded, "base64"))),
      };
    });
  }
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

  if (cpuProfilePath) {
    const profilerSession = await context.newCDPSession(page);
    workerProfiler = createWorkerProfiler(profilerSession, cpuSamplingIntervalUs);
    await workerProfiler.start();
  }
  if (tracePath) {
    traceSession = await context.newCDPSession(page);
    traceComplete = new Promise((resolve) => traceSession.once("Tracing.tracingComplete", resolve));
    await traceSession.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: [
          "toplevel",
          "v8",
          "v8.execute",
          "v8.wasm",
          "disabled-by-default-v8.cpu_profiler",
          "disabled-by-default-v8.cpu_profiler.hires",
        ],
      },
    });
  }

  await page.goto(`${baseURL}/storage.html`, { waitUntil: "domcontentloaded" });
  const execution = await page.evaluate(async ({ bootPath: guestPath, timeout, requestedFrames, presentToCanvas, untilDraw, renderInterval, captureFrameRgba, captureShaderPrograms, repeatedRenders, capturePacketFixture, watchedAddresses, tracedPc, tracedDelayPc, tracedDelayMs, watchedWriteAddress, guestClockScale, guestCoreUrl, guestAccurateSpuDma, guestRenderer, guestPacketCaptureLevel }) => {
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
      globalThis.__rpcs3CommercialWorker = worker;
      const events = [];
      const frames = [];
      let lastProgress;
      let lastFrame;
      const needsPackets = (frameNumber) => untilDraw || (
        renderInterval > 0 && ((frameNumber - 1) % renderInterval === 0 || frameNumber === requestedFrames)
      );
      const finish = (terminal) => {
        clearTimeout(timer);
        resolve({ terminal, lastProgress, lastFrame, events, frames });
      };
      let timer = setTimeout(() => {
        worker.postMessage({ type: "snapshot" });
        timer = setTimeout(() => finish({
          type: "timeout",
          detail: `commercial boot exceeded ${timeout} ms`,
          lastProgress,
          lastFrame,
        }), 5_000);
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
            const nextFrameNumber = frames.length + 1;
            const shouldRender = serializable.drawPacketCount > 0 && (
              untilDraw ||
              (renderInterval > 0 && (frames.length % renderInterval === 0 || nextFrameNumber === requestedFrames))
            );
            const decodedPackets = shouldRender
              ? packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer)))
              : [];
            if (capturePacketFixture && shouldRender && (untilDraw || nextFrameNumber === requestedFrames)) {
              const packetBase64 = packetBuffers.map((buffer) => {
                const bytes = new Uint8Array(buffer);
                let binary = "";
                for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
                  binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
                }
                return btoa(binary);
              });
              await globalThis.__rpcs3CapturePacketFrame(packetBase64, {
                frameSequence: serializable.frameSequence,
                packetCount: serializable.packetCount,
                drawPacketCount: serializable.drawPacketCount,
                flipPacketCount: serializable.flipPacketCount,
              });
            }
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
              worker.postMessage({ type: "next-frame", discardPackets: !needsPackets(frames.length + 1) });
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
        coreUrl: guestCoreUrl,
        packetTimeoutMs: Math.max(1_000, timeout - 5_000),
        progressIntervalMs: 1_000,
        debugAddresses: watchedAddresses,
        tracePc: tracedPc,
        traceDelayPc: tracedDelayPc,
        traceDelayMs: tracedDelayMs,
        watchAddress: watchedWriteAddress,
        clockScale: guestClockScale,
        accurateSpuDma: guestAccurateSpuDma,
        renderer: guestRenderer,
        packetCaptureLevel: guestPacketCaptureLevel,
        discardPackets: !needsPackets(1),
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
    capturePacketFixture: Boolean(packetFixturePath),
    watchedAddresses: debugAddresses,
    tracedPc: tracePc,
    tracedDelayPc: traceDelayPc,
    tracedDelayMs: traceDelayMs,
    watchedWriteAddress: watchAddress,
    guestClockScale: clockScale,
    guestCoreUrl: coreUrl,
    guestAccurateSpuDma: accurateSpuDma,
    guestRenderer: renderer,
    guestPacketCaptureLevel: packetCaptureLevel,
  });

  const { capabilities, run } = execution;
  if (workerProfiler) {
    await writeCpuProfiles(await workerProfiler.stop());
    workerProfiler = undefined;
  }
  await stopTrace();
  const adapterIdentity = [
    capabilities.adapter.vendor,
    capabilities.adapter.architecture,
    capabilities.adapter.device,
    capabilities.adapter.description,
  ].filter(Boolean).join(" \u00b7 ");
  const softwareAdapter = capabilities.adapter.isFallbackAdapter || softwareAdapterPattern.test(adapterIdentity);
  const completed = Boolean(
    run.terminal?.ok &&
    !softwareAdapter &&
    (stopAtFirstDraw
      ? run.frames.some((frame) => frame.drawPacketCount > 0)
      : run.frames.length >= frameCount)
  );
  const report = {
    bootPath,
    adapter: adapterIdentity,
    softwareAdapter,
    clockScale,
    coreVariant,
    capabilities,
    acceptance: {
      completed,
      softwareAdapterRejected: softwareAdapter,
      requestedFrames: frameCount,
      completedFrames: run.frames.length,
      stopAtFirstDraw,
    },
    run,
    browserConsole,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json);
  }
  if (packetFixturePath) {
    if (!capturedPacketFrame) throw new Error("the requested commercial packet frame was not captured");
    await mkdir(path.dirname(packetFixturePath), { recursive: true });
    const fixture = gzipSync(encodePacketFixture(capturedPacketFrame.packets), { level: 9 });
    await writeFile(packetFixturePath, fixture);
    await writeFile(`${packetFixturePath}.json`, `${JSON.stringify({
      bootPath,
      ...capturedPacketFrame.metadata,
      compressedBytes: fixture.byteLength,
      uncompressedBytes: capturedPacketFrame.packets.reduce((sum, packet) => sum + packet.byteLength, 0),
      gpu: run.terminal.gpu && {
        width: run.terminal.gpu.width,
        height: run.terminal.gpu.height,
        draws: run.terminal.gpu.draws,
        vertices: run.terminal.gpu.vertices,
        changedPixels: run.terminal.gpu.changedPixels,
        changedBounds: run.terminal.gpu.changedBounds,
        frameHash: run.terminal.gpu.frameHash,
      },
    }, null, 2)}\n`);
  }
  if (!completed) process.exitCode = 1;
} finally {
  if (workerProfiler) {
    try {
      await writeCpuProfiles(await workerProfiler.stop());
    } catch {}
  }
  if (traceSession) {
    try {
      await stopTrace();
    } catch {}
  }
  if (activePage) {
    try {
      await activePage.evaluate(() => {
        globalThis.__rpcs3CommercialWorker?.terminate();
        delete globalThis.__rpcs3CommercialWorker;
      });
    } catch {}
  }
  await context.close();
}
