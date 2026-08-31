import { PacketKind, copyFrontPacket, packetSummary } from "./rpcs3-webgpu-packet.mjs";

const scope = self;
let module;
let logs = [];
let initialized = 0;
let bootResult = -1;
let bootStartedAt = 0;
let fixtureBytes = 0;
let frameSequence = 0;
let debugAddresses = [];

function detail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

function debugRead32(address) {
  return module.ccall("rpcs3_web_debug_read32", "number", ["number"], [address]) >>> 0;
}

async function captureFrame(type) {
  let status = module.ccall("rpcs3_web_status", "number", [], []);
  let packetCount = 0;
  let drawPacketCount = 0;
  let flipPacketCount = 0;
  const packetSummaries = [];
  const packets = [];
  const packetDeadline = performance.now() + 10_000;
  // Capture exactly one coherent RSX frame. Stopping at the first draw can
  // omit overlays, while draining past a flip would blend independent frames.
  while (bootResult === 0 && flipPacketCount === 0 && status !== 0 && performance.now() < packetDeadline) {
    let packet;
    while ((packet = copyFrontPacket(module))) {
      packetCount += 1;
      drawPacketCount += packet.kind === PacketKind.draw ? 1 : 0;
      flipPacketCount += packet.kind === PacketKind.flip ? 1 : 0;
      packetSummaries.push(packetSummary(packet));
      packets.push(packet);
      if (packet.kind === PacketKind.flip) break;
    }
    if (flipPacketCount !== 0) break;
    // This is bounded acceptance polling, not guest or presentation pacing.
    // RPCS3's PPU and RSX pthreads continue running independently.
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    entryOpd: [0x40250, 0x40254].map((address) => debugRead32(address)),
    entryCodeWord: debugRead32(0x1022c),
    elapsedMs: performance.now() - bootStartedAt,
    fixtureBytes,
    logs: logs.slice(-200),
    detail: `Emu.Init=${initialized}; System::BootGame=${bootResult}; frame=${frameSequence}`,
  }, packetBuffers);
}

scope.addEventListener("message", async (event) => {
  if (event.data?.type === "shutdown") {
    try {
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
      await captureFrame("runtime-frame");
    } catch (error) {
      scope.postMessage({ type: "runtime-frame", ok: false, detail: detail(error), logs: logs.slice(-200) });
    }
    return;
  }
  if (event.data?.type !== "boot") return;
  logs = [];
  debugAddresses = Array.isArray(event.data.debugAddresses) ? event.data.debugAddresses : [];
  try {
    // Keep Emscripten out of module evaluation so the host can acquire and
    // configure its WebGPU device before allocating the shared Wasm memory.
    const { default: createRPCS3 } = await import("./core/rpcs3-web.mjs");
    module = await createRPCS3({
      locateFile: (name) => new URL(`./core/${name}`, scope.location.href).href,
      print: (line) => logs.push(String(line)),
      printErr: (line) => logs.push(String(line)),
    });
    const response = await fetch(new URL(`./${event.data.fixture}`, scope.location.href));
    if (!response.ok) throw new Error(`fixture fetch returned ${response.status}`);
    const elf = new Uint8Array(await response.arrayBuffer());
    fixtureBytes = elf.byteLength;
    const path = "/acceptance-homebrew.elf";
    module.FS.writeFile(path, elf);
    bootStartedAt = performance.now();
    initialized = module.ccall("rpcs3_web_init", "number", [], []);
    bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], [path]);
    await captureFrame("runtime-result");
  } catch (error) {
    scope.postMessage({ type: "runtime-result", ok: false, detail: detail(error), logs: logs.slice(-200) });
  }
});
