const scope = self;

function dylinkTableSize(module) {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (!sections.length) return 0;
  const bytes = new Uint8Array(sections[0]);
  const leb = (offset) => { let result = 0, shift = 0; for (;;) { const byte = bytes[offset++]; result |= (byte & 0x7f) << shift; if (!(byte & 0x80)) return [result >>> 0, offset]; shift += 7; } };
  let offset = 0;
  while (offset < bytes.length) {
    const type = bytes[offset++];
    let size; [size, offset] = leb(offset);
    if (type === 1) { let cursor = offset; [, cursor] = leb(cursor); [, cursor] = leb(cursor); return leb(cursor)[0]; }
    offset += size;
  }
  return 0;
}

function detail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

function swap32(value) {
  return (((value & 0xff) << 24) |
    ((value & 0xff00) << 8) |
    ((value >>> 8) & 0xff00) |
    ((value >>> 24) & 0xff)) >>> 0;
}

scope.addEventListener("message", async (event) => {
  if (event.data?.type !== "run") return;

  let module;
  const startedAt = performance.now();
  try {
    const [{ default: createRPCS3 }, mainWasm, aotWasm, elf] = await Promise.all([
      import("./core/rpcs3-web.mjs"),
      WebAssembly.compileStreaming(fetch("./core/rpcs3-web.wasm")),
      WebAssembly.compileStreaming(fetch("./fixtures/ppu-thread-aot.wasm")),
      fetch("./fixtures/ppu_thread.elf").then(async (response) => {
        if (!response.ok) throw new Error(`ELF fetch returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }),
    ]);

    let mainInstance;
    let mainMemory;
    module = await createRPCS3({
      locateFile: (name) => new URL(`./core/${name}`, scope.location.href).href,
      print: () => {},
      printErr: () => {},
      instantiateWasm(imports, receiveInstance) {
        mainMemory = imports.env.memory;
        mainInstance = new WebAssembly.Instance(mainWasm, imports);
        receiveInstance(mainInstance, mainWasm);
        return mainInstance.exports;
      },
    });
    module.ccall("rpcs3_web_set_null_renderer", null, ["number"], [1]);
    const initialized = module.ccall("rpcs3_web_init", "number", [], []);
    const sparseVmProbe = module.ccall("rpcs3_web_sparse_vm_probe", "number", [], []);
    module.ccall("rpcs3_web_set_hold_ppu_at_entry", null, ["number"], [1]);
    module.FS.writeFile("/ppu_thread.elf", elf);
    const bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], ["/ppu_thread.elf"]);

    const mainExports = mainInstance.exports;
    const read32 = mainExports.rpcs3_web_vm_read32_raw;
    const write32 = mainExports.rpcs3_web_vm_write32_raw;
    const bootStatus = mainExports.rpcs3_web_status();
    const hybridContext = mainExports.rpcs3_web_ppu_aot_create_context(0x1022c, 0x38b50, 1) >>> 0;
    const originalImportSlot = read32(0x30184) >>> 0;
    const originalImportDescriptor = swap32(originalImportSlot);
    const originalImportTarget = swap32(read32(originalImportDescriptor) >>> 0);
    const originalImportToc = swap32(read32(originalImportDescriptor + 4) >>> 0);
    const resolvedImports = [];
    for (let slot = 0x30168; slot <= 0x301a8; slot += 4) {
      const descriptor = swap32(read32(slot) >>> 0);
      resolvedImports.push({
        slot: `0x${slot.toString(16)}`,
        descriptor: `0x${descriptor.toString(16)}`,
        target: `0x${swap32(read32(descriptor) >>> 0).toString(16)}`,
      });
    }

    const sideAllocationSize = 128 * 1024;
    const sideAllocation = module._malloc(sideAllocationSize + 15);
    const memoryBase = (sideAllocation + 15) & ~15;
    const context = module._malloc(2048);
    module.HEAPU8.fill(0, context, context + 2048);

    const env = {
      memory: mainMemory,
      __stack_pointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        memoryBase + sideAllocationSize,
      ),
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      // Modules built for the table dispatch path place their blocks in an imported table by element segment.
      __indirect_function_table: new WebAssembly.Table({ initial: dylinkTableSize(aotWasm), element: "anyfunc" }),
      __check: () => {},
      __get_tb: () => 0n,
      __trap: () => { throw new WebAssembly.RuntimeError("translated PPU trap"); },
      __lshrti3: () => 0,
      __ashlti3: () => 0,
      __ashrti3: () => 0,
    };
    for (const imported of WebAssembly.Module.imports(aotWasm)) {
      if (imported.kind !== "function" || imported.name in env) continue;
      if (imported.name.startsWith("rpcs3_web_vm_")) {
        env[imported.name] = mainExports[imported.name];
      } else if (/^(sys_|syscall_|__syscall)/.test(imported.name)) {
        env[imported.name] = () => 0;
      } else {
        env[imported.name] = () => 0;
      }
    }

    const aotInstance = new WebAssembly.Instance(aotWasm, { env });
    const view = new DataView(mainMemory.buffer);
    const initialStack = 0x35e00n;
    const clearContext = () => module.HEAPU8.fill(0, context, context + 2048);
    const contextState = (targetContext, pc, kind) => ({
      kind,
      pc: `0x${pc.toString(16)}`,
      next: `0x${view.getUint32(targetContext + 1140, true).toString(16)}`,
      r1: `0x${view.getBigUint64(targetContext + 32, true).toString(16)}`,
      r2: `0x${view.getBigUint64(targetContext + 40, true).toString(16)}`,
      r3: `0x${view.getBigUint64(targetContext + 48, true).toString(16)}`,
      r13: `0x${view.getBigUint64(targetContext + 128, true).toString(16)}`,
      lr: `0x${view.getBigUint64(targetContext + 1120, true).toString(16)}`,
    });
    const runBlock = (targetContext, pc, stackOverride) => {
      const fn = aotInstance.exports[`__0x${pc.toString(16)}`];
      if (typeof fn !== "function") return { pc: `0x${pc.toString(16)}`, missing: true };
      fn(
        // Exec base: RPCS3's page directory, so indirect branches to unregistered blocks store cia and return
        mainExports.rpcs3_web_ppu_aot_exec_base() >>> 0,
        targetContext,
        0n,
        0,
        view.getBigUint64(targetContext + 24, true),
        stackOverride ?? view.getBigUint64(targetContext + 32, true),
        view.getBigUint64(targetContext + 40, true),
      );
      return contextState(targetContext, pc, "aot");
    };

    clearContext();
    const naturalBoundary = runBlock(context, 0x1022c, initialStack);

    const probeDescriptor = 0x35f80;
    write32(0x30184, swap32(probeDescriptor));
    write32(probeDescriptor, swap32(0x10260));
    write32(probeDescriptor + 4, swap32(0x38b50));
    const guestMapped = (read32(0x30184) >>> 0) === swap32(probeDescriptor);
    clearContext();
    const dispatcherTrace = [];
    let dispatchPc = 0x1022c;
    for (let step = 0; step < 3; step += 1) {
      const state = runBlock(context, dispatchPc, step === 0 ? initialStack : undefined);
      dispatcherTrace.push(state);
      if (state.missing) break;
      dispatchPc = view.getUint32(context + 1140, true);
    }

    write32(probeDescriptor, swap32(0x12345678));
    clearContext();
    const executionStartedAt = performance.now();
    runBlock(context, 0x1022c, initialStack);
    const aotExecutionMs = performance.now() - executionStartedAt;

    write32(0x30184, originalImportSlot);
    const runHybridBlock = (pc) => {
      if (!mainExports.rpcs3_web_ppu_aot_begin(hybridContext)) {
        throw new Error("RPCS3 rejected the PPU AOT slice");
      }
      const sliceStartedAt = performance.now();
      try {
        const blockState = runBlock(hybridContext, pc);
        blockState.sliceMs = performance.now() - sliceStartedAt;
        return blockState;
      } finally {
        mainExports.rpcs3_web_ppu_aot_end(hybridContext);
      }
    };
    const hybridTrace = [];
    let hybridPc = hybridContext ? view.getUint32(hybridContext + 1140, true) : 0;
    for (let step = 0; hybridContext && hybridPc && step < 16; step += 1) {
      const state = typeof aotInstance.exports[`__0x${hybridPc.toString(16)}`] === "function"
        ? runHybridBlock(hybridPc)
        : (() => {
            mainExports.rpcs3_web_ppu_aot_interpreter_step(hybridContext);
            return contextState(hybridContext, hybridPc, "interpreter");
          })();
      hybridTrace.push(state);
      const next = view.getUint32(hybridContext + 1140, true);
      if (!next || next === hybridPc) break;
      hybridPc = next;
    }
    const hybridOk = hybridTrace.length === 16 &&
      hybridTrace[0]?.pc === "0x1022c" && hybridTrace[0]?.next === `0x${originalImportTarget.toString(16)}` &&
      hybridTrace[1]?.kind === "interpreter" && hybridTrace[1]?.next === "0x103a8" &&
      hybridTrace[3]?.kind === "interpreter" && hybridTrace[3]?.next === "0x19058" &&
      hybridTrace[4]?.kind === "aot" && hybridTrace[4]?.next === "0x1907c" &&
      hybridTrace[5]?.kind === "interpreter" && hybridTrace[5]?.next === "0x19080";
    const result = {
      ok: initialized === 1 && sparseVmProbe === 1 && bootResult === 0 && bootStatus === 6 && guestMapped &&
        dispatcherTrace[0]?.next === "0x10260" && dispatcherTrace[1]?.next === "0x103a8" &&
        hybridOk &&
        view.getUint32(context + 1140, true) === 0x12345678 &&
        view.getBigUint64(context + 40, true) === 0x38b50n &&
        view.getBigUint64(context + 1120, true) === 0x103a8n &&
        view.getUint32(context + 20, true) === 0,
      initialized,
      sparseVmProbe,
      bootResult,
      bootStatus,
      guestMapped,
      originalImportDescriptor: `0x${originalImportDescriptor.toString(16)}`,
      originalImportTarget: `0x${originalImportTarget.toString(16)}`,
      originalImportToc: `0x${originalImportToc.toString(16)}`,
      resolvedImports,
      naturalBoundary,
      dispatcherTrace,
      hybridContext: `0x${hybridContext.toString(16)}`,
      hybridTrace,
      cia: `0x${view.getUint32(context + 1140, true).toString(16)}`,
      r2: `0x${view.getBigUint64(context + 40, true).toString(16)}`,
      lr: `0x${view.getBigUint64(context + 1120, true).toString(16)}`,
      state: view.getUint32(context + 20, true),
      mainHeapBytes: mainMemory.buffer.byteLength,
      aotImports: WebAssembly.Module.imports(aotWasm).length,
      aotExports: WebAssembly.Module.exports(aotWasm).length,
      aotExecutionMs,
      elapsedMs: performance.now() - startedAt,
    };
    module._free(context);
    module._free(sideAllocation);
    module.ccall("rpcs3_web_stop", null, [], []);
    module.PThread?.terminateAllThreads();
    scope.postMessage({ type: "result", ...result });
  } catch (error) {
    try {
      module?.ccall("rpcs3_web_stop", null, [], []);
      module?.PThread?.terminateAllThreads();
    } catch {}
    scope.postMessage({ type: "result", ok: false, detail: detail(error) });
  }
});
