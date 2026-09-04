// Hardware (physical-adapter) acceptance runner. Drives the same page API
// (`__rpcs3Runtime.run`) as the Playwright lanes and the hosted-origin iPad
// runner, from a persistent Chrome profile whose origin-private storage holds
// firmware and games. This is the one desktop runner for homebrew fixtures and
// commercial titles alike; it only adds browser launch, adapter gating,
// evidence files, and optional CPU profiles/traces.
//
//   node scripts/run-hardware-acceptance.mjs <fixtures/x.elf | /opfs/games/x.iso> [report.json]
//
// Environment:
//   RPCS3_WEB_URL=http://127.0.0.1:4175   origin (keep it stable: OPFS is per origin)
//   RPCS3_CHROME_PROFILE=~/.cache/rpcs3-web-chrome-profile
//   RPCS3_CHROME_PATH=/usr/bin/google-chrome   RPCS3_HEADED=1
//   RPCS3_FRAMES=1 (max 3600)   RPCS3_UNTIL_DRAW=1   RPCS3_RENDER_EVERY=1
//   RPCS3_TIMEOUT_MS=120000   RPCS3_WIDTH=1280 RPCS3_HEIGHT=720   RPCS3_READBACK=0|1
//   RPCS3_CLOCK_SCALE=<percent>   RPCS3_ACCURATE_SPU_DMA=1   RPCS3_RENDERER=webgpu|null
//   RPCS3_PACKET_CAPTURE_LEVEL=0..5   RPCS3_POOL_SIZE=12   RPCS3_CORE=release|profile|jspi
//   RPCS3_PACKET_FIXTURE=/path/frame.wgpf.gz   RPCS3_CAPTURE_RGBA=1   RPCS3_CAPTURE_SHADERS=1
//   RPCS3_CPU_PROFILE=/path/run.cpuprofile   RPCS3_CPU_INTERVAL_US=10000   RPCS3_TRACE=/path/trace.json
//   RPCS3_PPU_JIT=1   RPCS3_PPU_JIT_THRESHOLD=64   RPCS3_PPU_JIT_CAPACITY=65536
//   RPCS3_WATCH_ADDRESS / RPCS3_TRACE_PC / RPCS3_TRACE_DELAY_PC / RPCS3_TRACE_DELAY_MS / RPCS3_DEBUG_ADDRESSES=a,b
//   RPCS3_INPUT_TRACE=/path/trace.json   frame-indexed pad states recorded on play.html
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: run-hardware-acceptance.mjs <fixtures/x.elf | /opfs/games/x.iso> [report.json]\n");
  process.exit(2);
}
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const env = process.env;
const profilePath = env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");
const baseURL = env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
const headed = env.RPCS3_HEADED === "1";
const untilDraw = env.RPCS3_UNTIL_DRAW === "1";
// Until-draw runs keep going up to the cap unless a smaller frame budget is given explicitly. A
// commercial title spends thousands of flips on its logos, boot and intro before it reaches
// gameplay — LittleBigPlanet 2's first heavy frame is around flip 3500 — so a performance run needs
// a budget well past that to have a gameplay window at all.
const frames = Math.max(1, Math.min(20_000, Number(env.RPCS3_FRAMES) || (untilDraw ? 3600 : 1)));
const renderEvery = Math.max(1, Number(env.RPCS3_RENDER_EVERY) || 1);
const timeoutMs = Math.max(5_000, Number(env.RPCS3_TIMEOUT_MS) || 120_000);
const width = Number(env.RPCS3_WIDTH) || 1280;
const height = Number(env.RPCS3_HEIGHT) || 720;
const packetFixturePath = env.RPCS3_PACKET_FIXTURE ? path.resolve(env.RPCS3_PACKET_FIXTURE) : undefined;
const captureRgba = env.RPCS3_CAPTURE_RGBA === "1";
const captureShaders = env.RPCS3_CAPTURE_SHADERS === "1";
const readback = env.RPCS3_READBACK ? env.RPCS3_READBACK === "1" : Boolean(packetFixturePath || captureRgba);
const cpuProfilePath = env.RPCS3_CPU_PROFILE ? path.resolve(env.RPCS3_CPU_PROFILE) : undefined;
const cpuSamplingIntervalUs = Math.max(1_000, Math.min(100_000, Number(env.RPCS3_CPU_INTERVAL_US) || 10_000));
const tracePath = env.RPCS3_TRACE ? path.resolve(env.RPCS3_TRACE) : undefined;
const coreVariant = ["profile", "jspi"].includes(env.RPCS3_CORE) ? env.RPCS3_CORE : "release";
const inputTrace = env.RPCS3_INPUT_TRACE ? JSON.parse(await readFile(path.resolve(env.RPCS3_INPUT_TRACE), "utf8")).entries : undefined;
const runOptions = {
  frames,
  untilDraw,
  renderEvery,
  timeoutMs,
  render: env.RPCS3_RENDERER !== "null",
  renderer: env.RPCS3_RENDERER === "null" ? "null" : "webgpu",
  directRenderer: env.RPCS3_DIRECT_RENDERER === "1",
  captureEvery: env.RPCS3_CAPTURE_EVERY ? Number(env.RPCS3_CAPTURE_EVERY) : undefined,
  width,
  height,
  readback,
  captureRgba,
  captureShaders,
  capturePacketFixture: Boolean(packetFixturePath),
  ppuAotBundle: process.env.RPCS3_PPU_AOT_BUNDLE || undefined,
  spuAotBundle: process.env.RPCS3_SPU_AOT_BUNDLE || undefined,
  spuFallbackHistogram: env.RPCS3_SPU_FALLBACK_HIST === "1",
  spuDecoder: env.RPCS3_SPU_DECODER || undefined,
  ppuProfile: env.RPCS3_PPU_PROFILE === "1",
  ppuJit: env.RPCS3_PPU_JIT === "1",
  ppuJitThreshold: Number(env.RPCS3_PPU_JIT_THRESHOLD) || undefined,
  ppuJitCapacity: Number(env.RPCS3_PPU_JIT_CAPACITY) || undefined,
  spuBlockSize: env.RPCS3_SPU_BLOCK_SIZE || undefined,
  spuLlvmWorkers: Number(env.RPCS3_SPU_LLVM_WORKERS) || undefined,
  spuHotThreshold: Number(env.RPCS3_SPU_HOT_THRESHOLD) || undefined,
  spuWasmSelftestBase64: env.RPCS3_SPU_WASM_SELFTEST ? readFileSync(path.resolve(env.RPCS3_SPU_WASM_SELFTEST)).toString("base64") : undefined,
  diagnostics: env.RPCS3_DIAGNOSTICS === "1",
  dumpSurfaces: env.RPCS3_DUMP_SURFACES === "1",
  skipDraws: env.RPCS3_SKIP_DRAWS ? env.RPCS3_SKIP_DRAWS.split(",").flatMap((item) => { const [a, b] = item.split("-").map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i); }) : undefined,
  vertexDiagnostics: env.RPCS3_VERTEX_DIAGNOSTICS === "1",
  spuTraceRange: env.RPCS3_SPU_TRACE_RANGE ? env.RPCS3_SPU_TRACE_RANGE.split("-").map((value) => Number(value)) : undefined,
  tolerateRenderErrors: env.RPCS3_TOLERATE_RENDER_ERRORS !== "0",
  inputTrace,
  clockScale: env.RPCS3_CLOCK_SCALE ? Number(env.RPCS3_CLOCK_SCALE) : undefined,
  resolutionScale: env.RPCS3_RESOLUTION_SCALE ? Number(env.RPCS3_RESOLUTION_SCALE) : undefined,
  accurateSpuDma: env.RPCS3_ACCURATE_SPU_DMA ? env.RPCS3_ACCURATE_SPU_DMA === "1" : undefined,
  packetCaptureLevel: env.RPCS3_PACKET_CAPTURE_LEVEL ? Number(env.RPCS3_PACKET_CAPTURE_LEVEL) : undefined,
  pthreadPoolSize: env.RPCS3_POOL_SIZE ? Number(env.RPCS3_POOL_SIZE) : undefined,
  coreUrl: coreVariant === "release" ? undefined : `./core/${coreVariant}/rpcs3-web.mjs`,
  suspending: coreVariant === "jspi",
  tracePc: env.RPCS3_TRACE_PC ? Number(env.RPCS3_TRACE_PC) : undefined,
  traceDelayPc: env.RPCS3_TRACE_DELAY_PC ? Number(env.RPCS3_TRACE_DELAY_PC) : undefined,
  traceDelayMs: env.RPCS3_TRACE_DELAY_MS ? Number(env.RPCS3_TRACE_DELAY_MS) : undefined,
  watchAddress: env.RPCS3_WATCH_ADDRESS ? Number(env.RPCS3_WATCH_ADDRESS) : undefined,
  debugAddresses: env.RPCS3_DEBUG_ADDRESSES ? env.RPCS3_DEBUG_ADDRESSES.split(",").map((value) => Number(value)) : [],
  progressIntervalMs: 1_000,
};
// Same flags and rejection rule as playwright.gpu.config.ts / the GPU specs.
const chromeArgs = [
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--enable-webgpu-developer-features",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
];
const softwareAdapterPattern = /SwiftShader|llvmpipe|software|CPU/i;

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: !headed,
  args: chromeArgs,
});
let workerProfiler;
let traceSession;
let traceComplete;

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
  const page = context.pages()[0] ?? await context.newPage();
  const browserConsole = [];
  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    if (browserConsole.length < 2_000) browserConsole.push(line);
    if (message.type() === "error") process.stderr.write(`${line}\n`);
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
    // Stop the profilers while the pthread workers still exist (the page tears them down
    // during its shutdown report).
    await page.exposeFunction("__rpcs3BeforeShutdown", async () => {
      if (!workerProfiler) return;
      const profiler = workerProfiler;
      workerProfiler = undefined;
      await writeCpuProfiles(await profiler.stop());
    });
  }
  if (tracePath) {
    traceSession = await context.newCDPSession(page);
    traceComplete = new Promise((resolve) => traceSession.once("Tracing.tracingComplete", resolve));
    await traceSession.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: ["toplevel", "v8", "v8.execute", "v8.wasm", "disabled-by-default-v8.cpu_profiler", "disabled-by-default-v8.cpu_profiler.hires"],
      },
    });
  }

  await page.goto(`${baseURL}/runtime.html`, { waitUntil: "domcontentloaded" });
  // WebGPU adapter acquisition is occasionally refused while another browser
  // instance is tearing down; probe it before booting and retry with reloads.
  let capabilities;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    capabilities = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" }) ?? await navigator.gpu?.requestAdapter();
      const info = adapter?.info ?? {};
      return {
        crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer === "function",
        webGpu: Boolean(adapter),
        adapter: adapter ? { vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "", description: info.description || "", isFallbackAdapter: Boolean(info.isFallbackAdapter), features: [...adapter.features].sort() } : undefined,
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
      };
    });
    if (capabilities.webGpu) break;
    process.stderr.write(`WebGPU adapter unavailable (attempt ${attempt}); reloading\n`);
    await page.waitForTimeout(1_000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  const adapterIdentity = capabilities.adapter
    ? [capabilities.adapter.vendor, capabilities.adapter.architecture, capabilities.adapter.device, capabilities.adapter.description].filter(Boolean).join(" \u00b7 ")
    : "";
  const softwareAdapter = !capabilities.webGpu || capabilities.adapter.isFallbackAdapter || softwareAdapterPattern.test(adapterIdentity);
  if (softwareAdapter && runOptions.render) {
    throw new Error(`hardware WebGPU adapter required, got ${JSON.stringify(capabilities.adapter ?? null)}`);
  }

  const startedAt = Date.now();
  const result = await page.evaluate(async ({ target, options }) => {
    const runtime = window.__rpcs3Runtime;
    if (!runtime) throw new Error("runtime acceptance API is unavailable");
    return runtime.run(target, options);
  }, { target, options: runOptions });
  const elapsedMs = Date.now() - startedAt;
  if (workerProfiler) {
    await writeCpuProfiles(await workerProfiler.stop());
    workerProfiler = undefined;
  }
  await stopTrace();

  const frameList = result.frames ?? [result];
  const completed = Boolean(result.ok) && !result.renderError
    && (untilDraw ? frameList.some((frame) => (frame.drawPacketCount ?? 0) > 0) : frameList.length >= frames);
  const { packetFixture, ...resultWithoutFixture } = result;
  const rgbaBase64 = result.gpu?.rgbaBase64;
  if (result.spuMissBase64) {
    // Recorded SPU AOT misses in SPU cache format: append to the title's native cache and rerun the IR dump
    await writeFile(outputPath.replace(/\.json$/, "") + ".spu-misses.dat", Buffer.from(result.spuMissBase64, "base64"));
    delete result.spuMissBase64;
  }
  if (result.ppuProfileBase64) {
    // Guest addresses this run entered, little-endian u32s, for building a profile-guided PPU bundle
    await writeFile(outputPath.replace(/\.json$/, "") + ".ppu-used.bin", Buffer.from(result.ppuProfileBase64, "base64"));
    delete result.ppuProfileBase64;
    delete resultWithoutFixture.ppuProfileBase64;
  }
  for (const image of result.gpu?.frameImages ?? []) {
    const data = String(image.png).replace(/^data:image\/png;base64,/, "");
    await writeFile(outputPath.replace(/\.json$/, "") + `.frame${image.frame}.png`, Buffer.from(data, "base64"));
  }
  if (result.gpu?.frameImages) result.gpu = { ...result.gpu, frameImages: result.gpu.frameImages.map((image) => ({ frame: image.frame, presented: image.presented })) };
  const surfaceDumps = result.gpu?.surfaceDumps;
  if (resultWithoutFixture.gpu) resultWithoutFixture.gpu = { ...resultWithoutFixture.gpu, rgbaBase64: undefined, surfaceDumps: undefined };
  const percentile = (values, fraction) => {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : undefined;
  };
  const rendered = frameList.filter((frame) => frame.gpu);
  const report = {
    target,
    baseURL,
    adapter: adapterIdentity,
    softwareAdapter,
    coreVariant,
    options: runOptions,
    capabilities,
    acceptance: {
      completed,
      softwareAdapterRejected: softwareAdapter,
      requestedFrames: frames,
      completedFrames: frameList.length,
      renderedFrames: rendered.length,
      untilDraw,
      elapsedMs,
    },
    summary: {
      bootResult: result.bootResult,
      renderError: result.renderError,
      moduleCreateMs: result.moduleCreateMs,
      droppedPackets: frameList.reduce((sum, frame) => sum + (frame.droppedPackets ?? 0), 0),
      presentedSkips: frameList.at(-1)?.presentedSkips,
      lastPpuInstructions: frameList.at(-1)?.ppuInstructions,
      lastSpuInstructions: frameList.at(-1)?.spuInstructions,
      captureMs: { p50: percentile(frameList.map((frame) => frame.captureMs), 0.5), p95: percentile(frameList.map((frame) => frame.captureMs), 0.95) },
      waitForPacketsMs: { p50: percentile(frameList.map((frame) => frame.hostTimings?.waitForPacketsMs), 0.5), p95: percentile(frameList.map((frame) => frame.hostTimings?.waitForPacketsMs), 0.95) },
      renderMs: { p50: percentile(rendered.map((frame) => frame.hostTimings?.renderMs), 0.5), p95: percentile(rendered.map((frame) => frame.hostTimings?.renderMs), 0.95) },
      lastGpu: result.gpu && { draws: result.gpu.draws, vertices: result.gpu.vertices, frameHash: result.gpu.frameHash, changedPixels: result.gpu.changedPixels, timings: result.gpu.timings, pipelineCache: result.gpu.pipelineCache, textureCache: result.gpu.textureCache },
      workingSet: frameList.at(-1)?.workingSet,
      shutdown: result.shutdown && { stoppedCleanly: result.shutdown.stoppedCleanly, stopMs: result.shutdown.stopMs, liveThreadNames: result.shutdown.liveThreadNames, maxStackUsedBytes: Math.max(0, ...(result.shutdown.stackReport ?? []).map((entry) => entry.usedBytes)), workingSet: result.shutdown.workingSet },
    },
    packetFixture: packetFixture && { path: packetFixturePath, ...packetFixture, base64: undefined },
    result: resultWithoutFixture,
    browserConsole,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(`${JSON.stringify({ target, adapter: adapterIdentity, acceptance: report.acceptance, summary: report.summary }, null, 2)}\n`);
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json);
    if (rgbaBase64 && result.gpu?.width && result.gpu?.height) {
      const png = new PNG({ width: result.gpu.width, height: result.gpu.height });
      png.data.set(Buffer.from(rgbaBase64, "base64"));
      await writeFile(outputPath.replace(/\.json$/, "") + ".frame.png", PNG.sync.write(png));
    }
    for (const dump of surfaceDumps ?? []) {
      const png = new PNG({ width: dump.width, height: dump.height });
      png.data.set(Buffer.from(dump.rgbaBase64, "base64"));
      await writeFile(`${outputPath.replace(/\.json$/, "")}.${dump.key.replace(/[^a-z0-9]+/gi, "_")}.png`, PNG.sync.write(png));
    }
  }
  if (packetFixturePath) {
    if (!packetFixture) throw new Error("the requested packet fixture frame was not captured");
    await mkdir(path.dirname(packetFixturePath), { recursive: true });
    const fixture = gzipSync(Buffer.from(packetFixture.base64, "base64"), { level: 9 });
    await writeFile(packetFixturePath, fixture);
    await writeFile(`${packetFixturePath}.json`, `${JSON.stringify({
      target,
      adapter: adapterIdentity,
      frameSequence: packetFixture.frameSequence,
      packetCount: packetFixture.packetCount,
      drawPacketCount: packetFixture.drawPacketCount,
      uncompressedBytes: packetFixture.bytes,
      compressedBytes: fixture.byteLength,
      gpu: report.summary.lastGpu,
    }, null, 2)}\n`);
  }
  if (!completed) process.exitCode = 1;
} finally {
  if (workerProfiler) {
    try { await writeCpuProfiles(await workerProfiler.stop()); } catch {}
  }
  try { await stopTrace(); } catch {}
  await context.close();
}
