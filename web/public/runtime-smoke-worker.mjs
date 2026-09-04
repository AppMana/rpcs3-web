import { PacketKind, copyFrontPacket, discardFrontPacket, packetSummary } from "./rpcs3-webgpu-packet.mjs";
// RPCS3 surface store effects carried by packets discarded without rendering; the next rendered frame applies them first
let carriedSurfaceOps = [];
import { createPpuDispatcher } from "./rpcs3-ppu-dispatcher.mjs";
import { createSpuDispatcher } from "./rpcs3-spu-dispatcher.mjs";

const scope = self;
let module;
let persistentMainInstance;
let persistentMainMemory;
let logs = [];
let initialized = 0;
let bootResult = -1;
let bootStartedAt = 0;
let fixtureBytes = 0;
let frameSequence = 0;
let debugAddresses = [];
let tracePc = 0;
let traceDelayPc = 0;
let watchAddress = 0;
let clockScale = 0;
let accurateSpuDma;
let atomicNotifyReentry = 0;
let sparseVmProbe = 0;
let packetTimeoutMs = 10_000;
let progressIntervalMs = 250;
let progressTimer;
let dispatchLines = [];
let ppuDispatcher;
let ppuAotTable = null;
let spuAotTable = null;
let spuLlvmPool = null;
let ppuJit = false;
let spuDispatcher;
let padState = { digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
let moduleCreateMs = 0;
let recordInputs = false;
const inputTrace = [];
let spuFallbackHistogram = false;
let ppuProfile = false;
let diagnostics = false;
let presentLatestOnly = false;
let consumedFlips = 0;
let directGpu;
// A core whose guest threads can suspend: its file-touching entry points return promises, and the
// boot has to run off this thread so this one can keep servicing them.
let suspendingCore = false;
let presentedSkips = 0;
let frameCounterAddress = 0;

function recordLog(line) {
  const text = String(line);
  logs.push(text);
  const marker = text.indexOf("RPCS3-DISPATCH/1 ");
  if (marker >= 0) {
    const protocolLine = text.slice(marker).split(/\r?\n/, 1)[0];
    dispatchLines.push(protocolLine);
    scope.postMessage({ type: "runtime-dispatch", line: protocolLine });
  }
  if (text.includes("RPCS3 Web") || text.startsWith("Aborted") ||
      text.includes("RuntimeError") || text.startsWith("worker:") || text.startsWith("Pthread ")) {
    scope.postMessage({ type: "runtime-log", line: text });
  }
}

async function captureDispatch(expectedVerdict = "", timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  let terminal = "";
  let aotSnapshot;
  while (bootResult === 0 && performance.now() < deadline) {
    if (ppuDispatcher) {
      const snapshot = ppuDispatcher.runBatch(256);
      aotSnapshot = snapshot;
    }
    if (spuDispatcher) spuDispatcher.runBatch(256);
    await runHostTasks();
    if (!ppuDispatcher || aotSnapshot?.context) refreshDispatchLines();
    terminal = dispatchLines.findLast((line) => / (PASS|FAIL) /.test(line)) ?? "";
    if (terminal) break;
    if (ppuDispatcher && aotSnapshot?.context) await ppuDispatcher.taskYield();
    else if (ppuDispatcher) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    else await new Promise((resolve) => setTimeout(resolve, 1));
  }
  module.ccall("rpcs3_web_sync_logs", null, [], []);
  refreshDispatchLines();
  terminal ||= dispatchLines.findLast((line) => / (PASS|FAIL) /.test(line)) ?? "";
  // The SPU LLVM tier answers asynchronously; let its outstanding compiles land in the report
  if (spuLlvmPool) await spuLlvmPool.drain(15_000);
  const verdict = terminal.startsWith("RPCS3-DISPATCH/1 PASS ") ? terminal.split(" ").at(-1) : "";
  const ppuInstructions = Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], []));
  const spuInstructions = Number(module.ccall("rpcs3_web_spu_instruction_count", "bigint", [], []));
  scope.postMessage({
    type: "runtime-result",
    ok: initialized === 1 && bootResult === 0 && Boolean(verdict) && (!expectedVerdict || verdict === expectedVerdict),
    initialized,
    bootResult,
    status: module.ccall("rpcs3_web_status", "number", [], []),
    fixtureBytes,
    dispatchLines,
    verdict,
    expectedVerdict,
    ppuInstructions,
    ppuLastPc: module.ccall("rpcs3_web_ppu_last_pc", "number", [], []) >>> 0,
    spuInstructions,
    spuLastPcs: Array.from({ length: 6 }, (_, index) =>
      module.ccall("rpcs3_web_spu_last_pc", "number", ["number"], [index]) >>> 0),
    spuLsBoundaryCount: Number(module.ccall("rpcs3_web_spu_ls_boundary_count", "bigint", [], [])),
    spuLsBoundaryLast: `0x${module.ccall("rpcs3_web_spu_ls_boundary_last", "bigint", [], []).toString(16).padStart(16, "0")}`,
    spuPageSplitDmaCount: Number(module.ccall("rpcs3_web_spu_page_split_dma_count", "bigint", [], [])),
    atomicNotifyReentry,
    sparseVmProbe,
    ppuAot: ppuDispatcher?.snapshot() ?? null,
    ppuAotTable: ppuAotTable
      ? { ...ppuAotTable, dispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])), blocksUsed: Number(module.ccall("rpcs3_web_ppu_blocks_used", "number", [], [])) }
      : null,
    spuAotTable: spuAotTable
      ? { ...spuAotTable, dispatches: Number(module.ccall("rpcs3_web_spu_aot_dispatches", "number", [], [])), fallbacks: Number(module.ccall("rpcs3_web_spu_aot_fallbacks", "number", [], [])) }
      : null,
    spuAot: spuDispatcher?.snapshot() ?? null,
    spuAotAbi: Array.from({ length: 7 }, (_, field) =>
      module.ccall("rpcs3_web_spu_aot_abi", "number", ["number"], [field]) >>> 0),
    spuHotReport: JSON.parse(module.ccall("rpcs3_web_spu_hot_report", "string", [], [])),
    spuLlvm: spuLlvmPool ? spuLlvmPool.stats() : undefined,
    ppuJitReport: ppuJit ? JSON.parse(module.ccall("rpcs3_web_ppu_jit_report", "string", [], [])) : undefined,
    ppuAotDispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])),
    elapsedMs: performance.now() - bootStartedAt,
    logs: logs.slice(-300),
    detail: terminal || `dispatch protocol did not finish within ${timeoutMs} ms`,
  });
}

