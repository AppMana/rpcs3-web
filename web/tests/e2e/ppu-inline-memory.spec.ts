import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The "through real runtime workers" oracle needs the opt-in inline-reads core
// (`RPCS3_PPU_WASM_INLINE_READS` + JSPI). The default build stages the normal JSPI
// core under core/jspi and does not build this experiment variant; when it is absent
// and no RPCS3_TEST_CORE_URL points at a staged copy, the oracle simply cannot run.
const inlineCoreUrl = process.env.RPCS3_TEST_CORE_URL;
const inlineCoreServed = inlineCoreUrl || existsSync("public/core/ppu-inline-reads-jspi/rpcs3-web.mjs");


test("inline-read bundles reject runtimes without the page-table capability", async ({ page }) => {
  await page.goto("/runtime.html");
  const message = await page.evaluate(async () => {
    const loaderUrl = "/rpcs3-ppu-aot-table.mjs";
    const { loadPpuAotBundle } = await import(/* @vite-ignore */ loaderUrl);
    try {
      await loadPpuAotBundle({ module: {}, mainMemory: new WebAssembly.Memory({ initial: 1 }),
        mainInstance: { exports: { __indirect_function_table: new WebAssembly.Table({ initial: 1, element: "anyfunc" }) } },
        manifestUrl: new URL("local-aot/dispatch-inline-reads/manifest.json", location.href).href });
      return "unexpected success";
    } catch (error) { return String(error); }
  });
  expect(message).toContain("direct guest-page reads unsupported by this runtime");
});

test("inline-read PPU bundle matches the dispatch oracle through real runtime workers", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!inlineCoreServed, "inline-reads core not staged in this tree; run with RPCS3_TEST_CORE_URL pointing at a built ppu-inline-reads-jspi core");
  await page.goto("/runtime.html");
  const result = await page.evaluate(async ({coreUrl, compilerUrl}) => {
    const runtime = (window as any).__rpcs3Runtime;
    return runtime.run("fixtures/web_dispatch_conformance.self", {
      completion: "dispatch", renderer: "null", suspending: true, coreUrl,
      ppuAotBundle: "local-aot/dispatch-inline-reads/manifest.json",
      ppuJit: true, ppuInlineReads: true, ppuReturnDispatch: true, spuLlvmWorkers: 1, llvmCompilerUrl: compilerUrl,
      expectedVerdict: "76ec98ba0e352b1c", dispatchTimeoutMs: 60_000,
    });
  }, {coreUrl: inlineCoreUrl || "./core/ppu-inline-reads-jspi/rpcs3-web.mjs",
    compilerUrl: process.env.RPCS3_TEST_SPU_COMPILER_URL || "/core/rpcs3-spu-llvm.mjs"});
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  expect(result.ppuAotTable.dispatches).toBeGreaterThan(0);
  expect(result.spuLlvm.policy.ppuInlineReads).toBe(true);
  expect(result.spuLlvm.policy.moduleUrl).toContain(process.env.RPCS3_TEST_SPU_COMPILER_URL || "/core/rpcs3-spu-llvm.mjs");
});

