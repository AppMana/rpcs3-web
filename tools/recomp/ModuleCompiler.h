#pragma once

#include "ModuleDescriptor.h"
#include "ModuleLifter.h"
#include <cstdint>
#include <string>
#include <vector>

namespace ps3recomp
{
	struct CompileOptions
	{
		bool form_regions = true;
		bool inline_reads = true;
		bool inline_writes = false;
		bool unary_swizzles = true;
		bool optimize_ir = true;
	};

	struct CompiledPart
	{
		std::string shard_name;
		std::string filename;
		std::vector<uint8_t> wasm_bytes;
		uint32_t block_count = 0;
		uint32_t hle_stub_calls_lowered = 0;
		uint32_t jump_tables_lowered = 0;
		uint32_t region_linked_calls = 0;
	};

	struct CompileResult
	{
		std::vector<CompiledPart> parts;
		std::string manifest_json;
		uint32_t total_blocks = 0;
		uint32_t total_hle_calls = 0;
		uint32_t total_jump_tables = 0;
		uint32_t total_region_links = 0;
	};

	// Stage 2 (In-Memory Fast Path): Lower an already-lifted llvm::Module + ModuleDescriptor HLE stubs & jump tables
	// directly to a shared PIC .wasm module in memory without ASCII IR serialization.
	bool compile_llvm_module_to_wasm(
		const ModuleDescriptor& desc,
		llvm::Module& mod,
		const std::string& symbol_suffix,
		uint32_t block_count,
		const CompileOptions& opts,
		CompiledPart& out_part,
		std::string& err);

	// Stage 2: Lower a single lifted shard (.ll or .cpp) + ModuleDescriptor HLE stubs & jump tables
	// to a shared PIC .wasm module in memory.
	bool compile_shard_to_wasm(
		const ModuleDescriptor& desc,
		const LiftedShard& shard,
		const CompileOptions& opts,
		CompiledPart& out_part,
		std::string& err);

	// Compile all shards of a module (in parallel on desktop, or per-shard in workers) and emit manifest.json.
	bool compile_lifted_module(
		const ModuleDescriptor& desc,
		const LiftResult& lifted,
		const CompileOptions& opts,
		uint32_t parallel_threads,
		CompileResult& out,
		std::string& err);
}
