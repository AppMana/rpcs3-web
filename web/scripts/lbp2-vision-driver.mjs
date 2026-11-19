#!/usr/bin/env node
// Interactive vision-guided driver for RPCS3-Web commercial games.
// Launches headless hardware WebGPU Chrome on play.html and exposes a local control
// server on 127.0.0.1:4399 so an agent/operator can inspect live PNG frames with a
// vision model, inject controller inputs (automatically recorded into the guest-frame
// input trace), adjust clockScale, and create an OPFS savestate (.SAVESTAT.zst) once
// real 3D gameplay is reached.

import http from "node:http";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { hardwareChromeArgs } from "./chrome-gpu.mjs";

const Digital1 = Object.freeze({
  select: 0x01, l3: 0x02, r3: 0x04, start: 0x08,
  up: 0x10, right: 0x20, down: 0x40, left: 0x80,
});
const Digital2 = Object.freeze({
  l2: 0x01, r2: 0x02, l1: 0x04, r1: 0x08,
  triangle: 0x10, circle: 0x20, cross: 0x40, square: 0x80,
});

const NeutralPad = Object.freeze({
  digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128,
});

function parsePngStats(pngBuffer) {
  try {
    const png = PNG.sync.read(pngBuffer);
    const data = png.data;
    let nonBlack = 0;
    let colored = 0;
    let hash = 0x811c9dc5;
    const totalPixels = png.width * png.height;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (r > 0 || g > 0 || b > 0) nonBlack++;
      if (r + g + b > 60) colored++;
      hash ^= r; hash = Math.imul(hash, 0x01000193);
      hash ^= g; hash = Math.imul(hash, 0x01000193);
      hash ^= b; hash = Math.imul(hash, 0x01000193);
      hash ^= a; hash = Math.imul(hash, 0x01000193);
    }
    return {
      width: png.width,
      height: png.height,
      nonBlackPixels: nonBlack,
      coloredPixels: colored,
      nonBlackRatio: Number((nonBlack / Math.max(1, totalPixels)).toFixed(4)),
      fnv1aHash: hash >>> 0,
    };
  } catch (err) {
    return { error: err.message };
  }
}

const target = process.argv[2] || "/opfs/games/LittleBigPlanet 2 - Special Edition (USA) (En,Fr,Es,Pt).iso";
const outDir = path.resolve(process.argv[3] || "profile-results/lbp2-vision");
const port = Number(process.env.RPCS3_DRIVER_PORT || 4399);
const origin = process.env.RPCS3_WEB_URL || "https://rpcs3.appmana.com";
const initialClockScale = Number(process.env.RPCS3_CLOCK_SCALE || 300);
const profilePath = process.env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache/rpcs3-web-chrome-profile");
const lockPath = `${profilePath}.benchmark-lock`;

await mkdir(outDir, { recursive: true });
const lock = await open(lockPath, "wx");
await lock.writeFile(`${process.pid}\n`);

let context;
let page;
let shuttingDown = false;
const consoleLogs = [];
const consolePath = path.join(outDir, "console.log");

async function writeConsoleLog() {
  await writeFile(consolePath, `${consoleLogs.join("\n")}\n`).catch(() => {});
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await context?.close(); } catch {}
  await writeConsoleLog();
  try { await lock.close(); } catch {}
  try { await unlink(lockPath); } catch {}
}

process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

const args = hardwareChromeArgs();
context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: process.env.RPCS3_HEADED !== "1",
  viewport: { width: 1280, height: 720 },
  args,
});

page = context.pages()[0] ?? await context.newPage();
page.on("console", (msg) => {
  if (consoleLogs.length >= 2000) consoleLogs.shift();
  consoleLogs.push(`[${msg.type()}] ${msg.text().slice(0, 500)}`);
});
page.on("pageerror", (err) => {
  consoleLogs.push(`[pageerror] ${err.stack || err.message}`);
});
page.on("crash", () => consoleLogs.push("[pageerror] page crashed"));

