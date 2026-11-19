import { afterEach, expect, it, vi } from "vitest";
import { runtimeOptions } from "../public/rpcs3-runtime-session.mjs";

afterEach(() => vi.unstubAllGlobals());
it("preserves an explicit disabled bundle while supplying the other title default", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ titles: [
    { disc: "/opfs/game.iso", ppu: "ppu.json", spu: "spu.json" },
  ] }) })));
  const options = await runtimeOptions("/opfs/game.iso", { suspending: false, ppuAotBundle: null });
  expect(options.ppuAotBundle).toBeNull();
  expect(options.spuAotBundle).toBe("spu.json");
  expect(options.ppuBackend).toBe("aot");
  expect(options.ppuFailClosed).toBe(true);
  expect(options.ppuJit).toBe(false);
  expect(options.autoRecomp).toBe(true);
});

it("allows an explicit native-JIT comparison backend", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const options = await runtimeOptions("/opfs/game.iso", {
    suspending: false,
    ppuBackend: "jit",
    ppuFailClosed: false,
    ppuJit: true,
    autoRecomp: false,
  });
  expect(options.ppuBackend).toBe("jit");
  expect(options.ppuFailClosed).toBe(false);
  expect(options.ppuJit).toBe(true);
  expect(options.autoRecomp).toBe(false);
});