// The guest addresses this run entered, as little-endian u32s. The page asks for these once the run
// has produced its frames, the way it asks for the recorded SPU misses, so a profile large enough to
// matter never rides along in a per-frame record.
function ppuUsedBase64() {
  const max = 1 << 19;
  const pointer = module._malloc(max * 4) >>> 0;
  try {
    const count = Math.min(module.ccall("rpcs3_web_ppu_used_blocks", "number", ["number", "number"], [pointer, max]) >>> 0, max);
    const bytes = new Uint8Array(module.HEAPU8.buffer, pointer, count * 4);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    recordLog(`PPU profile: ${count} entered blocks`);
    return btoa(binary);
  } finally {
    module._free(pointer);
  }
}

function detail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

function refreshDispatchLines() {
  for (const path of ["/opfs/cache/rpcs3/TTY.log", "/opfs/rpcs3/TTY.log"]) {
    try {
      const text = module.FS.readFile(path, { encoding: "utf8" });
      const lines = text.split(/\r?\n/).filter((line) => line.startsWith("RPCS3-DISPATCH/1 "));
      if (lines.length >= dispatchLines.length) dispatchLines = lines;
    } catch {}
  }
}

function vmRangeLocks() {
  const read = (name, args = [], values = []) =>
    BigInt.asUintN(64, module.ccall(name, "bigint", args, values));
  const allocated = read("rpcs3_web_vm_range_lock_bits", ["number"], [0]);
  const exclusive = read("rpcs3_web_vm_range_lock_bits", ["number"], [1]);
  const active = [];
  const relevant = allocated | exclusive;
  for (let index = 0; index < 64; index += 1) {
    if ((relevant & (1n << BigInt(index))) === 0n) continue;
    const value = read("rpcs3_web_vm_range_lock", ["number"], [index]);
    active.push({ index, value: `0x${value.toString(16).padStart(16, "0")}` });
  }
  return {
    allocated: `0x${allocated.toString(16).padStart(16, "0")}`,
    exclusive: `0x${exclusive.toString(16).padStart(16, "0")}`,
    active,
  };
}

function vmPpuLocks() {
  const count = module.ccall("rpcs3_web_vm_ppu_lock_count", "number", [], []) >>> 0;
  return Array.from({ length: count }, (_, index) => ({
    index,
    id: module.ccall("rpcs3_web_vm_ppu_lock_id", "number", ["number"], [index]) >>> 0,
    state: module.ccall("rpcs3_web_vm_ppu_lock_state", "number", ["number"], [index]) >>> 0,
  })).filter(({ id }) => id !== 0);
}

// Working-set telemetry. These are the numbers that decide the Mobile Safari
// worker pool, stack size, and initial memory; they are recorded, never used
// as a correctness oracle.
function workingSet() {
  if (!module) return undefined;
  const u64 = (name) => Number(module.ccall(name, "bigint", [], []));
  const u32 = (name) => module.ccall(name, "number", [], []) >>> 0;
  const pthreads = module.PThread?.pthreads ? Object.keys(module.PThread.pthreads).length : 0;
  const poolIdle = module.PThread?.unusedWorkers?.length ?? 0;
  return {
    heapBytes: module.HEAPU8?.byteLength ?? 0,
    mallocBytes: u64("rpcs3_web_malloc_bytes"),
    mallocArenaBytes: u64("rpcs3_web_malloc_arena_bytes"),
    vmMappedPages: u32("rpcs3_web_vm_mapped_pages"),
    vmBackingBytes: u64("rpcs3_web_vm_backing_bytes"),
    liveThreads: u32("rpcs3_web_live_thread_count"),
    peakThreads: u32("rpcs3_web_peak_thread_count"),
    startedThreads: u32("rpcs3_web_started_thread_count"),
    stackMaxUsedBytes: u64("rpcs3_web_stack_max_used"),
    poolIdle,
    poolBusy: pthreads,
    poolTotal: poolIdle + pthreads,
    queuedPacketBytes: u64("rpcs3_webgpu_queued_bytes"),
    peakQueuedPacketBytes: u64("rpcs3_webgpu_peak_queued_bytes"),
    droppedPackets: u64("rpcs3_webgpu_dropped_packets"),
    flipCounter: u32("rpcs3_webgpu_frame_counter"),
  };
}

function stackReport() {
  if (!module) return [];
  return module.ccall("rpcs3_web_stack_report", "string", [], [])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, used, size] = line.split("\t");
      return { name, usedBytes: Number(used), stackBytes: Number(size) };
    })
    .sort((a, b) => b.usedBytes - a.usedBytes);
}

// RPCS3 queues work for its main thread; this worker is that thread. On a suspending core that
// queue carries file access, which suspends, so draining it returns a promise the caller awaits.
function runHostTasks() {
  if (!module) return 0;
  return module.ccall("rpcs3_web_run_host_tasks", "number", [], []);
}

