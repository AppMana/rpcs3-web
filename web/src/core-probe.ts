import type { CoreProbeResult } from "./types";

type ProbeModule = {
  _rpcs3_web_probe_abi_version(): number;
  _rpcs3_web_probe_memory(): number;
  _rpcs3_web_probe_mapped_pages(): number;
  _rpcs3_web_probe_resident_pages(): number;
  _rpcs3_web_probe_ppu(): number;
  _rpcs3_web_probe_ppu_steps(): number;
  _rpcs3_web_probe_ppu_result(): number;
  _rpcs3_web_probe_ppu_loaded(): number;
  _rpcs3_web_probe_ppu_supported_opcodes(): number;
};

type ProbeFactory = (options?: Record<string, unknown>) => Promise<ProbeModule>;

export async function runCoreProbe(): Promise<CoreProbeResult> {
  const url = `${import.meta.env.BASE_URL}core/rpcs3-web-probe.mjs`;
  try {
    const imported = await import(/* @vite-ignore */ url) as { default?: ProbeFactory };
    if (typeof imported.default !== "function") {
      return { loaded: false, detail: "probe module has no default factory" };
    }
    const module = await imported.default({ locateFile: (name: string) => `${import.meta.env.BASE_URL}core/${name}` });
    const memoryTestMask = module._rpcs3_web_probe_memory();
    const ppuTestMask = module._rpcs3_web_probe_ppu();
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
      detail: memoryTestMask === 0 && ppuTestMask === 0
        ? "sparse memory and PPU execution passed"
        : `test masks memory=0x${memoryTestMask.toString(16)} ppu=0x${ppuTestMask.toString(16)}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { loaded: false, detail: `optional core artifact unavailable: ${detail}` };
  }
}
