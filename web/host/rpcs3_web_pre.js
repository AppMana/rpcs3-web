// RPCS3 web: compiled PPU blocks in this worker's function table.
//
// Linked with --pre-js, so this runs inside every createRPCS3() factory: the
// module worker and each Emscripten pthread worker. WebAssembly tables are per
// instance, so every worker instantiates the AOT parts itself and places the
// exported blocks at the same table indices. The layout comes from
// web/public/rpcs3-ppu-aot-table.mjs, which registers (guest address, index)
// pairs with RPCS3 once and then hands the same layout to each worker.
// Reserves [tableBase, tableBase + tableSize) of this instance's function table for a layout.
// A worker may populate layouts out of order (an SPU thread can run on a worker that never ran a
// PPU thread), so the gap below a layout is grown with null entries and filled if its own load
// is populated later.
function rpcs3ReserveAotTable(table, load) {
  if (table.length < load.tableBase) table.grow(load.tableBase - table.length);
  if (table.length === load.tableBase) {
    table.grow(load.tableSize);
  } else if (table.length < load.tableBase + load.tableSize) {
    throw new Error(`function table has ${table.length} entries; the layout expects ${load.tableBase}+${load.tableSize}`);
  }
}

Module["rpcs3PopulatePpuAot"] = (load) => {
  const table = wasmExports["__indirect_function_table"];
  if (!(table instanceof WebAssembly.Table)) throw new Error("the runtime did not export its function table");
  rpcs3ReserveAotTable(table, load);
  const result = { parts: [] };
  for (const part of load.parts) {
    const guestPages = {};
    const env = {
      memory: wasmMemory,
      __indirect_function_table: table,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.memoryBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.elemBase),
    };
    for (const imported of WebAssembly.Module.imports(part.module)) {
      if (imported.module === "GOT.mem" && imported.kind === "global" && imported.name === "__rpcs3_guest_pages") {
        const address = wasmExports["rpcs3_web_vm_page_table_address"]?.() >>> 0;
        if (!address) throw new Error("PPU module requires a guest page table from the runtime");
        guestPages.__rpcs3_guest_pages = new WebAssembly.Global({ value: "i32", mutable: true }, address);
        continue;
      }
      if (imported.module === "GOT.mem" && imported.kind === "global" && imported.name === "__rpcs3_web_page_versions") {
        const address = wasmExports["rpcs3_web_versions_address"]?.() >>> 0;
        if (!address) throw new Error("PPU module requires a page version table from the runtime");
        guestPages.__rpcs3_web_page_versions = new WebAssembly.Global({ value: "i32", mutable: true }, address);
        continue;
      }
      if (imported.module !== "env") throw new Error(`unsupported import ${imported.module}.${imported.name}`);
      if (imported.name in env) continue;
      if (imported.kind === "global" && imported.name === "__stack_pointer") {
        // Share this worker's own stack pointer: a longjmp out of compiled code unwinds without epilogues,
        // and Emscripten's invoke wrappers restore only the main module's stack pointer.
        if (wasmExports["__stack_pointer"] instanceof WebAssembly.Global) {
          env.__stack_pointer = wasmExports["__stack_pointer"];
          continue;
        }
        const pool = part.stackPool;
        if (!pool) throw new Error("part imports __stack_pointer but the layout reserved no stack pool");
        const slot = Atomics.add(new Int32Array(wasmMemory.buffer, pool.base, 1), 0, 1);
        if (slot >= pool.slots) throw new Error(`PPU AOT stack pool exhausted (${pool.slots} slots)`);
        const top = (pool.base + 16 + (slot + 1) * pool.bytes) & ~15;
        env.__stack_pointer = new WebAssembly.Global({ value: "i32", mutable: true }, top);
        continue;
      }
      if (imported.kind !== "function") throw new Error(`unsupported import kind ${imported.kind} for ${imported.name}`);
      const target = load.bindings[imported.name];
      if (!target || typeof wasmExports[target] !== "function") {
        throw new Error(`no runtime binding for PPU AOT import ${imported.name}`);
      }
      env[imported.name] = wasmExports[target];
    }
    // The element segments place every block at __table_base + slot; __ppu_block_index_* returns
    // those absolute indices, so no data relocation is needed for the block tables.
    const instance = new WebAssembly.Instance(part.module, { env, "GOT.mem": guestPages });
    // Shared-memory modules keep their data segments passive: __wasm_init_memory copies them once (the
    // flag makes later workers no-ops) and __wasm_call_ctors relocates the exported address globals.
    if (typeof instance.exports.__wasm_init_memory === "function") instance.exports.__wasm_init_memory();
    if (typeof instance.exports.__wasm_apply_data_relocs === "function") instance.exports.__wasm_apply_data_relocs();
    if (typeof instance.exports.__wasm_call_ctors === "function") instance.exports.__wasm_call_ctors();
    result.parts.push({ elemBase: part.elemBase, tableSize: part.tableSize, instance });
  }
  self.__rpcs3PpuAotReady = true;
  return result;
};

