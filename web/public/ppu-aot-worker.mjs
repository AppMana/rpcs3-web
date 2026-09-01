const scope = self;

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
    module.FS.writeFile("/ppu_thread.elf", elf);
    const bootResult = module.ccall("rpcs3_web_boot", "number", ["string"], ["/ppu_thread.elf"]);

    const mainExports = mainInstance.exports;
    const read32 = mainExports.rpcs3_web_vm_read32_raw;
    const write32 = mainExports.rpcs3_web_vm_write32_raw;
    write32(0x30184, swap32(0x30200));
    write32(0x30200, swap32(0x12345678));
    write32(0x30204, swap32(0x38b50));
    const guestMapped = read32(0x30184) === swap32(0x30200);

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
      __check: () => {},
      __get_tb: () => 0n,
      __trap: () => { throw new WebAssembly.RuntimeError("translated PPU trap"); },
      __lshrti3: () => 0,
      __ashlti3: () => 0,
      __ashrti3: () => 0,
    };
    for (const imported of WebAssembly.Module.imports(aotWasm)) {
      if (imported.kind !== "function" || imported.name in env) continue;
      env[imported.name] = imported.name.startsWith("rpcs3_web_vm_")
        ? mainExports[imported.name]
        : () => 0;
    }

    const aotInstance = new WebAssembly.Instance(aotWasm, { env });
    const executionStartedAt = performance.now();
    aotInstance.exports.__0x1022c(0, context, 0n, 0, 0n, 0x31000n, 0n);
    const aotExecutionMs = performance.now() - executionStartedAt;

    const view = new DataView(mainMemory.buffer);
    const result = {
      ok: initialized === 1 && sparseVmProbe === 1 && bootResult === 0 && guestMapped &&
        view.getUint32(context + 1140, true) === 0x12345678 &&
        view.getBigUint64(context + 40, true) === 0x38b50n &&
        view.getBigUint64(context + 1120, true) === 0x103a8n &&
        view.getUint32(context + 20, true) === 0,
      initialized,
      sparseVmProbe,
      bootResult,
      guestMapped,
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
