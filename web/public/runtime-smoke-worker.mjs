import { PacketKind, copyFrontPacket, discardFrontPacket, packetSummary } from "./rpcs3-webgpu-packet.mjs";

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
let padState = { digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };

function recordLog(line) {
  const text = String(line);
  logs.push(text);
  if (text.includes("RPCS3 Web") || text.startsWith("Aborted") ||
      text.includes("RuntimeError") || text.startsWith("worker:") || text.startsWith("Pthread ")) {
    scope.postMessage({ type: "runtime-log", line: text });
  }
}

function detail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
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

function progress(includeThreads = false) {
  if (!module) return;
  scope.postMessage({
    type: "runtime-progress",
    bootResult,
    heapBytes: module.HEAPU8?.byteLength ?? 0,
    ppuInstructions: Number(module.ccall("rpcs3_web_ppu_instruction_count", "bigint", [], [])),
    ppuLastPc: module.ccall("rpcs3_web_ppu_last_pc", "number", [], []) >>> 0,
    ppuLastFunction: module.ccall("rpcs3_web_ppu_last_function", "string", [], []),
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

async function captureFrame(type, discardPackets = false) {
  let status = module.ccall("rpcs3_web_status", "number", [], []);
  let packetCount = 0;
  let drawPacketCount = 0;
  let flipPacketCount = 0;
  const packetSummaries = [];
  const packets = [];
  const packetDeadline = performance.now() + packetTimeoutMs;
  // Capture exactly one coherent RSX frame. Stopping at the first draw can
  // omit overlays, while draining past a flip would blend independent frames.
  while (bootResult === 0 && flipPacketCount === 0 && status !== 0 && performance.now() < packetDeadline) {
    if (discardPackets) {
      let kind;
      while ((kind = discardFrontPacket(module))) {
        packetCount += 1;
        drawPacketCount += kind === PacketKind.draw ? 1 : 0;
        flipPacketCount += kind === PacketKind.flip ? 1 : 0;
        if (kind === PacketKind.flip) break;
      }
    }
    let packet;
    while (!discardPackets && (packet = copyFrontPacket(module))) {
      packetCount += 1;
      drawPacketCount += packet.kind === PacketKind.draw ? 1 : 0;
      flipPacketCount += packet.kind === PacketKind.flip ? 1 : 0;
      packetSummaries.push(packetSummary(packet));
      packets.push(packet);
      if (packet.kind === PacketKind.flip) break;
    }
    if (flipPacketCount !== 0) break;
    // Yield so pad messages and the browser's worker scheduler can run while
    // RPCS3's PPU and RSX pthreads produce the next packet. This is polling,
    // not guest or presentation pacing, and adds no fixed frame interval.
    await new Promise((resolve) => setTimeout(resolve, 1));
    status = module.ccall("rpcs3_web_status", "number", [], []);
  }
  frameSequence += 1;
  const packetBuffers = packets.map((packet) => packet.bytes.buffer);
  const debugWords = Object.fromEntries(debugAddresses.map((address) => [
    `0x${(address >>> 0).toString(16)}`,
    debugRead32(address >>> 0),
  ]));
  const textureWords = Object.fromEntries(packets.flatMap((packet) => packet.textures.flatMap((texture) =>
    [0, 4, 0x100, Math.max(0, texture.dataSize - 4)].map((offset) => {
      const address = (texture.address + offset) >>> 0;
      return [`0x${address.toString(16)}`, debugRead32(address)];
    }))));
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
  debugAddresses = Array.isArray(event.data.debugAddresses) ? event.data.debugAddresses : [];
  tracePc = Number(event.data.tracePc) >>> 0;
  traceDelayPc = Number(event.data.traceDelayPc) >>> 0;
  watchAddress = Number(event.data.watchAddress) >>> 0;
  clockScale = Math.max(0, Math.min(3_000, Number(event.data.clockScale) || 0)) >>> 0;
  accurateSpuDma = typeof event.data.accurateSpuDma === "boolean" ? event.data.accurateSpuDma : undefined;
  packetTimeoutMs = Math.max(1_000, Math.min(300_000, Number(event.data.packetTimeoutMs) || 10_000));
  progressIntervalMs = Math.max(100, Math.min(10_000, Number(event.data.progressIntervalMs) || 250));
  try {
    // Keep Emscripten out of module evaluation so the host can acquire and
    // configure its WebGPU device before allocating the shared Wasm memory.
    const { default: createRPCS3 } = await import("./core/rpcs3-web.mjs");
    module = await createRPCS3({
      locateFile: (name) => new URL(`./core/${name}`, scope.location.href).href,
      print: recordLog,
      printErr: recordLog,
    });
    atomicNotifyReentry = module.ccall("rpcs3_web_atomic_notify_reentry_probe", "number", [], []);
    let path = event.data.path;
    if (!path) {
      const response = await fetch(new URL(`./${event.data.fixture}`, scope.location.href));
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
    if (event.data.path) fixtureBytes = Number(module.FS.stat(path).size);
    applyPadState(event.data.pad);
    bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], [path]);
    progress(true);
    progressTimer = setInterval(progress, progressIntervalMs);
    await captureFrame("runtime-result", event.data.discardPackets === true);
  } catch (error) {
    scope.postMessage({ type: "runtime-result", ok: false, detail: detail(error), logs: logs.slice(-200) });
  }
});
