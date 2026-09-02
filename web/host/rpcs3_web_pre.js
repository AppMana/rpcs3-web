// RPCS3 web: compiled PPU blocks in this worker's function table.
//
// Linked with --pre-js, so this runs inside every createRPCS3() factory: the
// module worker and each Emscripten pthread worker. WebAssembly tables are per
// instance, so every worker instantiates the AOT parts itself and places the
// exported blocks at the same table indices. The layout comes from
// web/public/rpcs3-ppu-aot-table.mjs, which registers (guest address, index)
// pairs with RPCS3 once and then hands the same layout to each worker.
Module["rpcs3PopulatePpuAot"] = (load) => {
  const table = wasmExports["__indirect_function_table"];
  if (!(table instanceof WebAssembly.Table)) throw new Error("the runtime did not export its function table");
  if (table.length !== load.tableBase) {
    throw new Error(`function table has ${table.length} entries; the layout expects ${load.tableBase}`);
  }
  table.grow(load.tableSize);
  const result = { parts: [] };
  for (const part of load.parts) {
    const env = {
      memory: wasmMemory,
      __indirect_function_table: table,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.memoryBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, part.elemBase),
    };
    for (const imported of WebAssembly.Module.imports(part.module)) {
      if (imported.module !== "env") throw new Error(`unsupported import ${imported.module}.${imported.name}`);
      if (imported.name in env) continue;
      if (imported.kind === "global" && imported.name === "__stack_pointer") {
        // One pool slot per worker instance (claimed atomically; no malloc before thread init).
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
    const instance = new WebAssembly.Instance(part.module, { env });
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
  if (table.length !== load.tableBase) {
    throw new Error(`function table has ${table.length} entries; the layout expects ${load.tableBase}`);
  }
  table.grow(load.tableSize);
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
  }
  self.__rpcs3SpuAotReady = true;
  return placed;
};

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  const handlers = {
    rpcs3PpuAot: { populate: "rpcs3PopulatePpuAot", base: "__rpcs3PpuAotBase", count: (result) => result.parts.length },
    rpcs3SpuAot: { populate: "rpcs3PopulateSpuAot", base: "__rpcs3SpuAotBase", count: (result) => result },
  };
  self.addEventListener("message", (event) => {
    for (const key of Object.keys(handlers)) {
      const load = event.data && event.data[key];
      if (!load) continue;
      const handler = handlers[key];
      try {
        if (self[handler.base] === load.tableBase) {
          self.postMessage({ [`${key}Ready`]: 0 });
          continue;
        }
        const result = Module[handler.populate](load);
        self[handler.base] = load.tableBase;
        self.postMessage({ [`${key}Ready`]: handler.count(result) });
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        self.postMessage({ [`${key}Error`]: message });
      }
    }
  });
}