// Compiled SPU programs: the same per-worker placement, but programs are placed from the module's
// exports (a title has thousands of programs across a few modules) rather than element segments.
Module["rpcs3PopulateSpuAot"] = (load) => {
  const table = wasmExports["__indirect_function_table"];
  if (!(table instanceof WebAssembly.Table)) throw new Error("the runtime did not export its function table");
  rpcs3ReserveAotTable(table, load);
  let placed = 0;
  for (const part of load.parts) {
    const env = {
      memory: wasmMemory,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.memoryBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.elemBase),
    };
    if (part.importsTable) env.__indirect_function_table = table;
    for (const imported of WebAssembly.Module.imports(part.module)) {
      if (imported.module !== "env") throw new Error(`unsupported import ${imported.module}.${imported.name}`);
      if (imported.name in env) continue;
      if (imported.kind === "global" && imported.name === "__stack_pointer") {
        if (wasmExports["__stack_pointer"] instanceof WebAssembly.Global) {
          env.__stack_pointer = wasmExports["__stack_pointer"];
          continue;
        }
        const pool = part.stackPool;
        if (!pool) throw new Error("part imports __stack_pointer but the layout reserved no stack pool");
        const slot = Atomics.add(new Int32Array(wasmMemory.buffer, pool.base, 1), 0, 1);
        if (slot >= pool.slots) throw new Error(`SPU AOT stack pool exhausted (${pool.slots} slots)`);
        const top = (pool.base + 16 + (slot + 1) * pool.bytes) & ~15;
        env.__stack_pointer = new WebAssembly.Global({ value: "i32", mutable: true }, top);
        continue;
      }
      if (imported.kind !== "function") throw new Error(`unsupported import kind ${imported.kind} for ${imported.name}`);
      const target = load.bindings[imported.name];
      if (!target || typeof wasmExports[target] !== "function") {
        throw new Error(`no runtime binding for SPU AOT import ${imported.name}`);
      }
      env[imported.name] = wasmExports[target];
    }
    const instance = new WebAssembly.Instance(part.module, { env });
    if (typeof instance.exports.__wasm_init_memory === "function") instance.exports.__wasm_init_memory();
    if (typeof instance.exports.__wasm_apply_data_relocs === "function") instance.exports.__wasm_apply_data_relocs();
    if (typeof instance.exports.__wasm_call_ctors === "function") instance.exports.__wasm_call_ctors();
    // Same filter and order as rpcs3-spu-aot-table.mjs programExports()
    let index = part.exportBase;
    for (const exported of WebAssembly.Module.exports(part.module)) {
      if (exported.kind !== "function" || !/^__spu-0x[0-9a-f]+-/i.test(exported.name)) continue;
      table.set(index++, instance.exports[exported.name]);
      placed += 1;
    }
    if (index !== part.exportBase + part.exportCount) {
      throw new Error(`part placed ${index - part.exportBase} programs, layout expected ${part.exportCount}`);
    }
    for (const region of part.regionEntries || []) {
      table.set(region.index, instance.exports[region.symbol]);
      if (load.initializeRegionAliases) {
        const pointer = instance.exports[region.aliases]() >>> 0;
        if ((pointer & 3) || pointer < part.memoryBase || pointer + region.targets.length * 4 > part.memoryBase + part.memorySize) {
          throw new Error("SPU region aliases lie outside their module allocation");
        }
        new Uint32Array(wasmMemory.buffer, pointer, region.targets.length).set(region.targets);
      }
    }
    if (part.chainIndex) {
      if (typeof instance.exports.rpcs3_spu_run_chain !== "function") throw new Error("SPU part is missing its chain runner");
      table.set(part.chainIndex, instance.exports.rpcs3_spu_run_chain);
    }
    if (part.profileIndex) {
      if (typeof instance.exports.rpcs3_spu_run_chain_profile !== "function") throw new Error("SPU part is missing its edge profiler");
      table.set(part.profileIndex, instance.exports.rpcs3_spu_run_chain_profile);
    }
  }
  self.__rpcs3SpuAotReady = true;
  return placed;
};


