// Headful playback benchmark. Usage: node scripts/run-performance.mjs <target> <output-directory>
import { sampleThreads } from "./linux-thread-sampler.mjs";
import { hardwareChromeArgs } from "./chrome-gpu.mjs";
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { createWorkerProfiler, writeCpuProfiles } from "./worker-profiler.mjs";

const target = process.argv[2];
if (!target) throw new Error("usage: run-performance.mjs <target> <output-directory>");
const output = path.resolve(process.argv[3] || "performance-evidence");
await mkdir(output, { recursive: true });
const origin = process.env.RPCS3_WEB_URL || "https://rpcs3.appmana.com";
const profilePath = process.env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache/rpcs3-web-chrome-profile");
const lockPath = `${profilePath}.benchmark-lock`;
const lock = await open(lockPath, "wx");
await lock.writeFile(`${process.pid}\n`);
const runId = randomUUID();
const streaming = process.env.RPCS3_TRACE === "1";
let traceSession, traceFinished;
const report = {
  schemaVersion: 2, runId, target, origin,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  patchHash: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"),
  spuDispatchCache: process.env.RPCS3_SPU_DISPATCH_CACHE !== "0",
  spuExecutionSlices: process.env.RPCS3_SPU_EXECUTION_SLICES !== "0",
  ppuBatchedDiagnostics: process.env.RPCS3_PPU_BATCHED_DIAGNOSTICS !== "0",
  spuChainEdges: process.env.RPCS3_SPU_CHAIN_EDGES === "1",
  core: process.env.RPCS3_CORE || "jspi", frames: [], processSamples: [], failures: [], console: [],
};
const threadTicks = process.env.RPCS3_THREAD_CPU === "1"
  ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) : 0;
