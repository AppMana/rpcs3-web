// Loads a title's compiled PPU blocks into RPCS3's function tables so the PPU
// pthreads call them directly (see web/host/rpcs3_web_pre.js for the per-worker
// side). One layout is computed here: each part gets a contiguous range of table
// indices for its `__0x<addr>` exports, RPCS3 learns (address, index) pairs
// through rpcs3_web_ppu_aot_register_many, and every Emscripten pthread worker
// instantiates the same modules at the same indices before it runs a thread.

// Imports the translator emits in wasm mode, bound to the runtime's direct
// dispatch exports (the native link table binds the same names the same way).
const bindings = Object.freeze({
  __check: "rpcs3_web_ppu_direct_check",
  __error: "rpcs3_web_ppu_direct_error",
  __syscall: "rpcs3_web_ppu_direct_syscall",
  __lv1call: "rpcs3_web_ppu_direct_lv1call",
  __get_tb: "rpcs3_web_ppu_direct_get_tb",
  __lwarx: "rpcs3_web_ppu_direct_lwarx",
  __ldarx: "rpcs3_web_ppu_direct_ldarx",
  __stwcx: "rpcs3_web_ppu_direct_stwcx",
  __stdcx: "rpcs3_web_ppu_direct_stdcx",
});

function readLeb(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, offset];
    shift += 7;
  }
}

