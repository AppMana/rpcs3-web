#!/usr/bin/env node
// Headless hardware WebGPU deep profiler for RPCS3-Web.
// Runs a fixture or OPFS commercial title in headless Chrome on the physical GPU,
// attaches CDP CPU profilers to the main page and all nested Emscripten pthread &
// compiler workers, captures Dawn validation errors, verifies rendered pixels,
// breaks down RSX WebGPU per-draw phases, and writes deep-profile.json + flame.folded.
//
// Usage:
//   node scripts/deep-profile.mjs <target> <output-dir> [options]
//   node scripts/deep-profile.mjs --analyse-only <output-dir>

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  activeWorkSampleCount,
  callersOf,
  classifyWorkerProfile,
  isSpinWaitFunction,
  selfTime,
  workSampleCount,
} from "./worker-profiler.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

function parsePngStats(pngBuffer) {
  try {
    const png = PNG.sync.read(pngBuffer);
    const data = png.data;
    let nonBlack = 0;
    let colored = 0;
    let hash = 0x811c9dc5;
    const totalPixels = png.width * png.height;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
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
      totalPixels,
      nonBlackPixels: nonBlack,
      coloredPixels: colored,
      nonBlackRatio: Number((nonBlack / Math.max(1, totalPixels)).toFixed(4)),
      fnv1aHash: hash >>> 0,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function summarizeFlipTimings(flipTimings = [], frames = []) {
  const withPhases = flipTimings.filter((f) => f?.phasesUs && typeof f.phasesUs === "object");
  if (!withPhases.length) return null;
  const phaseKeys = [
    "submit",
    "present",
    "limiter",
    "fifoIdle",
    "draw",
    "drawSetup",
    "drawTextures",
    "drawProgram",
    "drawClause",
    "drawVertex",
    "drawUniform",
    "drawBind",
    "drawEncode",
    "drawEnd",
  ];
  const childDrawKeys = [
    "drawSetup",
    "drawTextures",
    "drawProgram",
    "drawClause",
    "drawVertex",
    "drawUniform",
    "drawBind",
    "drawEncode",
    "drawEnd",
  ];
  const totalsUs = {};
  for (const k of phaseKeys) totalsUs[k] = 0;
  for (const sample of withPhases) {
    for (const k of phaseKeys) {
      totalsUs[k] += Number(sample.phasesUs[k] || 0);
    }
  }
  const n = withPhases.length;
  const lastDraws = frames.at(-1)?.directStats?.draws ?? 0;
  const firstDraws = frames[0]?.directStats?.draws ?? 0;
  const totalDraws = Math.max(1, lastDraws - firstDraws || lastDraws);
  const perFrameUs = {};
  const perDrawUs = {};
  const shareOfDrawPct = {};
  const childDrawSumUs = Math.max(1, childDrawKeys.reduce((acc, k) => acc + totalsUs[k], 0));
  for (const k of phaseKeys) {
    perFrameUs[k] = Number((totalsUs[k] / n).toFixed(2));
    perDrawUs[k] = Number((totalsUs[k] / totalDraws).toFixed(3));
  }
  for (const k of childDrawKeys) {
    shareOfDrawPct[k] = Number(((totalsUs[k] * 100) / childDrawSumUs).toFixed(1));
  }
  return {
    sampledFlips: n,
    estimatedDraws: totalDraws,
    perFrameUs,
    perDrawUs,
    shareOfDrawPct,
  };
}

function summarizeFrameBands(frames = []) {
  const valid = frames
    .filter((f) => Number.isFinite(f?.emuFlipId) && Number.isFinite(f?.hostTimeMs))
    .sort((a, b) => a.emuFlipId - b.emuFlipId);
  if (valid.length < 2) return null;
  const first = valid[0];
  const last = valid.at(-1);
  const totalFlips = last.emuFlipId - first.emuFlipId;
  const totalWallSec = (last.hostTimeMs - first.hostTimeMs) / 1000;
  const totalDraws = (last.directStats?.draws ?? 0) - (first.directStats?.draws ?? 0);
  const totalPpu = (last.ppuInstructions ?? 0) - (first.ppuInstructions ?? 0);
  const totalSpu = (last.spuInstructions ?? 0) - (first.spuInstructions ?? 0);

  const measureContiguous = (pred) => {
    let prev = null, run = [], best = [];
    for (const f of valid) {
      const eid = f.emuFlipId, h = f.hostTimeMs, dr = f.directStats?.draws ?? 0;
      if (prev && eid > prev[0] && h > prev[2]) {
        const dpf = (dr - prev[1]) / (eid - prev[0]);
        if (pred(dpf)) run.push([eid, h, dpf]);
        else { if (run.length > best.length) best = run; run = []; }
      }
      prev = [eid, dr, h];
    }
    if (run.length > best.length) best = run;
    if (best.length < 2) return null;
    const f0 = best[0][0], f1 = best.at(-1)[0];
    const dt = (best.at(-1)[1] - best[0][1]) / 1000;
    const medianDpf = best.map((r) => r[2]).sort((a, b) => a - b)[(best.length / 2) | 0];
    return {
      frameSpan: [f0, f1],
      samples: best.length,
      flips: f1 - f0,
      wallSec: Number(dt.toFixed(2)),
      fps: dt > 0 ? Number(((f1 - f0) / dt).toFixed(2)) : null,
      msPerFrame: f1 > f0 ? Number(((dt * 1000) / (f1 - f0)).toFixed(2)) : null,
      medianDrawsPerFrame: Number(medianDpf.toFixed(1)),
    };
  };

  return {
    overall: {
      flips: totalFlips,
      wallSec: Number(totalWallSec.toFixed(2)),
      fps: totalWallSec > 0 ? Number((totalFlips / totalWallSec).toFixed(2)) : null,
      msPerFrame: totalFlips > 0 ? Number(((totalWallSec * 1000) / totalFlips).toFixed(2)) : null,
      avgDrawsPerFrame: totalFlips > 0 ? Number((totalDraws / totalFlips).toFixed(1)) : 0,
      avgPpuPerFrame: totalFlips > 0 ? Math.round(totalPpu / totalFlips) : 0,
      avgSpuPerFrame: totalFlips > 0 ? Math.round(totalSpu / totalFlips) : 0,
    },
    activeDrawBand: measureContiguous((dpf) => dpf >= 1),
    menuOrIntroBand: measureContiguous((dpf) => dpf >= 300 && dpf <= 700),
    gameplay3dBand: measureContiguous((dpf) => dpf > 700),
  };
}

export async function generateDeepProfile(outDir) {
  const reportPath = path.join(outDir, "report.json");
  if (!existsSync(reportPath)) throw new Error(`missing report.json in ${outDir}`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const frames = report.frames ?? (report.result?.frames ? report.result.frames : []);
  const flipTimings = report.flipTimings ?? report.result?.flipTimings ?? [];
  const windowStart = Number(report.profileWindow?.startedAtFrame || 0);
  const windowEnd = Number(report.profileWindow?.stoppedAtFrame || Infinity);
  const windowedFrames = windowStart > 0
    ? frames.filter((f) => Number(f?.emuFlipId) >= windowStart && Number(f?.emuFlipId) <= windowEnd)
    : frames;
  const windowedFlipTimings = windowStart > 0
    ? flipTimings.filter((f) => Number(f?.emuFlipId) >= windowStart && Number(f?.emuFlipId) <= windowEnd)
    : flipTimings;
  const lastFrame = frames.at(-1) ?? report.result ?? {};

  // 1. Pixel verification
  let pixelStats = null;
  const framePngPath = path.join(outDir, "frame.png");
  if (existsSync(framePngPath)) {
    pixelStats = parsePngStats(await readFile(framePngPath));
  } else if (report.result?.gpu?.rgbaBase64) {
    const raw = Buffer.from(report.result.gpu.rgbaBase64, "base64");
    let nonBlack = 0, colored = 0;
    for (let i = 0; i < raw.length; i += 4) {
      if (raw[i] || raw[i + 1] || raw[i + 2]) nonBlack++;
      if (raw[i] + raw[i + 1] + raw[i + 2] > 60) colored++;
    }
    pixelStats = {
      totalPixels: raw.length / 4,
      nonBlackPixels: nonBlack,
      coloredPixels: colored,
      frameHash: report.result.gpu.frameHash,
    };
  }

  // 2. Worker CPU profiles
  let cpuSummary = null;
  const targetsPath = path.join(outDir, "run.cpuprofile.targets.json");
  if (existsSync(targetsPath)) {
    const targetsMeta = JSON.parse(await readFile(targetsPath, "utf8"));
    const samplingIntervalUs = targetsMeta.samplingIntervalUs || 5000;
    const roleStats = {};
    const pooledSelf = new Map();
    const pooledSpin = new Map();
    const roleSelf = {};
    let totalSamples = 0;
    let totalWorkSamples = 0;
    let totalActiveSamples = 0;

    for (const t of targetsMeta.targets || []) {
      if (!t.profilePath || !existsSync(t.profilePath)) continue;
      const prof = JSON.parse(await readFile(t.profilePath, "utf8"));
      const role = t.role || classifyWorkerProfile(prof, t.targetInfo);
      const samples = prof.samples?.length || 0;
      const work = workSampleCount(prof);
      const active = activeWorkSampleCount(prof);
      totalSamples += samples;
      totalWorkSamples += work;
      totalActiveSamples += active;

      const rs = (roleStats[role] ??= { workers: 0, totalSamples: 0, workSamples: 0, activeSamples: 0, activeCpuMs: 0 });
      rs.workers += 1;
      rs.totalSamples += samples;
      rs.workSamples += work;
      rs.activeSamples += active;
      rs.activeCpuMs = Number(((rs.activeSamples * samplingIntervalUs) / 1000).toFixed(1));

      for (const row of selfTime(prof, 10_000, { excludeSpinWaits: true })) {
        pooledSelf.set(row.name, (pooledSelf.get(row.name) ?? 0) + row.samples);
        const rm = (roleSelf[role] ??= new Map());
        rm.set(row.name, (rm.get(row.name) ?? 0) + row.samples);
      }
      for (const row of selfTime(prof, 10_000, { excludeSpinWaits: false })) {
        if (isSpinWaitFunction(row.name)) {
          pooledSpin.set(row.name, (pooledSpin.get(row.name) ?? 0) + row.samples);
        }
      }
    }

    const totalFlips = Math.max(1, (report.profileWindow?.stoppedAtFrame - report.profileWindow?.startedAtFrame) || report.status?.frames || lastFrame.emuFlipId || 1);
    const activeDenom = Math.max(1, totalActiveSamples);
    const topActiveSelf = [...pooledSelf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, samples]) => ({
        name,
        samples,
        percentOfActive: Number(((samples * 100) / activeDenom).toFixed(2)),
        cpuMsPerFlip: Number((((samples * samplingIntervalUs) / 1000) / totalFlips).toFixed(3)),
      }));

    const topSpinWaits = [...pooledSpin.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, samples]) => ({
        name,
        samples,
        cpuMs: Number(((samples * samplingIntervalUs) / 1000).toFixed(1)),
      }));

    const topByRole = {};
    for (const [role, rm] of Object.entries(roleSelf)) {
      const rDenom = Math.max(1, roleStats[role]?.activeSamples || 1);
      topByRole[role] = [...rm.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, samples]) => ({
          name,
          samples,
          percentOfRole: Number(((samples * 100) / rDenom).toFixed(1)),
        }));
    }

    // Also run analyse-flame.mjs to produce flame.folded
    try {
      execFileSync(process.execPath, [path.join(here, "analyse-flame.mjs"), outDir, "20"], { cwd: webRoot, stdio: "pipe" });
    } catch (_) {}

    cpuSummary = {
      samplingIntervalUs,
      profiledFlips: totalFlips,
      totalWorkers: (targetsMeta.targets || []).length,
      totalSamples,
      totalWorkSamples,
      totalActiveSamples,
      activeCpuMsTotal: Number(((totalActiveSamples * samplingIntervalUs) / 1000).toFixed(1)),
      activeCpuMsPerFlip: Number((((totalActiveSamples * samplingIntervalUs) / 1000) / totalFlips).toFixed(2)),
      spinWaitCpuMsTotal: Number((((totalWorkSamples - totalActiveSamples) * samplingIntervalUs) / 1000).toFixed(1)),
      roleBreakdown: roleStats,
      topActiveSelf,
      topByRole,
      topSpinWaits,
    };
  }

  // 3. Collect console WebGPU / worker errors
  const consoleGpuErrors = (report.console || [])
    .map((c) => typeof c === "string" ? c : c?.text || "")
    .filter((line) => /WebGPU uncaptured error|rpcs3 gpu worker error|rpcs3 worker error|validation error|Invalid CommandBuffer/i.test(line));

  const deepProfile = {
    generatedAt: new Date().toISOString(),
    target: report.target,
    revision: report.revision,
    core: report.core,
    adapter: report.capabilities?.adapter ?? report.directGpu ?? null,
    completed: report.completed ?? report.result?.ok ?? false,
    failures: report.failures ?? [],
    workerErrors: [...new Set([...(report.workerErrors ?? []), ...consoleGpuErrors])].slice(0, 50),
    pixelVerification: pixelStats,
    profileWindow: report.profileWindow ?? null,
    shutdown: report.shutdown ?? null,
    frameBands: summarizeFrameBands(frames),
    rsxDrawPhases: summarizeFlipTimings(windowedFlipTimings.length ? windowedFlipTimings : flipTimings, windowedFrames.length ? windowedFrames : frames),
    rsxBackendStats: lastFrame.directStats ?? report.status?.backend ?? null,
    executionTiers: {
      ppuInstructions: lastFrame.ppuInstructions ?? report.status?.ppuInstructions ?? 0,
      ppuAotBlocks: lastFrame.ppuAotTable?.blocks ?? report.status?.ppuAotBlocks ?? 0,
      ppuAotDispatches: lastFrame.ppuAotDispatches ?? report.status?.ppuAotDispatches ?? 0,
      ppuJit: lastFrame.ppuJitReport ?? report.status?.ppuJit ?? null,
      spuInstructions: lastFrame.spuInstructions ?? report.status?.spuInstructions ?? 0,
      spuAotDispatches: lastFrame.spuDispatches ?? lastFrame.spuAotTable?.dispatches ?? 0,
      spuHotDispatches: lastFrame.spuHotDispatches ?? lastFrame.spuHotReport?.dispatches ?? 0,
      spuLlvmDispatches: lastFrame.spuLlvmDispatches ?? lastFrame.spuHotReport?.llvm?.dispatches ?? 0,
      spuDispatchProfile: lastFrame.dispatchProfile ?? null,
      compilation: lastFrame.compilation ?? null,
    },
    cpuProfile: cpuSummary,
  };

  const deepProfilePath = path.join(outDir, "deep-profile.json");
  await writeFile(deepProfilePath, JSON.stringify(deepProfile, null, 2) + "\n");
  return deepProfile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--analyse-only") {
    const outDir = path.resolve(args[1]);
    const dp = await generateDeepProfile(outDir);
    console.log(JSON.stringify(dp, null, 2));
    process.exit(0);
  }
  const [target, rawOut] = args;
  if (!target) {
    console.error("usage: node scripts/deep-profile.mjs <target> [output-dir] | --analyse-only <output-dir>");
    process.exit(2);
  }
  const outDir = path.resolve(rawOut || path.join(webRoot, "profile-results", `run-${Date.now()}`));
  await mkdir(outDir, { recursive: true });
  const env = {
    ...process.env,
    RPCS3_WEB_URL: process.env.RPCS3_WEB_URL || "https://rpcs3.appmana.com",
    RPCS3_CORE: process.env.RPCS3_CORE || "jspi",
    RPCS3_PROFILE: "1",
    RPCS3_PPU_PROFILE: process.env.RPCS3_PPU_PROFILE || "1",
    RPCS3_CPU_INTERVAL_US: process.env.RPCS3_CPU_INTERVAL_US || "2000",
    RPCS3_FRAMES: process.env.RPCS3_FRAMES || (target.startsWith("fixtures/") ? "120" : "600"),
  };
  let runErr = null;
  try {
    execFileSync(process.execPath, [path.join(here, "run-performance.mjs"), target, outDir, ...args.slice(2)], {
      cwd: webRoot,
      env,
      stdio: "inherit",
    });
  } catch (err) {
    runErr = err;
  }
  const dp = await generateDeepProfile(outDir);
  console.log(JSON.stringify(dp, null, 2));
  if (runErr) process.exitCode = 1;
}