// Direct WebGPU backend support (module main thread side). The pool worker that will host the
// RSX thread creates the GPU device and receives the presentation OffscreenCanvas before the
// thread starts, and the worker allocator hands that worker to the RSX thread when RPCS3 spawns
// it (Utilities/Thread.cpp sets the flag at rpcs3_web_rsx_spawn_flag_address).
// SPU hot load: compiled programs live in a registry in wasm memory (SPUWasmRecompiler.cpp);
// each SPU thread calls rpcs3_web_spu_hot_sync before dispatching to place the entries this
// worker has not placed yet into its own function table (busy pool workers never process
// posted messages, so nothing here may depend on messaging).
const rpcs3SpuHotBindings = Object.freeze({
  spu_escape: "rpcs3_web_spu_direct_escape", spu_dispatch: "rpcs3_web_spu_direct_dispatch",
  spu_dispatcher: "rpcs3_web_spu_direct_dispatcher_address", spu_exec_check_state: "rpcs3_web_spu_direct_check_state",
  spu_exec_mfc_cmd: "rpcs3_web_spu_direct_mfc_cmd", spu_exec_mfc_cmd_saveable: "rpcs3_web_spu_direct_mfc_cmd_saveable",
  spu_read_channel: "rpcs3_web_spu_direct_read_channel", spu_read_channel_count: "rpcs3_web_spu_direct_read_channel_count",
  spu_read_in_mbox: "rpcs3_web_spu_direct_read_in_mbox", spu_read_decrementer: "rpcs3_web_spu_direct_read_decrementer",
  spu_read_events: "rpcs3_web_spu_direct_read_events", spu_get_events: "rpcs3_web_spu_direct_get_events",
  spu_write_channel: "rpcs3_web_spu_direct_write_channel", spu_list_unstall: "rpcs3_web_spu_direct_list_unstall",
  spu_check_interrupts: "rpcs3_web_spu_direct_check_interrupts", spu_syscall: "rpcs3_web_spu_direct_syscall",
  spu_unknown: "rpcs3_web_spu_direct_unknown", spu_web_fatal: "rpcs3_web_spu_direct_fatal", spu_memcpy: "rpcs3_web_spu_direct_memcpy",
  wait_on_spu_channel: "rpcs3_web_spu_direct_wait_on_channel", wait_spu_inbox: "rpcs3_web_spu_direct_wait_inbox",
  get_timebased_time: "rpcs3_web_spu_direct_get_tb",
});
function rpcs3InstantiateSpuHot(module) {
  const env = { memory: wasmMemory };
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module !== "env" || imported.name in env) continue;
    if (imported.kind !== "function") throw new Error(`unsupported SPU hot import ${imported.kind} ${imported.name}`);
    const target = rpcs3SpuHotBindings[imported.name];
    if (!target || typeof wasmExports[target] !== "function") throw new Error(`no runtime binding for SPU hot import ${imported.name}`);
    env[imported.name] = wasmExports[target];
  }
  const instance = new WebAssembly.Instance(module, { env });
  const name = WebAssembly.Module.exports(module).find((e) => e.kind === "function" && /^__spu-0x[0-9a-f]+-/i.test(e.name));
  if (!name) throw new Error("SPU hot module exports no program");
  return instance.exports[name.name];
}
// LLVM-tier side modules (dylink, wasm-ld --shared): same placement as a bundle part in
// rpcs3PopulateSpuAot, with the element segment at elemBase and the data at memoryBase that the
// registry reserved (spu_web_llvm_register); the stack pointer is this worker's own.
const rpcs3SpuPatchpointPattern = /^__spu-0x[0-9a-f]+-.+-(?:pp|chunkpp)-/i;
function rpcs3InstantiateSpuSide(module, elemBase, memoryBase, importsTable, table) {
  const env = {
    memory: wasmMemory,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, elemBase),
  };
  if (importsTable) env.__indirect_function_table = table;
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module !== "env" || imported.name in env) continue;
    if (imported.kind === "global" && imported.name === "__stack_pointer") {
      if (!(wasmExports["__stack_pointer"] instanceof WebAssembly.Global)) throw new Error("the runtime does not export __stack_pointer");
      env.__stack_pointer = wasmExports["__stack_pointer"];
      continue;
    }
    if (imported.kind !== "function") throw new Error(`unsupported SPU side-module import ${imported.kind} ${imported.name}`);
    const target = rpcs3SpuHotBindings[imported.name] ?? (rpcs3SpuPatchpointPattern.test(imported.name) ? "rpcs3_web_spu_direct_patchpoint" : undefined);
    if (!target || typeof wasmExports[target] !== "function") throw new Error(`no runtime binding for SPU side-module import ${imported.name}`);
    env[imported.name] = wasmExports[target];
  }
  const instance = new WebAssembly.Instance(module, { env });
  for (const init of ["__wasm_init_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]) {
    if (typeof instance.exports[init] === "function") instance.exports[init]();
  }
  const name = WebAssembly.Module.exports(module).find((e) => e.kind === "function" && /^__spu-0x[0-9a-f]+-/i.test(e.name) && !rpcs3SpuPatchpointPattern.test(e.name));
  if (!name) throw new Error("SPU side module exports no program");
  return instance.exports[name.name];
}
// Called from the SPU thread (C++) on this worker; returns the highest function table index this
// worker holds. The registry is in index order, so a published index at or below it is placed here.
function rpcs3SpuHotSyncImpl() {
  const count = wasmExports["rpcs3_web_spu_hot_count"]() >>> 0;
  let placed = self.__rpcs3SpuHotPlaced >>> 0;
  if (placed >= count) return self.__rpcs3SpuHotMaxIndex >>> 0;
  const table = wasmExports["__indirect_function_table"];
  const info = self.__rpcs3SpuHotInfo ??= wasmExports["malloc"](32) >>> 0;
  let maxIndex = self.__rpcs3SpuHotMaxIndex >>> 0;
  for (; placed < count; placed++) {
    wasmExports["rpcs3_web_spu_hot_info"](placed, info);
    const [kind, index, pointer, size, elemBase, tableSize, memoryBase, importsTable] = new Uint32Array(wasmMemory.buffer, info, 8);
    const bytes = new Uint8Array(wasmMemory.buffer, pointer, size).slice();
    const module = new WebAssembly.Module(bytes);
    const need = kind === 1 ? Math.max(index + 1, elemBase + tableSize) : index + 1;
    if (table.length < need) table.grow(Math.max(need - table.length, 256));
    table.set(index, kind === 1 ? rpcs3InstantiateSpuSide(module, elemBase, memoryBase, importsTable, table) : rpcs3InstantiateSpuHot(module));
    if (index > maxIndex) maxIndex = index;
    if ((self.__rpcs3SpuHotLogged = (self.__rpcs3SpuHotLogged | 0) + 1) <= 40) console.log(`[rpcs3 spu hot] worker placed entry ${placed} at table index ${index} (table length ${table.length}, ${size} bytes)`);
  }
  self.__rpcs3SpuHotPlaced = placed;
  self.__rpcs3SpuHotMaxIndex = maxIndex;
  return maxIndex;
}
Module["rpcs3SpuHotStats"] = () => ({ placedHere: self.__rpcs3SpuHotPlaced >>> 0, count: wasmExports["rpcs3_web_spu_hot_count"]() >>> 0 });

