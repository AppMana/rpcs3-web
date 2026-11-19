// Browser & Desktop-Wasm LLVM tiers + Whole-Module Decomposed Static Recompiler (runtime side).
// Guest-side threads hand compile requests over through shared Wasm memory slots:
//   1. Whole-module static recompilation (rpcs3_web_recomp_poll): extracts live PS3 EBOOT.BIN and
//      every preloaded or dynamically loaded .sprx module into a PS3R descriptor, lifts 100% of
//      executable blocks (with Ghidra 12.1.3 JumpTable recovery + automatic HLE/LLE stub maps) into
//      IR shards on one worker, compiles all shards in parallel across the worker pool into shared
//      PIC .wasm modules, registers all (guest_pc, table_index) pairs before guest code runs, and
//      persists the compiled shards in IndexedDB (browser) or disk cache (desktop Wasm host).
//   2. SPU LLVM tier (rpcs3_web_spu_llvm_poll): compiles SPU programs from 256 KiB LS snapshots.
//   3. PPU block-JIT fallback (rpcs3_web_ppu_llvm_poll): compiles any dynamic RAM thunk on first hit.
import { dylinkInfo, programExports } from "./rpcs3-spu-aot-table.mjs";
import { SpuWgslCompiler } from "./rpcs3-spu-wgsl.mjs";

const ppuBlockExport = /^__0x[0-9a-f]+$/i;

function ppuExports(wasm) {
  return WebAssembly.Module.exports(wasm).filter((entry) => entry.kind === "function" && ppuBlockExport.test(entry.name));
}

function extractShardGuestRelPairs(wasm, info) {
  if (!info.tableSize) return new Uint32Array(0);
  const memPages = Math.max(1, Math.ceil(((info.memorySize >>> 0) + 4096) / 65536));
  const scratchMem = new WebAssembly.Memory({
    initial: memPages,
    maximum: Math.max(memPages, 32768),
    shared: true,
  });
  const scratchTable = new WebAssembly.Table({
    element: "anyfunc",
    initial: Math.max(1, (info.tableSize >>> 0) + 1),
  });
  const envImports = {
    memory: scratchMem,
    __indirect_function_table: scratchTable,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 1024),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, memPages * 65536),
  };
  const gotMem = {};
  const gotFunc = {};
  for (const imp of WebAssembly.Module.imports(wasm)) {
    if (imp.module === "env" && imp.kind === "function" && !(imp.name in envImports)) {
      envImports[imp.name] = () => 0;
    } else if (imp.module === "GOT.mem" && imp.kind === "global") {
      gotMem[imp.name] = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    } else if (imp.module === "GOT.func" && imp.kind === "global") {
      gotFunc[imp.name] = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    }
  }
  const inst = new WebAssembly.Instance(wasm, { env: envImports, "GOT.mem": gotMem, "GOT.func": gotFunc });
  for (const init of ["__wasm_init_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"]) {
    if (typeof inst.exports[init] === "function") inst.exports[init]();
  }
  const heapWords = new Uint32Array(scratchMem.buffer);
  const pairs = [];
  for (const [name, value] of Object.entries(inst.exports)) {
    if (!name.startsWith("__ppu_blocks_") || !(value instanceof WebAssembly.Global)) continue;
    const indexOf = inst.exports[`__ppu_block_index_${name.slice("__ppu_blocks_".length)}`];
    if (typeof indexOf !== "function") continue;
    const addr = (1024 + (value.value >>> 0)) >>> 0;
    const count = heapWords[addr >>> 2] >>> 0;
    for (let i = 0; i < count; i++) {
      const guestPc = heapWords[(addr >>> 2) + 1 + i] >>> 0;
      const relIdx = indexOf(i) >>> 0;
      if (relIdx < (info.tableSize >>> 0)) {
        pairs.push(guestPc, relIdx);
      }
    }
  }
  return new Uint32Array(pairs);
}

const memoryModuleCache = new Map();
const IDB_NAME = "rpcs3-wasm-jit-cache-v3";
const IDB_STORE = "modules";