let progressInFlight = false;

async function progress(includeThreads = false) {
  if (!module || progressInFlight) return;
  progressInFlight = true;
  try {
    await runHostTasks();
  } catch {
    progressInFlight = false;
    return;
  }
  scope.postMessage({
    type: "runtime-progress",
    bootResult,
    heapBytes: module.HEAPU8?.byteLength ?? 0,
    workingSet: workingSet(),
    stackReport: includeThreads ? stackReport() : undefined,
    ppuInstructions: Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], [])),
    ppuAotTable: ppuAotTable
      ? { ...ppuAotTable, dispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])), blocksUsed: Number(module.ccall("rpcs3_web_ppu_blocks_used", "number", [], [])) }
      : null,
    spuAotTable: spuAotTable
      ? { ...spuAotTable, dispatches: Number(module.ccall("rpcs3_web_spu_aot_dispatches", "number", [], [])), fallbacks: Number(module.ccall("rpcs3_web_spu_aot_fallbacks", "number", [], [])) }
      : null,
    ppuLastPc: module.ccall("rpcs3_web_ppu_last_pc", "number", [], []) >>> 0,
    ppuLastFunction: module.ccall("rpcs3_web_ppu_last_function", "string", [], []),
    ppuAotEntryReady: module.ccall("rpcs3_web_ppu_aot_entry_ready", "number", [], []),
    ppuAotDispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])),
    ppuJitReport: ppuJit ? JSON.parse(module.ccall("rpcs3_web_ppu_jit_report", "string", [], [])) : undefined,
    spuInstructions: Number(module.ccall("rpcs3_web_spu_instruction_count", "bigint", [], [])),
    spuLastPcs: Array.from({ length: 6 }, (_, index) =>
      module.ccall("rpcs3_web_spu_last_pc", "number", ["number"], [index]) >>> 0),
    spuLsBoundaryCount: Number(module.ccall("rpcs3_web_spu_ls_boundary_count", "bigint", [], [])),
    spuLsBoundaryLast: `0x${module.ccall("rpcs3_web_spu_ls_boundary_last", "bigint", [], []).toString(16).padStart(16, "0")}`,
    spuPageSplitDmaCount: Number(module.ccall("rpcs3_web_spu_page_split_dma_count", "bigint", [], [])),
    vmRangeLocks: vmRangeLocks(),
    vmPpuLocks: vmPpuLocks(),
    tracePc,
    clockScale,
    traceHits: module.ccall("rpcs3_web_trace_hits", "number", [], []) >>> 0,
    threads: includeThreads ? module.ccall("rpcs3_web_thread_snapshot", "string", [], []) : "",
    elapsedMs: bootStartedAt ? performance.now() - bootStartedAt : 0,
  });
  progressInFlight = false;
}

scope.addEventListener("error", (event) => {
  scope.postMessage({
    type: "runtime-fatal",
    detail: detail(event.error ?? `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`),
    logs: logs.slice(-200),
  });
});

scope.addEventListener("unhandledrejection", (event) => {
  scope.postMessage({ type: "runtime-fatal", detail: detail(event.reason), logs: logs.slice(-200) });
});

function debugRead32(address) {
  return module.ccall("rpcs3_web_debug_read32", "number", ["number"], [address]) >>> 0;
}

function applyPadState(next = {}) {
  padState = {
    digital1: Number(next.digital1 ?? padState.digital1) >>> 0,
    digital2: Number(next.digital2 ?? padState.digital2) >>> 0,
    leftX: Math.max(0, Math.min(255, Number(next.leftX ?? padState.leftX))) >>> 0,
    leftY: Math.max(0, Math.min(255, Number(next.leftY ?? padState.leftY))) >>> 0,
    rightX: Math.max(0, Math.min(255, Number(next.rightX ?? padState.rightX))) >>> 0,
    rightY: Math.max(0, Math.min(255, Number(next.rightY ?? padState.rightY))) >>> 0,
  };
  module?.ccall("rpcs3_web_set_pad", null,
    ["number", "number", "number", "number", "number", "number"],
    [padState.digital1, padState.digital2, padState.leftX, padState.leftY, padState.rightX, padState.rightY]);
}

function pendingFlips() {
  return (module.ccall("rpcs3_webgpu_frame_counter", "number", [], []) >>> 0) - consumedFlips;
}

// Sleep until RPCS3's RSX thread has pushed another flip (it notifies the
// frame counter word), or until the timeout. This worker is the module main
// thread that Emscripten proxies pthread creation through, so it must never
// block in Atomics.wait; waitAsync yields to the event loop instead.
async function waitForFlip(timeoutMs) {
  const expected = consumedFlips;
  if (frameCounterAddress && typeof Atomics.waitAsync === "function") {
    const heap = new Int32Array(module.HEAPU8.buffer);
    const result = Atomics.waitAsync(heap, frameCounterAddress >>> 2, expected, Math.max(1, timeoutMs));
    if (result.async) await result.value;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}

// untilDraw: keep consuming whole frames inside the worker, without a page
// round trip, until one contains a draw packet (or the deadline passes).
// Skipped frames are counted; nothing is transferred for them, so a title
// that flips empty frames for seconds cannot back the host queue up.
// Recorded SPU AOT misses (SPU cache format) for the native compile pass
function spuMissBase64() {
  const size = module.ccall("rpcs3_web_spu_miss_size", "number", [], []) >>> 0;
  const pointer = module.ccall("rpcs3_web_spu_miss_data", "number", [], []) >>> 0;
  if (!size || !pointer) return "";
  const bytes = module.HEAPU8.subarray(pointer, pointer + size);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(""));
}