// PPU blocks compiled while the guest runs (rpcs3/Emu/Cell/PPUWebRecompiler.cpp). Same placement as
// an LLVM-tier SPU program: a dylink side module whose element segment sits at elemBase and whose
// data sits at the memoryBase the registry reserved, bound to the runtime's direct dispatch exports.
const rpcs3PpuHotBindings = Object.freeze({
  __check: "rpcs3_web_ppu_direct_check", __error: "rpcs3_web_ppu_direct_error",
  __ppu_trap: "rpcs3_web_ppu_direct_trap", __trap: "rpcs3_web_ppu_direct_trap",
  __syscall: "rpcs3_web_ppu_direct_syscall", __lv1call: "rpcs3_web_ppu_direct_lv1call",
  __hle_bridge: "rpcs3_web_ppu_direct_hle_bridge",
  __hle_call_fnid: "rpcs3_web_ppu_direct_hle_fnid",
  __get_tb: "rpcs3_web_ppu_direct_get_tb",
  __lwarx: "rpcs3_web_ppu_direct_lwarx", __lwarx_at: "rpcs3_web_ppu_direct_lwarx_at",
  __ldarx: "rpcs3_web_ppu_direct_ldarx", __ldarx_at: "rpcs3_web_ppu_direct_ldarx_at",
  __stwcx: "rpcs3_web_ppu_direct_stwcx",
  __stdcx: "rpcs3_web_ppu_direct_stdcx",
  fma: "rpcs3_web_libcall_fma", fmaf: "rpcs3_web_libcall_fmaf",
  fmod: "rpcs3_web_libcall_fmod", fmodf: "rpcs3_web_libcall_fmodf",
  memcpy: "rpcs3_web_libcall_memcpy", memmove: "rpcs3_web_libcall_memmove",
  memset: "rpcs3_web_libcall_memset", memcmp: "rpcs3_web_libcall_memcmp",
});
const rpcs3PpuMathFallbacks = Object.freeze({
  exp2f: (x) => Math.fround(Math.pow(2, x)),
  log2f: (x) => Math.fround(Math.log2(x)),
  exp2: (x) => Math.pow(2, x),
  log2: (x) => Math.log2(x),
  powf: (x, y) => Math.fround(Math.pow(x, y)),
  pow: Math.pow,
  sinf: (x) => Math.fround(Math.sin(x)),
  cosf: (x) => Math.fround(Math.cos(x)),
  sin: Math.sin,
  cos: Math.cos,
  ldexpf: (x, n) => Math.fround(x * Math.pow(2, n | 0)),
  ldexp: (x, n) => x * Math.pow(2, n | 0),
});
function rpcs3InstantiatePpuSide(module, elemBase, memoryBase, importsTable, table) {
  const guestPages = {};
  const gotFunc = {};
  const env = {
    memory: wasmMemory,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, elemBase),
  };
  if (importsTable) env.__indirect_function_table = table;
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module === "GOT.mem" && imported.kind === "global" && imported.name === "__rpcs3_guest_pages") {
      const address = wasmExports["rpcs3_web_vm_page_table_address"]?.() >>> 0;
      if (!address) throw new Error("PPU module requires a guest page table from the runtime");
      guestPages.__rpcs3_guest_pages = new WebAssembly.Global({ value: "i32", mutable: true }, address);
      continue;
    }
    if (imported.module === "GOT.mem" && imported.kind === "global" && imported.name === "__rpcs3_web_page_versions") {
      const address = wasmExports["rpcs3_web_versions_address"]?.() >>> 0;
      if (!address) throw new Error("PPU module requires a page version table from the runtime");
      guestPages.__rpcs3_web_page_versions = new WebAssembly.Global({ value: "i32", mutable: true }, address);
      continue;
    }
    if (imported.module === "GOT.mem" && imported.kind === "global") {
      guestPages[imported.name] = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
      continue;
    }
    if (imported.module === "GOT.func" && imported.kind === "global") {
      gotFunc[imported.name] = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
      continue;
    }
    if (imported.module !== "env") throw new Error(`unsupported PPU side-module import ${imported.module}.${imported.name}`);
    if (imported.name in env) continue;
    if (imported.kind === "global" && imported.name === "__stack_pointer") {
      if (!(wasmExports["__stack_pointer"] instanceof WebAssembly.Global)) throw new Error("the runtime does not export __stack_pointer");
      env.__stack_pointer = wasmExports["__stack_pointer"];
      continue;
    }
    if (imported.kind !== "function") throw new Error(`unsupported PPU side-module import ${imported.kind} ${imported.name}`);
    const target = rpcs3PpuHotBindings[imported.name] ?? (imported.name.startsWith("rpcs3_web_vm_") ? imported.name : undefined);
    if (target && typeof wasmExports[target] === "function") {
      env[imported.name] = wasmExports[target];
      continue;
    }
    if (typeof rpcs3PpuMathFallbacks[imported.name] === "function") {
      env[imported.name] = rpcs3PpuMathFallbacks[imported.name];
      continue;
    }
    if (imported.name.startsWith("__mtspr_")) {
      env[imported.name] = () => {};
      continue;
    }
    if (imported.name.startsWith("__mfspr_") || imported.name.startsWith("__mftb_")) {
      env[imported.name] = wasmExports["rpcs3_web_ppu_direct_get_tb"] ?? (() => 0n);
      continue;
    }
    throw new Error(`no runtime binding for PPU side-module import ${imported.name}`);
  }
  const instance = new WebAssembly.Instance(module, { env, "GOT.mem": guestPages, "GOT.func": gotFunc });
  for (const init of ["__wasm_init_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]) {
    if (typeof instance.exports[init] === "function") instance.exports[init]();
  }
  const name = WebAssembly.Module.exports(module).find((e) => e.kind === "function" && /^__0x[0-9a-f]+$/i.test(e.name));
  // Whole-module recompiled shards (index === 0) populate all their hidden __0x* blocks directly
  // into [elemBase, elemBase + tableSize) via the module's element segment during instantiation!
  return name ? instance.exports[name.name] : instance;
}
// A compiled block reaches another through the function table, so a slot the runtime tier may
// publish while this worker is inside compiled code has to be callable already: the whole region is
// reserved here and every free slot answers with the stub that hands the block back to the
// interpreter, which then places what the registry has grown by.
function rpcs3ReserveHotRegion(table) {
  if (self.__rpcs3HotRegionReserved) return;
  self.__rpcs3HotRegionReserved = true;
  const base = wasmExports["rpcs3_web_hot_table_base"]() >>> 0;
  const limit = wasmExports["rpcs3_web_hot_table_limit"]() >>> 0;
  if (!base) { self.__rpcs3HotRegionReserved = false; return; }
  const unplaced = wasmExports["rpcs3_web_ppu_direct_unplaced"];
  if (table.length < base) table.grow(base - table.length);
  const existingLimit = Math.min(table.length, limit);
  if (table.length < limit) table.grow(limit - table.length, unplaced);
  for (let index = base; index < existingLimit; index++) {
    if (table.get(index) === null) table.set(index, unplaced);
  }
}
// Called from the PPU thread (C++) on this worker; returns the highest function table index it holds
function rpcs3PpuHotSyncImpl() {
  const count = wasmExports["rpcs3_web_ppu_hot_count"]() >>> 0;
  const table = wasmExports["__indirect_function_table"];
  rpcs3ReserveHotRegion(table);
  const placedSet = self.__rpcs3PlacedEntries ??= new Set();
  let placed = self.__rpcs3PpuHotPlaced >>> 0;
  if (placed >= count) return self.__rpcs3PpuHotMaxIndex >>> 0;
  const info = self.__rpcs3PpuHotInfo ??= wasmExports["malloc"](32) >>> 0;
  let maxIndex = self.__rpcs3PpuHotMaxIndex >>> 0;
  for (; placed < count; placed++) {
    try {
      wasmExports["rpcs3_web_ppu_hot_info"](placed, info);
      const [index, pointer, size, elemBase, tableSize, memoryBase, importsTable] = new Uint32Array(wasmMemory.buffer, info, 7);
      const module = self.__rpcs3SharedHotModules?.get(placed)
        ?? new WebAssembly.Module(new Uint8Array(wasmMemory.buffer, pointer, size).slice());
      const need = Math.max(index ? index + 1 : 0, elemBase + tableSize);
      if (table.length < need) table.grow(need - table.length);
      const instantiated = rpcs3InstantiatePpuSide(module, elemBase, memoryBase, importsTable, table);
      if (index) {
        table.set(index, instantiated);
        if (index > maxIndex) maxIndex = index;
      } else if (elemBase + tableSize > 0) {
        const shardMax = (elemBase + tableSize - 1) >>> 0;
        if (shardMax > maxIndex) maxIndex = shardMax;
      }
      placedSet.add(placed);
      self.__rpcs3PpuHotPlaced = placed + 1;
      self.__rpcs3PpuHotMaxIndex = maxIndex;
      if ((self.__rpcs3PpuHotLogged = (self.__rpcs3PpuHotLogged | 0) + 1) <= 40) console.log(`[rpcs3 ppu recomp] worker placed entry ${placed} at table ${index || `${elemBase}+${tableSize}`} (table length ${table.length}, ${size} bytes)`);
    } catch (err) {
      console.error(`[rpcs3 ppu recomp] worker failed placing entry ${placed}:`, err);
      throw err;
    }
  }
  return maxIndex;
}
function rpcs3PpuHotEnsureImpl(targetIndex, outSpanPtr) {
  const table = wasmExports["__indirect_function_table"];
  rpcs3ReserveHotRegion(table);
  const unplaced = wasmExports["rpcs3_web_ppu_direct_unplaced"];
  const info = self.__rpcs3PpuHotInfo ??= wasmExports["malloc"](32) >>> 0;
  const found = wasmExports["rpcs3_web_ppu_hot_find_entry"](targetIndex >>> 0, info) >>> 0;
  if (!found) return 0;
  const [index, pointer, size, elemBase, tableSize, memoryBase, importsTable, entryIdx] = new Uint32Array(wasmMemory.buffer, info, 8);
  const placedSet = self.__rpcs3PlacedEntries ??= new Set();
  // A sync can place a whole-module shard without visiting Ensure. Conversely, a
  // table slot can still be the unplaced stub after bookkeeping was initialized,
  // so the actual function-table entry is the authority before dispatch uses it.
  if (!placedSet.has(entryIdx) || targetIndex >= table.length || table.get(targetIndex) === unplaced) {
    try {
      const module = self.__rpcs3SharedHotModules?.get(entryIdx)
        ?? new WebAssembly.Module(new Uint8Array(wasmMemory.buffer, pointer, size).slice());
      const need = Math.max(index ? index + 1 : 0, elemBase + tableSize);
      if (table.length < need) table.grow(need - table.length);
      const instantiated = rpcs3InstantiatePpuSide(module, elemBase, memoryBase, importsTable, table);
      if (index) {
        table.set(index, instantiated);
      }
      placedSet.add(entryIdx);
      self.__rpcs3PpuHotPlaced = placedSet.size;
      if ((self.__rpcs3PpuHotLogged = (self.__rpcs3PpuHotLogged | 0) + 1) <= 16) {
        console.log(`[rpcs3 ppu recomp] worker placed shard ${entryIdx} at table ${index || `${elemBase}+${tableSize}`} (${size} bytes)`);
      }
    } catch (err) {
      console.error(`[rpcs3 ppu recomp] worker failed placing shard ${entryIdx}:`, err);
      throw err;
    }
  }
  if (targetIndex >= table.length || table.get(targetIndex) === unplaced) {
    placedSet.delete(entryIdx);
    return 0;
  }
  if (outSpanPtr) {
    const outWords = new Uint32Array(wasmMemory.buffer, outSpanPtr >>> 0, 2);
    outWords[0] = elemBase >>> 0;
    outWords[1] = (index ? (index + 1) : (elemBase + tableSize)) >>> 0;
  }
  return 1;
}
Module["rpcs3PpuHotStats"] = () => ({ placedHere: self.__rpcs3PpuHotPlaced >>> 0, count: wasmExports["rpcs3_web_ppu_hot_count"]() >>> 0 });

