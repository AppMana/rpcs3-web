#pragma once

#include "ModuleDescriptor.h"
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace ps3recomp
{
	// Default path to Ghidra 12.1.3 SLEIGH specification files (overridable via GHIDRA_HOME env or CLI)
	std::string default_ghidra_home();

	// Use libghidra_decomp's PowerPC:BE:64:64-32addr SLEIGH + JumpTable analysis to recover indirect
	// bctr switch jump tables across the module, populating desc.jump_tables.
	bool recover_jump_tables_with_ghidra(
		ModuleDescriptor& desc,
		std::string_view ghidra_home,
		std::string& err);

	// Frontend B ("ghidra-cpp"): Lift discovered PPU blocks (addr, size) to standalone, Clang-compilable
	// C++20 source targeting wasm32-unknown-unknown with the exact RPCS3 7-arg Wasm dispatch ABI,
	// direct @__hle_call_fnid calls, C++ switch jump tables, and SLEIGH P-code instruction lowering.
	bool lift_blocks_to_ghidra_cpp(
		const ModuleDescriptor& desc,
		std::span<const std::pair<uint32_t, uint32_t>> blocks,
		std::string_view shard_suffix,
		std::string_view ghidra_home,
		bool include_decomp_comments,
		std::string& cpp_out,
		std::string& err);
}
