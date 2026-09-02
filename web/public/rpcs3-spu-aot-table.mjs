// Loads a title's compiled SPU programs into RPCS3's function tables so the SPU
// pthreads call them directly (web/host/rpcs3_web_pre.js holds the per-worker
// side). Every exported `__spu-0x<entry>-<hash>` program gets a table index;
// RPCS3 learns (entry address, index) pairs through
// rpcs3_web_spu_aot_register_many. A program verifies its own local-store
// contents at entry, so no program data travels to the browser.

// Imports the SPU LLVM translator emits in wasm mode, bound to the runtime's
// direct dispatch exports (the native link table binds the same helpers).
const bindings = Object.freeze({
  spu_escape: "rpcs3_web_spu_direct_escape",
  spu_dispatch: "rpcs3_web_spu_direct_dispatch",
  spu_dispatcher: "rpcs3_web_spu_direct_dispatcher_address",
  spu_exec_check_state: "rpcs3_web_spu_direct_check_state",
  spu_exec_mfc_cmd: "rpcs3_web_spu_direct_mfc_cmd",
  spu_exec_mfc_cmd_saveable: "rpcs3_web_spu_direct_mfc_cmd_saveable",
  spu_read_channel: "rpcs3_web_spu_direct_read_channel",
  spu_read_channel_count: "rpcs3_web_spu_direct_read_channel_count",
  spu_read_in_mbox: "rpcs3_web_spu_direct_read_in_mbox",
  spu_read_decrementer: "rpcs3_web_spu_direct_read_decrementer",
  spu_read_events: "rpcs3_web_spu_direct_read_events",
  spu_get_events: "rpcs3_web_spu_direct_get_events",
  spu_write_channel: "rpcs3_web_spu_direct_write_channel",
  spu_list_unstall: "rpcs3_web_spu_direct_list_unstall",
  spu_check_interrupts: "rpcs3_web_spu_direct_check_interrupts",
  spu_syscall: "rpcs3_web_spu_direct_syscall",
  spu_unknown: "rpcs3_web_spu_direct_unknown",
  spu_web_fatal: "rpcs3_web_spu_direct_fatal",
  spu_memcpy: "rpcs3_web_spu_direct_memcpy",
  wait_on_spu_channel: "rpcs3_web_spu_direct_wait_on_channel",
  wait_spu_inbox: "rpcs3_web_spu_direct_wait_inbox",
  get_timebased_time: "rpcs3_web_spu_direct_get_tb",
});
const patchpointPattern = /^__spu-0x[0-9a-f]+-.+-(?:pp|chunkpp)-/i;
const programPattern = /^__spu-0x([0-9a-f]+)-/i;

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

// Program export names of a module in the order the worker hook places them.
export function programExports(module) {
  const names = [];
  for (const exported of WebAssembly.Module.exports(module)) {
    if (exported.kind === "function" && programPattern.test(exported.name)) names.push(exported.name);
  }
  return names;
}