Module["rpcs3ShareHotModule"] = (slot, wasmMod) => {
  if (!(wasmMod instanceof WebAssembly.Module)) return;
  const s = slot >>> 0;
  (self.__rpcs3SharedHotModules ??= new Map()).set(s, wasmMod);
};

// One region above every bundle for both runtime tiers, with a dedicated 4096-slot SPU hot/LLVM
// span below the PPU recomp/hot span so an SPU program and a PPU block never claim the same
// function table index even when no pre-baked SPU AOT bundle is loaded.
Module["rpcs3InstallHotTable"] = (ppuLoad, spuLoad) => {
  const table = wasmExports["__indirect_function_table"];
  let base = table.length;
  for (const load of [ppuLoad, spuLoad]) {
    if (load) base = Math.max(base, (load.tableBase >>> 0) + (load.tableSize >>> 0));
  }
  const existingSpuBase = typeof wasmExports["rpcs3_web_spu_hot_table_base"] === "function"
    ? (wasmExports["rpcs3_web_spu_hot_table_base"]() >>> 0)
    : 0;
  let spuBase = existingSpuBase;
  if (!spuBase) {
    spuBase = base;
    base = (spuBase + 4096) >>> 0;
    if (table.length < base) table.grow(base - table.length);
    Module["ccall"]("rpcs3_web_spu_set_hot_table_base", null, ["number"], [spuBase]);
  } else {
    base = Math.max(base, (spuBase + 4096) >>> 0);
  }
  Module["ccall"]("rpcs3_web_set_hot_table_base", null, ["number"], [base]);
  return { base, spuBase };
};

