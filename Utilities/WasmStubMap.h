#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace wasm_codegen
{
	struct sce_stub_entry
	{
		uint32_t stub_pc = 0;
		uint32_t faddr = 0;
		uint32_t fnid = 0;
		bool is_direct_hle = true;
		const char* module_name = "";
		const char* func_name = "";
	};

	struct jump_table_entry
	{
		uint32_t branch_pc = 0;
		std::vector<uint32_t> targets;
	};

	inline std::span<const sce_stub_entry>& active_sce_stubs_ref() noexcept
	{
		thread_local std::span<const sce_stub_entry> s_active{};
		return s_active;
	}

	inline void set_active_sce_stubs(std::span<const sce_stub_entry> stubs) noexcept
	{
		active_sce_stubs_ref() = stubs;
	}

	inline std::span<const sce_stub_entry> active_sce_stubs() noexcept
	{
		return active_sce_stubs_ref();
	}

	inline std::span<const jump_table_entry>& active_jump_tables_ref() noexcept
	{
		thread_local std::span<const jump_table_entry> s_active{};
		return s_active;
	}

	inline void set_active_jump_tables(std::span<const jump_table_entry> tables) noexcept
	{
		active_jump_tables_ref() = tables;
	}

	inline std::span<const jump_table_entry> active_jump_tables() noexcept
	{
		return active_jump_tables_ref();
	}

	inline const sce_stub_entry* lookup_sce_stub_in(std::span<const sce_stub_entry> stubs, uint32_t stub_pc) noexcept
	{
		if (stubs.empty() || !stub_pc) return nullptr;
		const auto it = std::lower_bound(stubs.begin(), stubs.end(), stub_pc,
			[](const sce_stub_entry& entry, uint32_t pc) { return entry.stub_pc < pc; });
		if (it != stubs.end() && it->stub_pc == stub_pc)
		{
			return &(*it);
		}
		return nullptr;
	}

	inline const sce_stub_entry* lookup_sce_stub(uint32_t stub_pc) noexcept
	{
		return lookup_sce_stub_in(active_sce_stubs(), stub_pc);
	}

	inline const jump_table_entry* lookup_jump_table_in(std::span<const jump_table_entry> tables, uint32_t branch_pc) noexcept
	{
		if (tables.empty() || !branch_pc) return nullptr;
		const auto it = std::lower_bound(tables.begin(), tables.end(), branch_pc,
			[](const jump_table_entry& entry, uint32_t pc) { return entry.branch_pc < pc; });
		if (it != tables.end() && it->branch_pc == branch_pc)
		{
			return &(*it);
		}
		return nullptr;
	}
}
