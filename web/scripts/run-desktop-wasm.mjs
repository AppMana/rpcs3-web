#!/usr/bin/env node
// Desktop Wasm + Native Dawn Vulkan WebGPU Host (Zero Browser!).
// Runs the exact same Wasm runtime (rpcs3-web.wasm), Wasm compiler worker pool
// (rpcs3-spu-llvm.wasm), runtime worker (runtime-smoke-worker.mjs), and WebGPU
// renderer (rpcs3-webgpu-renderer.mjs) directly on Linux desktop via Node.js
// worker_threads + Dawn WebGPU + native JSPI.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";

if (typeof WebAssembly.Suspending !== "function") {
  const node26 = path.join(os.homedir(), ".nvm", "versions", "node", "v26.12.1", "bin", "node");
  if (fs.existsSync(node26) && process.execPath !== node26) {
    const res = spawnSync(node26, process.argv.slice(1), { stdio: "inherit" });
    process.exit(res.status ?? 1);
  }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(webDir, "..");
const publicDir = path.join(webDir, "public");
const bootstrapPath = path.join(scriptDir, "desktop-worker-bootstrap.mjs");

function encodeRgbaPng(width, height, rgba) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.allocUnsafe(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parseArgs(argv) {
  const opts = {
    fixture: null,
    elfPath: null,
    bootPath: null,
    completion: "frame",
    expectedVerdict: "",
    frames: 1,
    renderEvery: 1,
    untilDraw: false,
    jspi: true,
    renderer: "webgpu",
    width: 1280,
    height: 720,
    pngPath: null,
    jsonPath: null,
    opfsDir: path.join(repoDir, ".cache", "desktop-opfs"),
    recompCacheDir: path.join(repoDir, ".cache", "rpcs3-recomp"),
    coldRecomp: false,
    autoRecomp: true,
    workers: Math.min(16, Math.max(2, os.cpus().length)),
    pthreadPoolSize: 72,
    spuDecoder: "asmjit",
    spuBlockSize: "mega",
    clockScale: 0,
    timeoutMs: 180_000,
    inputTracePath: null,
    gameplayTrace: false,
    tracePc: 0,
    watchAddress: 0,
    mounts: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" && argv[i + 1]) opts.fixture = argv[++i];
    else if (a === "--elf" && argv[i + 1]) opts.elfPath = path.resolve(argv[++i]);
    else if (a === "--path" && argv[i + 1]) opts.bootPath = argv[++i];
    else if (a === "--completion" && argv[i + 1]) opts.completion = argv[++i];
    else if (a === "--expected-verdict" && argv[i + 1]) opts.expectedVerdict = argv[++i];
    else if (a === "--frames" && argv[i + 1]) opts.frames = Math.max(1, Number(argv[++i]));
    else if (a === "--render-every" && argv[i + 1]) opts.renderEvery = Math.max(1, Number(argv[++i]));
    else if (a === "--until-draw") opts.untilDraw = true;
    else if (a === "--jspi") opts.jspi = true;
    else if (a === "--no-jspi") opts.jspi = false;
    else if (a === "--null-renderer") opts.renderer = "null";
    else if (a === "--png" && argv[i + 1]) opts.pngPath = path.resolve(argv[++i]);
    else if (a === "--json" && argv[i + 1]) opts.jsonPath = path.resolve(argv[++i]);
    else if (a === "--opfs" && argv[i + 1]) opts.opfsDir = path.resolve(argv[++i]);
    else if (a === "--recomp-cache" && argv[i + 1]) opts.recompCacheDir = path.resolve(argv[++i]);
    else if (a === "--cold-recomp") opts.coldRecomp = true;
    else if (a === "--no-auto-recomp") opts.autoRecomp = false;
    else if (a === "--workers" && argv[i + 1]) opts.workers = Number(argv[++i]);
    else if (a === "--pthreads" && argv[i + 1]) opts.pthreadPoolSize = Number(argv[++i]);
    else if (a === "--spu-decoder" && argv[i + 1]) opts.spuDecoder = argv[++i];
    else if (a === "--spu-block-size" && argv[i + 1]) opts.spuBlockSize = argv[++i];
    else if (a === "--clock-scale" && argv[i + 1]) opts.clockScale = Number(argv[++i]);
    else if (a === "--timeout-ms" && argv[i + 1]) opts.timeoutMs = Number(argv[++i]);
    else if (a === "--input-trace" && argv[i + 1]) opts.inputTracePath = path.resolve(argv[++i]);
    else if (a === "--gameplay-trace") opts.gameplayTrace = true;
    else if (a === "--trace-pc" && argv[i + 1]) opts.tracePc = Number(argv[++i]) >>> 0;
    else if (a === "--watch-address" && argv[i + 1]) opts.watchAddress = Number(argv[++i]) >>> 0;
    else if (a === "--mount" && argv[i + 1]) opts.mounts.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.fixture && !opts.elfPath && !opts.bootPath) {
    throw new Error("Specify one of --fixture <rel>, --elf <file>, or --path </opfs/...>");
  }
  return opts;
}

function prepareDesktopOpfs(opfsDir, mounts) {
  fs.rmSync(path.join(opfsDir, "rpcs3", "dev_hdd1", "caches"), { recursive: true, force: true });
  fs.rmSync(path.join(opfsDir, "rpcs3", "dev_hdd0", "home", "00000001", "trophy"), { recursive: true, force: true });
  const gameDir = path.join(opfsDir, "rpcs3", "dev_hdd0", "game");
  if (fs.existsSync(gameDir)) {
    for (const entry of fs.readdirSync(gameDir)) {
      if (entry.startsWith("_GDATA_") || entry.includes("temp") || entry === "BCUS98245_USER1") {
        fs.rmSync(path.join(gameDir, entry), { recursive: true, force: true });
      }
    }
  }
  fs.mkdirSync(path.join(opfsDir, "rpcs3"), { recursive: true });
  fs.mkdirSync(path.join(opfsDir, "cache", "rpcs3"), { recursive: true });
  fs.mkdirSync(path.join(opfsDir, "games"), { recursive: true });

  const hostDevFlash = path.join(os.homedir(), ".config", "rpcs3", "dev_flash");
  const targetDevFlash = path.join(opfsDir, "rpcs3", "dev_flash");
  if (fs.existsSync(hostDevFlash) && !fs.existsSync(targetDevFlash)) {
    fs.symlinkSync(hostDevFlash, targetDevFlash, "dir");
  }

  for (const spec of mounts) {
    const sep = spec.indexOf(":");
    if (sep <= 0) throw new Error(`Invalid --mount '${spec}' (expected <hostPath>:<opfsRelPath>)`);
    const src = path.resolve(spec.slice(0, sep));
    const dstRel = spec.slice(sep + 1).replace(/^\/+/, "").replace(/^opfs\/+/, "");
    const dst = path.join(opfsDir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) {
      fs.symlinkSync(src, dst);
    }
  }
}

function startStaticServer(extraFiles = new Map()) {
  const mime = {
    ".wasm": "application/wasm",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (extraFiles.has(reqPath)) {
      const f = extraFiles.get(reqPath);
      const stat = fs.statSync(f);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stat.size });
      fs.createReadStream(f).pipe(res);
      return;
    }
    const localFile = path.join(publicDir, reqPath.replace(/^\/+/, ""));
    if (!localFile.startsWith(publicDir) || !fs.existsSync(localFile) || fs.statSync(localFile).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(localFile);
    const stat = fs.statSync(localFile);
    res.writeHead(200, {
      "Content-Type": mime[ext] || "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(localFile).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, originUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

async function initDesktopWebGpu(width, height) {
  const webgpuMod = await import(pathToFileURL(path.join(webDir, "node_modules", "webgpu", "index.js")).href).catch(
    () => import("webgpu"),
  );
  const { create, globals } = webgpuMod;
  Object.assign(globalThis, globals);
  const gpu = create([]);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { gpu, userAgent: "NodeDawnWebGPU/22", hardwareConcurrency: os.cpus().length },
  });
  const { prepareWebGPU, renderPacketsToWebGPU, releaseWebGPU } = await import(
    pathToFileURL(path.join(publicDir, "rpcs3-webgpu-renderer.mjs")).href
  );
  const { decodeDrawPacket } = await import(
    pathToFileURL(path.join(publicDir, "rpcs3-webgpu-packet.mjs")).href
  );
  const headlessCanvas = { width, height, getContext: () => null };
  const prepared = await prepareWebGPU(headlessCanvas, { presentation: false, format: "rgba8unorm" });
  return { prepared, renderPacketsToWebGPU, releaseWebGPU, decodeDrawPacket };
}

async function main() {
  const opts = parseArgs(process.argv);
  prepareDesktopOpfs(opts.opfsDir, opts.mounts);

  const recompCacheDir = opts.coldRecomp
    ? fs.mkdtempSync(path.join(os.tmpdir(), "rpcs3-cold-recomp-"))
    : opts.recompCacheDir;

  const extraFiles = new Map();
  let fixtureUrl;
  if (opts.elfPath) {
    const ext = path.extname(opts.elfPath) || ".elf";
    const virt = `/__mounted_input${ext}`;
    extraFiles.set(virt, opts.elfPath);
    fixtureUrl = virt;
  }

  const { server, originUrl } = await startStaticServer(extraFiles);
  let gpuHost = null;
  if (opts.completion === "frame" && opts.renderer === "webgpu") {
    gpuHost = await initDesktopWebGpu(opts.width, opts.height);
    console.error(`[desktop-wasm] Dawn Vulkan WebGPU initialized (${opts.width}x${opts.height})`);
  }

  let inputTrace = [];
  if (opts.inputTracePath) {
    const rawTrace = JSON.parse(fs.readFileSync(opts.inputTracePath, "utf8"));
    inputTrace = Array.isArray(rawTrace) ? rawTrace : (rawTrace.entries ?? []);
  } else if (opts.gameplayTrace) {
    for (let f = 60; f <= opts.frames; f += 30) {
      inputTrace.push({ frame: f, duration: 8, buttons1: (1 << 3) | (1 << 2), buttons2: 1 << 6 });
    }
    inputTrace.push({ frame: Math.max(100, opts.frames - 80), duration: 80, buttons1: 0, buttons2: 0, lx: 255, ly: 128 });
  }

  const runtimeWorkerPath = path.join(publicDir, "runtime-smoke-worker.mjs");
  const worker = new NodeWorker(bootstrapPath, {
    name: "rpcs3-runtime-main",
    resourceLimits: { maxOldGenerationSizeMb: 8192, maxYoungGenerationSizeMb: 512 },
    workerData: {
      scriptUrl: pathToFileURL(runtimeWorkerPath).href,
      name: "rpcs3-runtime-main",
      originUrl,
      publicDir,
      opfsDir: opts.opfsDir,
      recompCacheDir,
    },
  });

  const startedAt = performance.now();
  let lastProgress = null;
  let pendingResolve = null;
  let pendingReject = null;

  const waitNextResult = (expectedType, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolve = null;
      pendingReject = null;
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${expectedType}; lastProgress=${JSON.stringify(lastProgress)}`));
    }, timeoutMs);
    pendingResolve = (msg) => {
      if (msg.type !== expectedType) return false;
      clearTimeout(timer);
      pendingResolve = null;
      pendingReject = null;
      resolve(msg);
      return true;
    };
    pendingReject = (err) => {
      clearTimeout(timer);
      pendingResolve = null;
      pendingReject = null;
      reject(err);
    };
  });

  let lastLogAt = 0;
  worker.on("message", (msg) => {
    if (!msg) return;
    if (msg.type === "runtime-progress") {
      lastProgress = {
        ppuInstructions: msg.ppuInstructions,
        ppuAotDispatches: msg.ppuAotDispatches,
        ppuHleHooks: msg.ppuHleHooks,
        spuInstructions: msg.spuInstructions,
        flipCounter: msg.workingSet?.flipCounter,
        recomp: msg.spuLlvm?.recomp,
      };
      const now = performance.now();
      if (now - lastLogAt >= 5000) {
        lastLogAt = now;
        const r = lastProgress.recomp;
        console.error(`[desktop-wasm +${Math.round((now - startedAt) / 1000)}s] flip=${lastProgress.flipCounter ?? 0} ppuInsn=${lastProgress.ppuInstructions} spuInsn=${lastProgress.spuInstructions} recomp=${r ? `${r.modulesCompiled}/${r.modulesRequested} (fw=${r.firmwareLinked}, shards=${r.shardsCompiled}, blocks=${r.blocksRegistered})` : "-"}`);
      }
      return;
    }
    if (msg.type === "runtime-fatal") {
      pendingReject?.(new Error(`runtime-fatal: ${msg.detail}\n${(msg.logs || []).slice(-30).join("\n")}`));
      return;
    }
    pendingResolve?.(msg);
  });
  worker.on("error", (err) => pendingReject?.(err));

  try {
    const firstResultPromise = waitNextResult("runtime-result", opts.timeoutMs);
    worker.postMessage({
      type: "boot",
      coreUrl: opts.jspi ? "./core/jspi/rpcs3-web.mjs" : "./core/rpcs3-web.mjs",
      suspending: opts.jspi,
      fixture: opts.fixture ?? undefined,
      fixtureUrl: fixtureUrl ? new URL(fixtureUrl, originUrl).href : undefined,
      path: opts.bootPath ?? undefined,
      completion: opts.completion,
      expectedVerdict: opts.expectedVerdict,
      dispatchTimeoutMs: opts.timeoutMs,
      packetTimeoutMs: opts.timeoutMs,
      untilDraw: opts.untilDraw,
      renderer: opts.renderer === "null" ? "null" : "webgpu",
      autoRecomp: opts.autoRecomp,
      spuLlvmWorkers: opts.workers,
      pthreadPoolSize: opts.pthreadPoolSize,
      spuDecoder: opts.spuDecoder,
      spuBlockSize: opts.spuBlockSize,
      clockScale: opts.clockScale,
      inputTrace,
      tracePc: opts.tracePc,
      watchAddress: opts.watchAddress,
      benchmark: true,
    });

    let lastFrameResult = await firstResultPromise;
    if (!lastFrameResult.ok) {
      throw new Error(`Runtime failed: ${lastFrameResult.detail}\n${lastFrameResult.rpcs3Log ?? ""}\n${(lastFrameResult.logs ?? []).slice(-40).join("\n")}`);
    }

    let lastRenderSummary = null;
    const renderFrame = async (frameMsg, wantRgba) => {
      if (!gpuHost) return null;
      const decodedPackets = (frameMsg.packetBuffers ?? []).map((ab) => gpuHost.decodeDrawPacket(new Uint8Array(ab)));
      return gpuHost.renderPacketsToWebGPU(gpuHost.prepared, decodedPackets, {
        carriedSurfaceOps: frameMsg.carriedSurfaceOps,
        readback: wantRgba,
        captureRgba: wantRgba,
        replayPresentation: false,
      });
    };

    const frameTimesMs = [];
    const gameplaySamples = [];
    let steadyStartInstructions = null;
    let steadyStartSpuInstructions = null;
    let steadyStartDispatches = null;
    let steadyWallStart = performance.now();

    if (opts.completion === "frame") {
      lastRenderSummary = await renderFrame(lastFrameResult, opts.frames === 1 && Boolean(opts.pngPath));
      steadyStartInstructions = lastFrameResult.ppuInstructions;
      steadyStartSpuInstructions = lastFrameResult.spuInstructions;
      steadyStartDispatches = lastFrameResult.ppuAotDispatches;
      steadyWallStart = performance.now();
      gameplaySamples.push({
        emuFlipId: lastFrameResult.emuFlipId ?? 1,
        hostTimeMs: performance.now() - startedAt,
        draws: lastRenderSummary?.draws ?? lastFrameResult.drawPacketCount ?? 0,
      });

      for (let f = 2; f <= opts.frames; f++) {
        const t0 = performance.now();
        const isLast = f === opts.frames;
        const shouldRender = isLast || (f % opts.renderEvery === 0);
        const nextPromise = waitNextResult("runtime-frame", opts.timeoutMs);
        worker.postMessage({ type: "next-frame", untilDraw: opts.untilDraw, discardPackets: !shouldRender });
        lastFrameResult = await nextPromise;
        if (!lastFrameResult.ok) {
          throw new Error(`Frame ${f} failed (status=${lastFrameResult.status}): ${lastFrameResult.detail}\n${lastFrameResult.rpcs3Log ?? ""}`);
        }
        const r = shouldRender ? await renderFrame(lastFrameResult, isLast && Boolean(opts.pngPath)) : null;
        if (r) lastRenderSummary = r;
        const now = performance.now();
        frameTimesMs.push(now - t0);
        gameplaySamples.push({
          emuFlipId: lastFrameResult.emuFlipId ?? f,
          hostTimeMs: now - startedAt,
          draws: r?.draws ?? lastFrameResult.drawPacketCount ?? 0,
        });
        if (now - lastLogAt >= 5000) {
          lastLogAt = now;
          console.error(`[desktop-wasm +${Math.round((now - startedAt) / 1000)}s] frame=${f}/${opts.frames} emuFlip=${lastFrameResult.emuFlipId} draws=${r?.draws ?? lastFrameResult.drawPacketCount} ppuInsn=${lastProgress?.ppuInstructions ?? lastFrameResult.ppuInstructions} spuInsn=${lastProgress?.spuInstructions ?? lastFrameResult.spuInstructions}`);
        }
      }

      if (opts.pngPath && lastRenderSummary?.rgbaBase64) {
        const rgba = Buffer.from(lastRenderSummary.rgbaBase64, "base64");
        const png = encodeRgbaPng(lastRenderSummary.width, lastRenderSummary.height, rgba);
        fs.mkdirSync(path.dirname(opts.pngPath), { recursive: true });
        fs.writeFileSync(opts.pngPath, png);
        console.error(`[desktop-wasm] Saved WebGPU rendered frame PNG -> ${opts.pngPath} (${png.length} bytes, changedPixels=${lastRenderSummary.changedPixels})`);
      }
    }

    const steadyWallSec = Math.max(0.001, (performance.now() - steadyWallStart) / 1000);
    const steadyFrames = Math.max(0, opts.frames - 1);
    const heavyIntervals = [];
    let dpfMax = 0;
    let anchorFlip = null;
    for (let i = 1; i < gameplaySamples.length; i++) {
      const a = gameplaySamples[i - 1];
      const b = gameplaySamples[i];
      const de = b.emuFlipId - a.emuFlipId;
      const dt = b.hostTimeMs - a.hostTimeMs;
      if (de <= 0 || dt <= 0) continue;
      const dpf = b.draws;
      if (dpf > dpfMax) dpfMax = dpf;
      if (dpf >= 300) {
        if (anchorFlip === null) anchorFlip = b.emuFlipId;
        heavyIntervals.push(dt / de);
      }
    }
    const heavyMeanMs = heavyIntervals.length
      ? heavyIntervals.reduce((acc, v) => acc + v, 0) / heavyIntervals.length
      : null;
    const report = {
      host: "desktop-node-wasm-dawn-webgpu",
      nodeVersion: process.version,
      ok: lastFrameResult.ok,
      completion: opts.completion,
      verdict: lastFrameResult.verdict,
      framesCaptured: opts.completion === "frame" ? opts.frames : 0,
      steadyStateFps: steadyFrames > 0 ? Number((steadyFrames / steadyWallSec).toFixed(2)) : undefined,
      gameplay: heavyIntervals.length ? {
        stretchFrames: heavyIntervals.length,
        anchorFlip,
        dpfMax,
        meanMsPerFrame: Number(heavyMeanMs.toFixed(2)),
        fps: Number((1000 / heavyMeanMs).toFixed(2)),
      } : undefined,
      totalElapsedMs: Math.round(performance.now() - startedAt),
      ppuInstructionsTotal: lastFrameResult.ppuInstructions,
      ppuInstructionsSteadyDelta: steadyStartInstructions !== null ? (lastFrameResult.ppuInstructions - steadyStartInstructions) : undefined,
      ppuAotDispatchesTotal: lastFrameResult.ppuAotDispatches,
      ppuAotDispatchesSteadyDelta: steadyStartDispatches !== null ? (lastFrameResult.ppuAotDispatches - steadyStartDispatches) : undefined,
      ppuHleHooksTotal: lastFrameResult.ppuHleHooks ?? 0,
      spuInstructionsTotal: lastFrameResult.spuInstructions,
      spuInstructionsSteadyDelta: steadyStartSpuInstructions !== null ? (lastFrameResult.spuInstructions - steadyStartSpuInstructions) : undefined,
      recomp: lastFrameResult.spuLlvm?.recomp,
      spuWgsl: lastFrameResult.spuLlvm?.spuWgsl,
      ppuJit: lastFrameResult.ppuJitReport,
      spuHot: lastFrameResult.spuHotReport ? {
        compiled: lastFrameResult.spuHotReport.compiled,
        registered: lastFrameResult.spuHotReport.registered,
        llvmRegistered: lastFrameResult.spuHotReport.llvmRegistered,
        dispatches: lastFrameResult.spuHotReport.dispatches,
        misses: lastFrameResult.spuHotReport.misses,
      } : undefined,
      webgpu: lastRenderSummary ? {
        width: lastRenderSummary.width,
        height: lastRenderSummary.height,
        draws: lastRenderSummary.draws,
        vertices: lastRenderSummary.vertices,
        changedPixels: lastRenderSummary.changedPixels,
        frameHash: lastRenderSummary.frameHash,
        validationError: lastRenderSummary.validationError ?? null,
        timings: lastRenderSummary.timings,
      } : undefined,
    };

    if (opts.jsonPath) {
      fs.mkdirSync(path.dirname(opts.jsonPath), { recursive: true });
      fs.writeFileSync(opts.jsonPath, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report, null, 2));

    // Clean shutdown
    const shutdownPromise = waitNextResult("runtime-shutdown", 10_000).catch(() => null);
    worker.postMessage({ type: "shutdown" });
    await shutdownPromise;
  } finally {
    await worker.terminate().catch(() => {});
    gpuHost?.releaseWebGPU(gpuHost.prepared);
    gpuHost?.prepared?.device?.destroy?.();
    server.close();
    if (opts.coldRecomp && recompCacheDir.startsWith(os.tmpdir())) {
      fs.rmSync(recompCacheDir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[desktop-wasm] ERROR: ${err?.stack ?? err}`);
    process.exit(1);
  });