Module["rpcs3PrepareGpu"] = (canvas, flagAddress, capture, presentationYield = "message", bindGroupCache = true) => new Promise((resolve, reject) => {
  const PThread = Module["PThread"];
  const worker = PThread.unusedWorkers[PThread.unusedWorkers.length - 1];
  if (!worker) { reject(new Error("no idle pthread worker to host the GPU device")); return; }
  // This worker holds the only WebGPU device, and a thread that is not the RSX thread must never be
  // given it: emscripten_webgpu_get_device asserts on a worker that was never prepared. Hold it out
  // of the pool from here, so neither the device setup below nor a saturated pool can spend it.
  PThread.unusedWorkers.splice(PThread.unusedWorkers.indexOf(worker), 1);
  const deadline = setTimeout(() => reject(new Error("GPU worker did not answer")), 60_000);
  let sentCanvas = false;
  const onMessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.rpcs3GpuPong && !sentCanvas) {
      sentCanvas = true;
      worker.postMessage({ rpcs3PrepareGpu: { canvas, capture, presentationYield, bindGroupCache } }, [canvas]);
    } else if (data.rpcs3GpuReady) {
      clearTimeout(deadline);
      Module["__rpcs3GpuWorker"] = worker;
      Module["__rpcs3RsxSpawnFlag"] = flagAddress >>> 0;
      resolve(data.rpcs3GpuReady);
    } else if (data.rpcs3GpuError) {
      clearTimeout(deadline);
      reject(new Error(data.rpcs3GpuError));
    } else if (data.rpcs3Capture && Module["rpcs3OnCapture"]) {
      Module["rpcs3OnCapture"](data);
    } else if (data.rpcs3Present && Module["rpcs3OnPresent"]) {
      Module["rpcs3OnPresent"](data);
    } else if (data.rpcs3Presented !== undefined && Module["rpcs3OnPresented"]) {
      // A transferred canvas presents itself; this only reports that a frame went out
      Module["rpcs3OnPresented"](data.rpcs3Presented);
    } else if (typeof data.rpcs3WorkerError === "string") {
      if (Module["rpcs3OnWorkerError"]) Module["rpcs3OnWorkerError"](data.rpcs3WorkerError);
      else console.error(`[rpcs3 gpu worker error] ${data.rpcs3WorkerError}`);
    }
  };
  worker.addEventListener("message", onMessage);
  // A worker still loading its wasm drops unknown messages: ping until its hook answers
  let attempts = 0;
  const ping = setInterval(() => {
    if (sentCanvas || ++attempts > 60) { clearInterval(ping); return; }
    worker.postMessage({ rpcs3GpuPing: 1 });
  }, 250);
  worker.postMessage({ rpcs3GpuPing: 1 });
  Module["rpcs3PinWorkerPools"]?.(flagAddress);
});