export async function loadSpuAotBundle({ module, mainInstance, mainMemory, manifestUrl, readyTimeoutMs = 60_000, log = () => {} }) {
  if (!(mainMemory instanceof WebAssembly.Memory)) throw new TypeError("mainMemory must be RPCS3's WebAssembly.Memory");
  const startedAt = performance.now();
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`SPU AOT manifest fetch returned ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.parts)) throw new Error("unsupported SPU AOT manifest");
  const compiled = await mapConcurrent(manifest.parts, 4, async (part) => {
    const response = await fetch(new URL(part.url, manifestUrl));
    if (!response.ok) throw new Error(`SPU AOT part ${part.url} fetch returned ${response.status}`);
    return WebAssembly.compileStreaming(response);
  });
  const compileMs = performance.now() - startedAt;
  log(`SPU AOT bundle: compiled ${compiled.length} parts in ${Math.round(compileMs)} ms`);

  const table = mainInstance.exports.__indirect_function_table;
  if (!(table instanceof WebAssembly.Table)) throw new Error("the runtime did not export its function table");
  const tableBase = table.length;
  let cursor = tableBase;
  const parts = [];
  const pairs = [];
  const boundNames = { ...bindings };
  for (let index = 0; index < compiled.length; index += 1) {
    const wasm = compiled[index];
    const info = dylinkInfo(wasm);
    let importsTable = false;
    for (const imported of WebAssembly.Module.imports(wasm)) {
      if (imported.module !== "env") throw new Error(`unsupported SPU AOT import module ${imported.module}.${imported.name}`);
      if (imported.kind === "table" && imported.name === "__indirect_function_table") { importsTable = true; continue; }
      if (imported.kind !== "function") continue;
      if (imported.name in boundNames) continue;
      if (patchpointPattern.test(imported.name)) {
        boundNames[imported.name] = "rpcs3_web_spu_direct_patchpoint";
        continue;
      }
      throw new Error(`unsupported SPU AOT function import env.${imported.name}`);
    }
    const names = programExports(wasm);
    if (!names.length) throw new Error(`SPU AOT part ${manifest.parts[index].url} exports no programs`);
    const align = Math.max(1, 1 << info.memoryAlign);
    let memoryBase = 0;
    if (info.memorySize > 0) {
      const allocation = module._malloc(info.memorySize + align) >>> 0;
      memoryBase = (allocation + align - 1) & ~(align - 1);
      new Uint8Array(mainMemory.buffer, memoryBase, info.memorySize).fill(0);
    }
    let stackPool = null;
    if (WebAssembly.Module.imports(wasm).some((entry) => entry.kind === "global" && entry.name === "__stack_pointer")) {
      const slots = 64;
      const bytes = 65536;
      const base = module._malloc(16 + slots * bytes) >>> 0;
      new Uint8Array(mainMemory.buffer, base, 16).fill(0);
      stackPool = { base, slots, bytes };
    }
    const elemBase = cursor;
    cursor += importsTable ? info.tableSize : 0;
    const exportBase = cursor;
    cursor += names.length;
    parts.push({ module: wasm, memoryBase, elemBase, importsTable, tableSize: importsTable ? info.tableSize : 0, exportBase, exportCount: names.length, stackPool });
    for (let position = 0; position < names.length; position += 1) {
      pairs.push(Number.parseInt(programPattern.exec(names[position])[1], 16) >>> 0, exportBase + position);
    }
  }
  // Diagnosis aid: `manifest.json#range=lo-hi` registers only programs [lo, hi) in placement order.
  const range = /#range=(\d+)-(\d+)/.exec(manifestUrl);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const kept = [];
    for (let entry = 0; entry < pairs.length / 2; entry += 1) {
      if (entry >= lo && entry < hi) kept.push(pairs[entry * 2], pairs[entry * 2 + 1]);
    }
    log(`SPU AOT bundle: registering programs ${lo}-${hi} of ${pairs.length / 2}`);
    pairs.length = 0;
    pairs.push(...kept);
  }
  const load = { tableBase, tableSize: cursor - tableBase, parts, bindings: boundNames };
  log(`SPU AOT bundle: layout ${pairs.length / 2} programs in ${parts.length} parts at table ${tableBase}+${load.tableSize}`);

  const populateStartedAt = performance.now();
  const placed = module.rpcs3PopulateSpuAot(load);
  if (!range && placed !== pairs.length / 2) throw new Error(`placed ${placed} programs, expected ${pairs.length / 2}`);
  const pairBytes = module._malloc(pairs.length * 4) >>> 0;
  new Uint32Array(mainMemory.buffer, pairBytes, pairs.length).set(pairs);
  module.ccall("rpcs3_web_spu_aot_register_many", null, ["number", "number"], [pairBytes, pairs.length / 2]);
  module._free(pairBytes);
  const populateMs = performance.now() - populateStartedAt;
  log(`SPU AOT bundle: module worker populated and registered in ${Math.round(populateMs)} ms`);

  const { broadcastAotLoad } = await import("./rpcs3-aot-workers.mjs");
  const ready = await broadcastAotLoad({ module, key: "rpcs3SpuAot", load, readyTimeoutMs });
  log(`SPU AOT bundle: ${ready.workersReady} workers acknowledged, ${ready.errors.length} errors`);
  if (ready.errors.length) throw new Error(`SPU AOT worker population failed: ${ready.errors[0]}`);
  return {
    parts: parts.length,
    programs: pairs.length / 2,
    tableBase,
    tableSize: load.tableSize,
    compileMs,
    populateMs,
    idleWorkersReady: ready.idleWorkersReady,
    idleWorkers: ready.idleWorkers,
    workersReady: ready.workersReady,
    totalMs: performance.now() - startedAt,
  };
}
