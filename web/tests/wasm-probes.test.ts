import { describe, expect, it } from "vitest";
import { answerModule, memory64Module, runDynamicWasmProbe, supportsMemory64 } from "../src/wasm-probes";

describe("WebAssembly feature probes", () => {
  it("executes a runtime-compiled module", async () => {
    expect(WebAssembly.validate(answerModule)).toBe(true);
    await expect(runDynamicWasmProbe()).resolves.toBe(42);
  });

  it("uses a structurally valid memory64 feature probe", () => {
    expect(memory64Module.slice(0, 4)).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
    expect(typeof supportsMemory64()).toBe("boolean");
  });
});