async function captureFrame(type, discardPackets = false, untilDraw = false) {
  let status = module.ccall("rpcs3_web_status", "number", [], []);
  let packetCount = 0;
  let drawPacketCount = 0;
  let flipPacketCount = 0;
  const packetSummaries = [];
  const packets = [];
  const captureStartedAt = performance.now();
  const packetDeadline = captureStartedAt + packetTimeoutMs;
  // Interactive presentation only wants the newest complete frame. Skip
  // older complete frames that queued while the page was busy; they are
  // counted separately from host queue drops.
  if (presentLatestOnly) {
    let stale = pendingFlips() - 1;
    while (stale > 0) {
      const kind = discardFrontPacket(module, carriedSurfaceOps);
      if (!kind) break;
      if (kind === PacketKind.flip) {
        consumedFlips += 1;
        presentedSkips += 1;
        stale -= 1;
      }
    }
  }
  let skippedFrames = 0;
  // Capture exactly one coherent RSX frame. Stopping at the first draw can
  // omit overlays, while draining past a flip would blend independent frames.
  for (;;) {
  while (bootResult === 0 && flipPacketCount === 0 && status !== 0 && performance.now() < packetDeadline) {
    if (directGpu) {
      // Direct backend: frames are presented by the RSX thread itself; a frame is complete when
      // the host frame counter advanced (no packets to drain)
      const pending = pendingFlips();
      if (pending > 0) {
        consumedFlips += pending;
        presentedSkips += pending - 1;
        flipPacketCount = 1;
        break;
      }
    }
    if (discardPackets) {
      let kind;
      while ((kind = discardFrontPacket(module, carriedSurfaceOps))) {
        packetCount += 1;
        drawPacketCount += kind === PacketKind.draw ? 1 : 0;
        flipPacketCount += kind === PacketKind.flip ? 1 : 0;
        if (kind === PacketKind.flip) { consumedFlips += 1; break; }
      }
    }
    let packet;
    while (!discardPackets && (packet = copyFrontPacket(module))) {
      packetCount += 1;
      drawPacketCount += packet.kind === PacketKind.draw ? 1 : 0;
      flipPacketCount += packet.kind === PacketKind.flip ? 1 : 0;
      if (diagnostics) packetSummaries.push(packetSummary(packet));
      packets.push(packet);
      if (packet.kind === PacketKind.flip) { consumedFlips += 1; break; }
    }
    if (flipPacketCount !== 0) break;
    // Wait for the RSX thread's flip notification (bounded so pad messages
    // and status changes are still observed). This is not guest pacing.
    await waitForFlip(Math.min(250, packetDeadline - performance.now()));
    await runHostTasks();
    status = module.ccall("rpcs3_web_status", "number", [], []);
  }
  if (untilDraw && flipPacketCount === 1 && drawPacketCount === 0 && bootResult === 0 && status !== 0 && performance.now() < packetDeadline) {
    // Empty frame: drop it and capture the next one.
    skippedFrames += 1;
    packets.length = 0;
    packetSummaries.length = 0;
    packetCount = 0;
    flipPacketCount = 0;
    continue;
  }
  break;
  }
  frameSequence += 1;
  const captureMs = performance.now() - captureStartedAt;
  const packetBuffers = packets.map((packet) => packet.bytes.buffer);
  const debugWords = Object.fromEntries(debugAddresses.map((address) => [
    `0x${(address >>> 0).toString(16)}`,
    debugRead32(address >>> 0),
  ]));
  const textureWords = diagnostics ? Object.fromEntries(packets.flatMap((packet) => packet.textures.flatMap((texture) =>
    [0, 4, 0x100, Math.max(0, texture.dataSize - 4)].map((offset) => {
      const address = (texture.address + offset) >>> 0;
      return [`0x${address.toString(16)}`, debugRead32(address)];
    })))) : undefined;
  scope.postMessage({
    type,
    directGpu,
    directStats: directGpu ? JSON.parse(module.ccall("rpcs3_web_direct_stats", "string", [], [])) : undefined,
    carriedSurfaceOps: packets.length ? carriedSurfaceOps.splice(0) : undefined,
    ok: initialized === 1 && bootResult === 0 && flipPacketCount === 1,
    initialized,
    storageState: module.ccall("rpcs3_web_storage_state", "number", [], []),
    bootResult,
    status,
    frameSequence,
    packetCount,
    drawPacketCount,
    flipPacketCount,
    packetSummaries,
    packetBuffers,
    debugWords,
    textureWords,
    droppedPackets: Number(module.ccall("rpcs3_webgpu_dropped_packets", "bigint", [], [])),
    presentedSkips,
    skippedFrames,
    padScheduleApplied: module.ccall("rpcs3_web_pad_schedule_applied", "number", [], []) >>> 0,
    captureMs,
    workingSet: workingSet(),
    liveThreadNames: module.ccall("rpcs3_web_live_thread_names", "string", [], []).split("\n").filter(Boolean),
    threads: diagnostics ? module.ccall("rpcs3_web_thread_snapshot", "string", [], []) : "",
    spuFallbackReport: spuFallbackHistogram ? module.ccall("rpcs3_web_spu_aot_fallback_report", "string", ["number"], [48]) : undefined,
    spuHot: module.rpcs3SpuHotStats ? module.rpcs3SpuHotStats() : undefined,
    spuHotReport: module ? JSON.parse(module.ccall("rpcs3_web_spu_hot_report", "string", [], [])) : undefined,
    spuLlvm: spuLlvmPool ? spuLlvmPool.stats() : undefined,
    ppuJitReport: ppuJit ? JSON.parse(module.ccall("rpcs3_web_ppu_jit_report", "string", [], [])) : undefined,
    ppuHot: ppuJit && module.rpcs3PpuHotStats ? module.rpcs3PpuHotStats() : undefined,
    ppuAotDispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])),
    spuMissCount: spuFallbackHistogram ? module.ccall("rpcs3_web_spu_miss_count", "number", [], []) >>> 0 : 0,
    stackReport: stackReport(),
    ppuInstructions: Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], [])),
    ppuAotTable: ppuAotTable
      ? { ...ppuAotTable, dispatches: Number(module.ccall("rpcs3_web_ppu_aot_dispatches", "number", [], [])), blocksUsed: Number(module.ccall("rpcs3_web_ppu_blocks_used", "number", [], [])) }
      : null,
    spuAotTable: spuAotTable
      ? { ...spuAotTable, dispatches: Number(module.ccall("rpcs3_web_spu_aot_dispatches", "number", [], [])), fallbacks: Number(module.ccall("rpcs3_web_spu_aot_fallbacks", "number", [], [])) }
      : null,
    ppuLastPc: module.ccall("rpcs3_web_ppu_last_pc", "number", [], []) >>> 0,
    ppuLastFunction: module.ccall("rpcs3_web_ppu_last_function", "string", [], []),
    spuInstructions: Number(module.ccall("rpcs3_web_spu_instruction_count", "bigint", [], [])),
    spuLastPcs: Array.from({ length: 6 }, (_, index) =>
      module.ccall("rpcs3_web_spu_last_pc", "number", ["number"], [index]) >>> 0),
    spuLsBoundaryCount: Number(module.ccall("rpcs3_web_spu_ls_boundary_count", "bigint", [], [])),
    spuLsBoundaryLast: `0x${module.ccall("rpcs3_web_spu_ls_boundary_last", "bigint", [], []).toString(16).padStart(16, "0")}`,
    spuPageSplitDmaCount: Number(module.ccall("rpcs3_web_spu_page_split_dma_count", "bigint", [], [])),
    tracePc,
    traceHits: module.ccall("rpcs3_web_trace_hits", "number", [], []) >>> 0,
    atomicNotifyReentry,
    sparseVmProbe,
    entryOpd: [0x40250, 0x40254].map((address) => debugRead32(address)),
    entryCodeWord: debugRead32(0x1022c),
    elapsedMs: performance.now() - bootStartedAt,
    moduleCreateMs,
    fixtureBytes,
    logs: logs.slice(-200),
    detail: `Emu.Init=${initialized}; System::BootGame=${bootResult}; frame=${frameSequence}`,
  }, packetBuffers);
}

