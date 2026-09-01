import { PacketKind, copyFrontPacket, discardFrontPacket, packetSummary } from "./rpcs3-webgpu-packet.mjs";
import { createPpuDispatcher } from "./rpcs3-ppu-dispatcher.mjs";
import { createSpuDispatcher } from "./rpcs3-spu-dispatcher.mjs";

const scope = self;
let module;
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
let spuDispatcher;
let padState = { digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
let moduleCreateMs = 0;
let diagnostics = false;
let presentLatestOnly = false;
let consumedFlips = 0;
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
    spuAot: spuDispatcher?.snapshot() ?? null,
    spuAotAbi: Array.from({ length: 7 }, (_, field) =>
      module.ccall("rpcs3_web_spu_aot_abi", "number", ["number"], [field]) >>> 0),
    elapsedMs: performance.now() - bootStartedAt,
    logs: logs.slice(-300),
    detail: terminal || `dispatch protocol did not finish within ${timeoutMs} ms`,
  });
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

function progress(includeThreads = false) {
  if (!module) return;
  scope.postMessage({
    type: "runtime-progress",
    bootResult,
    heapBytes: module.HEAPU8?.byteLength ?? 0,
    workingSet: workingSet(),
    stackReport: includeThreads ? stackReport() : undefined,
    ppuInstructions: Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], [])),
    ppuLastPc: module.ccall("rpcs3_web_ppu_last_pc", "number", [], []) >>> 0,
    ppuLastFunction: module.ccall("rpcs3_web_ppu_last_function", "string", [], []),
    ppuAotEntryReady: module.ccall("rpcs3_web_ppu_aot_entry_ready", "number", [], []),
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

async function captureFrame(type, discardPackets = false) {
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
      const kind = discardFrontPacket(module);
      if (!kind) break;
      if (kind === PacketKind.flip) {
        consumedFlips += 1;
        presentedSkips += 1;
        stale -= 1;
      }
    }
  }
  // Capture exactly one coherent RSX frame. Stopping at the first draw can
  // omit overlays, while draining past a flip would blend independent frames.
  while (bootResult === 0 && flipPacketCount === 0 && status !== 0 && performance.now() < packetDeadline) {
    if (discardPackets) {
      let kind;
      while ((kind = discardFrontPacket(module))) {
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
    status = module.ccall("rpcs3_web_status", "number", [], []);
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
    captureMs,
    workingSet: workingSet(),
    stackReport: stackReport(),
    ppuInstructions: Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], [])),
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
    return;
  }
  if (event.data?.type === "shutdown") {
    try {
      clearInterval(progressTimer);
      ppuDispatcher?.release();
      ppuDispatcher = undefined;
      spuDispatcher?.release();
      spuDispatcher = undefined;
      module?.ccall("rpcs3_web_stop", null, [], []);
      module?.PThread?.terminateAllThreads();
      scope.postMessage({ type: "runtime-shutdown", ok: true });
    } catch (error) {
      scope.postMessage({ type: "runtime-shutdown", ok: false, detail: detail(error) });
    }
    scope.close();
    return;
  }
  if (event.data?.type === "next-frame") {
    if (!module) {
      scope.postMessage({ type: "runtime-frame", ok: false, detail: "RPCS3 runtime is not booted" });
      return;
    }
    try {
      await captureFrame("runtime-frame", event.data.discardPackets === true);
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
  consumedFlips = 0;
  presentedSkips = 0;
  progressIntervalMs = Math.max(100, Math.min(10_000, Number(event.data.progressIntervalMs) || 250));
  try {
    // Keep Emscripten out of module evaluation so the host can acquire and
    // configure its WebGPU device before allocating the shared Wasm memory.
    // coreUrl/wasmUrl/fixtureUrl let the iPad harness inject Blob URLs and let
    // desktop profiling select the symbolized profile build.
    const coreUrl = new URL(event.data.coreUrl ?? "./core/rpcs3-web.mjs", scope.location.href).href;
    const resolveCoreFile = (name) => {
      if (event.data.wasmUrl && name.endsWith(".wasm")) return event.data.wasmUrl;
      try { return new URL(name, coreUrl).href; } catch { return name; }
    };
    const { default: createRPCS3 } = await import(coreUrl);
    let mainInstance;
    let mainMemory;
    const [mainWasm, aotWasm, spuAotWasm] = await Promise.all([
      event.data.ppuAot === true || event.data.spuAot === true
        ? WebAssembly.compileStreaming(fetch(resolveCoreFile("rpcs3-web.wasm"))) : undefined,
      event.data.ppuAot === true
        ? WebAssembly.compileStreaming(fetch("./fixtures/web_dispatch_conformance-aot.wasm")) : undefined,
      event.data.spuAot === true
        ? WebAssembly.compileStreaming(fetch("./fixtures/web_dispatch_conformance-spu-aot.wasm")) : undefined,
    ]);
    const moduleCreateStartedAt = performance.now();
    module = await createRPCS3({
      locateFile: resolveCoreFile,
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
    initialized = module.ccall("rpcs3_web_init", "number", [], []);
    sparseVmProbe = module.ccall("rpcs3_web_sparse_vm_probe", "number", [], []);
    module.ccall("rpcs3_webgpu_set_capture_level", null, ["number"], [Number(event.data.packetCaptureLevel ?? 4)]);
    if (clockScale) module.ccall("rpcs3_web_set_clock_scale", null, ["number"], [clockScale]);
    if (typeof accurateSpuDma === "boolean") {
      module.ccall("rpcs3_web_set_accurate_spu_dma", null, ["number"], [accurateSpuDma ? 1 : 0]);
    }
    module.ccall("rpcs3_web_set_trace_pc", null, ["number"], [tracePc]);
    module.ccall("rpcs3_web_set_trace_delay", null, ["number", "number"], [
      traceDelayPc,
      Number(event.data.traceDelayMs) >>> 0,
    ]);
    module.ccall("rpcs3_web_set_watch_address", null, ["number"], [watchAddress]);
    if (aotWasm) module.ccall("rpcs3_web_set_ppu_aot_handoff", null, ["number"], [1]);
    if (spuAotWasm) module.ccall("rpcs3_web_set_spu_aot_handoff", null, ["number"], [1]);
    if (event.data.path) fixtureBytes = Number(module.FS.stat(path).size);
    applyPadState(event.data.pad);
    bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], [path]);
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
    progress(true);
    progressTimer = setInterval(progress, progressIntervalMs);
    if (event.data.completion === "dispatch") {
      await captureDispatch(String(event.data.expectedVerdict ?? ""), Number(event.data.dispatchTimeoutMs) || 30_000);
    } else {
      await captureFrame("runtime-result", event.data.discardPackets === true);
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
