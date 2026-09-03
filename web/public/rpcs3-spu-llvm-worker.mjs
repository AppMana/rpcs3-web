// Compiler worker of the browser SPU LLVM tier. Hosts core/rpcs3-spu-llvm.wasm (RPCS3's LLVM SPU
// recompiler in wasm-IR mode, LLVM's WebAssembly backend, wasm-ld) and turns local-store snapshots
// into dylink side modules; rpcs3-spu-llvm.mjs on the runtime's module thread feeds it.
let module = null;
let lsPointer = 0;
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
      self.postMessage({ type: "compiled", id: data.id, pc: data.pc, bytes, words, ms }, [bytes.buffer]);
    } catch (error) {
      self.postMessage({ type: "failed", id: data.id, pc: data.pc, ms: performance.now() - startedAt, error: `${String(error?.stack ?? error)}\n${lines.slice(-20).join("\n")}` });
    }
  }
};
