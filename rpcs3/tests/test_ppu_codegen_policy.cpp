#include <gtest/gtest.h>

#include "Emu/Cell/PPUOpcodes.h"
#include "Emu/Cell/PPUWasmDispatch.h"
#include "Utilities/PPUCodegenPolicy.h"

TEST(PpuCodegenPolicy, NativeJitDefaultsToO3AndAllowsInterpretedDebugFallback)
{
	ppu_codegen_policy policy;
	policy.backend = ppu_backend_kind::jit;
	policy.target = ppu_target_kind::native;
	policy.optimization = ppu_llvm_optimization::o3;
	policy.fail_closed = false;

	EXPECT_STREQ(ppu_codegen_policy::backend_name(policy.backend), "jit");
	EXPECT_STREQ(ppu_codegen_policy::target_name(policy.target), "x86_64");
	EXPECT_EQ(policy.cache_tag(), "o3");
	EXPECT_EQ(ppu_codegen_policy::optimization_number(policy.optimization), 3u);
	EXPECT_FALSE(policy.fail_closed);
}

TEST(PpuCodegenPolicy, AotPolicyIsFailClosedAndCacheVersioned)
{
	const ppu_codegen_policy policy = make_ppu_codegen_policy(ppu_backend_kind::aot, ppu_target_kind::wasm);

	EXPECT_EQ(policy.target, ppu_target_kind::wasm);
	EXPECT_TRUE(policy.fail_closed);
	EXPECT_EQ(ppu_codegen_policy::semantics_version, 23u);
	EXPECT_EQ(ppu_codegen_policy::cache_schema, "ppu-codegen-v2");
	EXPECT_EQ(sizeof(ppu_wasm_dispatch_context), 24u);
	EXPECT_EQ(offsetof(ppu_wasm_dispatch_context, gpr11_write_pc), 16u);
	EXPECT_EQ(offsetof(ppu_wasm_dispatch_context, gpr11_write_value), 20u);
}

TEST(PpuCodegenPolicy, MoveAliasEncodingPreservesOrSourceSemantics)
{
	const ppu_opcode_t op{0x7c691b78};

	EXPECT_EQ(static_cast<u32>(op.ra), 9u);
	EXPECT_EQ(static_cast<u32>(op.rs), 3u);
	EXPECT_EQ(static_cast<u32>(op.rb), 3u);
	EXPECT_TRUE(ppu_or_is_move(op));

	const u64 source = 0x1234'5678'9abc'def0;
	const u64 result = ppu_or_is_move(op) ? source : (source | source);
	EXPECT_EQ(result, source);
}
