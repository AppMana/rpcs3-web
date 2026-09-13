import { expect, test } from "@playwright/test";

// Compile a real PowerPC absolute branch, then control its dispatch table and module bounds.
// The target is a Wasm-exported spy; it records whether the generated branch actually called it.
test("portable PPU branches call only slots within the supplied instance bounds", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async () => {
    const worker = new Worker("/rpcs3-spu-llvm-worker.mjs", { type: "module" });
    const next = () => new Promise<any>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    let bytes: Uint8Array;
    try {
      let reply = next();
      worker.postMessage({ type: "init", moduleUrl: new URL("/core/rpcs3-spu-llvm.mjs", location.href).href, ppuReturnDispatch: true });
      const ready = await reply;
      if (ready.error) throw new Error(ready.error);
      reply = next();
      // ba 0x2000: opcode18, absolute-address bit1, link bit0 clear.
      const code = Uint8Array.from([0x48, 0, 0x20, 2]);
      worker.postMessage({ type: "compile-ppu", id: 1, addr: 0x1000, code: code.buffer, attr: 0 }, [code.buffer]);
      const compiled = await reply;
      if (compiled.type !== "compiled") throw new Error(compiled.error);
      bytes = compiled.bytes;
    } finally { worker.terminate(); }
    const wasm = await WebAssembly.compile(new Uint8Array(bytes!));
    const memory = new WebAssembly.Memory({ initial: 512, maximum: 32768, shared: true });
    const table = new WebAssembly.Table({ initial: 1024, element: "anyfunc" });
    const env: Record<string, any> = { memory, __indirect_function_table: table,
      __memory_base: new WebAssembly.Global({ value: "i32" }, 0x100000),
      __table_base: new WebAssembly.Global({ value: "i32" }, 32),
      __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 0x1000000) };
    for (const entry of WebAssembly.Module.imports(wasm)) {
      if (entry.name in env) continue;
      if (entry.kind === "function") env[entry.name] = () => 0;
      else if (entry.kind === "global") env[entry.name] = new WebAssembly.Global({ value: "i32" }, 0);
      else throw new Error(`unexpected import ${entry.name}`);
    }
    const instance = new WebAssembly.Instance(wasm, { env });
    (instance.exports.__wasm_apply_data_relocs as Function | undefined)?.();
    const types = [0x7f,0x7f,0x7e,0x7f,0x7e,0x7e,0x7e];
    const section = (id: number, content: number[]) => [id, content.length, ...content];
    const spyBytes = Uint8Array.from([0,97,115,109,1,0,0,0,
      ...section(1, [1,0x60,7,...types,0]),
      ...section(2, [1,1,101,3,104,105,116,0,0]), // import e.hit, function type0
      ...section(7, [1,3,104,105,116,0,0])]);
    let hits = 0;
    const spy = new WebAssembly.Instance(new WebAssembly.Module(spyBytes), { e: { hit: () => { hits++; } } });
    table.set(10, spy.exports.hit);
    const heap = new Uint32Array(memory.buffer);
    const directory = 0x10000, leaf = 0x20000, thread = 0x60000, context = 0x80000;
    heap[directory / 4] = leaf;
    heap[(leaf + (0x2000 / 4) * 4) / 4] = 10;
    const entry = instance.exports.__0x1000 as Function;
    const invoke = (begin: number, end: number, pointer = context) => {
      heap[context / 4] = begin; heap[context / 4 + 1] = end;
      const before = hits;
      entry(directory, thread, 0n, pointer, 0n, 0n, 0n);
      return hits - before;
    };
    return { local: invoke(10,11), upperExcluded: invoke(0,10), lowerExcluded: invoke(11,12),
      empty: invoke(0,0), legacy: invoke(10,11,0) };
  });
  expect(result).toEqual({ local: 1, upperExcluded: 0, lowerExcluded: 0, empty: 0, legacy: 0 });
});