const query = new URLSearchParams({
  ...(target.startsWith("fixtures/") ? { fixture: target } : { boot: target }),
  core: process.env.RPCS3_CORE || "jspi",
  benchmark: "vision-driver",
  capture: "1",
  captureEvery: process.env.RPCS3_CAPTURE_EVERY || "5",
  clockScale: String(initialClockScale),
  spuDispatchCache: "1",
  spuExecutionSlices: "1",
});
for (const [queryKey, envKey] of [
  ["ppuBackend", "RPCS3_PPU_BACKEND"],
  ["ppuFailClosed", "RPCS3_PPU_FAIL_CLOSED"],
  ["spuLlvmWorkers", "RPCS3_SPU_LLVM_WORKERS"],
  ["autoStartSec", "RPCS3_AUTO_START_SEC"],
  ["autoRecomp", "RPCS3_AUTO_RECOMP"],
  ["ppuJit", "RPCS3_PPU_JIT"],
  ["ppuJitThreshold", "RPCS3_PPU_JIT_THRESHOLD"],
  ["debugAddresses", "RPCS3_DEBUG_ADDRESSES"],
  ["tracePc", "RPCS3_TRACE_PC"],
  ["traceDelayPc", "RPCS3_TRACE_DELAY_PC"],
  ["traceDelayMs", "RPCS3_TRACE_DELAY_MS"],
  ["watchAddress", "RPCS3_WATCH_ADDRESS"],
]) {
  if (process.env[envKey]) query.set(queryKey, process.env[envKey]);
}
if (process.env.RPCS3_INPUT_TRACE) {
  const { readFile } = await import("node:fs/promises");
  const trace = JSON.parse(await readFile(process.env.RPCS3_INPUT_TRACE, "utf8"));
  await page.route("**/benchmark-input.json", (route) => route.fulfill({ json: trace }));
  query.set("trace", `${origin}/benchmark-input.json`);
}

const playUrl = `${origin}/play.html?${query}`;
console.log(`Navigating to ${playUrl}`);
// Match the benchmark runner's startup order. The OPFS page establishes the
// isolated storage/WebGPU context before the runtime worker is created.
await page.goto(`${origin}/storage.html?headless=1`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__rpcs3Storage));
await page.goto(playUrl, { waitUntil: "domcontentloaded" });
await page.bringToFront();

async function getSnapshot(tag = "", capture = false) {
  const state = await page.evaluate(() => {
    const p = window.__rpcs3Playable;
    if (!p) return null;
    const status = p.status();
    const bench = p.benchmark();
    const frames = bench?.frames ?? [];
    const last = frames.at(-1);
    const prev = frames.at(-10) ?? frames[0];
    let drawsPerFlip = 0;
    if (last && prev && last.emuFlipId > prev.emuFlipId) {
      drawsPerFlip = ((last.directStats?.draws ?? 0) - (prev.directStats?.draws ?? 0)) / (last.emuFlipId - prev.emuFlipId);
    }
    return {
      status,
      drawsPerFlip: Number(drawsPerFlip.toFixed(1)),
      totalRecordedFrames: frames.length,
      workerErrors: bench?.workerErrors ?? [],
    };
  });
  const dataUrl = capture ? await page.evaluate(() => window.__rpcs3Playable?.capturePng?.()) : null;
  let pixelStats = null;
  let framePath = null;
  const latestPath = path.join(outDir, "latest.png");
  if (dataUrl?.startsWith("data:image/png;base64,")) {
    const buf = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    pixelStats = parsePngStats(buf);
    await writeFile(latestPath, buf);
    const flip = state?.status?.frames ?? 0;
    const suffix = tag ? `-${tag}` : "";
    framePath = path.join(outDir, `frame-${String(flip).padStart(5, "0")}${suffix}.png`);
    await writeFile(framePath, buf);
  }
  return {
    ...state,
    latestPath,
    framePath,
    pixelStats,
    recentConsole: consoleLogs.slice(-15),
  };
}