test("generated PPU reads use helpers only for unmapped or crossing accesses", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const outcomes = await page.evaluate(async ({ compilerUrl, prelude }) => {
    const worker = new Worker("/rpcs3-spu-llvm-worker.mjs", { type: "module" });
    const next = () => new Promise<any>((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message));
    });
    const programs: Array<{ width: number; bytes: Uint8Array }> = [];
    try {
      let reply = next();
      worker.postMessage({ type: "init", moduleUrl: new URL(compilerUrl, location.href).href, ppuReturnDispatch: true, ppuInlineReads: true });
      const ready = await reply;
      if (ready.error) throw new Error(ready.error);
      // Load r3 through r1, store through r2, ba 0x2000. ABI arguments supply r1/r2.
      for (const [width, load, store] of [[1, 0x88610000, 0x98620000], [2, 0xa0610000, 0xb0620000], [4, 0x80610000, 0x90620000], [8, 0xe8610000, 0xf8620000], [16, (31 << 26) | (3 << 21) | (1 << 11) | (103 << 1), (31 << 26) | (3 << 21) | (2 << 11) | (231 << 1)]] as const) {
        const code = new Uint8Array(12), view = new DataView(code.buffer);
        [load, store, 0x48002002].forEach((word, i) => view.setUint32(i * 4, word, false));
        reply = next();
        worker.postMessage({ type: "compile-ppu", id: width, addr: 0x1000, code: code.buffer, attr: 0 }, [code.buffer]);
        const compiled = await reply;
        if (compiled.type !== "compiled") throw new Error(compiled.error);
        programs.push({ width, bytes: compiled.bytes });
      }
    } finally { worker.terminate(); }
    const results: any[] = [];
    for (const { width, bytes } of programs) {
      const wasm = await WebAssembly.compile(new Uint8Array(bytes)), imports = WebAssembly.Module.imports(wasm);
      if (!imports.some((i) => i.module === "GOT.mem" && i.name === "__rpcs3_guest_pages" && i.kind === "global")) throw new Error(`missing page import: ${JSON.stringify(imports)}`);
      const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
      const heap = new Uint8Array(memory.buffer), words = new Uint32Array(memory.buffer);
      const pages = 0x100000, guest = 0x90000000, first = 0x600000, second = 0x700000;
      words[pages / 4 + (guest >>> 12)] = first;
      words[pages / 4 + (guest >>> 12) + 1] = second;
      for (let i = 0; i < 4096; i++) { heap[first + i] = (i * 37 + 13) & 255; heap[second + i] = (i * 19 + 71) & 255; }
      const helperWidth = Math.min(width, 8);
      let slowCalls = 0, written: number[] = [];
      const byteAt = (address: number) => {
        const base = words[pages / 4 + (address >>> 12)];
        return base ? heap[base + (address & 4095)]! : 0xa5;
      };
      const env: Record<string, any> = { memory,
        __indirect_function_table: new WebAssembly.Table({ initial: 1024, element: "anyfunc" }),
        __memory_base: new WebAssembly.Global({ value: "i32" }, 0x800000),
        __table_base: new WebAssembly.Global({ value: "i32" }, 32),
        __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 0xe00000) };
      for (const imported of imports) {
        if (imported.module !== "env" || imported.name in env) continue;
        if (imported.name === `rpcs3_web_vm_read${helperWidth * 8}_raw`) env[imported.name] = (address: number) => {
          slowCalls++;
          let value = 0n;
          for (let i = 0; i < helperWidth; i++) value |= BigInt(byteAt((address + i) >>> 0)) << BigInt(i * 8);
          return helperWidth === 8 ? value : Number(value);
        };
        else if (imported.name === `rpcs3_web_vm_write${helperWidth * 8}_raw`) env[imported.name] = (_address: number, value: number | bigint) => {
          const raw = BigInt.asUintN(helperWidth * 8, BigInt(value));
          written.splice((_address >>> 0) - 0x1000, helperWidth, ...Array.from({ length: helperWidth }, (_, i) => Number((raw >> BigInt(i * 8)) & 255n)));
        };
        else if (imported.kind === "function") env[imported.name] = () => { throw new Error(`unexpected helper ${imported.name}`); };
        else throw new Error(`unexpected import ${imported.name}`);
      }
      // Exercise the production runtime side-module loader, not a hand-bound
      // import object: otherwise enabling inline reads in the pool can pass this
      // test while every real pthread fails its GOT.mem import at installation.
      const runtimeExports = new Proxy({ ...env,
        rpcs3_web_vm_page_table_address: () => pages,
      }, { get: (target: any, name: string) => target[name] ?? (() => { throw new Error(`unexpected runtime helper ${name}`); }) });
      const instantiate = new Function("Module", "wasmExports", "wasmMemory", "self",
        prelude + "\nreturn rpcs3InstantiatePpuSide;")({}, runtimeExports, memory, {});
      if (width === 1) {
        runtimeExports.rpcs3_web_vm_page_table_address = () => 0;
        let rejected = false;
        try { instantiate(wasm, 32, 0x800000, true, env.__indirect_function_table); }
        catch (error) { rejected = String(error).includes("requires a guest page table"); }
        if (!rejected) throw new Error("runtime side loader accepted a missing page table");
        runtimeExports.rpcs3_web_vm_page_table_address = () => pages;
      }
      const entry = instantiate(wasm, 32, 0x800000, true, env.__indirect_function_table);
      const cases: Array<{offset: number; calls: number; unmapped?: boolean}> = [{ offset: 32, calls: 0 }, { offset: 35, calls: 0 }, { offset: 4096 - width, calls: 0 }, ...(width > 1 && width < 16 ? [{ offset: 4097 - width, calls: 1 }] : []), { offset: 32, calls: width === 16 ? 2 : 1, unmapped: true }];
      for (const item of cases) {
        words[pages / 4 + (guest >>> 12)] = item.unmapped ? 0 : first;
        const address = (guest + item.offset) >>> 0;
        const effectiveAddress = width === 16 ? (address & ~15) >>> 0 : address;
        const expected = Array.from({ length: width }, (_, i) => byteAt((effectiveAddress + i) >>> 0));
        slowCalls = 0; written = [];
        entry(0x20000, 0x10000, 0n, 0, 0n, BigInt(address), 0x1000n);
        results.push({ width, ...item, slowCalls, written, expected });
      }
    }
    return results;
  }, { compilerUrl: process.env.RPCS3_TEST_SPU_COMPILER_URL || "/core/rpcs3-spu-llvm.mjs",
    prelude: readFileSync(new URL("../../host/rpcs3_web_pre.js", import.meta.url), "utf8").split("// A compiled block reaches")[0] });
  expect(outcomes).toHaveLength(23);
  for (const outcome of outcomes) {
    expect(outcome.written, JSON.stringify(outcome)).toEqual(outcome.expected);
    expect(outcome.slowCalls, JSON.stringify(outcome)).toBe(outcome.calls);
  }
});

