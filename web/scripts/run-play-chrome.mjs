// Drives play.html in desktop Chrome and reports what the page is doing, so the interactive page
// can be checked against a real title without a device.
//
//   RPCS3_BOOT=/opfs/games/<title>.iso RPCS3_PPU_AOT=local-aot/<title>/manifest.json \
//   node scripts/run-play-chrome.mjs [seconds]
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createWorkerProfiler, selfTime, workSampleCount, writeCpuProfiles } from "./worker-profiler.mjs";

const env = process.env;
const seconds = Number(process.argv[2] || 120);
const baseURL = env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
// The same profile the other runners use: it is where the origin-private file system holding
// firmware and disc images lives.
const profilePath = env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");
const cpuProfilePath = path.resolve("play-chrome.cpuprofile");
const samplingIntervalUs = 10_000;

const query = new URLSearchParams();
if (env.RPCS3_BOOT) query.set("boot", env.RPCS3_BOOT);
if (env.RPCS3_PPU_AOT) query.set("ppuAot", env.RPCS3_PPU_AOT);
if (env.RPCS3_SPU_AOT) query.set("spuAot", env.RPCS3_SPU_AOT);
if (env.RPCS3_SPU_DECODER) query.set("spuDecoder", env.RPCS3_SPU_DECODER);
if (env.RPCS3_SPU_LLVM_WORKERS) query.set("spuLlvmWorkers", env.RPCS3_SPU_LLVM_WORKERS);
if (env.RPCS3_CLOCK_SCALE) query.set("clockScale", env.RPCS3_CLOCK_SCALE);
if (env.RPCS3_TRACE) query.set("trace", env.RPCS3_TRACE);

// Same flags and rejection rule as the other hardware runners.
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: false,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features",
    "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan"],
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  const verbose = env.RPCS3_VERBOSE === "1";
  const failures = [];
  const consoleLines = [];
  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    if (consoleLines.length < 4000) consoleLines.push(line);
    if (message.type() === "error") failures.push({ kind: "console", text: message.text() });
    if (verbose || message.type() === "error") process.stderr.write(`${line}\n`);
  });
  page.on("pageerror", (error) => {
    failures.push({ kind: "pageerror", text: error.message, stack: error.stack });
    process.stderr.write(`[pageerror] ${error.message}\n${error.stack ?? ""}\n`);
  });
  page.on("crash", () => failures.push({ kind: "crash", text: "the page process crashed" }));
  page.on("worker", (worker) => {
    worker.on("close", () => {
      if (!worker.url().includes("runtime-smoke-worker")) return;
      failures.push({ kind: "worker-close", text: worker.url() });
    });
  });

  // The page boots as soon as it loads, and the RSX worker asks for its own adapter, so the GPU
  // process has to be up before that: probe from a page that is not the one under test.
  await page.goto(`${baseURL}/units.html`, { waitUntil: "domcontentloaded" });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const adapter = await page.evaluate(async () => {
      const found = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
        ?? await navigator.gpu?.requestAdapter();
      return found ? (found.info?.description || found.info?.vendor || "adapter") : null;
    });
    if (adapter) { process.stdout.write(`adapter: ${adapter}\n`); break; }
    if (attempt === 5) throw new Error("no WebGPU adapter in Chrome");
    await page.waitForTimeout(1_000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  const session = await context.newCDPSession(page);
  const profiler = createWorkerProfiler(session, samplingIntervalUs);
  await profiler.start();

  await page.goto(`${baseURL}/play.html?${query}`, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5_000);
    const status = await page.evaluate(() => window.__rpcs3Playable?.status() ?? null);
    if (!status) continue;
    last = status;
    process.stdout.write(`${JSON.stringify(status)}\n`);
    if (status.state === "failed") break;
  }

  // RPCS3's own log says what the emulator thought was wrong, which a page-level error never does
  const emulatorLog = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const cache = await root.getDirectoryHandle("cache");
      const rpcs3 = await cache.getDirectoryHandle("rpcs3");
      const text = await (await (await rpcs3.getFileHandle("RPCS3.log")).getFile()).text();
      const lines = text.split("\n");
      return { severe: lines.filter((line) => /^·[FEU]/.test(line)).slice(-40), tail: lines.slice(-20) };
    } catch (error) {
      return { severe: [], tail: [`no log: ${String(error?.message ?? error)}`] };
    }
  }).catch(() => ({ severe: [], tail: [] }));

  // RPCS3 writes save data on shutdown; without it the title replays what it has already been shown
  await page.evaluate(() => window.__rpcs3Playable?.stop()).catch(() => {});
  await page.waitForTimeout(3_000);
  await page.locator("#gpu-output").screenshot({ path: "play-chrome-screen.png" }).catch(() => {});
  process.stdout.write(`\nfinal: ${JSON.stringify(last)}\n`);

  const failed = !last || last.state !== "running" || failures.length > 0;
  if (failed) {
    process.stdout.write(`\n${failures.length} failure(s)\n`);
    for (const failure of failures.slice(0, 8)) {
      process.stdout.write(`  ${failure.kind}: ${failure.text}\n`);
      if (failure.stack) process.stdout.write(`${failure.stack.split("\n").slice(0, 12).join("\n")}\n`);
    }
    if (emulatorLog.severe.length) {
      process.stdout.write(`\nRPCS3 errors:\n`);
      for (const line of emulatorLog.severe.slice(-12)) process.stdout.write(`  ${line.slice(0, 160)}\n`);
    }
  }
  await writeFile("play-chrome-report.json", `${JSON.stringify({
    status: last, failures, emulatorLog, console: consoleLines.slice(-400),
  }, null, 2)}\n`);

  const targets = await profiler.stop();
  await writeCpuProfiles(targets, cpuProfilePath, samplingIntervalUs);
  const ranked = targets
    .filter(({ profile }) => profile)
    .sort((left, right) => workSampleCount(right.profile) - workSampleCount(left.profile));
  process.stdout.write(`\nprofiled ${ranked.length} workers\n`);
  for (const target of ranked.slice(0, 3)) {
    const work = workSampleCount(target.profile);
    if (!work) continue;
    process.stdout.write(`\n${target.targetInfo.url.split("/").pop()} `
      + `(${work} work samples of ${target.profile.samples.length})\n`);
    for (const row of selfTime(target.profile, 12)) {
      process.stdout.write(`  ${row.percent.toFixed(1).padStart(5)}%  ${row.name}  ${row.where ?? ""}\n`);
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await context.close();
}
