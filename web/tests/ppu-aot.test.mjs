import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PPU LLVM WebAssembly AOT pipeline", () => {
  it("emits an instantiable shared-memory wasm32 module", () => {
    const scratch = mkdtempSync(join(tmpdir(), "rpcs3-ppu-aot-test-"));
    try {
      const input = join(scratch, "block.ll");
      const output = join(scratch, "block.wasm");
      writeFileSync(input, `
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128"
target triple = "wasm32-unknown-unknown"

define void @__0x10000(ptr %context) {
entry:
  %state = getelementptr i8, ptr %context, i32 20
  %old = atomicrmw or ptr %state, i32 4 acq_rel, align 4
  ret void
}
`);
      const report = JSON.parse(execFileSync(process.execPath, [
        "scripts/compile-ppu-ir-to-wasm.mjs",
        input,
        output,
        "--export=__0x10000",
      ], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
      expect(report.exports).toContainEqual({ name: "__0x10000", kind: "function" });

      const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
      const module = new WebAssembly.Module(readFileSync(output));
      const instance = new WebAssembly.Instance(module, { env: { memory } });
      instance.exports.__0x10000(4096);
      expect(new Uint32Array(memory.buffer, 4096 + 20, 1)[0]).toBe(4);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
