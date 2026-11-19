import { describe, expect, it } from "vitest";
import { decompilePpuIrToCpp } from "../scripts/decompile-ppu-to-cpp.mjs";

describe("decompilePpuIrToCpp", () => {
  it("lifts PPU LLVM IR functions into C++20 with inline page-table memory helpers and direct syscalls", () => {
    const sampleIr = `
define dso_local void @__0x10200(ptr %0, ptr %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6) {
entry:
  %7 = getelementptr inbounds i8, ptr %1, i32 48
  %8 = load i64, ptr %7, align 8
  %9 = trunc i64 %8 to i32
  %10 = call i32 @rpcs3_web_vm_read32_raw(i32 %9)
  %11 = call i32 @llvm.bswap.i32(i32 %10)
  %12 = add i32 %11, 1
  %13 = call i32 @llvm.bswap.i32(i32 %12)
  call void @rpcs3_web_vm_write32_raw(i32 %9, i32 %13)
  call void @__syscall(ptr %1, i64 988)
  ret void
}
`;
    const result = decompilePpuIrToCpp(sampleIr);
    expect(result.functionCount).toBe(1);
    expect(result.functions).toEqual(["__0x10200"]);
    expect(result.cpp).toContain("extern \"C\" void __0x10200(");
    expect(result.cpp).toContain("rpcs3_decompiled::vm_read_fast<uint32_t>(v_9, rpcs3_web_vm_read32_raw)");
    expect(result.cpp).toContain("__builtin_bswap32");
    expect(result.cpp).toContain("rpcs3_decompiled::vm_write_fast<uint32_t>(v_9, v_13, rpcs3_web_vm_write32_raw)");
    expect(result.cpp).toContain("__syscall(v_1, 988ULL);");
    expect(result.cpp).toContain("0x10200u");
  });
});
