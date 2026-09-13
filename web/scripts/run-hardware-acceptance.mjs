import { createWorkerProfiler, writeCpuProfiles } from "./worker-profiler.mjs";
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
import { hardwareChromeArgs } from "./chrome-gpu.mjs";
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
const baseURL = env.RPCS3_WEB_URL || "https://rpcs3.appmana.com";
const headed = env.RPCS3_HEADED !== "0";
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
const coreVariant = ["release", "profile", "jspi", "profile-jspi"].includes(env.RPCS3_CORE) ? env.RPCS3_CORE : "auto";
const inputTrace = env.RPCS3_INPUT_TRACE ? JSON.parse(await readFile(path.resolve(env.RPCS3_INPUT_TRACE), "utf8")).entries : undefined;
const runOptions = {
  frames,
  untilDraw,
  renderEvery,
  timeoutMs,
  render: env.RPCS3_RENDERER !== "null",
  renderer: env.RPCS3_RENDERER === "null" ? "null" : "webgpu",
  directRenderer: env.RPCS3_DIRECT_RENDERER === undefined ? undefined : env.RPCS3_DIRECT_RENDERER === "1",
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
  ppuJit: env.RPCS3_PPU_JIT === undefined ? undefined : env.RPCS3_PPU_JIT === "1",
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
  coreUrl: env.RPCS3_CORE_URL || (coreVariant === "auto" ? undefined : `./core/${coreVariant === "release" ? "" : coreVariant + "/"}rpcs3-web.mjs`),
  suspending: coreVariant === "auto" ? undefined : coreVariant.endsWith("jspi"),
  tracePc: env.RPCS3_TRACE_PC ? Number(env.RPCS3_TRACE_PC) : undefined,
  traceDelayPc: env.RPCS3_TRACE_DELAY_PC ? Number(env.RPCS3_TRACE_DELAY_PC) : undefined,
  traceDelayMs: env.RPCS3_TRACE_DELAY_MS ? Number(env.RPCS3_TRACE_DELAY_MS) : undefined,
  watchAddress: env.RPCS3_WATCH_ADDRESS ? Number(env.RPCS3_WATCH_ADDRESS) : undefined,
  debugAddresses: env.RPCS3_DEBUG_ADDRESSES ? env.RPCS3_DEBUG_ADDRESSES.split(",").map((value) => Number(value)) : [],
  progressIntervalMs: 1_000,
};
// Same flags and rejection rule as playwright.gpu.config.ts / the GPU specs.
const chromeArgs = hardwareChromeArgs();
const softwareAdapterPattern = /SwiftShader|llvmpipe|software|CPU/i;

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: !headed,
  args: chromeArgs,
});
let workerProfiler;
let traceSession;
let traceComplete;

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
      await writeCpuProfiles(await profiler.stop(), cpuProfilePath, cpuSamplingIntervalUs);
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
    try { return await runtime.run(target, options); }
    catch (error) {
      // Serialize partial evidence here: Playwright does not transport custom
      // Error properties when page.evaluate rejects across the process boundary.
      return { ...error.partial, ok: false, detail: String(error), stack: error.stack };
    }
  }, { target, options: runOptions });
  const elapsedMs = Date.now() - startedAt;
  if (workerProfiler) {
    await writeCpuProfiles(await workerProfiler.stop(), cpuProfilePath, cpuSamplingIntervalUs);
    workerProfiler = undefined;
  }
  await stopTrace();

  const frameList = result.frames ?? [result];
  const completed = Boolean(result.ok) && !result.renderError
    && (untilDraw ? frameList.some((frame) => (frame.drawPacketCount ?? 0) > 0) : (result.emuFlipId ?? result.workingSet?.flipCounter ?? frameList.length) >= frames);
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
    try { await writeCpuProfiles(await workerProfiler.stop(), cpuProfilePath, cpuSamplingIntervalUs); } catch {}
  }
  try { await stopTrace(); } catch {}
  await context.close();
}
