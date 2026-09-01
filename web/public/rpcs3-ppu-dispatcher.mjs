const boundary = Object.freeze({ syscall: Symbol("syscall"), guestBlock: Symbol("guest-block") });

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

export function createPpuDispatcher({ module, mainExports, mainMemory, aotModule, entryReadyAddress }) {
  if (!(aotModule instanceof WebAssembly.Module)) throw new TypeError("aotModule must be a WebAssembly.Module");
  if (!(mainMemory instanceof WebAssembly.Memory)) throw new TypeError("mainMemory must be RPCS3's WebAssembly.Memory");

  const allocationSize = 512 * 1024;
  const allocation = module._malloc(allocationSize + 15);
  const memoryBase = (allocation + 15) & ~15;
  let activeContext = 0;
  let pendingBoundary = null;
  let context = 0;
  let released = false;
  const counters = {
    batches: 0,
    blocks: 0,
    compiledBlocks: 0,
    interpreterSteps: 0,
    syscallBoundaries: 0,
    missingBlocks: 0,
    guestBlockBoundaries: 0,
    reservationLoads: 0,
    reservationStores: 0,
  };

  const setBoundary = (kind, pc) => {
    if (!activeContext) throw new Error("PPU boundary import called outside an active RPCS3 slice");
    if (pc !== undefined && !mainExports.rpcs3_web_ppu_aot_set_pc(activeContext, pc >>> 0)) {
      throw new Error(`RPCS3 rejected boundary PC 0x${(pc >>> 0).toString(16)}`);
    }
    pendingBoundary = kind;
    throw kind;
  };
  const env = {
    memory: mainMemory,
    __stack_pointer: new WebAssembly.Global(
      { value: "i32", mutable: true },
      memoryBase + allocationSize,
    ),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    __check: (thread, pc) => mainExports.rpcs3_web_ppu_aot_check(thread >>> 0, Number(pc) >>> 0),
    __get_tb: () => mainExports.rpcs3_web_ppu_aot_timebase(),
    __lwarx: (thread, address) => {
      counters.reservationLoads += 1;
      return mainExports.rpcs3_web_ppu_aot_lwarx(thread >>> 0, address);
    },
    __ldarx: (thread, address) => {
      counters.reservationLoads += 1;
      return mainExports.rpcs3_web_ppu_aot_ldarx(thread >>> 0, address);
    },
    __stwcx: (thread, address, value) => {
      counters.reservationStores += 1;
      return Boolean(mainExports.rpcs3_web_ppu_aot_stwcx(thread >>> 0, address, value >>> 0));
    },
    __stdcx: (thread, address, value) => {
      counters.reservationStores += 1;
      return Boolean(mainExports.rpcs3_web_ppu_aot_stdcx(thread >>> 0, address, value));
    },
  };

  for (const imported of WebAssembly.Module.imports(aotModule)) {
    if (imported.module !== "env") {
      throw new Error(`unsupported PPU AOT import module ${imported.module}.${imported.name}`);
    }
    if (imported.kind !== "function" || imported.name in env) continue;
    if (imported.name.startsWith("rpcs3_web_vm_") && typeof mainExports[imported.name] === "function") {
      env[imported.name] = mainExports[imported.name];
    } else if (/^(sys_|syscall_|__syscall)/.test(imported.name)) {
      env[imported.name] = () => setBoundary(boundary.syscall);
    } else if (/^__0x[0-9a-f]+$/i.test(imported.name)) {
      const pc = Number.parseInt(imported.name.slice(4), 16) >>> 0;
      env[imported.name] = () => setBoundary(boundary.guestBlock, pc);
    } else {
      throw new Error(`unsupported PPU AOT function import env.${imported.name}`);
    }
  }

  const aotInstance = new WebAssembly.Instance(aotModule, { env });
  const acquire = () => {
    if (released) throw new Error("PPU dispatcher has been released");
    if (!context && !Atomics.load(new Uint32Array(mainMemory.buffer), entryReadyAddress >>> 2)) return 0;
    context ||= mainExports.rpcs3_web_ppu_aot_acquire_main() >>> 0;
    return context;
  };
  const interpreterStep = () => {
    counters.interpreterSteps += 1;
    return mainExports.rpcs3_web_ppu_aot_interpreter_step(context) >>> 0;
  };

  const runBatch = (maximumBlocks = 256) => {
    if (!acquire()) return { ...counters, context: 0, pc: 0 };
    counters.batches += 1;
    for (let index = 0; index < maximumBlocks; index += 1) {
      const pc = mainExports.rpcs3_web_ppu_aot_pc(context) >>> 0;
      if (!pc) break;
      const fn = aotInstance.exports[`__0x${pc.toString(16)}`];
      counters.blocks += 1;
      if (typeof fn !== "function") {
        counters.missingBlocks += 1;
        interpreterStep();
        continue;
      }

      if (!mainExports.rpcs3_web_ppu_aot_begin(context)) {
        throw new Error(`RPCS3 rejected PPU AOT slice at 0x${pc.toString(16)}`);
      }
      pendingBoundary = null;
      activeContext = context;
      try {
        fn(
          0,
          context,
          0n,
          0,
          mainExports.rpcs3_web_ppu_aot_gpr(context, 0),
          mainExports.rpcs3_web_ppu_aot_gpr(context, 1),
          mainExports.rpcs3_web_ppu_aot_gpr(context, 2),
        );
        counters.compiledBlocks += 1;
      } catch (error) {
        if (error !== boundary.syscall && error !== boundary.guestBlock) throw error;
      } finally {
        activeContext = 0;
        mainExports.rpcs3_web_ppu_aot_end(context);
      }
      if (pendingBoundary) {
        counters[pendingBoundary === boundary.syscall ? "syscallBoundaries" : "guestBlockBoundaries"] += 1;
        interpreterStep();
      }
    }
    return {
      ...counters,
      context,
      pc: mainExports.rpcs3_web_ppu_aot_pc(context) >>> 0,
      state: mainExports.rpcs3_web_ppu_aot_state(context) >>> 0,
    };
  };

  return {
    instance: aotInstance,
    runBatch,
    taskYield,
    snapshot: () => ({ ...counters, context, pc: context ? mainExports.rpcs3_web_ppu_aot_pc(context) >>> 0 : 0 }),
    release() {
      if (released) return;
      if (context) mainExports.rpcs3_web_ppu_aot_release(context);
      module._free(allocation);
      released = true;
    },
  };
}