// wasm-ld --shared records the memory and table space a module needs in dylink.0.
function dylinkInfo(module) {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  const info = { memorySize: 0, memoryAlign: 0, tableSize: 0, tableAlign: 0 };
  if (!sections.length) return info;
  const bytes = new Uint8Array(sections[0]);
  let offset = 0;
  while (offset < bytes.length) {
    const type = bytes[offset++];
    let size;
    [size, offset] = readLeb(bytes, offset);
    if (type === 1) {
      let cursor = offset;
      [info.memorySize, cursor] = readLeb(bytes, cursor);
      [info.memoryAlign, cursor] = readLeb(bytes, cursor);
      [info.tableSize, cursor] = readLeb(bytes, cursor);
      [info.tableAlign, cursor] = readLeb(bytes, cursor);
    }
    offset += size;
  }
  return info;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function loadPpuAotBundle({ module, mainInstance, mainMemory, manifestUrl, readyTimeoutMs = 60_000, log = () => {} }) {
  if (!(mainMemory instanceof WebAssembly.Memory)) throw new TypeError("mainMemory must be RPCS3's WebAssembly.Memory");
  const startedAt = performance.now();
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`PPU AOT manifest fetch returned ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.parts)) throw new Error("unsupported PPU AOT manifest");
  // Relocatable (PRX) parts carry segment-relative block names; only absolute EBOOT parts are registered.
  const descriptors = manifest.parts.filter((part) => !part.relocatable);
  const compiled = await mapConcurrent(descriptors, 8, async (part) => {
    const response = await fetch(new URL(part.url, manifestUrl));
    if (!response.ok) throw new Error(`PPU AOT part ${part.url} fetch returned ${response.status}`);
    return WebAssembly.compileStreaming(response);
  });
  const compileMs = performance.now() - startedAt;
  log(`PPU AOT bundle: compiled ${compiled.length} parts in ${Math.round(compileMs)} ms`);

  const table = mainInstance.exports.__indirect_function_table;
  if (!(table instanceof WebAssembly.Table)) throw new Error("the runtime did not export its function table");
  const tableBase = table.length;
  let cursor = tableBase;
  const parts = [];
  for (let index = 0; index < compiled.length; index += 1) {
    const wasm = compiled[index];
    const info = dylinkInfo(wasm);
    for (const imported of WebAssembly.Module.imports(wasm)) {
      if (imported.module !== "env") throw new Error(`unsupported PPU AOT import module ${imported.module}.${imported.name}`);
      if (imported.kind !== "function") continue;
      if (imported.name.startsWith("rpcs3_web_vm_")) {
        bindingsFor(imported.name);
        continue;
      }
      if (!(imported.name in bindings)) throw new Error(`unsupported PPU AOT function import env.${imported.name}`);
    }
    if (!WebAssembly.Module.exports(wasm).some((entry) => entry.kind === "global" && entry.name.startsWith("__ppu_blocks_"))) {
      throw new Error(`PPU AOT part ${descriptors[index].url} carries no block table`);
    }
    const align = Math.max(1, 1 << info.memoryAlign);
    let memoryBase = 0;
    if (info.memorySize > 0) {
      const allocation = module._malloc(info.memorySize + align) >>> 0;
      memoryBase = (allocation + align - 1) & ~(align - 1);
      // __wasm_init_memory copies the passive data segments only when its flag word in this area is
      // zero; reused heap memory is not.
      new Uint8Array(mainMemory.buffer, memoryBase, info.memorySize).fill(0);
    }
    const elemBase = cursor;
    cursor += info.tableSize;
    // A worker must not call malloc before its thread runtime is initialized, so any side stack the
    // part still imports comes from a pool reserved here; workers claim slots with an atomic counter.
    let stackPool = null;
    if (WebAssembly.Module.imports(wasm).some((entry) => entry.kind === "global" && entry.name === "__stack_pointer")) {
      const slots = 64;
      const bytes = 65536;
      const base = module._malloc(16 + slots * bytes) >>> 0;
      new Uint8Array(mainMemory.buffer, base, 16).fill(0);
      stackPool = { base, slots, bytes };
    }
    parts.push({ module: wasm, memoryBase, elemBase, tableSize: info.tableSize, stackPool });
  }
  const load = {
    tableBase,
    tableSize: cursor - tableBase,
    parts,
    bindings: { ...bindings, ...Object.fromEntries(vmBindings) },
  };

  log(`PPU AOT bundle: layout ${parts.length} parts at table ${tableBase}+${load.tableSize}`);
  const populateStartedAt = performance.now();
  // A bundle that carries its blocks in the manifest is registered without instantiating anything
  // here: this thread runs no PPU thread, and instantiating every part costs a function reference
  // per table entry, which a phone does not have room for. Workers still populate their own tables
  // when a PPU thread first runs on them.
  const prebuilt = descriptors.every((part) => typeof part.blocks === "string");
  if (prebuilt) {
    const pairs = [];
    for (let position = 0; position < descriptors.length; position += 1) {
      const relative = new Uint32Array(Uint8Array.from(atob(descriptors[position].blocks), (c) => c.charCodeAt(0)).buffer);
      const elemBase = load.parts[position].elemBase;
      for (let entry = 0; entry < relative.length; entry += 2) {
        pairs.push(relative[entry], elemBase + relative[entry + 1]);
      }
    }
    if (!pairs.length) throw new Error("PPU AOT bundle has no blocks");
    const pairBytes = module._malloc(pairs.length * 4) >>> 0;
    new Uint32Array(mainMemory.buffer, pairBytes, pairs.length).set(pairs);
    module.ccall("rpcs3_web_ppu_aot_register_many", null, ["number", "number"], [pairBytes, pairs.length / 2]);
    module._free(pairBytes);
    const registerMs = performance.now() - populateStartedAt;
    log(`PPU AOT bundle: registered ${pairs.length / 2} blocks from the manifest in ${Math.round(registerMs)} ms`);
    const { broadcastAotLoad } = await import("./rpcs3-aot-workers.mjs");
    const ready = await broadcastAotLoad({ module, key: "rpcs3PpuAot", load, readyTimeoutMs });
    log(`PPU AOT bundle: ${ready.workersReady} workers acknowledged, ${ready.errors.length} errors`);
    if (ready.errors.length) throw new Error(`PPU AOT worker population failed: ${ready.errors[0]}`);
    return {
      parts: parts.length, blocks: pairs.length / 2, tableBase, tableSize: load.tableSize,
      bindings: load.bindings, compileMs, populateMs: registerMs, prebuilt: true,
      idleWorkersReady: ready.idleWorkersReady, idleWorkers: ready.idleWorkers,
      workersReady: ready.workersReady, workersSent: ready.workersSent,
      skippedRelocatable: manifest.parts.length - descriptors.length,
      totalMs: performance.now() - startedAt,
    };
  }
  // Older bundles carry no block lists, so this thread instantiates to read them out.
  const placed = module.rpcs3PopulatePpuAot(load);
  const pairs = [];
  // Read through the live memory: growth during population would leave a cached view stale.
  const heap = new Uint32Array(mainMemory.buffer);
  for (let position = 0; position < placed.parts.length; position += 1) {
    const part = placed.parts[position];
    // A shared module exports its data symbols as offsets from __memory_base.
    const memoryBase = load.parts[position].memoryBase;
    for (const [name, value] of Object.entries(part.instance.exports)) {
      if (!name.startsWith("__ppu_blocks_") || !(value instanceof WebAssembly.Global)) continue;
      const indexOf = part.instance.exports[`__ppu_block_index_${name.slice("__ppu_blocks_".length)}`];
      if (typeof indexOf !== "function") throw new Error(`${name} has no index function`);
      const address = (memoryBase + (value.value >>> 0)) >>> 0;
      const count = heap[address >>> 2];
      for (let entry = 0; entry < count; entry += 1) {
        const guest = heap[(address >>> 2) + 1 + entry];
        const index = indexOf(entry) >>> 0;
        if (index < part.elemBase || index >= part.elemBase + part.tableSize) {
          throw new Error(`block 0x${guest.toString(16)} placed at table index ${index} outside ${part.elemBase}+${part.tableSize}`);
        }
        pairs.push(guest, index);
      }
    }
  }
  if (!pairs.length) throw new Error("PPU AOT bundle has no blocks");
  const pairBytes = module._malloc(pairs.length * 4) >>> 0;
  new Uint32Array(mainMemory.buffer, pairBytes, pairs.length).set(pairs);
  module.ccall("rpcs3_web_ppu_aot_register_many", null, ["number", "number"], [pairBytes, pairs.length / 2]);
  module._free(pairBytes);
  const populateMs = performance.now() - populateStartedAt;
  log(`PPU AOT bundle: module worker populated and registered ${pairs.length / 2} blocks in ${Math.round(populateMs)} ms`);

  // Every pthread worker, present and future, instantiates the same layout before it runs a thread.
  const PThread = module.PThread;
  const populated = new WeakSet();
  const pending = new Map();
  const ready = { workers: 0, errors: [] };
  const status = new Map();
  const send = (worker) => {
    if (populated.has(worker)) return;
    populated.add(worker);
    const promise = new Promise((resolve) => {
      worker.addEventListener("message", function listener(event) {
        const data = event.data;
        if (data && typeof data.rpcs3PpuAotReady === "number") {
          worker.removeEventListener("message", listener);
          ready.workers += 1;
          status.set(worker, "ready");
          resolve();
        } else if (data && data.rpcs3PpuAotError) {
          worker.removeEventListener("message", listener);
          ready.errors.push(data.rpcs3PpuAotError);
          resolve();
        }
      });
    });
    pending.set(worker, promise);
    // A worker still loading its own wasm queues early messages through Emscripten's handler, which
    // drops unknown ones; resend until the worker acknowledges (the worker side ignores repeats).
    // Bounded, slow resend: each message clones the module handles, and a worker busy running a
    // thread only reads its queue once idle.
    let attempts = 0;
    const resend = setInterval(() => {
      if (++attempts > 20) { clearInterval(resend); return; }
      worker.postMessage({ rpcs3PpuAot: load });
    }, 3000);
    promise.then(() => clearInterval(resend));
    worker.postMessage({ rpcs3PpuAot: load });
  };
  const idle = [...PThread.unusedWorkers];
  for (const worker of idle) send(worker);
  // Workers currently running a thread queue the message and apply it once idle, before any later "run".
  for (const worker of Object.values(PThread.pthreads ?? {})) if (worker && typeof worker.postMessage === "function") send(worker);
  const originalLoad = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) => {
    const result = originalLoad.call(PThread, worker);
    send(worker);
    return result;
  };
  const originalReturn = PThread.returnWorkerToPool;
  PThread.returnWorkerToPool = (worker) => {
    originalReturn.call(PThread, worker);
    send(worker);
  };
  await Promise.race([
    Promise.all(idle.map((worker) => pending.get(worker))),
    new Promise((resolve) => setTimeout(resolve, readyTimeoutMs)),
  ]);
  log(`PPU AOT bundle: ${ready.workers} workers acknowledged, ${ready.errors.length} errors`);
  if (ready.errors.length) throw new Error(`PPU AOT worker population failed: ${ready.errors[0]}`);
  const stats = {
    parts: parts.length,
    skippedRelocatable: manifest.parts.length - descriptors.length,
    blocks: pairs.length / 2,
    tableBase,
    tableSize: load.tableSize,
    compileMs,
    populateMs,
    idleWorkersReady: idle.filter((worker) => status.get(worker) === "ready").length,
    idleWorkers: idle.length,
    workersReady: ready.workers,
    workersSent: pending.size,
    totalMs: performance.now() - startedAt,
  };
  log(`PPU AOT bundle: ${stats.blocks} blocks in ${stats.parts} parts, table ${tableBase}+${stats.tableSize}, ${ready.workers}/${idle.length} idle workers ready`);
  return stats;

  function bindingsFor(name) {
    if (!vmBindings.has(name)) vmBindings.set(name, name);
  }
}

const vmBindings = new Map();