test("runtime compiler pool forwards inline-read policy into emitted PPU code", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async compilerUrl => {
    const poolUrl = "/rpcs3-spu-llvm.mjs";
    const { createLlvmCompilerPool } = await import(/* @vite-ignore */ poolUrl);
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
    const bytes = new Uint8Array(memory.buffer);
    const code = new DataView(memory.buffer, 0x1000, 12);
    [0x80610000, 0x90620000, 0x48002002].forEach((word, i) => code.setUint32(i * 4, word, false));
    let requested = false;
    let finish!: (value: any) => void;
    const completed = new Promise(resolve => { finish = resolve; });
    const module = { wasmMemory: memory, _malloc: () => 0x100000,
      ccall(name: string, _result: any, _types: any, args: number[]) {
        if (name === "rpcs3_web_ppu_llvm_poll") { if (requested) return -1; requested = true; return 0; }
        if (name === "rpcs3_web_ppu_llvm_slot_code") return 0x1000;
        if (name === "rpcs3_web_ppu_llvm_slot_size") return 12;
        if (name === "rpcs3_web_ppu_llvm_slot_addr") return 0x1000;
        if (name === "rpcs3_web_ppu_llvm_slot_attr") return 0;
        if (name === "rpcs3_web_ppu_llvm_slot_finish") {
          const [, pointer, size] = args;
          if (pointer === undefined || size === undefined) throw new Error("missing compiler result span");
          finish(size ? WebAssembly.Module.imports(new WebAssembly.Module(bytes.slice(pointer, pointer + size))) : null);
          return;
        }
        throw new Error(`unexpected runtime call ${name}`);
      } };
    const pool = await createLlvmCompilerPool({ module, memory, workers: 1, spu: false, ppu: true,
      moduleUrl: new URL(compilerUrl, location.href).href, ppuReturnDispatch: true, ppuInlineReads: true });
    try { return { imports: await completed, stats: pool.stats() }; }
    finally { pool.stop(); }
  }, process.env.RPCS3_TEST_SPU_COMPILER_URL || "/core/rpcs3-spu-llvm.mjs");
  expect(result.imports).toContainEqual({ module: "GOT.mem", name: "__rpcs3_guest_pages", kind: "global" });
  expect(result.stats.ppu.compiled).toBe(1);
  expect(result.stats.ppu.failed).toBe(0);
});