function hashPayloadHex(bytes) {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  if ((bytes.byteOffset & 3) === 0 && (bytes.byteLength & 3) === 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((w << 7) | (w >>> 25)), 0x01000193) >>> 0;
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((b << 1) | (b >>> 7)), 0x01000193) >>> 0;
    }
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${bytes.length}`;
}

function openJitCacheDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function warmMemoryCacheFromIdb() {
  const db = await openJitCacheDb();
  if (!db) return null;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        const val = cursor.value;
        if (val && val.recompBundle === true && Array.isArray(val.parts)) {
          memoryModuleCache.set(String(cursor.key), {
            recompBundle: true,
            parts: val.parts.map((p) => ({
              bytes: p.bytes instanceof Uint8Array ? p.bytes : new Uint8Array(p.bytes),
              info: p.info,
              importsTable: Boolean(p.importsTable),
              pairs: p.pairs instanceof Uint32Array ? p.pairs : new Uint32Array(p.pairs),
              blocks: p.blocks >>> 0,
              hleCalls: p.hleCalls >>> 0,
              regionLinks: p.regionLinks >>> 0,
            })),
          });
        } else if (val && val.bytes instanceof Uint8Array) {
          memoryModuleCache.set(String(cursor.key), {
            bytes: val.bytes,
            words: val.words >>> 0,
            info: val.info ?? null,
            importsTable: Boolean(val.importsTable),
          });
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  return db;
}

function persistModuleEntry(db, key, entry) {
  try {
    globalThis.__rpcs3DiskCache?.set?.(key, entry);
  } catch {}
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(entry, key);
  } catch {
    // Best-effort persistence
  }
}

function lookupCachedEntry(key) {
  const mem = memoryModuleCache.get(key);
  if (mem) return mem;
  try {
    const disk = globalThis.__rpcs3DiskCache?.get?.(key);
    if (disk) {
      memoryModuleCache.set(key, disk);
      return disk;
    }
  } catch {}
  return null;
}

export async function createLlvmCompilerPool({
  module,
  memory,
  workers = 2,
  moduleUrl,
  log = () => {},
  pumpIntervalMs = 4,
  jobTimeoutMs = 20_000,
  recompTimeoutMs = 300_000,
  recompMaxBlocksPerShard = 2048,
  firmwareWasmIndexUrl,
  spu = true,
  ppu = false,
  autoRecomp = false,
  ppuReturnDispatch = false,
  ppuInlineReads = true,
  ppuInlineWrites = false,
  spuPortableCalls = false,
  wasmRegions = true,
}) {
  const sharedMemory = memory ?? module.wasmMemory;
  if (!(sharedMemory instanceof WebAssembly.Memory)) throw new Error("the runtime did not expose its shared memory");
  const heap = () => new Uint8Array(sharedMemory.buffer);
  const spuWgsl = new SpuWgslCompiler();
  const tierState = () => ({ requested: 0, sent: 0, compiled: 0, cached: 0, failed: 0, stuck: 0, bytes: 0, words: 0, errors: [] });
  const recompState = {
    modulesRequested: 0,
    modulesCompiled: 0,
    modulesCached: 0,
    firmwareLinked: 0,
    modulesFailed: 0,
    shardsCompiled: 0,
    blocksRegistered: 0,
    hleCallsLowered: 0,
    regionLinks: 0,
    bytes: 0,
    liftMs: 0,
    compileMs: 0,
    errors: [],
  };
  const state = { workers: 0, compileMs: 0, maxCompileMs: 0, peakHeapBytes: 0, queue: [], spu: tierState(), ppu: tierState(), recomp: recompState };
  const ppuCodegenVersion = module._rpcs3_web_ppu_codegen_semantics_version
    ? module.ccall("rpcs3_web_ppu_codegen_semantics_version", "number", [], []) >>> 0
    : 0;
  const ppuBackend = module._rpcs3_web_ppu_codegen_backend
    ? module.ccall("rpcs3_web_ppu_codegen_backend", "number", [], []) >>> 0
    : 0;
  const ppuPolicyTag = `${ppuBackend}:v${ppuCodegenVersion}:${ppuReturnDispatch ? 1 : 0}:${ppuInlineReads ? 1 : 0}:${ppuInlineWrites ? 1 : 0}:${wasmRegions ? 1 : 0}`;
  const spuPolicyTag = `${spuPortableCalls ? 1 : 0}:${wasmRegions ? 1 : 0}`;
  let cacheDb = null;
  let recompJobSeq = 0;
  const idle = [];
  const pool = [];
  const inFlight = new Map(); // worker -> { job, timer }

  const makeCacheKey = (job) => {
    const bytes = new Uint8Array(job.payload);
    const compatSuffix = job.tier === "spu" && (job.key === 0x00cc8 || job.key === 0x02310) ? ":compat1" : "";
    const policyTag = job.tier === "ppu" ? ppuPolicyTag : spuPolicyTag;
    return `${job.tier}:0x${(job.key >>> 0).toString(16)}:${(job.attr >>> 0).toString(16)}:${policyTag}:${hashPayloadHex(bytes)}${compatSuffix}`;
  };

  const registerRecompShard = (part, shardSeg0 = 0) => {
    if (!part.bytes?.byteLength || !part.info?.tableSize) return 0;
    const wasmPtr = module._malloc(part.bytes.byteLength) >>> 0;
    const pairsBytes = part.pairs.byteLength >>> 0;
    const pairsPtr = pairsBytes ? (module._malloc(pairsBytes) >>> 0) : 0;
    try {
      heap().set(part.bytes, wasmPtr);
      if (pairsBytes) {
        new Uint32Array(sharedMemory.buffer, pairsPtr, part.pairs.length).set(part.pairs);
      }
      const regCount = module.ccall(
        "rpcs3_web_recomp_register_shard",
        "number",
        ["number", "number", "number", "number", "number", "number", "number", "number", "number"],
        [
          wasmPtr,
          part.bytes.byteLength,
          part.info.memorySize >>> 0,
          part.info.memoryAlign >>> 0,
          part.info.tableSize >>> 0,
          part.importsTable ? 1 : 0,
          pairsPtr,
          part.pairs.length >>> 1,
          shardSeg0 >>> 0,
        ],
      ) >>> 0;
      return regCount;
    } finally {
      if (pairsPtr) module._free(pairsPtr);
      if (wasmPtr) module._free(wasmPtr);
    }
  };

  const finish = (job, pointer, size, info, importsTable) => {
    module.ccall(job.tier === "ppu" ? "rpcs3_web_ppu_llvm_slot_finish" : "rpcs3_web_spu_llvm_slot_finish", null,
      ["number", "number", "number", "number", "number", "number", "number"],
      [job.slot, pointer, size, info?.memorySize ?? 0, info?.memoryAlign ?? 0, info?.tableSize ?? 0, importsTable ? 1 : 0]);
  };

  const fail = (job, error) => {
    const errText = String(error).slice(0, 500);
    if (job.tier === "recomp-lift") {
      recompState.modulesFailed += 1;
      if (recompState.errors.length < 8) recompState.errors.push(`${job.name}: ${errText}`);
      log(`RECOMP lift failed for '${job.name}': ${errText}`);
      module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [0]);
      return;
    }
    if (job.tier === "recomp-shard") {
      const parent = job.parent;
      if (!parent.failed) {
        parent.failed = true;
        recompState.modulesFailed += 1;
        if (recompState.errors.length < 8) recompState.errors.push(`${parent.name}/${job.suffix}: ${errText}`);
        log(`RECOMP shard '${parent.name}/${job.suffix}' failed: ${errText}`);
      }
      parent.remaining -= 1;
      if (parent.remaining <= 0) {
        module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [0]);
      }
      return;
    }
    const tier = state[job.tier];
    tier.failed += 1;
    if (tier.errors.length < 8) tier.errors.push(`0x${(job.key >>> 0).toString(16)}: ${errText}`);
    finish(job, 0, 0, null, false);
  };

  const answerRecompLifted = (job, reply) => {
    recompState.liftMs += reply.ms || 0;
    state.peakHeapBytes = Math.max(state.peakHeapBytes, reply.heapBytes >>> 0);
    const totalBlocks = reply.totalBlocks >>> 0;
    const shardCap = Math.max(64, (reply.maxBlocksPerShard ?? 2048) >>> 0);
    const shardCount = totalBlocks > 0 ? Math.ceil(totalBlocks / shardCap) : 0;
    if (!shardCount || !reply.planSab) {
      fail(job, "module planned 0 shards");
      return;
    }
    log(`RECOMP planned '${job.name}' (seg0=0x${job.seg0.toString(16)}): ${totalBlocks} blocks -> ${shardCount} parallel shards in ${Math.round(reply.ms || 0)} ms`);
    const parent = {
      name: job.name,
      sha1: job.sha1,
      seg0: job.seg0,
      isFirmware: Boolean(job.isFirmware),
      recompKey: job.recompKey,
      startedAt: job.startedAt,
      liftMs: reply.ms || 0,
      totalShards: shardCount,
      remaining: shardCount,
      failed: false,
      completed: new Array(shardCount),
    };
    for (let i = shardCount - 1; i >= 0; i--) {
      const pos = i * shardCap;
      const endPos = Math.min(totalBlocks, pos + shardCap);
      const suffix = `${reply.cleanMod}_part_${String(i).padStart(3, "0")}`;
      state.queue.unshift({
        id: ++recompJobSeq,
        tier: "recomp-shard",
        parent,
        shardIndex: i,
        suffix,
        pos,
        endPos,
        totalBlocks,
        blocks: endPos - pos,
        planSab: reply.planSab,
        descByteLength: reply.descByteLength >>> 0,
        blocksByteOffset: reply.blocksByteOffset >>> 0,
        blocksByteLength: reply.blocksByteLength >>> 0,
        blockEntryBytes: reply.blockEntryBytes >>> 0,
      });
    }
  };

  const answerRecompShard = (job, reply) => {
    const parent = job.parent;
    recompState.compileMs += reply.ms || 0;
    state.peakHeapBytes = Math.max(state.peakHeapBytes, reply.heapBytes >>> 0);
    if (!parent.failed) {
      try {
        const wasm = new WebAssembly.Module(reply.bytes);
        const info = dylinkInfo(wasm);
        const importsTable = WebAssembly.Module.imports(wasm).some((imp) => imp.kind === "table");
        const pairs = extractShardGuestRelPairs(wasm, info);
        parent.completed[job.shardIndex] = {
          bytes: reply.bytes.slice(),
          info,
          importsTable,
          pairs,
          blocks: (pairs.length >>> 1) || (reply.blocks >>> 0),
          hleCalls: reply.hleCalls >>> 0,
          regionLinks: reply.regionLinks >>> 0,
        };
      } catch (err) {
        fail(job, err);
        return;
      }
    }
    parent.remaining -= 1;
    if (!parent.failed) {
      recompState.shardsCompiled += 1;
      const done = parent.totalShards - parent.remaining;
      if (parent.totalShards >= 16 && (done % 16 === 0 || done === parent.totalShards)) {
        log(`RECOMP progress '${parent.name}': ${done}/${parent.totalShards} shards (${Math.round((performance.now() - parent.startedAt) / 1000)}s)`);
      }
    }
    if (parent.remaining > 0) return;

    if (parent.failed) {
      module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [0]);
      return;
    }

    try {
      let regBlocks = 0;
      let regHle = 0;
      let regRegions = 0;
      let regBytes = 0;
      for (const part of parent.completed) {
        registerRecompShard(part, parent.seg0);
        regBlocks += part.pairs.length >>> 1;
        regHle += part.hleCalls >>> 0;
        regRegions += part.regionLinks >>> 0;
        regBytes += part.bytes.byteLength >>> 0;
      }
      const numShards = parent.completed.length;
      const bundleEntry = { recompBundle: true, parts: parent.completed.slice() };
      persistModuleEntry(cacheDb, parent.recompKey, bundleEntry);
      parent.completed.length = 0;

      recompState.modulesCompiled += 1;
      if (parent.isFirmware) recompState.firmwareLinked += 1;
      recompState.blocksRegistered += regBlocks;
      recompState.hleCallsLowered += regHle;
      recompState.regionLinks += regRegions;
      recompState.bytes += regBytes;

      const totalMs = performance.now() - parent.startedAt;
      log(`RECOMP linked '${parent.name}' (seg0=0x${parent.seg0.toString(16)}): ${regBlocks} blocks, ${regHle} HLE calls, ${numShards} Wasm shards (${(regBytes / 1048576).toFixed(2)} MiB) in ${Math.round(totalMs)} ms`);
      module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [1]);
    } catch (err) {
      recompState.modulesFailed += 1;
      if (recompState.errors.length < 8) recompState.errors.push(`${parent.name}: ${String(err).slice(0, 400)}`);
      log(`RECOMP registration failed for '${parent.name}': ${err}`);
      module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [0]);
    }
  };

  const answer = (job, reply) => {
    const tier = state[job.tier];
    try {
      let info = reply.info;
      let importsTable = reply.importsTable;
      if (!info) {
        const wasm = new WebAssembly.Module(reply.bytes);
        info = dylinkInfo(wasm);
        const names = job.tier === "ppu" ? ppuExports(wasm) : programExports(wasm);
        if (names.length !== 1) throw new Error(`side module exports ${names.length} programs`);
        importsTable = WebAssembly.Module.imports(wasm).some((imported) => imported.kind === "table");
      }
      const pointer = module._malloc(reply.bytes.length) >>> 0;
      heap().set(reply.bytes, pointer);
      finish(job, pointer, reply.bytes.length, info, importsTable);
      tier.compiled += 1;
      if (reply.cached) tier.cached += 1;
      else if (job.cacheKey) {
        const entry = { bytes: reply.bytes.slice(), words: reply.words >>> 0, info, importsTable };
        memoryModuleCache.set(job.cacheKey, entry);
        persistModuleEntry(cacheDb, job.cacheKey, entry);
      }
      tier.bytes += reply.bytes.length;
      tier.words += reply.words >>> 0;
      state.peakHeapBytes = Math.max(state.peakHeapBytes, reply.heapBytes >>> 0);
      if (tier.compiled <= 8) log(`${job.tier.toUpperCase()} LLVM tier: ${reply.cached ? "cache-hit" : "compiled"} 0x${(job.key >>> 0).toString(16)} (${reply.bytes.length} bytes, ${reply.words} words, ${Math.round(reply.ms || 0)} ms)`);
    } catch (error) {
      fail(job, error);
    }
  };

  const dispatch = () => {
    while (state.queue.length) {
      const nextJob = state.queue[0];
      if (nextJob.tier === "spu" || nextJob.tier === "ppu") {
        nextJob.cacheKey ??= makeCacheKey(nextJob);
        const cached = lookupCachedEntry(nextJob.cacheKey);
        if (cached && cached.bytes instanceof Uint8Array) {
          state.queue.shift();
          answer(nextJob, { bytes: cached.bytes, words: cached.words, info: cached.info, importsTable: cached.importsTable, ms: 0, heapBytes: 0, cached: true });
          continue;
        }
      }
      if (!idle.length) break;
      const worker = idle.pop();
      const job = state.queue.shift();
      const isRecomp = job.tier === "recomp-lift" || job.tier === "recomp-shard";
      const timeoutForJob = isRecomp ? recompTimeoutMs : jobTimeoutMs;

      if (job.tier === "recomp-lift") {
        worker.postMessage({
          type: "recomp-lift",
          id: job.id,
          moduleName: job.name,
          prxBase: job.seg0 >>> 0,
          maxBlocksPerShard: job.maxBlocksPerShard,
          returnDispatch: ppuReturnDispatch,
          input: job.input,
        }, [job.input]);
      } else if (job.tier === "recomp-shard") {
        worker.postMessage({
          type: "recomp-compile-shard",
          id: job.id,
          suffix: job.suffix,
          pos: job.pos >>> 0,
          endPos: job.endPos >>> 0,
          totalBlocks: job.totalBlocks >>> 0,
          blocks: job.blocks >>> 0,
          returnDispatch: ppuReturnDispatch,
          formRegions: wasmRegions,
          inlineReads: ppuInlineReads,
          inlineWrites: ppuInlineWrites,
          planSab: job.planSab,
          descByteLength: job.descByteLength >>> 0,
          blocksByteOffset: job.blocksByteOffset >>> 0,
          blocksByteLength: job.blocksByteLength >>> 0,
          blockEntryBytes: job.blockEntryBytes >>> 0,
        });
      } else if (job.tier === "ppu") {
        worker.postMessage({ type: "compile-ppu", id: job.id, addr: job.key, attr: job.attr, code: job.payload }, [job.payload]);
        state.ppu.sent += 1;
      } else {
        worker.postMessage({ type: "compile", id: job.id, pc: job.key, ls: job.payload }, [job.payload]);
        state.spu.sent += 1;
      }

      const timer = setTimeout(() => {
        inFlight.delete(worker);
        if (!isRecomp) state[job.tier].stuck += 1;
        fail(job, `no answer within ${timeoutForJob} ms; compiler worker replaced`);
        log(`LLVM compiler pool: ${job.tier} job did not answer within ${timeoutForJob} ms; replacing worker`);
        worker.terminate();
        const at = pool.indexOf(worker);
        if (at >= 0) pool.splice(at, 1);
        spawn(pool.length).catch((error) => log(`LLVM compiler pool: ${error}`));
      }, timeoutForJob);
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
      if (data.type === "recomp-lifted") {
        answerRecompLifted(flight.job, data);
        idle.push(worker);
      } else if (data.type === "recomp-shard-compiled") {
        answerRecompShard(flight.job, data);
        idle.push(worker);
      } else if (data.type === "compiled") {
        answer(flight.job, data);
        idle.push(worker);
      } else {
        const errStr = String(data.error ?? data.type ?? "");
        fail(flight.job, errStr);
        if (/RuntimeError|Aborted|bad_alloc|unreachable|out of bounds/i.test(errStr)) {
          log(`LLVM compiler pool: respawning worker after Wasm trap (${errStr.slice(0, 120)})`);
          worker.terminate();
          const at = pool.indexOf(worker);
          if (at >= 0) pool.splice(at, 1);
          state.workers = Math.max(0, state.workers - 1);
          spawn(pool.length).catch((err) => log(`LLVM compiler pool respawn error: ${err}`));
        } else {
          idle.push(worker);
        }
      }
      dispatch();
    };
    worker.onerror = (event) => {
      const flight = inFlight.get(worker);
      if (flight) { clearTimeout(flight.timer); inFlight.delete(worker); fail(flight.job, `worker error: ${event.message}`); }
      reject(new Error(`LLVM compiler worker ${i}: ${event.message}`));
    };
    worker.postMessage({ type: "init", moduleUrl, ppuReturnDispatch, ppuInlineReads, ppuInlineWrites, spuPortableCalls, wasmRegions });
  });
  const resolvedFwIndexUrl = new URL(firmwareWasmIndexUrl ?? "../firmware-wasm/index.json", moduleUrl || import.meta.url).href;
  const loadFirmwareWasmIndex = async () => {
    try {
      const resp = await fetch(resolvedFwIndexUrl);
      if (!resp.ok) return null;
      const json = await resp.json();
      return json && typeof json.modules === "object" ? json : null;
    } catch {
      return null;
    }
  };
  const firmwarePartCache = new Map();
  const loadFirmwarePart = async (partFile) => {
    let entry = firmwarePartCache.get(partFile);
    if (entry) return entry;
    const partUrl = new URL(partFile, resolvedFwIndexUrl).href;
    const resp = await fetch(partUrl);
    if (!resp.ok) throw new Error(`fetch ${partFile} returned ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const wasm = new WebAssembly.Module(bytes);
    const info = dylinkInfo(wasm);
    const importsTable = WebAssembly.Module.imports(wasm).some((imp) => imp.kind === "table");
    const relPairs = extractShardGuestRelPairs(wasm, info);
    entry = { wasm, bytes, info, importsTable, relPairs };
    firmwarePartCache.set(partFile, entry);
    return entry;
  };

  const [db, firmwareIndex] = await Promise.all([
    warmMemoryCacheFromIdb(),
    loadFirmwareWasmIndex(),
    ...Array.from({ length: workers }, (_, i) => spawn(i)),
  ]);
  cacheDb = db;
  const fwCount = firmwareIndex?.modules ? Object.keys(firmwareIndex.modules).length : 0;
  log(`LLVM compiler pool: ${state.workers} compiler workers ready (${[autoRecomp ? "RECOMP" : null, spu ? "SPU" : null, ppu ? "PPU" : null].filter(Boolean).join(" + ") || "idle"}, ${memoryModuleCache.size} cached entries, ${fwCount} precompiled firmware .wasm libraries)`);

  const linkFirmwareWasmModule = async ({ name, sha1, seg0, recompKey, fwEntry, fallbackPs3rBytes }) => {
    const t0 = performance.now();
    try {
      const parts = await Promise.all((fwEntry.parts ?? []).map((p) => loadFirmwarePart(p.file)));
      let regBlocks = 0;
      let regBytes = 0;
      for (const part of parts) {
        const relocatedPairs = new Uint32Array(part.relPairs.length);
        for (let i = 0; i < part.relPairs.length; i += 2) {
          relocatedPairs[i] = (part.relPairs[i] + seg0) >>> 0;
          relocatedPairs[i + 1] = part.relPairs[i + 1] >>> 0;
        }
        registerRecompShard({
          wasm: part.wasm,
          bytes: part.bytes,
          info: part.info,
          importsTable: part.importsTable,
          pairs: relocatedPairs,
        }, seg0);
        regBlocks += relocatedPairs.length >>> 1;
        regBytes += part.bytes.byteLength >>> 0;
      }
      recompState.modulesCompiled += 1;
      recompState.firmwareLinked += 1;
      recompState.shardsCompiled += parts.length;
      recompState.blocksRegistered += regBlocks;
      recompState.hleCallsLowered += fwEntry.hleCalls >>> 0;
      recompState.bytes += regBytes;
      log(`FIRMWARE-WASM linked '${name}' at seg0=0x${seg0.toString(16)}: ${regBlocks} blocks in ${parts.length} shared .wasm assemblies (${(regBytes / 1024).toFixed(1)} KiB, ${(performance.now() - t0).toFixed(1)} ms)`);
      module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [1]);
    } catch (err) {
      log(`FIRMWARE-WASM link fallback to live recomp for '${name}': ${err}`);
      state.queue.unshift({
        id: ++recompJobSeq,
        tier: "recomp-lift",
        name,
        sha1,
        seg0,
        recompKey,
        maxBlocksPerShard: recompMaxBlocksPerShard,
        input: fallbackPs3rBytes.buffer,
        startedAt: performance.now(),
      });
      dispatch();
    }
  };

  const pump = () => {
    if (autoRecomp && typeof module._rpcs3_web_recomp_poll === "function") {
      if (module._rpcs3_web_recomp_poll() >= 0) {
        const ptr = module._rpcs3_web_recomp_slot_data() >>> 0;
        const sz = module._rpcs3_web_recomp_slot_size() >>> 0;
        const name = module.ccall("rpcs3_web_recomp_slot_name", "string", [], []) || "module";
        const sha1 = module.ccall("rpcs3_web_recomp_slot_sha1", "string", [], []) || "0";
        const seg0 = module._rpcs3_web_recomp_slot_seg0() >>> 0;
        const isFirmware = typeof module._rpcs3_web_recomp_slot_is_firmware === "function"
          ? (module._rpcs3_web_recomp_slot_is_firmware() >>> 0)
          : 0;
      // Bump the namespace when the compiler artifact format or lowering changes
      // independently of the runtime policy exposed through ppuPolicyTag.
      const recompKey = `recomp-v17:${sha1}:0x${seg0.toString(16)}:${ppuPolicyTag}`;
        recompState.modulesRequested += 1;

        const cached = lookupCachedEntry(recompKey);
        if (cached && cached.recompBundle === true && Array.isArray(cached.parts) && cached.parts.length > 0) {
          try {
            let regBlocks = 0;
            let regHle = 0;
            let regRegions = 0;
            let regBytes = 0;
            for (const part of cached.parts) {
              registerRecompShard(part, seg0);
              regBlocks += part.pairs.length >>> 1;
              regHle += part.hleCalls >>> 0;
              regRegions += part.regionLinks >>> 0;
              regBytes += part.bytes.byteLength >>> 0;
            }
            const numShards = cached.parts.length;
            memoryModuleCache.delete(recompKey);
            cached.parts.length = 0;
            recompState.modulesCompiled += 1;
            recompState.modulesCached += 1;
            if (isFirmware) recompState.firmwareLinked += 1;
            recompState.shardsCompiled += numShards;
            recompState.blocksRegistered += regBlocks;
            recompState.hleCallsLowered += regHle;
            recompState.regionLinks += regRegions;
            recompState.bytes += regBytes;
            log(`RECOMP cache-hit '${name}' (seg0=0x${seg0.toString(16)}): ${regBlocks} blocks, ${regHle} HLE calls in ${numShards} shards`);
            module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [1]);
          } catch (err) {
            log(`RECOMP cache-hit registration failed for '${name}', recompiling: ${err}`);
            const ps3rBytes = heap().slice(ptr, ptr + sz);
            state.queue.unshift({
              id: ++recompJobSeq,
              tier: "recomp-lift",
              name,
              sha1,
              seg0,
              isFirmware: Boolean(isFirmware),
              recompKey,
              maxBlocksPerShard: recompMaxBlocksPerShard,
              input: ps3rBytes.buffer,
              startedAt: performance.now(),
            });
          }
        } else {
          const fwEntry = isFirmware && firmwareIndex?.modules ? firmwareIndex.modules[name] : null;
          if (fwEntry && Array.isArray(fwEntry.parts) && fwEntry.parts.length > 0) {
            const fallbackPs3rBytes = sz > 0 ? heap().slice(ptr, ptr + sz) : new Uint8Array(0);
            linkFirmwareWasmModule({ name, sha1, seg0, recompKey, fwEntry, fallbackPs3rBytes });
          } else if (sz > 0) {
            const ps3rBytes = heap().slice(ptr, ptr + sz);
            state.queue.unshift({
              id: ++recompJobSeq,
              tier: "recomp-lift",
              name,
              sha1,
              seg0,
              isFirmware: Boolean(isFirmware),
              recompKey,
              maxBlocksPerShard: recompMaxBlocksPerShard,
              input: ps3rBytes.buffer,
              startedAt: performance.now(),
            });
          } else {
            module.ccall("rpcs3_web_recomp_slot_finish", null, ["number"], [0]);
          }
        }
      }
    }
    if (spu) {
      for (;;) {
        const slot = module._rpcs3_web_spu_llvm_poll();
        if (slot < 0) break;
        const pointer = module._rpcs3_web_spu_llvm_slot_ls(slot) >>> 0;
        const pc = module._rpcs3_web_spu_llvm_slot_pc(slot) >>> 0;
        const lsSlice = heap().slice(pointer, pointer + 262144);
        const payload = lsSlice.buffer;
        try {
          const lsWords = new Uint32Array(65536);
          const lsView = new DataView(lsSlice.buffer, lsSlice.byteOffset, lsSlice.byteLength);
          for (let i = 0; i < 65536; i++) {
            lsWords[i] = lsView.getUint32(i << 2, false);
          }
          spuWgsl.compileBlock(pc, lsWords);
        } catch {}
        state.spu.requested += 1;
        state.queue.push({ id: state.spu.requested, tier: "spu", slot, key: pc, payload });
      }
    }
    if (ppu) {
      for (;;) {
        const slot = module._rpcs3_web_ppu_llvm_poll();
        if (slot < 0) break;
        const pointer = module._rpcs3_web_ppu_llvm_slot_code(slot) >>> 0;
        const size = module._rpcs3_web_ppu_llvm_slot_size(slot) >>> 0;
        const addr = module._rpcs3_web_ppu_llvm_slot_addr(slot) >>> 0;
        const attr = module._rpcs3_web_ppu_llvm_slot_attr(slot) >>> 0;
        const payload = heap().slice(pointer, pointer + size).buffer;
        state.ppu.requested += 1;
        state.queue.push({ id: state.ppu.requested, tier: "ppu", slot, key: addr, attr, payload });
      }
    }
    dispatch();
  };
  const timer = setInterval(pump, pumpIntervalMs);

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
    requested: tier.requested, sent: tier.sent, compiled: tier.compiled, cached: tier.cached, failed: tier.failed,
    stuck: tier.stuck, bytes: tier.bytes, words: tier.words, errors: tier.errors,
  });

  return {
    pump,
    drain,
    stats: () => ({
      workers: state.workers, queued: state.queue.length,
      policy: { ppuInlineReads, ppuInlineWrites, ppuReturnDispatch, wasmRegions, autoRecomp, moduleUrl },
      compileMs: Math.round(state.compileMs), maxCompileMs: Math.round(state.maxCompileMs),
      peakHeapBytes: state.peakHeapBytes,
      ...tierStats(state.spu),
      spu: tierStats(state.spu),
      spuWgsl: spuWgsl.getStats(),
      ppu: tierStats(state.ppu),
      recomp: { ...recompState, liftMs: Math.round(recompState.liftMs), compileMs: Math.round(recompState.compileMs) },
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

export function createSpuLlvmPool(options) {
  return createLlvmCompilerPool({ ...options, spu: true, ppu: false });
}
