const boundary = Object.freeze({ dispatch: Symbol("dispatch"), escape: Symbol("escape"), patchpoint: Symbol("patchpoint") });

function taskYield() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export function createSpuDispatcher({ module, mainExports, mainMemory, aotModules }) {
  if (!(mainMemory instanceof WebAssembly.Memory)) throw new TypeError("mainMemory must be RPCS3's WebAssembly.Memory");
  if (!Array.isArray(aotModules) || aotModules.some((item) => !(item instanceof WebAssembly.Module))) {
    throw new TypeError("aotModules must contain WebAssembly.Module instances");
  }

  const allocationSize = Math.max(64 * 1024, aotModules.length * 64 * 1024);
  const allocation = module._malloc(allocationSize + 15);
  const memoryBase = (allocation + 15) & ~15;
  let activeBoundary = null;
  let released = false;
  const entries = new Map();
  const counters = {
    batches: 0,
    blocks: 0,
    compiledBlocks: 0,
    interpreterSteps: 0,
    dispatchBoundaries: 0,
    escapeBoundaries: 0,
    patchpointBoundaries: 0,
    readyMask: 0,
    pcs: Array(6).fill(0),
  };

  const stop = (kind) => {
    activeBoundary = kind;
    throw kind;
  };

  for (const [moduleIndex, aotModule] of aotModules.entries()) {
    const env = {
      memory: mainMemory,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase + moduleIndex * 64 * 1024),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      spu_dispatch: () => stop(boundary.dispatch),
      spu_escape: () => stop(boundary.escape),
    };
    for (const imported of WebAssembly.Module.imports(aotModule)) {
      if (imported.module !== "env") {
        throw new Error(`unsupported SPU AOT import module ${imported.module}.${imported.name}`);
      }
      if (imported.kind !== "function" || imported.name in env) continue;
      if (/^__spu-0x[0-9a-f]+-.+-(?:pp|chunkpp)-/i.test(imported.name)) {
        env[imported.name] = () => stop(boundary.patchpoint);
      } else {
        throw new Error(`unsupported SPU AOT function import env.${imported.name}`);
      }
    }
    const instance = new WebAssembly.Instance(aotModule, { env });
    for (const [name, value] of Object.entries(instance.exports)) {
      const match = /^__spu-0x([0-9a-f]+)-/i.exec(name);
      if (match && typeof value === "function") entries.set(Number.parseInt(match[1], 16) >>> 0, value);
    }
  }

  const runBatch = (maximumBlocks = 256) => {
    if (released) throw new Error("SPU dispatcher has been released");
    counters.batches += 1;
    counters.readyMask = mainExports.rpcs3_web_spu_aot_ready_mask() >>> 0;
    let remaining = maximumBlocks;
    while (remaining > 0) {
      let progressed = false;
      for (let index = 0; index < 6 && remaining > 0; index += 1) {
        const slot = 1 << index;
        counters.readyMask = mainExports.rpcs3_web_spu_aot_ready_mask() >>> 0;
        if ((counters.readyMask & slot) === 0) continue;
        const context = mainExports.rpcs3_web_spu_aot_context(index) >>> 0;
        if (!context) continue;

        const pc = mainExports.rpcs3_web_spu_aot_pc(context) >>> 0;
        counters.pcs[index] = pc;
        const fn = entries.get(pc);
        counters.blocks += 1;
        remaining -= 1;
        progressed = true;
        if (!fn) {
          counters.interpreterSteps += 1;
          mainExports.rpcs3_web_spu_aot_step(index);
          continue;
        }

        const localStore = mainExports.rpcs3_web_spu_aot_ls(context) >>> 0;
        activeBoundary = null;
        counters.compiledBlocks += 1;
        try {
          fn(context, localStore, 0n);
        } catch (error) {
          if (!Object.values(boundary).includes(error)) throw error;
        }
        if (activeBoundary === boundary.dispatch) counters.dispatchBoundaries += 1;
        if (activeBoundary === boundary.escape) counters.escapeBoundaries += 1;
        if (activeBoundary === boundary.patchpoint) counters.patchpointBoundaries += 1;
      }
      if (!progressed) break;
    }
    counters.readyMask = mainExports.rpcs3_web_spu_aot_ready_mask() >>> 0;
    return { ...counters, entries: [...entries.keys()] };
  };

  return {
    runBatch,
    taskYield,
    snapshot: () => ({ ...counters, entries: [...entries.keys()] }),
    release() {
      if (released) return;
      mainExports.rpcs3_web_set_spu_aot_handoff(0);
      module._free(allocation);
      released = true;
    },
  };
}