Module["rpcs3PinWorkerPools"] = (flagAddress) => {
  if (flagAddress) Module["__rpcs3RsxSpawnFlag"] = flagAddress >>> 0;
  if (PThread.__rpcs3GpuPinned) return;
  PThread.__rpcs3GpuPinned = true;
  const originalGetNewWorker = PThread.getNewWorker.bind(PThread);
  const takeRoleWorker = (role, aotKey) => {
    const unused = PThread.unusedWorkers;
    for (let i = 0; i < unused.length; i++) {
      if (unused[i].__rpcs3Role === role) {
        const [worker] = unused.splice(i, 1);
        return worker;
      }
    }
    for (let i = unused.length - 1; i >= 0; i--) {
      if (!unused[i].__rpcs3Role) {
        const [worker] = unused.splice(i, 1);
        worker.__rpcs3Role = role;
        PThread.__rpcs3AotSenders?.[aotKey]?.(worker);
        return worker;
      }
    }
    const worker = originalGetNewWorker();
    if (worker) {
      worker.__rpcs3Role = role;
      PThread.__rpcs3AotSenders?.[aotKey]?.(worker);
    }
    return worker;
  };
  PThread.getNewWorker = () => {
    const flag = Module["__rpcs3RsxSpawnFlag"];
    if (flag && Module["HEAPU8"]) {
      const words = new Uint32Array(Module["HEAPU8"].buffer);
      const base = flag >>> 2;
      const gpuWorker = Module["__rpcs3GpuWorker"];
      if (gpuWorker && Atomics.load(words, base) !== 0) {
        Atomics.store(words, base, 0);
        Module["__rpcs3GpuWorker"] = undefined;
        return gpuWorker;
      }
      if (PThread.__rpcs3RoleScoped) {
        if (Atomics.load(words, base + 1) > 0) {
          Atomics.sub(words, base + 1, 1);
          return takeRoleWorker("ppu", "rpcs3PpuAot");
        }
        if (Atomics.load(words, base + 2) > 0) {
          Atomics.sub(words, base + 2, 1);
          return takeRoleWorker("spu", "rpcs3SpuAot");
        }
      }
    }
    if (PThread.__rpcs3RoleScoped) {
      const unused = PThread.unusedWorkers;
      for (let i = unused.length - 1; i >= 0; i--) {
        if (!unused[i].__rpcs3Role) {
          const [worker] = unused.splice(i, 1);
          return worker;
        }
      }
    }
    return originalGetNewWorker();
  };
};

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  // An uncaught error in a pthread worker only reaches the parent as a message string; forward the
  // stack (wasm function names in the profile build) so the module worker can log it.
  self.addEventListener("error", (event) => {
    try {
      const stack = event && event.error && event.error.stack ? String(event.error.stack) : String(event && event.message);
      self.postMessage({ rpcs3WorkerError: stack.slice(0, 4000) });
    } catch (_) {}
  });
  const handlers = {
    rpcs3PpuAot: { populate: "rpcs3PopulatePpuAot", base: "__rpcs3PpuAotBase", pending: "__rpcs3PpuAotPending" },
    rpcs3SpuAot: { populate: "rpcs3PopulateSpuAot", base: "__rpcs3SpuAotBase", pending: "__rpcs3SpuAotPending" },
  };
  // Instantiating a title's compiled blocks costs JS-heap memory per worker (V8 keeps a function
  // reference per table entry per instance), so a worker keeps the delivered layout and populates
  // its table only when a PPU or SPU thread first runs on it (rpcs3_web_*_aot_worker_ready).
  Module["rpcs3EnsureAot"] = (key) => {
    const handler = handlers[key];
    const load = self[handler.pending];
    if (!load) return self[handler.base] !== undefined;
    self[handler.pending] = undefined;
    if (self[handler.base] === load.tableBase) return true;
    try {
      Module[handler.populate](load);
      self[handler.base] = load.tableBase;
      return true;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      self.postMessage({ [`${key}Error`]: message });
      return false;
    }
  };
  self.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) return;
    if (data.rpcs3SharedHotModule) {
      (self.__rpcs3SharedHotModules ??= new Map()).set(data.rpcs3SharedHotModule.slot >>> 0, data.rpcs3SharedHotModule.mod);
      return;
    }
    if (data.rpcs3GpuPing) { self.postMessage({ rpcs3GpuPong: 1 }); return; }
    if (!data.rpcs3PrepareGpu) return;
    (async () => {
      const canvas = data.rpcs3PrepareGpu.canvas;
      self.__rpcs3GpuCapture = data.rpcs3PrepareGpu.capture;
      const bindGroupCache = data.rpcs3PrepareGpu.bindGroupCache !== false;
      self.__rpcs3BindGroupCache = bindGroupCache;
      const presentationYield = data.rpcs3PrepareGpu.presentationYield ?? "message";
      if (!["timer", "message"].includes(presentationYield)) throw new Error(`Invalid presentation yield: ${presentationYield}`);
      self.__rpcs3PresentationYield = presentationYield;
      if (presentationYield === "message") {
        // A task boundary lets the transferred canvas publish. A resolved Promise
        // would only drain microtasks and would not release the worker event loop.
        const channel = new MessageChannel();
        let pending;
        channel.port1.onmessage = () => { const resolve = pending; pending = undefined; resolve(); };
        self.__rpcs3YieldPresentation = () => new Promise((resolve, reject) => {
          if (pending) { reject(new Error("Concurrent presentation yield")); return; }
          pending = resolve;
          channel.port2.postMessage(0);
        });
      } else {
        self.__rpcs3YieldPresentation = () => new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!("gpu" in navigator)) throw new Error("navigator.gpu is unavailable in this worker");
      let adapter = null;
      for (let attempt = 0; attempt < 5 && !adapter; attempt++) {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) ?? await navigator.gpu.requestAdapter();
        if (!adapter && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!adapter) throw new Error("requestAdapter returned null in the worker");
      // Features the backend uses when the adapter has them (BC textures for DXT, filterable
      // float for the float render targets, depth clip control for RSX depth clamp, timestamp-query for profiling)
      const wanted = ["texture-compression-bc", "float32-filterable", "depth-clip-control", "shader-f16", "timestamp-query"];
      const requiredFeatures = wanted.filter((feature) => adapter.features.has(feature));
      const device = await adapter.requestDevice({ requiredFeatures });
      self.__rpcs3WebGpuErrors = 0;
      device.addEventListener("uncapturederror", (error) => {
        if ((self.__rpcs3WebGpuErrors = (self.__rpcs3WebGpuErrors | 0) + 1) <= 50) {
          self.postMessage({ rpcs3WorkerError: `WebGPU uncaptured error (#${self.__rpcs3WebGpuErrors}): ${String(error.error && error.error.message || error.error)}` });
        }
      });
      device.lost?.then((info) => {
        self.postMessage({ rpcs3WorkerError: `WebGPU device lost (${info?.reason || "unknown"}): ${info?.message || ""}` });
      });
      self.__rpcs3GpuCanvas = canvas;
      Module["preinitializedWebGPUDevice"] = device;
      // WGSL translation for the direct backend (rpcs3-webgpu-renderer.mjs translateRsxProgram)
      // The renderer module sits at the site root; the core may be staged under core/ or core/profile/.
      // Collapse repeated leading slashes first: a base path like "https://host//core/..." would put
      // indexOf("/core/") at position 1 and turn the renderer specifier into a protocol-relative URL.
      const coreUrl = new URL(import.meta.url);
      const corePath = coreUrl.pathname.replace(/\/{2,}/g, "/");
      const coreIndex = corePath.indexOf("/core/");
      const translatorUrl = coreIndex >= 0 ? new URL(corePath.slice(0, coreIndex) + "/rpcs3-webgpu-renderer.mjs", coreUrl) : new URL("../rpcs3-webgpu-renderer.mjs", coreUrl);
      self.__rpcs3Translator = await import(translatorUrl.href);
      if (!Module["specialHTMLTargets"]) throw new Error("specialHTMLTargets is not exported to the worker");
      Module["specialHTMLTargets"]["#rpcs3-canvas"] = canvas;
      const info = adapter.info || {};
      self.postMessage({ rpcs3GpuReady: { bindGroupCache, presentationYield, vendor: info.vendor, architecture: info.architecture, description: info.description, width: canvas.width, height: canvas.height, features: requiredFeatures } });
    })().catch((error) => self.postMessage({ rpcs3GpuError: String(error && error.stack ? error.stack : error) }));
  });
  self.addEventListener("message", (event) => {
    for (const key of Object.keys(handlers)) {
      const load = event.data && event.data[key];
      if (!load) continue;
      const handler = handlers[key];
      if (self[handler.base] === load.tableBase) {
        self.postMessage({ [`${key}Ready`]: 0 });
        continue;
      }
      self[handler.pending] = load;
      self.postMessage({ [`${key}Ready`]: 1 });
    }
  });
}
