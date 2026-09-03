// Browser SPU LLVM tier, runtime side (module thread of runtime-smoke-worker.mjs). RPCS3's SPU
// LLVM worker threads (spu_llvm_worker) hand local-store snapshots over through request slots in
// wasm memory (SPUWasmRecompiler.cpp) and wait; this pump forwards each slot to a compiler worker
// and writes the side module back into the slot, where the waiting worker thread registers it as
// the leading dispatch candidate of its entry.
import { dylinkInfo, programExports } from "./rpcs3-spu-aot-table.mjs";

export async function createSpuLlvmPool({ module, memory, workers = 2, moduleUrl, log = () => {}, pumpIntervalMs = 2, jobTimeoutMs = 20_000 }) {
  // Fresh views on the shared memory: another thread may have grown it since this thread's HEAPU8 was taken
  const sharedMemory = memory ?? module.wasmMemory;
  if (!(sharedMemory instanceof WebAssembly.Memory)) throw new Error("the runtime did not expose its shared memory");
  const heap = () => new Uint8Array(sharedMemory.buffer);
  const state = { workers: 0, requested: 0, sent: 0, compiled: 0, failed: 0, stuck: 0, bytes: 0, words: 0, compileMs: 0, maxCompileMs: 0, queue: [], errors: [] };
  const idle = [];
  const pool = [];
  const inFlight = new Map(); // worker -> { job, timer }

  const finish = (slot, pointer, size, info, importsTable) => {
    module.ccall("rpcs3_web_spu_llvm_slot_finish", null,
      ["number", "number", "number", "number", "number", "number", "number"],
      [slot, pointer, size, info?.memorySize ?? 0, info?.memoryAlign ?? 0, info?.tableSize ?? 0, importsTable ? 1 : 0]);
  };

  const fail = (job, error) => {
    state.failed += 1;
    if (state.errors.length < 8) state.errors.push(`0x${(job.pc >>> 0).toString(16)}: ${String(error).slice(0, 400)}`);
    finish(job.slot, 0, 0, null, false);
  };

  const answer = (job, reply) => {
    try {
      const wasm = new WebAssembly.Module(reply.bytes);
      const info = dylinkInfo(wasm);
      const names = programExports(wasm);
      if (names.length !== 1) throw new Error(`side module exports ${names.length} programs`);
      const importsTable = WebAssembly.Module.imports(wasm).some((imported) => imported.kind === "table");
      const pointer = module._malloc(reply.bytes.length) >>> 0;
      heap().set(reply.bytes, pointer);
      finish(job.slot, pointer, reply.bytes.length, info, importsTable);
      state.compiled += 1;
      state.bytes += reply.bytes.length;
      state.words += reply.words >>> 0;
      if (state.compiled <= 8) log(`SPU LLVM tier: compiled 0x${(job.pc >>> 0).toString(16)} (${reply.bytes.length} bytes, ${reply.words} words, ${Math.round(reply.ms)} ms)`);
    } catch (error) {
      fail(job, error);
    }
  };

  // A compile that never answers would block its SPU LLVM worker thread for good: the watchdog
  // fails the slot and replaces the compiler worker
  const dispatch = () => {
    while (idle.length && state.queue.length) {
      const worker = idle.pop();
      const job = state.queue.shift();
      worker.postMessage({ type: "compile", id: job.id, pc: job.pc, ls: job.ls }, [job.ls]);
      state.sent += 1;
      const timer = setTimeout(() => {
        inFlight.delete(worker);
        state.stuck += 1;
        fail(job, `no answer within ${jobTimeoutMs} ms; compiler worker replaced`);
        log(`SPU LLVM tier: compile of 0x${(job.pc >>> 0).toString(16)} did not answer within ${jobTimeoutMs} ms; replacing the compiler worker`);
        worker.terminate();
        const at = pool.indexOf(worker);
        if (at >= 0) pool.splice(at, 1);
        spawn(pool.length).catch((error) => log(`SPU LLVM tier: ${error}`));
      }, jobTimeoutMs);
      inFlight.set(worker, { job, timer });
    }
  };

  const spawn = (i) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rpcs3-spu-llvm-worker.mjs", import.meta.url), { type: "module", name: `rpcs3-spu-llvm-${i}` });
    pool.push(worker);
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "ready") {
        if (data.error) reject(new Error(`SPU LLVM worker ${i}: ${data.error}`));
        else { state.workers += 1; idle.push(worker); resolve(); dispatch(); }
        return;
      }
      const flight = inFlight.get(worker);
      if (!flight) return;
      clearTimeout(flight.timer);
      inFlight.delete(worker);
      state.compileMs += data.ms || 0;
      state.maxCompileMs = Math.max(state.maxCompileMs, data.ms || 0);
      if (data.type === "compiled") answer(flight.job, data);
      else fail(flight.job, data.error ?? data.type);
      idle.push(worker);
      dispatch();
    };
    worker.onerror = (event) => {
      const flight = inFlight.get(worker);
      if (flight) { clearTimeout(flight.timer); inFlight.delete(worker); fail(flight.job, `worker error: ${event.message}`); }
      reject(new Error(`SPU LLVM worker ${i}: ${event.message}`));
    };
    worker.postMessage({ type: "init", moduleUrl });
  });
  await Promise.all(Array.from({ length: workers }, (_, i) => spawn(i)));
  log(`SPU LLVM tier: ${state.workers} compiler workers ready`);

  const pump = () => {
    for (;;) {
      const slot = module.ccall("rpcs3_web_spu_llvm_poll", "number", [], []);
      if (slot < 0) break;
      const pointer = module.ccall("rpcs3_web_spu_llvm_slot_ls", "number", ["number"], [slot]) >>> 0;
      const pc = module.ccall("rpcs3_web_spu_llvm_slot_pc", "number", ["number"], [slot]) >>> 0;
      const ls = heap().slice(pointer, pointer + 262144).buffer;
      state.requested += 1;
      state.queue.push({ id: state.requested, slot, pc, ls });
    }
    dispatch();
  };
  const timer = setInterval(pump, pumpIntervalMs);

  // Resolves once every forwarded request has been answered and registered (bounded): completion
  // reports then describe the tier's whole work for the run
  const drain = async (timeoutMs = 15_000) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      pump();
      const report = JSON.parse(module.ccall("rpcs3_web_spu_hot_report", "string", [], []));
      const settled = state.queue.length === 0 && inFlight.size === 0 && report.llvm.registered + report.llvm.failed + report.llvm.abandoned >= state.compiled + state.failed;
      if (settled || performance.now() >= deadline) return settled;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    pump,
    drain,
    stats: () => ({
      workers: state.workers, requested: state.requested, sent: state.sent, queued: state.queue.length,
      compiled: state.compiled, failed: state.failed, stuck: state.stuck, bytes: state.bytes, words: state.words,
      compileMs: Math.round(state.compileMs), maxCompileMs: Math.round(state.maxCompileMs), errors: state.errors,
    }),
    stop: () => {
      clearInterval(timer);
      for (const flight of inFlight.values()) clearTimeout(flight.timer);
      inFlight.clear();
      for (const worker of pool) worker.terminate();
      pool.length = 0;
    },
  };
}
