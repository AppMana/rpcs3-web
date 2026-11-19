#!/usr/bin/env node
// Fast, compact (< 2 KB output) indexer & search tool for Chrome .cpuprofile bundles,
// Chrome Trace Event (.trace.json) files, and RPCS3 hardware-acceptance report.json files.
//
// Usage examples:
//   node web/scripts/query-profile.mjs <path/to/run.cpuprofile | report.json | trace.json>
//   node web/scripts/query-profile.mjs run.cpuprofile --category hle --top 20
//   node web/scripts/query-profile.mjs run.cpuprofile --category spu --window-sec 15
//   node web/scripts/query-profile.mjs run.cpuprofile --search "cellGcm|sys_lwmutex|spu_"
//   node web/scripts/query-profile.mjs run.cpuprofile --callers "rpcs3_hle_call" --depth 3
import fs from "node:fs";
import path from "node:path";
import {
  activeWorkSampleCount,
  callersOf,
  classifyWorkerProfile,
  isSpinWaitFunction,
  selfTime,
  windowed,
  workSampleCount,
} from "./worker-profiler.mjs";

function parseArgs(argv) {
  const opts = {
    files: [],
    category: null,
    search: null,
    callers: null,
    depth: 3,
    top: 20,
    windowSec: 0,
    trailingSec: 0,
    allWorkers: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--category") opts.category = argv[++i];
    else if (a === "--search" || a === "--grep") opts.search = argv[++i];
    else if (a === "--callers") opts.callers = argv[++i];
    else if (a === "--depth") opts.depth = Number(argv[++i]) || 3;
    else if (a === "--top") opts.top = Number(argv[++i]) || 20;
    else if (a === "--window-sec") opts.windowSec = Number(argv[++i]) || 0;
    else if (a === "--trailing-sec") opts.trailingSec = Number(argv[++i]) || 0;
    else if (a === "--all-workers") opts.allWorkers = true;
    else if (a === "--json") opts.json = true;
    else if (!a.startsWith("--")) opts.files.push(a);
  }
  return opts;
}

const CATEGORY_PATTERNS = {
  hle: /rpcs3_hle_call|cell[A-Z]|sceNp|sys_fs|sys_net|sys_prx|sys_lwmutex|sys_lwcond|sys_spu|sys_event|sys_semaphore|sys_rwlock|sys_mutex|sys_cond|sys_timer|sys_memory|sys_mmapper|sys_vm|ppu_function_manager/i,
  spu: /spu_thread|spu_recompiler|spu_llvm|__spu-0x|rpcs3_web_spu_|spu_intrp|MFC|spurs/i,
  ppu: /ppu_thread|ppu_interpreter|rpcs3_web_ppu_|^__0x|^__fn_0x|ppu_acall|rpcs3_ppu_/i,
  rsx: /WebGPU|RSXThread|wgpu|rpcs3_web_direct_|translateRsxProgram|GSRender|cellGcm/i,
  compiler: /SelectionDAG|MachineFunction|SPULLVMRecompiler|CompilePpu|CompileSpu|ps3recomp/i,
};

function categorizeFunction(fn = "", url = "") {
  if (!fn) return "other";
  if (isSpinWaitFunction(fn)) return "spin_wait";
  if (CATEGORY_PATTERNS.hle.test(fn)) return "hle";
  if (CATEGORY_PATTERNS.rsx.test(fn) || url.includes("rpcs3-webgpu-renderer")) return "rsx";
  if (CATEGORY_PATTERNS.spu.test(fn)) return "spu";
  if (CATEGORY_PATTERNS.ppu.test(fn)) return "ppu";
  if (CATEGORY_PATTERNS.compiler.test(fn)) return "compiler";
  return "other";
}

function summarizeReportJson(data, opts) {
  const frames = data.frames || [];
  let maxDpf = 0;
  for (const f of frames) {
    if ((f.drawPacketCount ?? 0) > maxDpf) maxDpf = f.drawPacketCount;
  }
  const threshold = Math.max(100, Math.floor(maxDpf * 0.25));
  const anchor = frames.find((f) => (f.drawPacketCount ?? 0) >= threshold);
  const stretch = anchor ? frames.filter((f) => f.flipId >= anchor.flipId) : [];
  const deltas = stretch.slice(1).map((f, i) => f.elapsedMs - stretch[i].elapsedMs).filter((d) => d > 0);
  const meanMs = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

  return {
    type: "rpcs3-report",
    ok: Boolean(data.ok),
    totalFrames: frames.length,
    gameplayStretchFrames: stretch.length,
    dpfMax: maxDpf,
    gameplayFps: meanMs > 0 ? Number((1000 / meanMs).toFixed(2)) : 0,
    meanMsPerFrame: Number(meanMs.toFixed(2)),
    ppuInstructions: data.workingSet?.ppuInstructions ?? 0,
    spuInstructions: data.workingSet?.spuInstructions ?? 0,
    recomp: data.spuLlvm?.recomp ?? null,
    ppuJit: data.ppuJit ?? null,
    spuHot: data.spuHot ?? null,
    spuWgsl: data.spuWgsl ?? null,
    workerErrors: (data.workerErrors || []).slice(0, 5),
    logTail: (data.logTail || []).slice(-10),
  };
}

