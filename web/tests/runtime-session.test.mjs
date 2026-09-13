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
});
