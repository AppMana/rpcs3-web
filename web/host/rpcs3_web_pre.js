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
// Called from the SPU thread (C++) on this worker; returns the number of registry entries placed here
function rpcs3SpuHotSyncImpl() {
  const count = wasmExports["rpcs3_web_spu_hot_count"]() >>> 0;
  let placed = self.__rpcs3SpuHotPlaced >>> 0;
  if (placed >= count) return placed;
  const table = wasmExports["__indirect_function_table"];
  for (; placed < count; placed++) {
    const index = wasmExports["rpcs3_web_spu_hot_index"](placed) >>> 0;
    const pointer = wasmExports["rpcs3_web_spu_hot_bytes"](placed) >>> 0;
    const size = wasmExports["rpcs3_web_spu_hot_size"](placed) >>> 0;
    const bytes = new Uint8Array(wasmMemory.buffer, pointer, size).slice();
    const module = new WebAssembly.Module(bytes);
    if (table.length <= index) table.grow(index + 1 - table.length);
    table.set(index, rpcs3InstantiateSpuHot(module));
    if ((self.__rpcs3SpuHotLogged = (self.__rpcs3SpuHotLogged | 0) + 1) <= 40) console.log(`[rpcs3 spu hot] worker placed entry ${placed} at table index ${index} (table length ${table.length}, ${size} bytes)`);
  }
  self.__rpcs3SpuHotPlaced = placed;
  return placed;
}
Module["rpcs3InstallSpuHotLoad"] = (load) => {
  const table = wasmExports["__indirect_function_table"];
  const base = load ? load.tableBase + load.tableSize : table.length;
  Module["ccall"]("rpcs3_web_spu_set_hot_table_base", null, ["number"], [base]);
  return { base };
};
Module["rpcs3SpuHotStats"] = () => ({ placedHere: self.__rpcs3SpuHotPlaced >>> 0, count: wasmExports["rpcs3_web_spu_hot_count"]() >>> 0 });

Module["rpcs3PrepareGpu"] = (canvas, flagAddress) => new Promise((resolve, reject) => {
  const PThread = Module["PThread"];
  const worker = PThread.unusedWorkers[PThread.unusedWorkers.length - 1];
  if (!worker) { reject(new Error("no idle pthread worker to host the GPU device")); return; }
  const deadline = setTimeout(() => reject(new Error("GPU worker did not answer")), 60_000);
  let sentCanvas = false;
  const onMessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.rpcs3GpuPong && !sentCanvas) {
      sentCanvas = true;
      worker.postMessage({ rpcs3PrepareGpu: { canvas } }, [canvas]);
    } else if (data.rpcs3GpuReady) {
      clearTimeout(deadline);
      Module["__rpcs3GpuWorker"] = worker;
      Module["__rpcs3RsxSpawnFlag"] = flagAddress >>> 0;
      resolve(data.rpcs3GpuReady);
    } else if (data.rpcs3GpuError) {
      clearTimeout(deadline);
      reject(new Error(data.rpcs3GpuError));
    } else if (data.rpcs3Present && Module["rpcs3OnPresent"]) {
      Module["rpcs3OnPresent"](data);
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
  if (!PThread.__rpcs3GpuPinned) {
    PThread.__rpcs3GpuPinned = true;
    const originalGetNewWorker = PThread.getNewWorker.bind(PThread);
    PThread.getNewWorker = () => {
      const gpuWorker = Module["__rpcs3GpuWorker"];
      const flag = Module["__rpcs3RsxSpawnFlag"];
      if (gpuWorker && flag) {
        const words = new Uint32Array(Module["HEAPU8"].buffer);
        const wantsRsx = Atomics.load(words, flag >>> 2) !== 0;
        const index = PThread.unusedWorkers.indexOf(gpuWorker);
        if (wantsRsx && index >= 0) {
          Atomics.store(words, flag >>> 2, 0);
          PThread.unusedWorkers.splice(index, 1);
          return gpuWorker;
        }
        if (!wantsRsx && index >= 0 && PThread.unusedWorkers.length > 1) {
          // Keep the GPU worker for the RSX thread
          PThread.unusedWorkers.splice(index, 1);
          PThread.unusedWorkers.unshift(gpuWorker);
        }
      }
      return originalGetNewWorker();
    };
  }
});

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
    if (data.rpcs3GpuPing) { self.postMessage({ rpcs3GpuPong: 1 }); return; }
    if (!data.rpcs3PrepareGpu) return;
    (async () => {
      const canvas = data.rpcs3PrepareGpu.canvas;
      if (!("gpu" in navigator)) throw new Error("navigator.gpu is unavailable in this worker");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("requestAdapter returned null in the worker");
      // Features the backend uses when the adapter has them (BC textures for DXT, filterable
      // float for the float render targets, depth clip control for RSX depth clamp)
      const wanted = ["texture-compression-bc", "float32-filterable", "depth-clip-control", "shader-f16"];
      const requiredFeatures = wanted.filter((feature) => adapter.features.has(feature));
      const device = await adapter.requestDevice({ requiredFeatures });
      device.addEventListener("uncapturederror", (error) => {
        self.postMessage({ rpcs3WorkerError: `WebGPU uncaptured error: ${String(error.error && error.error.message || error.error)}` });
      });
      self.__rpcs3GpuCanvas = canvas;
      Module["preinitializedWebGPUDevice"] = device;
      // WGSL translation for the direct backend (rpcs3-webgpu-renderer.mjs translateRsxProgram)
      // The renderer module sits at the site root; the core may be staged under core/ or core/profile/
      const coreUrl = new URL(import.meta.url);
      const coreIndex = coreUrl.pathname.indexOf("/core/");
      const translatorUrl = coreIndex >= 0 ? new URL(coreUrl.pathname.slice(0, coreIndex) + "/rpcs3-webgpu-renderer.mjs", coreUrl) : new URL("../rpcs3-webgpu-renderer.mjs", coreUrl);
      self.__rpcs3Translator = await import(translatorUrl.href);
      if (!Module["specialHTMLTargets"]) throw new Error("specialHTMLTargets is not exported to the worker");
      Module["specialHTMLTargets"]["#rpcs3-canvas"] = canvas;
      const info = adapter.info || {};
      self.postMessage({ rpcs3GpuReady: { vendor: info.vendor, architecture: info.architecture, description: info.description, width: canvas.width, height: canvas.height, features: requiredFeatures } });
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
