import { expect, test } from "@playwright/test";

// The browser SPU LLVM tier compiler module (core/rpcs3-spu-llvm.wasm: RPCS3's LLVM SPU
// recompiler in wasm-IR mode, LLVM's WebAssembly backend, wasm-ld) hosted by its worker
// (rpcs3-spu-llvm-worker.mjs), driven directly: a local-store snapshot in, a dylink side
// module out. The program is hand-assembled so the expected registers are known exactly.

type CompileReply = {
  type: "compiled" | "failed";
  pc: number;
  bytes?: Uint8Array;
  words?: number;
  ms: number;
  error?: string;
};

// SPU encodings (Cell Broadband Engine SPU ISA): RI16 il, RI10 ai, RR bi
const il = (rt: number, i16: number) => ((0x081 << 23) | ((i16 & 0xffff) << 7) | rt) >>> 0;
const ai = (rt: number, ra: number, i10: number) => ((0x1c << 24) | ((i10 & 0x3ff) << 14) | (ra << 7) | rt) >>> 0;
const bi = (ra: number) => ((0x1a8 << 21) | (ra << 7)) >>> 0;

type Program = { pc: number; words: number[] };
type WorkerReply = { type: string; error?: string; bytes?: Uint8Array; words?: number; pc: number; ms: number };

// Runs in the page: hosts the compiler worker and compiles each program's local store in turn
const compileInPage = async ({ programs }: { programs: Program[] }) => {
  const worker = new Worker("/rpcs3-spu-llvm-worker.mjs", { type: "module" });
  const replies: Array<Omit<WorkerReply, "bytes"> & { bytes?: number[] }> = [];
  const next = () => new Promise<WorkerReply>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data as WorkerReply);
    worker.onerror = (event) => reject(new Error(event.message));
  });
  const ready = next();
  worker.postMessage({ type: "init", moduleUrl: new URL("/core/rpcs3-spu-llvm.mjs", location.href).href });
  const readiness = await ready;
  if (readiness.error) throw new Error(readiness.error);
  for (const program of programs) {
    const ls = new Uint8Array(262144);
    const view = new DataView(ls.buffer);
    program.words.forEach((word, i) => view.setUint32(program.pc + i * 4, word, false));
    const reply = next();
    worker.postMessage({ type: "compile", id: replies.length + 1, pc: program.pc, ls: ls.buffer }, [ls.buffer]);
    const data = await reply;
    replies.push({ ...data, bytes: data.bytes ? Array.from(data.bytes) : undefined });
  }
  worker.terminate();
  return replies;
};

test.describe("SPU LLVM tier compiler module", () => {
  test("compiles a program to a dylink side module with the runtime's import contract", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto("/runtime.html");
    const program = { pc: 0x100, words: [il(3, 5), ai(4, 3, 7), bi(5)] };
    const replies = (await page.evaluate(compileInPage, { programs: [program, program] })) as CompileReply[];
    await testInfo.attach("spu-llvm-compiler.json", { body: JSON.stringify(replies.map((r) => ({ ...r, bytes: r.bytes?.length })), null, 2), contentType: "application/json" });
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.type, reply.error).toBe("compiled");
      expect(reply.words).toBe(3);
      expect(reply.bytes!.length).toBeGreaterThan(0);
    }
    // Deterministic: the same snapshot yields the same module
    const [first, second] = replies as [CompileReply, CompileReply];
    expect(second.bytes).toEqual(first.bytes);

    const bytes = new Uint8Array(first.bytes!);
    const module = await WebAssembly.compile(bytes);
    expect(WebAssembly.Module.customSections(module, "dylink.0").length).toBe(1);
    const exports = WebAssembly.Module.exports(module).filter((e) => e.kind === "function").map((e) => e.name);
    expect(exports.some((name) => /^__spu-0x00100-/i.test(name)), exports.join(",")).toBe(true);
    for (const imported of WebAssembly.Module.imports(module)) {
      expect(imported.module, `${imported.module}.${imported.name}`).toBe("env");
      if (imported.kind === "function") expect(imported.name, imported.name).toMatch(/^spu_|^wait_|^get_timebased_time$|^__spu-0x.+-(?:pp|chunkpp)-/);
    }
  });

  test("executes the compiled program against a fake thread block with exact register results", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto("/runtime.html");
    const program = { pc: 0x100, words: [il(3, 5), ai(4, 3, 7), bi(5)] };
    const replies = (await page.evaluate(compileInPage, { programs: [program] })) as CompileReply[];
    const reply = replies[0] as CompileReply;
    expect(reply.type, reply.error).toBe("compiled");

    // spu_thread layout (rpcs3/Emu/Cell/SPUThread.h on wasm32): state at 20, pc at 24, gpr at 48
    const result = await page.evaluate(async ({ bytes, pc }) => {
      const memory = new WebAssembly.Memory({ initial: 128, maximum: 256, shared: true });
      const table = new WebAssembly.Table({ initial: 64, element: "anyfunc" });
      const module = await WebAssembly.compile(new Uint8Array(bytes));
      const calls: string[] = [];
      const env: Record<string, WebAssembly.ImportValue> = {
        memory,
        __indirect_function_table: table,
        __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 1 << 20),
        __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 8),
        __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 3 << 20),
      };
      for (const imported of WebAssembly.Module.imports(module)) {
        if (imported.name in env || imported.kind !== "function") continue;
        env[imported.name] = (...args: unknown[]) => { calls.push(`${imported.name}(${args.join(",")})`); return 0; };
      }
      const instance = new WebAssembly.Instance(module, { env });
      for (const init of ["__wasm_init_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]) {
        const fn = instance.exports[init];
        if (typeof fn === "function") (fn as () => void)();
      }
      const name = WebAssembly.Module.exports(module).find((e) => e.kind === "function" && /^__spu-0x00100-/i.test(e.name))!.name;
      const run = instance.exports[name] as (thread: number, ls: number, arg2: bigint) => void;
      const heap = new Uint8Array(memory.buffer);
      const thread = 2 << 20;
      const ls = 4 << 20;
      heap.fill(0, thread, thread + 16384);
      const view = new DataView(memory.buffer);
      const program = [0x40800283, 0x1c01c184, 0x35000280];
      program.forEach((word, i) => view.setUint32(ls + pc + i * 4, word, false));
      view.setUint32(thread + 24, pc, true);
      // gpr[5] preferred slot (word 3 of the little-endian v128) holds the branch target
      view.setUint32(thread + 48 + 5 * 16 + 12, 0x2000, true);
      run(thread, ls, 0n);
      const gpr = (r: number) => [0, 1, 2, 3].map((lane) => view.getUint32(thread + 48 + r * 16 + lane * 4, true));
      return { pc: view.getUint32(thread + 24, true), r3: gpr(3), r4: gpr(4), calls };
    }, { bytes: reply.bytes!, pc: program.pc });
    await testInfo.attach("spu-llvm-execution.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(result.r3).toEqual([5, 5, 5, 5]);
    expect(result.r4).toEqual([12, 12, 12, 12]);
    expect(result.pc).toBe(0x2000);
  });

  test("reports a failed request instead of answering with a module", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/runtime.html");
    const replies = (await page.evaluate(compileInPage, { programs: [{ pc: 0x102, words: [] }] })) as CompileReply[];
    const reply = replies[0] as CompileReply;
    expect(reply.type).toBe("failed");
    expect(reply.error).toContain("bad request");
  });
});
