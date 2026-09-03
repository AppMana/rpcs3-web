import { expect, test } from "@playwright/test";

// The LLVM build inside the browser compiler module (core/rpcs3-spu-llvm.wasm): textual LLVM IR
// in, a wasm32 dylink side module out, through the same lowering the SPU programs take (the
// WebAssembly backend at -O2, PIC, then wasm-ld --shared). Each case instantiates the result
// against the runtime's side-module import contract and executes it, so the assertions are on
// computed values, not on the module's shape alone.

type Reply = { type: string; error?: string; bytes?: number[]; ms: number };

const compileIrInPage = async ({ sources }: { sources: string[] }) => {
  const worker = new Worker("/rpcs3-spu-llvm-worker.mjs", { type: "module" });
  const next = () => new Promise<{ type: string; error?: string; bytes?: Uint8Array; ms: number }>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message));
  });
  const ready = next();
  worker.postMessage({ type: "init", moduleUrl: new URL("/core/rpcs3-spu-llvm.mjs", location.href).href });
  const readiness = await ready;
  if (readiness.error) throw new Error(readiness.error);
  const replies: Reply[] = [];
  for (const ir of sources) {
    const reply = next();
    worker.postMessage({ type: "compile-ir", id: replies.length + 1, pc: 0, ir });
    const data = await reply;
    replies.push({ type: data.type, error: data.error, ms: data.ms, bytes: data.bytes ? Array.from(data.bytes) : undefined });
  }
  worker.terminate();
  return replies;
};

// Instantiates a side module the way rpcs3_web_pre.js places one (memory, table, bases, stack
// pointer), binding every function import to the given JS implementation, and returns exports
const runInPage = async ({ bytes, imports, calls }: { bytes: number[]; imports: Record<string, string>; calls: Array<{ name: string; args: number[] }> }) => {
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 256, shared: true });
  const table = new WebAssembly.Table({ initial: 64, element: "anyfunc" });
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const env: Record<string, WebAssembly.ImportValue> = {
    memory,
    __indirect_function_table: table,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 1 << 20),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 8),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 3 << 20),
  };
  const missing: string[] = [];
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module !== "env") missing.push(`${imported.module}.${imported.name}`);
    if (imported.name in env || imported.kind !== "function") continue;
    const source = imports[imported.name];
    if (!source) { missing.push(imported.name); continue; }
    env[imported.name] = new Function(`return (${source});`)() as WebAssembly.ImportValue;
  }
  if (missing.length) throw new Error(`unbound imports: ${missing.join(", ")}`);
  const instance = new WebAssembly.Instance(module, { env });
  for (const init of ["__wasm_init_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]) {
    const fn = instance.exports[init];
    if (typeof fn === "function") (fn as () => void)();
  }
  // Scratch region for pointer arguments: 2 MiB, zeroed
  const scratch = 2 << 20;
  new Uint8Array(memory.buffer, scratch, 4096).fill(0);
  const view = new DataView(memory.buffer);
  const results: Array<number | number[]> = [];
  for (const call of calls) {
    const fn = instance.exports[call.name] as ((...args: number[]) => number) | undefined;
    if (typeof fn !== "function") throw new Error(`no export ${call.name}; exports: ${Object.keys(instance.exports).join(",")}`);
    results.push(fn(...call.args.map((arg) => (arg < 0 ? scratch - arg : arg))));
  }
  return { results, words: Array.from({ length: 8 }, (_, i) => view.getInt32(scratch + 64 + i * 4, true)) };
};

const header = 'target triple = "wasm32-unknown-unknown"\n';

test.describe("LLVM WebAssembly backend in the browser", () => {
  test("lowers scalar, loop, SIMD, import-calling and data-referencing IR to executable wasm", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto("/runtime.html");
    const ir = header + `
declare i32 @env_twice(i32)

@table = private constant [4 x i32] [i32 10, i32 20, i32 30, i32 40], align 4

define i32 @add(i32 %a, i32 %b) {
  %r = add i32 %a, %b
  ret i32 %r
}

define i32 @sum_to(i32 %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [ 1, %entry ], [ %i.next, %loop ]
  %acc = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  %acc.next = add i32 %acc, %i
  %i.next = add i32 %i, 1
  %done = icmp ugt i32 %i.next, %n
  br i1 %done, label %exit, label %loop
exit:
  ret i32 %acc.next
}

define i32 @vadd_store(ptr %out) {
  %a = add <4 x i32> <i32 1, i32 2, i32 3, i32 4>, <i32 10, i32 20, i32 30, i32 40>
  %b = mul <4 x i32> %a, <i32 2, i32 2, i32 2, i32 2>
  store <4 x i32> %b, ptr %out, align 16
  %lane = extractelement <4 x i32> %b, i32 3
  ret i32 %lane
}

define i32 @call_import(i32 %x) {
  %r = call i32 @env_twice(i32 %x)
  %s = add i32 %r, 1
  ret i32 %s
}

define i32 @lookup(i32 %i) {
  %p = getelementptr inbounds [4 x i32], ptr @table, i32 0, i32 %i
  %v = load i32, ptr %p, align 4
  ret i32 %v
}
`;
    const replies = (await page.evaluate(compileIrInPage, { sources: [ir, ir] })) as Reply[];
    const [first, second] = replies as [Reply, Reply];
    await testInfo.attach("llvm-wasm-backend.json", { body: JSON.stringify(replies.map((r) => ({ ...r, bytes: r.bytes?.length })), null, 2), contentType: "application/json" });
    expect(first.type, first.error).toBe("compiled");
    expect(second.bytes, "deterministic output").toEqual(first.bytes);

    const module = await WebAssembly.compile(new Uint8Array(first.bytes!));
    expect(WebAssembly.Module.customSections(module, "dylink.0").length).toBe(1);
    const exported = WebAssembly.Module.exports(module).filter((e) => e.kind === "function").map((e) => e.name);
    for (const name of ["add", "sum_to", "vadd_store", "call_import", "lookup"]) expect(exported, exported.join(",")).toContain(name);
    const imported = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
    expect(imported).toContain("env.env_twice");

    const run = await page.evaluate(runInPage, {
      bytes: first.bytes!,
      imports: { env_twice: "(x) => x * 2" },
      // A negative argument means "scratch + 64 bytes": the out pointer for the vector store
      calls: [
        { name: "add", args: [2, 3] },
        { name: "add", args: [0x7fffffff, 1] },
        { name: "sum_to", args: [10] },
        { name: "sum_to", args: [100] },
        { name: "vadd_store", args: [-64] },
        { name: "call_import", args: [7] },
        { name: "lookup", args: [2] },
        { name: "lookup", args: [0] },
      ],
    });
    expect(run.results).toEqual([5, -0x80000000, 55, 5050, 88, 15, 30, 10]);
    expect(run.words.slice(0, 4)).toEqual([22, 44, 66, 88]);
  });

  test("reports IR that does not parse instead of answering with a module", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/runtime.html");
    const replies = (await page.evaluate(compileIrInPage, { sources: [header + "define i32 @broken(i32 %a) {\n  ret i32 %missing\n}\n"] })) as Reply[];
    const reply = replies[0] as Reply;
    expect(reply.type).toBe("failed");
    expect(reply.error ?? "").toMatch(/use of undefined value|error/i);
  });
});