function buildPadState(params) {
  let digital1 = 0;
  let digital2 = 0;
  const buttons = (params.get("button") || params.get("buttons") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const b of buttons) {
    if (b in Digital1) digital1 |= Digital1[b];
    if (b in Digital2) digital2 |= Digital2[b];
  }
  const leftX = params.has("leftX") ? Number(params.get("leftX")) : 128;
  const leftY = params.has("leftY") ? Number(params.get("leftY")) : 128;
  const rightX = params.has("rightX") ? Number(params.get("rightX")) : 128;
  const rightY = params.has("rightY") ? Number(params.get("rightY")) : 128;
  return { digital1, digital2, leftX, leftY, rightX, rightY };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/status") {
      const snap = await getSnapshot(url.searchParams.get("tag") || "", url.searchParams.get("capture") === "1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap, null, 2));
      return;
    }
    if (url.pathname === "/snapshot") {
      const snapshot = await page.evaluate(() => window.__rpcs3Playable?.threadSnapshot?.());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot ?? { error: "no snapshot" }, null, 2));
      return;
    }
    if (url.pathname === "/press") {
      const padState = buildPadState(url.searchParams);
      const holdMs = Number(url.searchParams.get("holdMs") || 250);
      const repeat = Number(url.searchParams.get("repeat") || 1);
      const intervalMs = Number(url.searchParams.get("intervalMs") || 350);
      for (let i = 0; i < repeat; i++) {
        await page.evaluate((s) => window.__rpcs3Playable?.setPad(s), padState);
        await new Promise((r) => setTimeout(r, holdMs));
        await page.evaluate((s) => window.__rpcs3Playable?.setPad(s), NeutralPad);
        if (i + 1 < repeat) {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
      const trace = await page.evaluate(() => window.__rpcs3Playable?.exportInputTrace());
      if (trace) {
        await writeFile(path.join(outDir, "input-trace.json"), JSON.stringify(trace, null, 2));
      }
      const snap = await getSnapshot("after-press", url.searchParams.get("capture") === "1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pressed: padState, repeat, holdMs, traceEntries: trace?.entries?.length ?? 0, ...snap }, null, 2));
      return;
    }
    if (url.pathname === "/clock") {
      const scale = Number(url.searchParams.get("scale") || 100);
      await page.evaluate((s) => window.__rpcs3Playable?.setClockScale(s), scale);
      const snap = await getSnapshot(`clock-${scale}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clockScale: scale, ...snap }, null, 2));
      return;
    }
    if (url.pathname === "/trace") {
      const trace = await page.evaluate(() => window.__rpcs3Playable?.exportInputTrace());
      if (trace) {
        await writeFile(path.join(outDir, "input-trace.json"), JSON.stringify(trace, null, 2));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(trace ?? { error: "no trace" }, null, 2));
      return;
    }
    if (url.pathname === "/savestate") {
      const saveStatePath = url.searchParams.get("path") || "/opfs/rpcs3/savestates/lbp2-gameplay.SAVESTAT.zst";
      const trace = await page.evaluate(() => window.__rpcs3Playable?.exportInputTrace());
      if (trace) {
        await writeFile(path.join(outDir, "input-trace.json"), JSON.stringify(trace, null, 2));
      }
      const snap = await getSnapshot("savestate");
      const shutdown = await page.evaluate(
        (p) => window.__rpcs3Playable?.stop({ saveState: true, saveStatePath: p }),
        saveStatePath,
      );
      const result = { saveStatePath, shutdown, traceEntries: trace?.entries?.length ?? 0, finalSnapshot: snap };
      await writeFile(path.join(outDir, "savestate-report.json"), JSON.stringify(result, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      setTimeout(async () => {
        server.close();
        await cleanup();
        process.exit(0);
      }, 200);
      return;
    }
    if (url.pathname === "/quit") {
      const shutdown = await page.evaluate(() => window.__rpcs3Playable?.stop({ saveState: false }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ quit: true, shutdown }, null, 2));
      setTimeout(async () => {
        server.close();
        await cleanup();
        process.exit(0);
      }, 200);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.stack || err.message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Vision driver listening on http://127.0.0.1:${port}`);
});
