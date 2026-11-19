// Compiler worker of the browser LLVM tiers. Hosts core/rpcs3-spu-llvm.wasm (RPCS3's LLVM SPU
// recompiler in wasm-IR mode, RPCS3's PPUTranslator in its wasm mode, LLVM's WebAssembly backend,
// wasm-ld) and turns local-store snapshots and PPU blocks into dylink side modules;
// rpcs3-spu-llvm.mjs on the runtime's module thread feeds it.
let module = null;
let lsPointer = 0;
let wasmRegions = false;
const lines = [];
const keep = (line) => { lines.push(line); if (lines.length > 200) lines.shift(); };

self.onmessage = async (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "init") {
    try {
      const { default: createRPCS3SpuLlvm } = await import(data.moduleUrl);
      module = await createRPCS3SpuLlvm({
        locateFile: (path) => new URL(path, data.moduleUrl).href,
        print: keep,
        printErr: keep,
      });
      if (!module.ccall("rpcs3_spu_llvm_init", "number", [], [])) {
        throw new Error(`${module.ccall("rpcs3_spu_llvm_error", "string", [], [])}\n${lines.join("\n")}`);
      }
      if (!module.ccall("rpcs3_ppu_llvm_init", "number", [], [])) {
        throw new Error(`${module.ccall("rpcs3_ppu_llvm_error", "string", [], [])}\n${lines.join("\n")}`);
      }
      if (data.ppuInlineReads) module.ccall("rpcs3_ppu_llvm_inline_reads", null, ["number"], [1]);
      if (data.ppuInlineWrites) module.ccall("rpcs3_ppu_llvm_inline_writes", null, ["number"], [1]);
      if (data.ppuReturnDispatch) module.ccall("rpcs3_ppu_llvm_return_dispatch", null, ["number"], [1]);
      if (data.spuPortableCalls) module.ccall("rpcs3_spu_llvm_portable_calls", null, ["number"], [1]);
      wasmRegions = data.wasmRegions === true;
      if (wasmRegions) module.ccall("rpcs3_wasm_llvm_regions", null, ["number"], [1]);
      lsPointer = module._malloc(262144) >>> 0;
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "ready", error: String(error?.stack ?? error) });
    }
    return;
  }
  // Views are taken fresh from the memory: the module grows its heap while compiling, and a cached
  // HEAPU8 would then point at a detached buffer
  const heap = () => new Uint8Array(module.wasmMemory.buffer);
  if (data.type === "recomp-lift") {
    const startedAt = performance.now();
    let inPtr = 0;
    try {
      const input = new Uint8Array(data.input);
      inPtr = module._malloc(input.length) >>> 0;
      heap().set(input, inPtr);
      const shardCap = Math.max(64, (data.maxBlocksPerShard ?? 2048) >>> 0);
      const totalBlocks = module.ccall(
        "rpcs3_recomp_plan_descriptor",
        "number",
        ["number", "number", "string", "number", "number"],
        [inPtr, input.length, data.moduleName || "module", (data.prxBase ?? 0) >>> 0, shardCap],
      ) >>> 0;
      const ms = performance.now() - startedAt;
      if (!totalBlocks) {
        self.postMessage({ type: "failed", id: data.id, ms, error: `${module.ccall("rpcs3_ppu_llvm_error", "string", [], [])}\n${lines.slice(-20).join("\n")}` });
        return;
      }
      const descPtr = module.ccall("rpcs3_recomp_desc_data", "number", [], []) >>> 0;
      const descByteLength = module.ccall("rpcs3_recomp_desc_size", "number", [], []) >>> 0;
      const blocksPtr = module.ccall("rpcs3_recomp_plan_blocks_data", "number", [], []) >>> 0;
      const blocksByteLength = module.ccall("rpcs3_recomp_plan_blocks_bytes", "number", [], []) >>> 0;
      const cleanMod = module.ccall("rpcs3_recomp_plan_clean_mod", "string", [], []);
      const blocksByteOffset = (descByteLength + 7) & ~7;
      const planSab = new SharedArrayBuffer(blocksByteOffset + blocksByteLength);
      const planU8 = new Uint8Array(planSab);
      planU8.set(heap().subarray(descPtr, descPtr + descByteLength), 0);
      planU8.set(heap().subarray(blocksPtr, blocksPtr + blocksByteLength), blocksByteOffset);
      module.ccall("rpcs3_recomp_clear_lifted", null, [], []);
      self.postMessage({
        type: "recomp-lifted",
        id: data.id,
        planSab,
        descByteLength,
        blocksByteOffset,
        blocksByteLength,
        blockEntryBytes: module.ccall("rpcs3_recomp_plan_block_entry_bytes", "number", [], []) >>> 0,
        totalBlocks,
        cleanMod,
        maxBlocksPerShard: shardCap,
        ms,
        heapBytes: module.wasmMemory.buffer.byteLength,
      });
    } catch (error) {
      self.postMessage({ type: "failed", id: data.id, ms: performance.now() - startedAt, error: `${String(error?.stack ?? error)}\n${lines.slice(-20).join("\n")}` });
    } finally {
      if (inPtr) module._free(inPtr);
    }
    return;
  }
  if (data.type === "recomp-compile-shard") {
    const startedAt = performance.now();
    let descPtr = 0;
    let blocksPtr = 0;
    let irPtr = 0;
    try {
      let size = 0;
      let emittedBlocks = data.blocks >>> 0;
      if (data.planSab) {
        const planU8 = new Uint8Array(data.planSab);
        const descLen = data.descByteLength >>> 0;
        const blocksOff = data.blocksByteOffset >>> 0;
        const blockEntryBytes = data.blockEntryBytes >>> 0;
        if (!blockEntryBytes) throw new Error("compiler did not report BlockPlanEntry size");
        const pos = data.pos >>> 0;
        const endPos = data.endPos >>> 0;
        const sliceBlocks = endPos - pos;
        const sliceByteOff = blocksOff + pos * blockEntryBytes;
        const sliceByteLen = sliceBlocks * blockEntryBytes;
        if (sliceByteOff + sliceByteLen > planU8.length) throw new Error("planned block slice exceeds shared plan");
        descPtr = module._malloc(descLen) >>> 0;
        blocksPtr = module._malloc(sliceByteLen) >>> 0;
        heap().set(planU8.subarray(0, descLen), descPtr);
        heap().set(planU8.subarray(sliceByteOff, sliceByteOff + sliceByteLen), blocksPtr);
        size = module.ccall(
          "rpcs3_recomp_lift_and_compile_shard",
          "number",
          ["number", "number", "number", "number", "number", "number", "string", "number", "number", "number", "number"],
          [
            descPtr,
            descLen,
            blocksPtr,
            sliceBlocks,
            0,
            sliceBlocks,
            data.suffix,
            data.returnDispatch ? 1 : 0,
            data.formRegions !== false ? 1 : 0,
            data.inlineReads !== false ? 1 : 0,
            data.inlineWrites === true ? 1 : 0,
          ],
        ) >>> 0;
        if (size) {
          emittedBlocks = module.ccall("rpcs3_recomp_last_emitted_blocks", "number", [], []) >>> 0;
        }
      } else {
        const descBytes = new Uint8Array(data.descBytes);
        const irBytes = new Uint8Array(data.irBytes);
        descPtr = module._malloc(descBytes.length) >>> 0;
        irPtr = module._malloc(irBytes.length + 1) >>> 0;
        heap().set(descBytes, descPtr);
        heap().set(irBytes, irPtr);
        heap()[irPtr + irBytes.length] = 0;
        size = module.ccall(
          "rpcs3_recomp_compile_shard",
          "number",
          ["number", "number", "string", "number", "number", "number", "number", "number"],
          [descPtr, descBytes.length, data.suffix, irPtr, irBytes.length, data.formRegions !== false ? 1 : 0, data.inlineReads !== false ? 1 : 0, data.inlineWrites === true ? 1 : 0],
        ) >>> 0;
      }
      const ms = performance.now() - startedAt;
      if (!size) {
        self.postMessage({ type: "failed", id: data.id, suffix: data.suffix, ms, error: `${module.ccall("rpcs3_ppu_llvm_error", "string", [], [])}\n${lines.slice(-20).join("\n")}` });
        return;
      }
      const outPtr = module.ccall("rpcs3_ppu_llvm_output", "number", [], []) >>> 0;
      const bytes = heap().slice(outPtr, outPtr + size);
      const hleCalls = module.ccall("rpcs3_recomp_last_hle_calls", "number", [], []) >>> 0;
      const regionLinks = module.ccall("rpcs3_recomp_last_region_links", "number", [], []) >>> 0;
      self.postMessage({
        type: "recomp-shard-compiled",
        id: data.id,
        suffix: data.suffix,
        bytes,
        blocks: emittedBlocks,
        hleCalls,
        regionLinks,
        ms,
        heapBytes: module.wasmMemory.buffer.byteLength,
      }, [bytes.buffer]);
    } catch (error) {
      // Put the compiler's phase diagnostics first. The pool deliberately truncates worker
      // failures to keep logs bounded, and a Wasm abort stack can otherwise consume that
      // budget before the last completed compiler phase reaches the browser console.
      self.postMessage({ type: "failed", id: data.id, suffix: data.suffix, ms: performance.now() - startedAt, error: `${lines.slice(-20).join("\n")}\n${String(error?.stack ?? error)}` });
    } finally {
      if (descPtr) module._free(descPtr);
      if (blocksPtr) module._free(blocksPtr);
      if (irPtr) module._free(irPtr);
    }
    return;
  }
  if (data.type === "compile-ppu") {
    const startedAt = performance.now();
    let pointer = 0;
    try {
      const code = new Uint8Array(data.code);
      pointer = module._malloc(code.length) >>> 0;
      heap().set(code, pointer);
      const size = module.ccall("rpcs3_ppu_llvm_compile", "number", ["number", "number", "number", "number"], [data.addr, code.length, pointer, data.attr >>> 0]) >>> 0;
      const ms = performance.now() - startedAt;
      if (!size) {
        self.postMessage({ type: "failed", id: data.id, addr: data.addr, ms, error: `${module.ccall("rpcs3_ppu_llvm_error", "string", [], [])}\n${lines.slice(-20).join("\n")}` });
        return;
      }
      const output = module.ccall("rpcs3_ppu_llvm_output", "number", [], []) >>> 0;
      const bytes = heap().slice(output, output + size);
      const heapBytes = module.wasmMemory.buffer.byteLength;
      const regionLinks = wasmRegions ? module.ccall("rpcs3_wasm_llvm_region_links", "number", [], []) : undefined;
      self.postMessage({ type: "compiled", id: data.id, addr: data.addr, bytes, words: code.length / 4, ms, heapBytes, regionLinks }, [bytes.buffer]);
    } catch (error) {
      self.postMessage({ type: "failed", id: data.id, addr: data.addr, ms: performance.now() - startedAt, error: `${String(error?.stack ?? error)}\n${lines.slice(-20).join("\n")}` });
    } finally {
      if (pointer) module._free(pointer);
    }
    return;
  }
  if (data.type === "compile" || data.type === "compile-ir") {
    const startedAt = performance.now();
    try {
      let size = 0;
      if (data.type === "compile") {
        heap().set(new Uint8Array(data.ls), lsPointer);
        size = module.ccall("rpcs3_spu_llvm_compile", "number", ["number", "number"], [lsPointer, data.pc]) >>> 0;
      } else {
        size = module.ccall("rpcs3_spu_llvm_compile_ir", "number", ["string"], [data.ir]) >>> 0;
      }
      const ms = performance.now() - startedAt;
      if (!size) {
        self.postMessage({ type: "failed", id: data.id, pc: data.pc, ms, error: `${module.ccall("rpcs3_spu_llvm_error", "string", [], [])}\n${lines.slice(-20).join("\n")}` });
        return;
      }
      const pointer = module.ccall("rpcs3_spu_llvm_output", "number", [], []) >>> 0;
      const bytes = heap().slice(pointer, pointer + size);
      const words = module.ccall("rpcs3_spu_llvm_program_words", "number", [], []) >>> 0;
      // What this worker's heap has actually grown to, which is what its reservation has to cover
      const heapBytes = module.wasmMemory.buffer.byteLength;
      const regionLinks = wasmRegions ? module.ccall("rpcs3_wasm_llvm_region_links", "number", [], []) : undefined;
      self.postMessage({ type: "compiled", id: data.id, pc: data.pc, bytes, words, ms, heapBytes, regionLinks }, [bytes.buffer]);
    } catch (error) {
      self.postMessage({ type: "failed", id: data.id, pc: data.pc, ms: performance.now() - startedAt, error: `${String(error?.stack ?? error)}\n${lines.slice(-20).join("\n")}` });
    }
  }
};