scope.addEventListener("message", async (event) => {
  if (event.data?.type === "snapshot") {
    module?.ccall("rpcs3_web_sync_logs", null, [], []);
    progress(true);
    return;
  }
  if (event.data?.type === "pad") {
    applyPadState(event.data.state);
    if (recordInputs && module) {
      // Frame-indexed record: the state takes effect after this flip count.
      inputTrace.push({ frame: module.ccall("rpcs3_webgpu_frame_counter", "number", [], []) >>> 0, ...padState });
    }
    return;
  }
  if (event.data?.type === "export-input-trace") {
    scope.postMessage({
      type: "input-trace",
      schema: 1,
      entries: inputTrace.slice(),
      flipCounter: module ? module.ccall("rpcs3_webgpu_frame_counter", "number", [], []) >>> 0 : 0,
      applied: module ? module.ccall("rpcs3_web_pad_schedule_applied", "number", [], []) >>> 0 : 0,
    });
    return;
  }
  if (event.data?.type === "spu-wasm-selftest") {
    // SPU wasm recompiler self-test over an SPU cache image (base64)
    let report = "";
    try {
      const bytes = Uint8Array.from(atob(String(event.data.base64 || "")), (c) => c.charCodeAt(0));
      const pointer = module._malloc(bytes.length + 16) >>> 0;
      module.HEAPU8.set(bytes, pointer);
      report = module.ccall("rpcs3_web_spu_wasm_selftest", "string", ["number", "number"], [pointer, bytes.length]);
      module._free(pointer);
    } catch (error) {
      report = JSON.stringify({ error: String(error && error.message ? error.message : error) });
    }
    scope.postMessage({ type: "spu-wasm-selftest", report });
    return;
  }

  if (event.data?.type === "ppu-profile") {
    // The guest addresses this run entered, for building a bundle of only the blocks a run reaches
    scope.postMessage({ type: "ppu-profile", base64: ppuProfile && module ? ppuUsedBase64() : "" });
    return;
  }

  if (event.data?.type === "spu-misses") {
    // Recorded SPU AOT misses (SPU cache format) for the native compile pass
    scope.postMessage({ type: "spu-misses", base64: spuFallbackHistogram && module ? spuMissBase64() : "" });
    return;
  }

  if (event.data?.type === "shutdown") {
    try {
      clearInterval(progressTimer);
      spuLlvmPool?.stop();
      spuLlvmPool = null;
      ppuDispatcher?.release();
      ppuDispatcher = undefined;
      spuDispatcher?.release();
      spuDispatcher = undefined;
      const stopStartedAt = performance.now();
      await module?.ccall("rpcs3_web_stop", null, [], []);
      // Emu.Kill is asynchronous. Wait (without blocking this event-loop
      // thread) for RPCS3's threads to exit cooperatively: they record their
      // stack high-water marks on the way out, and a clean exit is what lets
      // the browser release the workers and the shared heap.
      let stoppedCleanly = false;
      while (module && performance.now() - stopStartedAt < 5_000) {
        await runHostTasks();
        if (module.ccall("rpcs3_web_is_stopped", "number", [], []) === 1
          && (module.ccall("rpcs3_web_live_thread_count", "number", [], []) >>> 0) === 0) {
          stoppedCleanly = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const shutdownStackReport = stackReport();
      const shutdownWorkingSet = workingSet();
      const liveThreadNames = module ? module.ccall("rpcs3_web_live_thread_names", "string", [], []).split("\n").filter(Boolean) : [];
      const keepRuntime = event.data.keepRuntime === true && stoppedCleanly;
      if (!keepRuntime) module?.PThread?.terminateAllThreads();
      scope.postMessage({
        type: "runtime-shutdown",
        ok: true,
        kept: keepRuntime,
        stoppedCleanly,
        stopMs: performance.now() - stopStartedAt,
        stackReport: shutdownStackReport,
        workingSet: shutdownWorkingSet,
        liveThreadNames,
      });
    } catch (error) {
      scope.postMessage({ type: "runtime-shutdown", ok: false, detail: detail(error) });
    }
    if (!(event.data.keepRuntime === true)) scope.close();
    return;
  }
  if (event.data?.type === "texture-forget") {
    if (module) {
      for (const key of event.data.textures ?? []) {
        module.ccall("rpcs3_webgpu_texture_forget", null, Array(12).fill("number"), key);
      }
    }
    return;
  }
  if (event.data?.type === "next-frame") {
    if (!module) {
      scope.postMessage({ type: "runtime-frame", ok: false, detail: "RPCS3 runtime is not booted" });
      return;
    }
    try {
      await captureFrame("runtime-frame", event.data.discardPackets === true, event.data.untilDraw === true);
    } catch (error) {
      scope.postMessage({ type: "runtime-frame", ok: false, detail: detail(error), logs: logs.slice(-200) });
    }
    return;
  }
  if (event.data?.type !== "boot") return;
  logs = [];
  dispatchLines = [];
  debugAddresses = Array.isArray(event.data.debugAddresses) ? event.data.debugAddresses : [];
  tracePc = Number(event.data.tracePc) >>> 0;
  traceDelayPc = Number(event.data.traceDelayPc) >>> 0;
  watchAddress = Number(event.data.watchAddress) >>> 0;
  clockScale = Math.max(0, Math.min(3_000, Number(event.data.clockScale) || 0)) >>> 0;
  accurateSpuDma = typeof event.data.accurateSpuDma === "boolean" ? event.data.accurateSpuDma : undefined;
  packetTimeoutMs = Math.max(1_000, Math.min(300_000, Number(event.data.packetTimeoutMs) || 10_000));
  diagnostics = event.data.diagnostics === true;
  presentLatestOnly = event.data.presentLatestOnly === true;
  recordInputs = event.data.recordInputs === true;
  inputTrace.length = 0;
  consumedFlips = 0;
  presentedSkips = 0;
  progressIntervalMs = Math.max(100, Math.min(10_000, Number(event.data.progressIntervalMs) || 250));
  try {
    // Keep Emscripten out of module evaluation so the host can acquire and
    // configure its WebGPU device before allocating the shared Wasm memory.
    // coreUrl/wasmUrl/fixtureUrl let the iPad harness inject Blob URLs and let
    // desktop profiling select the symbolized profile build.
    const coreUrl = new URL(event.data.coreUrl ?? "./core/rpcs3-web.mjs", scope.location.href).href;
    suspendingCore = event.data.suspending === true;
    const resolveCoreFile = (name) => {
      if (event.data.wasmUrl && name.endsWith(".wasm")) return event.data.wasmUrl;
      try { return new URL(name, coreUrl).href; } catch { return name; }
    };
    // Persistent runtime: a second boot reuses the module, its shared memory, the pthread pool and
    // the GPU worker (Safari does not release a 512 MiB shared memory promptly enough to allocate
    // another one for the next run)
    const reuse = Boolean(module) && event.data.reuse === true;
    if (reuse) {
      recordLog("persistent runtime: booting again in the existing module");
      consumedFlips = module.ccall("rpcs3_webgpu_frame_counter", "number", [], []) >>> 0;
      frameSequence = 0;
      carriedSurfaceOps = [];
      module.ccall("rpcs3_webgpu_clear", null, [], []);
    }
    const { default: createRPCS3 } = reuse ? { default: undefined } : await import(coreUrl);
    let mainInstance = reuse ? persistentMainInstance : undefined;
    let mainMemory = reuse ? persistentMainMemory : undefined;
    const [mainWasm, aotWasm, spuAotWasm] = reuse ? [] : await Promise.all([
      event.data.ppuAot === true || event.data.spuAot === true || typeof event.data.ppuAotBundle === "string" || typeof event.data.spuAotBundle === "string"
        ? WebAssembly.compileStreaming(fetch(resolveCoreFile("rpcs3-web.wasm"))) : undefined,
      event.data.ppuAot === true
        ? WebAssembly.compileStreaming(fetch("./fixtures/web_dispatch_conformance-aot.wasm")) : undefined,
      event.data.spuAot === true
        ? WebAssembly.compileStreaming(fetch("./fixtures/web_dispatch_conformance-spu-aot.wasm")) : undefined,
    ]);
    const moduleCreateStartedAt = performance.now();
    if (!reuse) module = await createRPCS3({
      locateFile: resolveCoreFile,
      // Emscripten workers started up front; RPCS3's homebrew boot uses 7-8
      // threads and the pool grows on demand beyond this.
      // The pool must cover the boot thread set: a thread created while the module thread is inside the
      // synchronous boot call cannot get a new worker (worker loads need this thread's event loop).
      pthreadPoolSize: Math.max(2, Math.min(64, Number(event.data.pthreadPoolSize) || 40)),
      print: recordLog,
      printErr: recordLog,
      ...(mainWasm ? {
        instantiateWasm(imports, receiveInstance) {
          mainMemory = imports.env.memory;
          mainInstance = new WebAssembly.Instance(mainWasm, imports);
          receiveInstance(mainInstance, mainWasm);
          return mainInstance.exports;
        },
      } : {}),
    });
    moduleCreateMs = performance.now() - moduleCreateStartedAt;
    persistentMainInstance = mainInstance;
    persistentMainMemory = mainMemory;
    frameCounterAddress = module.ccall("rpcs3_webgpu_frame_counter_address", "number", [], []) >>> 0;
    atomicNotifyReentry = module.ccall("rpcs3_web_atomic_notify_reentry_probe", "number", [], []);
    let path = event.data.path;
    if (!path) {
      const response = await fetch(event.data.fixtureUrl ?? new URL(`./${event.data.fixture}`, scope.location.href));
      if (!response.ok) throw new Error(`fixture fetch returned ${response.status}`);
      const elf = new Uint8Array(await response.arrayBuffer());
      fixtureBytes = elf.byteLength;
      path = "/acceptance-homebrew.elf";
      module.FS.writeFile(path, elf);
    }
    module.ccall("rpcs3_web_set_null_renderer", null, ["number"], [event.data.renderer === "null" ? 1 : 0]);
    bootStartedAt = performance.now();
    if (event.data.directRenderer) {
      // Direct WebGPU backend: the RSX thread's pool worker owns the device and the presentation canvas
      module.ccall("rpcs3_web_set_direct_renderer", null, ["number"], [1]);
      const flagAddress = module.ccall("rpcs3_web_rsx_spawn_flag_address", "number", [], []) >>> 0;
      module.rpcs3OnPresent = (data) => scope.postMessage({ type: "runtime-present", frame: data.frame, bitmap: data.rpcs3Present }, [data.rpcs3Present]);
      module.rpcs3OnPresented = (frame) => scope.postMessage({ type: "runtime-presented", frame });
      if (!module.__rpcs3GpuWorker) {
        directGpu = await module.rpcs3PrepareGpu(event.data.gpuCanvas, flagAddress);
        recordLog(`direct WebGPU device ready on a pool worker: ${JSON.stringify(directGpu)}`);
      }
    }
    // A suspending core's file-touching entry points return a promise, because the file system they
    // reach suspends the calling stack rather than blocking it.
    initialized = await module.ccall("rpcs3_web_init", "number", [], []);
    sparseVmProbe = module.ccall("rpcs3_web_sparse_vm_probe", "number", [], []);
    module.ccall("rpcs3_webgpu_set_capture_level", null, ["number"], [Number(event.data.packetCaptureLevel ?? 4)]);
    if (clockScale) module.ccall("rpcs3_web_set_clock_scale", null, ["number"], [clockScale]);
    // RPCS3's SPU decoder: static (interpreter only), asmjit (SPU->wasm recompiler), llvm (adds the LLVM tier)
    const spuDecoder = ["static", "asmjit", "llvm"].includes(event.data.spuDecoder) ? event.data.spuDecoder : "asmjit";
    module.ccall("rpcs3_web_set_spu_decoder", null, ["number"], [{ static: 0, asmjit: 1, llvm: 2 }[spuDecoder]]);
    // How much code one SPU program may cover: safe, mega or giga (RPCS3's own setting)
    const spuBlockSize = ["safe", "mega", "giga"].includes(event.data.spuBlockSize) ? event.data.spuBlockSize : "safe";
    module.ccall("rpcs3_web_set_spu_block_size", null, ["number"], [{ safe: 0, mega: 1, giga: 2 }[spuBlockSize]]);
    if (event.data.resolutionScalePercent) module.ccall("rpcs3_web_set_resolution_scale", null, ["number"], [Number(event.data.resolutionScalePercent) >>> 0]);
    if (typeof accurateSpuDma === "boolean") {
      module.ccall("rpcs3_web_set_accurate_spu_dma", null, ["number"], [accurateSpuDma ? 1 : 0]);
    }
    module.ccall("rpcs3_web_set_trace_pc", null, ["number"], [tracePc]);
    module.ccall("rpcs3_web_set_trace_delay", null, ["number", "number"], [
      traceDelayPc,
      Number(event.data.traceDelayMs) >>> 0,
    ]);
    module.ccall("rpcs3_web_set_watch_address", null, ["number"], [watchAddress]);
    if (event.data.spuFallbackHistogram === true) {
      module.ccall("rpcs3_web_set_spu_fallback_histogram", null, ["number"], [1]);
      spuFallbackHistogram = true;
    }
    ppuProfile = event.data.ppuProfile === true;
    if (Array.isArray(event.data.spuTraceRange)) {
      module.ccall("rpcs3_web_set_spu_trace_range", null, ["number", "number"], [Number(event.data.spuTraceRange[0]) >>> 0, Number(event.data.spuTraceRange[1]) >>> 0]);
    }
    // Input trace replay: applied on the RSX thread at the recorded flips.
    module.ccall("rpcs3_web_pad_schedule_clear", null, [], []);
    for (const entry of [...(Array.isArray(event.data.inputTrace) ? event.data.inputTrace : [])].sort((a, b) => a.frame - b.frame)) {
      module.ccall("rpcs3_web_pad_schedule_add", null, ["number", "number", "number", "number", "number", "number", "number"], [
        Number(entry.frame) >>> 0, Number(entry.digital1 ?? 0) >>> 0, Number(entry.digital2 ?? 0) >>> 0,
        Number(entry.leftX ?? 128) >>> 0, Number(entry.leftY ?? 128) >>> 0, Number(entry.rightX ?? 128) >>> 0, Number(entry.rightY ?? 128) >>> 0,
      ]);
    }
    if (typeof event.data.ppuAotBundle === "string" && !reuse) {
      // Title bundle: compiled blocks placed in every worker's function table before boot, run by the PPU pthreads.
      const { loadPpuAotBundle } = await import("./rpcs3-ppu-aot-table.mjs");
      ppuAotTable = await loadPpuAotBundle({
        module,
        mainInstance,
        mainMemory,
        manifestUrl: new URL(event.data.ppuAotBundle, scope.location.href).href,
        log: (line) => { recordLog(line); console.log(line); },
      });
    }
    if (typeof event.data.spuAotBundle === "string" && !reuse) {
      const { loadSpuAotBundle } = await import("./rpcs3-spu-aot-table.mjs");
      spuAotTable = await loadSpuAotBundle({
        module,
        mainInstance,
        mainMemory,
        manifestUrl: new URL(event.data.spuAotBundle, scope.location.href).href,
        log: (line) => { recordLog(line); console.log(line); },
      });
    }
    if (!reuse) {
      // Everything either runtime tier compiles goes into the function table above the bundles
      module.rpcs3InstallHotTable(ppuAotTable, spuAotTable);
      // The binding map (one entry per patchpoint import) is not report material
      if (spuAotTable) spuAotTable = { ...spuAotTable, bindings: undefined };
      if (Number(event.data.spuHotThreshold) > 0) {
        module.ccall("rpcs3_web_spu_set_hot_threshold", null, ["number"], [Number(event.data.spuHotThreshold)]);
      }
      // The PPU tier compiles blocks the bundle does not carry, so a block the analyser found never
      // falls back to the interpreter for the whole run. Enabled before boot, because ppu_initialize
      // is where the analyser hands it the blocks it may compile.
      ppuJit = event.data.ppuJit === true;
      if (ppuJit) {
        if (Number(event.data.ppuJitThreshold) > 0) {
          module.ccall("rpcs3_web_ppu_llvm_set_threshold", null, ["number"], [Number(event.data.ppuJitThreshold)]);
        }
        if (Number(event.data.ppuJitCapacity) > 0) {
          module.ccall("rpcs3_web_ppu_llvm_set_capacity", null, ["number"], [Number(event.data.ppuJitCapacity)]);
        }
        module.ccall("rpcs3_web_ppu_llvm_set_enabled", null, ["number"], [1]);
      }
      if (spuDecoder === "llvm" || ppuJit) {
        // RPCS3's own recompilers run in these compiler workers (see rpcs3-spu-llvm.mjs)
        const { createLlvmCompilerPool } = await import("./rpcs3-spu-llvm.mjs");
        spuLlvmPool = await createLlvmCompilerPool({
          module,
          memory: mainMemory ?? module.wasmMemory,
          workers: Number(event.data.spuLlvmWorkers) > 0 ? Number(event.data.spuLlvmWorkers) : 2,
          moduleUrl: new URL("./core/rpcs3-spu-llvm.mjs", scope.location.href).href,
          log: (line) => { recordLog(line); console.log(line); },
          spu: spuDecoder === "llvm",
          ppu: ppuJit,
        });
        if (spuDecoder === "llvm") module.ccall("rpcs3_web_spu_llvm_set_enabled", null, ["number"], [1]);
      }
    }
    if (aotWasm) module.ccall("rpcs3_web_set_ppu_aot_handoff", null, ["number"], [1]);
    if (spuAotWasm) module.ccall("rpcs3_web_set_spu_aot_handoff", null, ["number"], [1]);
    if (event.data.path) {
      try { fixtureBytes = Number(module.FS.stat(path).size); } catch { fixtureBytes = 0; }
    }
    applyPadState(event.data.pad);
    if (suspendingCore) {
      // Booting reads the disc image and waits on the threads it starts, and both of those need
      // this thread's event loop, so the boot runs on its own thread and this one keeps turning.
      bootResult = module.ccall("rpcs3_web_boot_begin", "number", ["string"], [path]);
      while (bootResult === 0 && !module.ccall("rpcs3_web_boot_finished", "number", [], [])) {
        await runHostTasks();
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      if (bootResult === 0) bootResult = module.ccall("rpcs3_web_boot_result", "number", [], []);
    } else {
      bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], [path]);
    }
    if (aotWasm) {
      ppuDispatcher = createPpuDispatcher({
        module,
        mainExports: mainInstance.exports,
        mainMemory,
        aotModule: aotWasm,
        entryReadyAddress: mainInstance.exports.rpcs3_web_ppu_aot_entry_ready_address() >>> 0,
      });
    }
    if (spuAotWasm) {
      spuDispatcher = createSpuDispatcher({
        module,
        mainExports: mainInstance.exports,
        mainMemory,
        aotModules: [spuAotWasm],
      });
    }
    progress();
    progressTimer = setInterval(progress, progressIntervalMs);
    if (event.data.completion === "dispatch") {
      await captureDispatch(String(event.data.expectedVerdict ?? ""), Number(event.data.dispatchTimeoutMs) || 30_000);
    } else {
      await captureFrame("runtime-result", event.data.discardPackets === true, event.data.untilDraw === true);
    }
  } catch (error) {
    // Attach the tail of RPCS3's own log so a boot failure is diagnosable
    // without a second run.
    let rpcs3Log = "";
    try {
      module?.ccall("rpcs3_web_sync_logs", null, [], []);
      rpcs3Log = module.FS.readFile("/opfs/cache/rpcs3/RPCS3.log", { encoding: "utf8" }).slice(-4000);
    } catch {}
    scope.postMessage({ type: "runtime-result", ok: false, detail: detail(error), logs: logs.slice(-200), rpcs3Log });
  }
});