function analyzeCpuProfile(profile, label, opts) {
  const byId = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const samples = windowed(profile, opts.windowSec, opts.trailingSec);
  const catCounts = { hle: 0, spu: 0, ppu: 0, rsx: 0, compiler: 0, spin_wait: 0, other: 0 };
  let activeTotal = 0;

  for (const id of samples) {
    const node = byId.get(id);
    if (!node) continue;
    const fn = node.callFrame?.functionName || "";
    const url = node.callFrame?.url || "";
    if (!fn || fn === "(idle)" || fn === "(program)" || fn === "emscripten_futex_wait" || fn === "_do_futex_wait") continue;
    const cat = categorizeFunction(fn, url);
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    if (cat !== "spin_wait") activeTotal++;
  }

  let rows = selfTime(profile, 500, {
    excludeSpinWaits: opts.category !== "spin_wait",
    lastSeconds: opts.windowSec,
    trailingSeconds: opts.trailingSec,
  });

  if (opts.category && CATEGORY_PATTERNS[opts.category]) {
    const re = CATEGORY_PATTERNS[opts.category];
    rows = rows.filter((r) => re.test(r.name) || (opts.category === "rsx" && r.where?.includes("webgpu")));
  }
  if (opts.search) {
    const re = new RegExp(opts.search, "i");
    rows = rows.filter((r) => re.test(r.name) || re.test(r.where || ""));
  }

  const topRows = rows.slice(0, opts.top).map((r) => ({
    name: r.name,
    category: categorizeFunction(r.name, r.where),
    samples: r.samples,
    pct: Number(r.percent.toFixed(2)),
  }));

  const result = {
    label,
    role: classifyWorkerProfile(profile),
    totalSamples: samples.length,
    activeWorkSamples: activeTotal,
    categoryBreakdown: catCounts,
    topFunctions: topRows,
  };

  if (opts.callers) {
    result.callers = callersOf(profile, opts.callers, opts.top, {
      depth: opts.depth,
      lastSeconds: opts.windowSec,
      trailingSeconds: opts.trailingSec,
    });
  }
  return result;
}

function analyzeTraceJson(data, opts) {
  const events = Array.isArray(data) ? data : (data.traceEvents || []);
  const durByName = new Map();
  const re = opts.search ? new RegExp(opts.search, "i") : null;
  for (const ev of events) {
    if (!ev || !ev.name) continue;
    if (re && !re.test(ev.name) && !re.test(ev.cat || "")) continue;
    const dur = Number(ev.dur || 0);
    const prev = durByName.get(ev.name) || { name: ev.name, cat: ev.cat || "", count: 0, totalUs: 0 };
    prev.count += 1;
    prev.totalUs += dur;
    durByName.set(ev.name, prev);
  }
  const ranked = [...durByName.values()]
    .sort((a, b) => (b.totalUs - a.totalUs) || (b.count - a.count))
    .slice(0, opts.top)
    .map((e) => ({ name: e.name, cat: e.cat, count: e.count, totalMs: Number((e.totalUs / 1000).toFixed(2)) }));
  return {
    type: "chrome-trace",
    totalEvents: events.length,
    topEvents: ranked,
  };
}

const opts = parseArgs(process.argv);
if (!opts.files.length) {
  console.error("Usage: node web/scripts/query-profile.mjs <file.cpuprofile|report.json|trace.json> [--category hle|spu|ppu|rsx] [--search regex] [--callers fn] [--top 20]");
  process.exit(1);
}

const targetFile = path.resolve(opts.files[0]);
const raw = JSON.parse(fs.readFileSync(targetFile, "utf8"));

if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.samples)) {
  const targetsPath = `${targetFile}.targets.json`;
  if (opts.allWorkers && fs.existsSync(targetsPath)) {
    const meta = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
    const summaries = [];
    for (const t of meta.targets || []) {
      if (!t.profilePath || !fs.existsSync(t.profilePath) || (t.activeWorkSamples || 0) === 0) continue;
      const prof = JSON.parse(fs.readFileSync(t.profilePath, "utf8"));
      summaries.push(analyzeCpuProfile(prof, path.basename(t.profilePath), opts));
    }
    console.log(JSON.stringify(summaries, null, 2));
  } else {
    console.log(JSON.stringify(analyzeCpuProfile(raw, path.basename(targetFile), opts), null, 2));
  }
} else if (raw && (Array.isArray(raw.traceEvents) || Array.isArray(raw))) {
  console.log(JSON.stringify(analyzeTraceJson(raw, opts), null, 2));
} else {
  console.log(JSON.stringify(summarizeReportJson(raw, opts), null, 2));
}
