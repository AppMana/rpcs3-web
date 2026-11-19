#pragma once

#include "ModuleDescriptor.h"
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace llvm
{
	class Module;
}

class jit_compiler;

namespace ps3recomp
{
	enum class LiftFrontend
	{
		LlvmIr,
		GhidraCpp,
	};

	struct BlockPlanEntry
	{
		uint32_t addr = 0;          // guest basic-block address
		uint32_t toc = 0;
		uint32_t size = 0;          // guest basic-block byte size
		uint32_t function_addr = 0; // owning function entry, or addr for a standalone block
		uint32_t function_size = 0; // whole function byte span, including all blocks
	};

	struct LiftOptions
	{
		LiftFrontend frontend = LiftFrontend::LlvmIr;
		uint32_t max_blocks_per_shard = 2048;
		bool recover_jump_tables = true;
		bool return_to_dispatcher = false;
		bool ghidra_decomp_comments = false;
		std::string ghidra_home;
		std::vector<std::pair<uint32_t, uint32_t>> ranges;
	};

	struct PlannedFunctionInfo
	{
		uint32_t addr = 0;
		uint32_t toc = 0;
		uint32_t size = 0;
		uint32_t blocks = 0;
	};

	struct PlanDiagnostics
	{
		uint32_t merged_functions = 0;
		struct MergeInfo
		{
			uint32_t addr = 0;
			uint32_t size = 0;
			uint32_t members = 0;
		};
		std::vector<MergeInfo> merge_groups;
		std::vector<PlannedFunctionInfo> analyzer_functions;
		std::vector<PlannedFunctionInfo> compile_functions;
	};

	struct LiftedShard
	{
		std::string shard_name;
		std::string symbol_suffix;
		LiftFrontend frontend = LiftFrontend::LlvmIr;
		std::string text; // .ll (LlvmIr) or .cpp (GhidraCpp)
		std::vector<uint32_t> block_addrs;
	};

	struct LiftResult
	{
		std::vector<LiftedShard> ppu_shards;
		uint32_t total_blocks = 0;
		uint32_t jump_table_splits = 0;
	};

	// Fast whole-binary PPU block discovery + JumpTable/OPD/stub splitting (<0.5s, <30 MiB RAM).
	bool plan_module_blocks(
		ModuleDescriptor& desc,
		const LiftOptions& opts,
		std::vector<BlockPlanEntry>& out_blocks,
		std::string& out_clean_mod,
		uint32_t& out_splits,
		std::string& err,
		PlanDiagnostics* diagnostics = nullptr);

	// Lift a single planned shard [pos, end_pos) directly into an in-memory llvm::Module (zero ASCII IR).
	bool lift_planned_shard_to_llvm(
		const ModuleDescriptor& desc,
		std::span<const BlockPlanEntry> all_blocks,
		size_t pos,
		size_t end_pos,
		const std::string& suffix,
		bool return_to_dispatcher,
		jit_compiler& jit,
		std::unique_ptr<llvm::Module>& out_mod,
		std::vector<uint32_t>& out_emitted_addrs,
		std::string& err);

	// Stage 1B: Lift 100% of a ModuleDescriptor's PPU code into sharded LLVM IR or Ghidra C++20.
	bool lift_module(
		ModuleDescriptor& desc,
		const LiftOptions& opts,
		LiftResult& out,
		std::string& err);
}
