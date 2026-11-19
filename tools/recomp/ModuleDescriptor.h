#pragma once

#include "Utilities/WasmStubMap.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <span>
#include <string>
#include <vector>

namespace ps3recomp
{
	struct SegmentDesc
	{
		uint32_t vaddr = 0;
		uint32_t filesz = 0;
		uint32_t memsz = 0;
		uint32_t flags = 0;
		std::vector<uint8_t> data;
	};

	struct StubDesc
	{
		uint32_t stub_pc = 0;
		uint32_t faddr = 0;
		uint32_t fnid = 0;
		bool is_direct_hle = true;
		std::string module_name;
		std::string func_name;
	};

	struct OpdDesc
	{
		uint32_t opd_addr = 0;
		uint32_t func_pc = 0;
		uint32_t toc_r2 = 0;
	};

	struct RelocDesc
	{
		uint32_t addr = 0;
		uint32_t type = 0;
		uint64_t data = 0;
	};

	struct SpuImageDesc
	{
		uint32_t guest_addr = 0;
		uint32_t entry_pc = 0;
		std::string name;
		std::vector<uint8_t> ls_image; // 256 KiB SPU local store snapshot
	};

	struct ModuleDescriptor
	{
		std::string name;
		std::string sha1_hex;
		bool is_prx = false;
		bool is_relocatable_wasm = false;
		uint32_t prx_base_addr = 0;
		uint32_t entry_opd = 0;
		uint32_t entry_pc = 0;
		uint32_t entry_toc = 0;
		uint32_t seg0_code_end = 0;

		std::vector<SegmentDesc> segments;
		std::vector<StubDesc> stubs;
		std::vector<OpdDesc> opds;
		std::vector<RelocDesc> relocs;
		std::vector<uint32_t> exported_funcs;
		std::vector<wasm_codegen::jump_table_entry> jump_tables;
		std::vector<SpuImageDesc> spu_images;

		bool read_bytes(uint32_t addr, uint8_t* dst, uint32_t size) const noexcept
		{
			for (const auto& seg : segments)
			{
				if (addr >= seg.vaddr && addr < seg.vaddr + seg.memsz)
				{
					const uint32_t off = addr - seg.vaddr;
					const uint32_t avail = std::min<uint32_t>(size, static_cast<uint32_t>(seg.data.size() > off ? seg.data.size() - off : 0));
					if (avail)
					{
						std::memcpy(dst, seg.data.data() + off, avail);
					}
					if (avail < size)
					{
						std::memset(dst + avail, 0, size - avail);
					}
					return true;
				}
			}
			return false;
		}

		bool read_u32_be(uint32_t addr, uint32_t& out) const noexcept
		{
			uint8_t b[4];
			if (!read_bytes(addr, b, 4)) return false;
			out = (static_cast<uint32_t>(b[0]) << 24) |
			      (static_cast<uint32_t>(b[1]) << 16) |
			      (static_cast<uint32_t>(b[2]) << 8) |
			      static_cast<uint32_t>(b[3]);
			return true;
		}

		bool is_exec_addr(uint32_t addr) const noexcept
		{
			for (const auto& seg : segments)
			{
				if ((seg.flags & 0x1u) && addr >= seg.vaddr && addr < seg.vaddr + seg.memsz)
				{
					return true;
				}
			}
			return false;
		}

		std::vector<wasm_codegen::sce_stub_entry> materialize_sce_stubs() const
		{
			const uint32_t stub_base = (is_relocatable_wasm && !segments.empty()) ? segments[0].vaddr : 0u;
			std::vector<wasm_codegen::sce_stub_entry> out;
			out.reserve(stubs.size());
			for (const auto& st : stubs)
			{
				if (!st.stub_pc || st.stub_pc < stub_base) continue;
				out.push_back(wasm_codegen::sce_stub_entry{
					st.stub_pc - stub_base,
					st.faddr,
					st.fnid,
					st.is_direct_hle,
					st.module_name.c_str(),
					st.func_name.c_str(),
				});
			}
			std::sort(out.begin(), out.end(),
				[](const wasm_codegen::sce_stub_entry& a, const wasm_codegen::sce_stub_entry& b)
				{
					return a.stub_pc < b.stub_pc;
				});
			out.erase(std::unique(out.begin(), out.end(),
				[](const wasm_codegen::sce_stub_entry& a, const wasm_codegen::sce_stub_entry& b)
				{
					return a.stub_pc == b.stub_pc;
				}), out.end());
			return out;
		}
	};

	// Fast binary + JSON bundle I/O for decomposed CLI stages & worker IPC
	std::vector<uint8_t> serialize_descriptor_binary(const ModuleDescriptor& desc);
	bool deserialize_descriptor_binary(std::span<const uint8_t> bytes, ModuleDescriptor& out, std::string& err);
	std::string format_descriptor_json_summary(const ModuleDescriptor& desc);
}
