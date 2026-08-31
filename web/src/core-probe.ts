import type { CoreProbeResult, ElfProbeResult } from "./types";

type ProbeModule = {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _rpcs3_web_probe_abi_version(): number;
  _rpcs3_web_probe_memory(): number;
  _rpcs3_web_probe_mapped_pages(): number;
  _rpcs3_web_probe_resident_pages(): number;
  _rpcs3_web_probe_ppu(): number;
  _rpcs3_web_probe_ppu_steps(): number;
  _rpcs3_web_probe_ppu_result(): number;
  _rpcs3_web_probe_ppu_loaded(): number;
  _rpcs3_web_probe_ppu_supported_opcodes(): number;
  _rpcs3_web_probe_elf(data: number, size: number, instructionLimit: number): number;
  _rpcs3_web_probe_elf_loaded(): number;
  _rpcs3_web_probe_elf_segments(): number;
  _rpcs3_web_probe_elf_entry(): number;
  _rpcs3_web_probe_elf_steps(): number;
  _rpcs3_web_probe_elf_stop_reason(): number;
  _rpcs3_web_probe_elf_pc(): number;
  _rpcs3_web_probe_elf_last_opcode(): number;
  _rpcs3_web_probe_elf_target(): number;
  _rpcs3_web_probe_elf_hle_calls(): number;
  _rpcs3_web_probe_elf_hle_nid(): number;
  _rpcs3_web_probe_elf_syscalls(): number;
  _rpcs3_web_probe_elf_last_syscall(): number;
};

type ProbeFactory = (options?: Record<string, unknown>) => Promise<ProbeModule>;

const stopReasons = ["running", "syscall", "unsupported instruction", "memory fault", "instruction limit", "unresolved indirect/HLE boundary"];

async function runElfProbe(module: ProbeModule): Promise<ElfProbeResult> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}fixtures/ppu_thread.elf`);
    if (!response.ok) return { loaded: false, detail: `fixture fetch returned ${response.status}` };
    const image = new Uint8Array(await response.arrayBuffer());
    const pointer = module._malloc(image.byteLength);
    if (!pointer) return { loaded: false, detail: "Wasm allocation failed" };
    let testMask: number;
    try {
      module.HEAPU8.set(image, pointer);
      testMask = module._rpcs3_web_probe_elf(pointer, image.byteLength, 100_000);
    } finally {
      module._free(pointer);
    }
    const loaded = module._rpcs3_web_probe_elf_loaded() === 1;
    const instructions = module._rpcs3_web_probe_elf_steps();
    const stopReason = module._rpcs3_web_probe_elf_stop_reason();
    const pc = module._rpcs3_web_probe_elf_pc() >>> 0;
    const stoppedAt = stopReason === 1 || stopReason === 2 ? (pc - 4) >>> 0 : pc;
    const lastOpcode = module._rpcs3_web_probe_elf_last_opcode() >>> 0;
    const target = module._rpcs3_web_probe_elf_target() >>> 0;
    const hleCalls = module._rpcs3_web_probe_elf_hle_calls();
    const hleNid = module._rpcs3_web_probe_elf_hle_nid() >>> 0;
    const syscalls = module._rpcs3_web_probe_elf_syscalls();
    const lastSyscall = module._rpcs3_web_probe_elf_last_syscall();
    return {
      loaded,
      testMask,
      segments: module._rpcs3_web_probe_elf_segments(),
      entry: module._rpcs3_web_probe_elf_entry() >>> 0,
      instructions,
      stopReason,
      pc,
      lastOpcode,
      target,
      hleCalls,
      hleNid,
      syscalls,
      lastSyscall,
      detail: loaded
        ? `${instructions} instructions, ${hleCalls} HLE calls / ${syscalls} syscalls; ${stopReasons[stopReason] ?? `stop ${stopReason}`} at 0x${stoppedAt.toString(16)} (opcode 0x${lastOpcode.toString(16)}, target 0x${target.toString(16)})`
        : `ELF load failed with mask 0x${testMask.toString(16)}`,
    };
  } catch (error) {
    return { loaded: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runCoreProbe(): Promise<CoreProbeResult> {
  const coreAsset = "rpcs3-web-probe-v6";
  const url = `${import.meta.env.BASE_URL}core/${coreAsset}.mjs`;
  try {
    const imported = await import(/* @vite-ignore */ url) as { default?: ProbeFactory };
    if (typeof imported.default !== "function") {
      return { loaded: false, detail: "probe module has no default factory" };
    }
    const module = await imported.default({ locateFile: (name: string) => `${import.meta.env.BASE_URL}core/${name}` });
    const memoryTestMask = module._rpcs3_web_probe_memory();
    const ppuTestMask = module._rpcs3_web_probe_ppu();
    const elfProbe = await runElfProbe(module);
    return {
      loaded: true,
      abiVersion: module._rpcs3_web_probe_abi_version(),
      memoryTestMask,
      mappedPages: module._rpcs3_web_probe_mapped_pages(),
      residentPages: module._rpcs3_web_probe_resident_pages(),
      ppuTestMask,
      ppuInstructions: module._rpcs3_web_probe_ppu_steps(),
      ppuResult: module._rpcs3_web_probe_ppu_result(),
      ppuLoadedResult: module._rpcs3_web_probe_ppu_loaded(),
      ppuSupportedOpcodes: module._rpcs3_web_probe_ppu_supported_opcodes(),
      elfProbe,
      detail: memoryTestMask === 0 && ppuTestMask === 0
        ? "sparse memory and PPU execution passed"
        : `test masks memory=0x${memoryTestMask.toString(16)} ppu=0x${ppuTestMask.toString(16)}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { loaded: false, detail: `optional core artifact unavailable: ${detail}` };
  }
}