if (threadTicks) { report.threadTicksPerSecond = threadTicks; report.threadSamples = []; }
const durationMs = Number(process.env.RPCS3_DURATION_MS || 0);
const frameBudget = Number(process.env.RPCS3_FRAMES || (durationMs ? Number.MAX_SAFE_INTEGER : 6000));
const edgeFrom = Number(process.env.RPCS3_EDGE_FROM_FRAME || 4500);
const edgeTo = Number(process.env.RPCS3_EDGE_TO_FRAME || 5200);
const timeoutMs = Number(process.env.RPCS3_TIMEOUT_MS || 1_200_000);
// A loaded board can take >30s to serve the 17.9MB transpiler blob over the runner's
// pre-boot artifact check; bound the per-request fetch cap (default 60s) instead of
// inheriting playwright's 30s request timeout that spuriously fails slow-boards.
const fetchTimeoutMs = Number(process.env.RPCS3_FETCH_TIMEOUT_MS || 60_000);
let context, profiler, perf, perfFinished;
let perfStarted = false;
const stopPerf = async () => {
  if (!perf) return;
  report.perfWindow.stoppedAt = Date.now();
  perf.kill("SIGINT");
  report.perfExit = await perfFinished;
  perf = undefined;
};
const profileFrom = Number(process.env.RPCS3_PROFILE_FROM_FRAME || 0);
const profileTo = Number(process.env.RPCS3_PROFILE_TO_FRAME || Infinity);
let profileStarted = false;
const save = () => writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
try {
  if (report.spuChainEdges && (!Number.isSafeInteger(edgeFrom) || edgeFrom < 0 || !Number.isSafeInteger(edgeTo) || edgeTo <= edgeFrom || edgeTo > frameBudget)) {
    throw new Error("edge profile requires 0 <= from < to <= frame budget");
  }
  const args = hardwareChromeArgs();
  if (process.env.RPCS3_V8_FLAGS) args.push(`--js-flags=${process.env.RPCS3_V8_FLAGS}`);
  report.chromeArgs = args;
  if (process.env.RPCS3_DEBUG_PORT) args.push(`--remote-debugging-port=${Number(process.env.RPCS3_DEBUG_PORT)}`);
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
    headless: false, viewport: { width: 1280, height: 720 }, args,
  });
  report.networkFailures = [];
  context.on("requestfailed", (request) => {
    if (report.networkFailures.length >= 100) report.networkFailures.shift();
    report.networkFailures.push({ at: Date.now(), url: request.url(), error: request.failure()?.errorText });
  });
  report.browser = context.browser().version();
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => report.failures.push({ type: "pageerror", message: error.stack }));
  page.on("crash", () => report.failures.push({ type: "crash" }));
  page.on("console", (message) => {
    if (report.console.length >= 1000) report.console.shift();
    report.console.push({ type: message.type(), text: message.text().slice(0, 4000) });
  });
  await page.goto(`${origin}/storage.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__rpcs3Storage));
  report.capabilities = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    return { isolated: crossOriginIsolated, secure: isSecureContext,
      adapter: adapter && { ...Object.fromEntries(["vendor", "architecture", "device", "description"].map((key) => [key, adapter.info[key]])), fallback: adapter.info.isFallbackAdapter, features: [...adapter.features] },
      hardwareConcurrency: navigator.hardwareConcurrency };
  });
  if (!report.capabilities.isolated || !report.capabilities.adapter || report.capabilities.adapter.fallback
      || /swiftshader|llvmpipe|software/i.test(JSON.stringify(report.capabilities.adapter))) throw new Error("hardware WebGPU and cross-origin isolation required");
  if (target.startsWith("/opfs/")) {
    const exists = await page.evaluate(async (target) => {
      const entries = await window.__rpcs3Storage.list(20_000);
      return entries.some((entry) => `/opfs/${entry.path}` === target);
    }, target);
    if (!exists) {
      console.log(`importing ${target} into ${origin}`);
      const destination = target.split("/").at(-2);
      report.import = await page.evaluate(({ name, destination }) => window.__rpcs3Storage.importFromLibrary(name, destination), { name: target.split("/").at(-1), destination });
    }
  }
  const session = await context.newCDPSession(page);
  const browserSession = await context.browser().newBrowserCDPSession();
  report.systemInfo = await browserSession.send("SystemInfo.getInfo");
  if (streaming) {
    traceSession = browserSession;
    const available = new Set((await traceSession.send("Tracing.getCategories")).categories);
    const categories = ["toplevel", "cc", "viz", "gpu", "v8", "v8.execute", "v8.wasm", "blink.user_timing", "disabled-by-default-v8.cpu_profiler"].filter((name) => available.has(name));
    traceFinished = new Promise((resolve) => traceSession.once("Tracing.tracingComplete", resolve));
    await traceSession.send("Tracing.start", { transferMode: "ReturnAsStream", categories: categories.join(",") });
  }
  await session.send("Performance.enable");
  const timestamp = async () => (await session.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "Timestamp").value * 1e6;
  const before = await timestamp();
  const epochUs = await page.evaluate(() => (performance.timeOrigin + performance.now()) * 1000);
  const after = await timestamp();
  report.clock = { offsetUs: (before + after) / 2 - epochUs, uncertaintyUs: (after - before) / 2 };
  const samplingIntervalUs = Number(process.env.RPCS3_CPU_INTERVAL_US || 5000);
  if (process.env.RPCS3_PROFILE === "1" && profileFrom === 0) {
    profileStarted = true;
    profiler = createWorkerProfiler(session, samplingIntervalUs);
    await profiler.start();
  }
  const corePath = `core/${report.core === "release" ? "" : report.core + "/"}rpcs3-web.wasm`;
  report.artifacts = {};
  for (const resource of [corePath, corePath.replace(/\.wasm$/, ".mjs"), "play-runtime.mjs", "runtime-smoke-worker.mjs", "rpcs3-runtime-session.mjs", "local-aot/index.json"]) {
    const response = await context.request.get(`${origin}/${resource}`, { timeout: fetchTimeoutMs });
    if (!response.ok()) throw new Error(`artifact ${resource}: ${response.status()}`);
    report.artifacts[resource] = createHash("sha256").update(await response.body()).digest("hex");
  }
  // The runtime compiler changes generated code too; identify its actual bytes.
  const compilerUrl = new URL(process.env.RPCS3_LLVM_COMPILER || "core/rpcs3-spu-llvm.mjs", `${origin}/`);
  const compilerWasmUrl = new URL(compilerUrl);
  compilerWasmUrl.pathname = compilerWasmUrl.pathname.replace(/\.mjs$/, ".wasm");
  for (const url of [compilerUrl, compilerWasmUrl]) {
    const response = await context.request.get(url.href, { timeout: fetchTimeoutMs });
    if (!response.ok()) throw new Error(`compiler artifact ${url}: ${response.status()}`);
    report.artifacts[url.href] = createHash("sha256").update(await response.body()).digest("hex");
  }
  // Isolated experiments can rebuild a bundle at the same URL. Capture the
  // bytes actually served before boot, not just its name or claimed checksum.
  for (const bundle of [process.env.RPCS3_PPU_AOT, process.env.RPCS3_SPU_AOT].filter(Boolean)) {
    const manifestUrl = new URL(bundle, `${origin}/`);
    manifestUrl.hash = "";
    const response = await context.request.get(manifestUrl.href, { timeout: fetchTimeoutMs });
    if (!response.ok()) throw new Error(`AOT manifest ${manifestUrl}: ${response.status()}`);
    const bytes = await response.body();
    report.artifacts[manifestUrl.href] = createHash("sha256").update(bytes).digest("hex");
    const manifest = JSON.parse(bytes.toString());
    if (!Array.isArray(manifest.parts)) throw new Error(`AOT manifest has no parts: ${manifestUrl}`);
    for (const part of manifest.parts) {
      const url = new URL(part.url, manifestUrl);
      const wasm = await context.request.get(url.href, { timeout: fetchTimeoutMs });
      if (!wasm.ok()) throw new Error(`AOT part ${url}: ${wasm.status()}`);
      const hash = createHash("sha256").update(await wasm.body()).digest("hex");
      report.artifacts[url.href] = hash;
      if (part.sha256 && hash !== part.sha256) throw new Error(`AOT checksum mismatch: ${url}`);
    }
  }
  const query = new URLSearchParams({ ...(target.startsWith("fixtures/") ? { fixture: target } : { boot: target }), core: report.core, benchmark: runId, spuDispatchCache: report.spuDispatchCache ? "1" : "0", spuExecutionSlices: report.spuExecutionSlices ? "1" : "0" });
  for (const [key, value] of Object.entries({ bindGroupCache: process.env.RPCS3_BIND_GROUP_CACHE, presentationYield: process.env.RPCS3_PRESENTATION_YIELD, ppuAot: process.env.RPCS3_PPU_AOT, ppuInlineReads: process.env.RPCS3_PPU_INLINE_READS, llvmCompiler: process.env.RPCS3_LLVM_COMPILER, ppuBatchedDiagnostics: process.env.RPCS3_PPU_BATCHED_DIAGNOSTICS, spuAot: process.env.RPCS3_SPU_AOT,
    spuDecoder: process.env.RPCS3_SPU_DECODER, spuLlvmWorkers: process.env.RPCS3_SPU_LLVM_WORKERS, clockScale: process.env.RPCS3_CLOCK_SCALE, introSkip: process.env.RPCS3_INTRO_SKIP, introSkipScale: process.env.RPCS3_INTRO_SKIP_SCALE, introDrawsThreshold: process.env.RPCS3_INTRO_DRAWS_THRESHOLD, introDrawsRun: process.env.RPCS3_INTRO_DRAWS_RUN, autoStartSec: process.env.RPCS3_AUTO_START_SEC, spuBlockSize: process.env.RPCS3_SPU_BLOCK_SIZE, spuHotThreshold: process.env.RPCS3_SPU_HOT_THRESHOLD, ppuJitThreshold: process.env.RPCS3_PPU_JIT_THRESHOLD })) {
    if (value) query.set(key, value);
  }
  if (process.env.RPCS3_INPUT_TRACE) {
    const trace = JSON.parse(await readFile(process.env.RPCS3_INPUT_TRACE, "utf8"));
    await page.route("**/benchmark-input.json", (route) => route.fulfill({ json: trace }));
    query.set("trace", `${origin}/benchmark-input.json`);
    report.inputTrace = trace;
  }
  // Retain explicit bundle/decoder overrides as well as the core hashes. Two
  // runs of the same core can otherwise silently compare different AOT policies.
  report.playUrl = `${origin}/play.html?${query}`;
  report.requestedPlayback = Object.fromEntries(query);
  await page.goto(report.playUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  const deadline = Date.now() + (durationMs || timeoutMs);
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.__rpcs3Playable?.status());
    const processes = await browserSession.send("SystemInfo.getProcessInfo");
    const hostStat = (await readFile("/proc/stat", "utf8")).split("\n", 1)[0].trim().split(/\s+/).slice(1).map(Number);
    (report.hostCpuSamples ??= []).push({ hostTimeMs: Date.now(), ticks: hostStat });
    report.processSamples.push({ hostTimeMs: Date.now(), processes: processes.processInfo });
    // Keep host contention evidence alongside browser CPU counters. Raw cumulative
    // counters allow matched-window analysis without conflating other jobs with Chrome.
    if (process.platform === "linux") {
      const readings = await Promise.allSettled(["/proc/pressure/cpu", "/proc/loadavg"]
        .map((file) => readFile(file, "utf8")));
      (report.hostSamples ??= []).push({ hostTimeMs: Date.now(),
        ...Object.fromEntries(readings.map((result, i) => [
          ["cpuPressure", "loadavg"][i],
          result.status === "fulfilled" ? result.value : { error: result.reason?.code ?? String(result.reason) },
        ])),
      });
    }
    if (threadTicks) report.threadSamples.push({ hostTimeMs: Date.now(),
      threads: await sampleThreads(processes.processInfo.map((process) => process.id), threadTicks) });
    if (state) {
      report.status = state;
      if (process.env.RPCS3_PERF === "1" && !perfStarted && state.frames >= profileFrom) {
        perfStarted = true;
        const pids = processes.processInfo.map((process) => process.id);
        // DWARF samples plus V8 mapping bursts overflowed the default ring in
        // profile-ppu-slices. Reserve 2048 pages per ring for subsequent captures.
        const perfArgs = ["record", "-m", "2048", "-k", "1", "-F", "99", "-e", "cycles:u", "--call-graph", "dwarf,4096",
          "-o", path.join(output, "browser.perf"), "-p", pids.join(",")];
        report.perfWindow = { startedAt: Date.now(), startedAtFrame: state.frames, pids, args: perfArgs };
        perf = spawn("perf", perfArgs, { stdio: ["ignore", "ignore", "pipe"] });
        report.perfLog = "";
        perf.stderr.on("data", (data) => { report.perfLog += data; });
        perfFinished = new Promise((resolve) => {
          perf.once("error", (error) => resolve({ error: error.message }));
          perf.once("exit", (code, signal) => resolve({ code, signal }));
        });
      }
      if (perf && state.frames >= profileTo) {
        report.perfWindow.stoppedAtFrame = state.frames;
        await stopPerf();
      }
      if (process.env.RPCS3_PROFILE === "1" && !profileStarted && state.frames >= profileFrom) {
        profileStarted = true;
        profiler = createWorkerProfiler(session, samplingIntervalUs);
        await profiler.start();
        report.profileWindow = { startedAtFrame: state.frames, startedAt: Date.now() };
      }
      if (profiler && state.frames >= profileTo) {
        const stoppedAt = Date.now();
        await writeCpuProfiles(await profiler.stop(), path.join(output, "run.cpuprofile"), samplingIntervalUs);
        profiler = undefined;
        report.profileWindow = { ...report.profileWindow, stoppedAtFrame: state.frames, stoppedAt };
      }
      if (state.state === "failed") throw new Error(state.detail);
      if (report.spuChainEdges && state.state === "running") {
        report.edgeWindow ??= { requestedFrom: edgeFrom, requestedTo: edgeTo };
        for (const [key, frame] of [["begin", edgeFrom], ["end", edgeTo]]) {
          if (state.frames >= frame && !report.edgeWindow[key]) {
            const snapshot = await page.evaluate(() => window.__rpcs3Playable?.exportSpuChainEdges());
            if (!snapshot || snapshot.error) throw new Error(snapshot?.error || "missing SPU edge snapshot");
            report.edgeWindow[key] = snapshot;
          }
        }
      }
      if (Date.now() - lastProgress >= 10_000) {
        console.log(JSON.stringify(state)); lastProgress = Date.now();
        const partial = await page.evaluate(() => window.__rpcs3Playable?.benchmark());
        report.frames = partial?.frames ?? [];
        if (report.frames.length && report.frames.at(-1).bindGroupCache !== (process.env.RPCS3_BIND_GROUP_CACHE === "1")) throw new Error("Bind group cache policy mismatch");
        if (process.env.RPCS3_BIND_GROUP_CACHE === "1" && state.frames >= 4500 && !(report.frames.at(-1)?.directStats?.bindGroupHits > 0)) throw new Error("Requested bind cache recorded no reuse in gameplay");
        const actualYield = report.frames.at(-1)?.presentationYield;
        if (report.frames.length && actualYield !== (process.env.RPCS3_PRESENTATION_YIELD ?? "timer")) throw new Error(`Presentation yield mismatch: ${actualYield}`);
        const compilation = report.frames.at(-1)?.compilation;
        if (compilation) {
          if (compilation.ppuInlineReads !== (process.env.RPCS3_PPU_INLINE_READS === "1")) throw new Error("runtime PPU inline-read policy does not match requested setting");
          if (compilation.compilerUrl !== compilerUrl.href) throw new Error("runtime compiler URL does not match recorded artifact");
        }
        report.flipTimings = partial?.flipTimings;
        await save();
      }
      if (state.frames >= frameBudget) break;
    }
    if (report.failures.length) throw new Error("browser failed");
    await page.waitForTimeout(1000);
  }
  report.completed = durationMs ? report.status?.frames > 0 : report.status?.frames >= frameBudget;
  const benchmark = await page.evaluate(() => window.__rpcs3Playable?.benchmark());
  report.frames = benchmark?.frames ?? [];
  report.flipTimings = benchmark?.flipTimings;
  report.timingDrops = benchmark?.timingDrops;
  report.observationDrops = benchmark?.observationDrops;
  report.inputTrace ??= await page.evaluate(() => window.__rpcs3Playable?.exportInputTrace());
  if (report.spuChainEdges && !report.edgeWindow?.end) {
    report.edgeWindow ??= {};
    report.edgeWindow.end = await page.evaluate(() => window.__rpcs3Playable?.exportSpuChainEdges());
    if (report.edgeWindow.end?.error) throw new Error(report.edgeWindow.end.error);
  }
  await page.screenshot({ path: path.join(output, "frame.png") });
  if (profiler) {
    await writeCpuProfiles(await profiler.stop(), path.join(output, "run.cpuprofile"), samplingIntervalUs);
    profiler = undefined;
  }
  report.shutdown = await page.evaluate(() => window.__rpcs3Playable?.stop());
  if (!report.completed) throw new Error("guest frame budget was not reached");
} catch (error) {
  report.failures.push({ type: "runner", message: error.stack });
  process.exitCode = 1;
} finally {
  await stopPerf();
  if (profiler) {
    try { await writeCpuProfiles(await profiler.stop(), path.join(output, "run.cpuprofile"), Number(process.env.RPCS3_CPU_INTERVAL_US || 5000)); }
    catch (error) { report.failures.push({ type: "profiler", message: error.message }); }
  }
  if (traceSession && traceFinished) {
    try {
      await traceSession.send("Tracing.end");
      const { stream } = await traceFinished;
      const file = await open(path.join(output, "trace.json"), "w");
      try {
        for (;;) {
          const chunk = await traceSession.send("IO.read", { handle: stream });
          await file.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
          if (chunk.eof) break;
        }
      } finally { await file.close(); await traceSession.send("IO.close", { handle: stream }); }
    } catch (error) { report.failures.push({ type: "trace", message: error.message }); }
  }
  await save();
  await context?.close();
  await lock.close();
  await unlink(lockPath);
}
console.log(JSON.stringify({ output, completed: report.completed, status: report.status, failures: report.failures }));
