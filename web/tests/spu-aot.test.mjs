import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSpuDispatcher } from "../public/rpcs3-spu-dispatcher.mjs";

describe("SPU LLVM WebAssembly AOT dispatch", () => {
  it("runs a translated block and resumes at its RPCS3 patchpoint", () => {
    const scratch = mkdtempSync(join(tmpdir(), "rpcs3-spu-aot-test-"));
    try {
      const input = join(scratch, "block.ll");
      const output = join(scratch, "block.wasm");
      writeFileSync(input, `
target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128"
target triple = "wasm32-unknown-unknown"

declare void @"__spu-0x00350-test-pp-0"(ptr, ptr, i32)

define void @"__spu-0x00350-test"(ptr %context, ptr %local_store, i64 %arg) {
entry:
  %pc = getelementptr i8, ptr %context, i32 24
  store volatile i32 852, ptr %pc, align 4
  call void @"__spu-0x00350-test-pp-0"(ptr %context, ptr %local_store, i32 0)
  ret void
}
`);
      execFileSync(process.execPath, [
        "scripts/compile-ppu-ir-to-wasm.mjs",
        input,
        output,
        "--pic",
        "--export-all",
      ], { cwd: new URL("..", import.meta.url), stdio: "ignore" });

      const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
      const context = 0x1000;
      const localStore = 0x10000;
      const words = new Uint32Array(memory.buffer);
      words[(context + 24) >>> 2] = 0x350;
      let readyMask = 1;
      let freed = 0;
      const mainExports = {
        rpcs3_web_spu_aot_ready_mask: () => readyMask,
        rpcs3_web_spu_aot_context: (index) => index === 0 ? context : 0,
        rpcs3_web_spu_aot_pc: () => words[(context + 24) >>> 2],
        rpcs3_web_spu_aot_ls: () => localStore,
        rpcs3_web_spu_aot_step: () => {
          words[(context + 24) >>> 2] += 4;
          return words[(context + 24) >>> 2];
        },
        rpcs3_web_set_spu_aot_handoff: () => { readyMask = 0; },
      };
      const dispatcher = createSpuDispatcher({
        module: { _malloc: () => 0x400000, _free: (pointer) => { freed = pointer; } },
        mainExports,
        mainMemory: memory,
        aotModules: [new WebAssembly.Module(readFileSync(output))],
      });

      const compiled = dispatcher.runBatch(1);
      expect(compiled.compiledBlocks).toBe(1);
      expect(compiled.patchpointBoundaries).toBe(1);
      expect(words[(context + 24) >>> 2]).toBe(0x354);

      const fallback = dispatcher.runBatch(1);
      expect(fallback.interpreterSteps).toBe(1);
      expect(words[(context + 24) >>> 2]).toBe(0x358);
      dispatcher.release();
      expect(readyMask).toBe(0);
      expect(freed).toBe(0x400000);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
