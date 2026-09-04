// Browser LLVM tiers, runtime side (module thread of runtime-smoke-worker.mjs). The guest-side
// threads that want a compile — RPCS3's SPU LLVM worker threads (spu_llvm_worker) with a local-store
// snapshot, and the PPU JIT thread with one block of guest code — hand their request over through
// slots in wasm memory (SPUWasmRecompiler.cpp, PPUWebRecompiler.cpp) and wait; this pump forwards
// each slot to a compiler worker and writes the side module back into the slot, where the waiting
// thread registers it as a dispatch candidate for its entry.
//
// Both tiers share one worker pool: the compiler module is LLVM and lld compiled to wasm, which
// every worker instantiates, so a second pool of them is not affordable on a device.
import { dylinkInfo, programExports } from "./rpcs3-spu-aot-table.mjs";

const ppuBlockExport = /^__0x[0-9a-f]+$/i;

function ppuExports(wasm) {
  return WebAssembly.Module.exports(wasm).filter((entry) => entry.kind === "function" && ppuBlockExport.test(entry.name));
}

export async function createLlvmCompilerPool({ module, memory, workers = 2, moduleUrl, log = () => {}, pumpIntervalMs = 2, jobTimeoutMs = 20_000, spu = true, ppu = false }) {
  // Fresh views on the shared memory: another thread may have grown it since this thread's HEAPU8 was taken
  const sharedMemory = memory ?? module.wasmMemory;
  if (!(sharedMemory instanceof WebAssembly.Memory)) throw new Error("the runtime did not expose its shared memory");
  const heap = () => new Uint8Array(sharedMemory.buffer);
  const tierState = () => ({ requested: 0, sent: 0, compiled: 0, failed: 0, stuck: 0, bytes: 0, words: 0, errors: [] });
  const state = { workers: 0, compileMs: 0, maxCompileMs: 0, peakHeapBytes: 0, queue: [], spu: tierState(), ppu: tierState() };
  const idle = [];
  const pool = [];
  const inFlight = new Map(); // worker -> { job, timer }

  const finish = (job, pointer, size, info, importsTable) => {
    module.ccall(job.tier === "ppu" ? "rpcs3_web_ppu_llvm_slot_finish" : "rpcs3_web_spu_llvm_slot_finish", null,
      ["number", "number", "number", "number", "number", "number", "number"],
      [job.slot, pointer, size, info?.memorySize ?? 0, info?.memoryAlign ?? 0, info?.tableSize ?? 0, importsTable ? 1 : 0]);
  };

  const fail = (job, error) => {
    const tier = state[job.tier];
    tier.failed += 1;
    if (tier.errors.length < 8) tier.errors.push(`0x${(job.key >>> 0).toString(16)}: ${String(error).slice(0, 400)}`);
    finish(job, 0, 0, null, false);
  };

  const answer = (job, reply) => {
    const tier = state[job.tier];
    try {
      const wasm = new WebAssembly.Module(reply.bytes);
      const info = dylinkInfo(wasm);
      const names = job.tier === "ppu" ? ppuExports(wasm) : programExports(wasm);
      if (names.length !== 1) throw new Error(`side module exports ${names.length} programs`);
      const importsTable = WebAssembly.Module.imports(wasm).some((imported) => imported.kind === "table");
      const pointer = module._malloc(reply.bytes.length) >>> 0;
      heap().set(reply.bytes, pointer);
      finish(job, pointer, reply.bytes.length, info, importsTable);
      tier.compiled += 1;
      tier.bytes += reply.bytes.length;
      tier.words += reply.words >>> 0;
      // What a compiler worker's heap actually reaches, which is what its reservation has to cover
      state.peakHeapBytes = Math.max(state.peakHeapBytes, reply.heapBytes >>> 0);
      if (tier.compiled <= 8) log(`${job.tier.toUpperCase()} LLVM tier: compiled 0x${(job.key >>> 0).toString(16)} (${reply.bytes.length} bytes, ${reply.words} words, ${Math.round(reply.ms)} ms)`);
    } catch (error) {
      fail(job, error);
    }
  };

  // A compile that never answers would block its waiting thread for good: the watchdog fails the
  // slot and replaces the compiler worker
  const dispatch = () => {
    while (idle.length && state.queue.length) {
      const worker = idle.pop();
      const job = state.queue.shift();
      if (job.tier === "ppu") {
        worker.postMessage({ type: "compile-ppu", id: job.id, addr: job.key, attr: job.attr, code: job.payload }, [job.payload]);
      } else {
        worker.postMessage({ type: "compile", id: job.id, pc: job.key, ls: job.payload }, [job.payload]);
      }
      state[job.tier].sent += 1;
      const timer = setTimeout(() => {
        inFlight.delete(worker);
        state[job.tier].stuck += 1;
        fail(job, `no answer within ${jobTimeoutMs} ms; compiler worker replaced`);
        log(`${job.tier.toUpperCase()} LLVM tier: compile of 0x${(job.key >>> 0).toString(16)} did not answer within ${jobTimeoutMs} ms; replacing the compiler worker`);
        worker.terminate();
        const at = pool.indexOf(worker);
        if (at >= 0) pool.splice(at, 1);
        spawn(pool.length).catch((error) => log(`LLVM compiler pool: ${error}`));
      }, jobTimeoutMs);
      inFlight.set(worker, { job, timer });
    }
  };

  const spawn = (i) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rpcs3-spu-llvm-worker.mjs", import.meta.url), { type: "module", name: `rpcs3-llvm-${i}` });
    pool.push(worker);
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "ready") {
        if (data.error) reject(new Error(`LLVM compiler worker ${i}: ${data.error}`));
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
      reject(new Error(`LLVM compiler worker ${i}: ${event.message}`));
    };
    worker.postMessage({ type: "init", moduleUrl });
  });
  await Promise.all(Array.from({ length: workers }, (_, i) => spawn(i)));
  log(`LLVM compiler pool: ${state.workers} compiler workers ready (${[spu ? "SPU" : null, ppu ? "PPU" : null].filter(Boolean).join(" + ") || "idle"})`);

  const pump = () => {
    if (spu) {
      for (;;) {
        const slot = module.ccall("rpcs3_web_spu_llvm_poll", "number", [], []);
        if (slot < 0) break;
        const pointer = module.ccall("rpcs3_web_spu_llvm_slot_ls", "number", ["number"], [slot]) >>> 0;
        const pc = module.ccall("rpcs3_web_spu_llvm_slot_pc", "number", ["number"], [slot]) >>> 0;
        const payload = heap().slice(pointer, pointer + 262144).buffer;
        state.spu.requested += 1;
        state.queue.push({ id: state.spu.requested, tier: "spu", slot, key: pc, payload });
      }
    }
    if (ppu) {
      for (;;) {
        const slot = module.ccall("rpcs3_web_ppu_llvm_poll", "number", [], []);
        if (slot < 0) break;
        const pointer = module.ccall("rpcs3_web_ppu_llvm_slot_code", "number", ["number"], [slot]) >>> 0;
        const size = module.ccall("rpcs3_web_ppu_llvm_slot_size", "number", ["number"], [slot]) >>> 0;
        const addr = module.ccall("rpcs3_web_ppu_llvm_slot_addr", "number", ["number"], [slot]) >>> 0;
        const attr = module.ccall("rpcs3_web_ppu_llvm_slot_attr", "number", ["number"], [slot]) >>> 0;
        const payload = heap().slice(pointer, pointer + size).buffer;
        state.ppu.requested += 1;
        state.queue.push({ id: state.ppu.requested, tier: "ppu", slot, key: addr, attr, payload });
      }
    }
    dispatch();
  };
  const timer = setInterval(pump, pumpIntervalMs);

  // Resolves once every forwarded request has been answered and registered (bounded): completion
  // reports then describe the tiers' whole work for the run
  const drain = async (timeoutMs = 15_000) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      pump();
      let settled = state.queue.length === 0 && inFlight.size === 0;
      if (settled && spu) {
        const report = JSON.parse(module.ccall("rpcs3_web_spu_hot_report", "string", [], []));
        settled = report.llvm.registered + report.llvm.failed + report.llvm.abandoned >= state.spu.compiled + state.spu.failed;
      }
      if (settled && ppu) {
        const report = JSON.parse(module.ccall("rpcs3_web_ppu_jit_report", "string", [], []));
        settled = report.registered + report.failed >= state.ppu.compiled + state.ppu.failed;
      }
      if (settled || performance.now() >= deadline) return settled;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const tierStats = (tier) => ({
    requested: tier.requested, sent: tier.sent, compiled: tier.compiled, failed: tier.failed,
    stuck: tier.stuck, bytes: tier.bytes, words: tier.words, errors: tier.errors,
  });

  return {
    pump,
    drain,
    stats: () => ({
      workers: state.workers, queued: state.queue.length,
      compileMs: Math.round(state.compileMs), maxCompileMs: Math.round(state.maxCompileMs),
      peakHeapBytes: state.peakHeapBytes,
      // Flattened SPU counters keep the shape earlier reports carry
      ...tierStats(state.spu),
      spu: tierStats(state.spu),
      ppu: tierStats(state.ppu),
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

// The SPU-only entry point earlier callers use
export function createSpuLlvmPool(options) {
  return createLlvmCompilerPool({ ...options, spu: true, ppu: false });
}
