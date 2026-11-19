#include "stdafx.h"
#include "ModuleExtractor.h"

#include "Crypto/sha1.h"
#include "Crypto/unself.h"
#include "Emu/IdManager.h"
#include "Emu/Cell/PPUAnalyser.h"
#include "Emu/Cell/lv2/sys_prx.h"
#include "Emu/Cell/lv2/sys_sync.h"
#include "Utilities/File.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <unordered_map>

extern std::string ppu_get_function_name(const std::string& _module, u32 fnid);

namespace ps3recomp
{
	namespace
	{
		uint16_t read_be16(const uint8_t* p) noexcept
		{
			return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
		}

		uint32_t read_be32(const uint8_t* p) noexcept
		{
			return (static_cast<uint32_t>(p[0]) << 24) |
			       (static_cast<uint32_t>(p[1]) << 16) |
			       (static_cast<uint32_t>(p[2]) << 8) |
			       static_cast<uint32_t>(p[3]);
		}

		uint64_t read_be64(const uint8_t* p) noexcept
		{
			return (static_cast<uint64_t>(read_be32(p)) << 32) | read_be32(p + 4);
		}

		void write_be16(uint8_t* p, uint16_t v) noexcept
		{
			p[0] = static_cast<uint8_t>(v >> 8);
			p[1] = static_cast<uint8_t>(v);
		}

		void write_be32(uint8_t* p, uint32_t v) noexcept
		{
			p[0] = static_cast<uint8_t>(v >> 24);
			p[1] = static_cast<uint8_t>(v >> 16);
			p[2] = static_cast<uint8_t>(v >> 8);
			p[3] = static_cast<uint8_t>(v);
		}

		void write_be64(uint8_t* p, uint64_t v) noexcept
		{
			write_be32(p, static_cast<uint32_t>(v >> 32));
			write_be32(p + 4, static_cast<uint32_t>(v));
		}

		uint8_t* get_mutable_ptr(ModuleDescriptor& desc, uint32_t addr, uint32_t size) noexcept
		{
			for (auto& seg : desc.segments)
			{
				if (addr >= seg.vaddr && addr + size <= seg.vaddr + seg.memsz && addr - seg.vaddr + size <= seg.data.size())
				{
					return seg.data.data() + (addr - seg.vaddr);
				}
			}
			return nullptr;
		}

		std::string read_cstring(const ModuleDescriptor& desc, uint32_t addr, uint32_t max_len = 256)
		{
			std::string out;
			for (uint32_t i = 0; i < max_len; ++i)
			{
				uint8_t c = 0;
				if (!desc.read_bytes(addr + i, &c, 1) || c == 0) break;
				out.push_back(static_cast<char>(c));
			}
			return out;
		}

		std::string compute_sha1_hex(const ModuleDescriptor& desc)
		{
			sha1_context ctx;
			sha1_starts(&ctx);
			const uint32_t base_be = desc.prx_base_addr;
			sha1_update(&ctx, reinterpret_cast<const uchar*>(&base_be), sizeof(base_be));
			for (const auto& seg : desc.segments)
			{
				sha1_update(&ctx, reinterpret_cast<const uchar*>(&seg.vaddr), sizeof(seg.vaddr));
				sha1_update(&ctx, reinterpret_cast<const uchar*>(&seg.memsz), sizeof(seg.memsz));
				const size_t hash_len = std::min<size_t>(seg.filesz, seg.data.size());
				if (hash_len)
				{
					sha1_update(&ctx, seg.data.data(), hash_len);
				}
			}
			uchar digest[20]{};
			sha1_finish(&ctx, digest);
			char hex[41]{};
			for (int i = 0; i < 20; ++i)
			{
				std::snprintf(hex + i * 2, 3, "%02x", digest[i]);
			}
			return std::string(hex, 40);
		}

		// Scan executable segments for 8-word .sceStub.text trampolines to map faddr -> stub_pc
		// even if *faddr was already patched by RPCS3's runtime loader!
		std::unordered_map<uint32_t, uint32_t> scan_stub_trampolines_by_faddr(const ModuleDescriptor& desc)
		{
			std::unordered_map<uint32_t, uint32_t> faddr_to_stub;
			for (const auto& seg : desc.segments)
			{
				if ((seg.flags & 0x1u) == 0 || seg.filesz < 32) continue;
				const uint32_t limit = std::min<uint32_t>(seg.filesz, static_cast<uint32_t>(seg.data.size()));
				for (uint32_t off = 0; off + 32 <= limit; off += 4)
				{
					const uint8_t* p = seg.data.data() + off;
					const uint32_t w0 = read_be32(p);
					const uint32_t w1 = read_be32(p + 4);
					const uint32_t w2 = read_be32(p + 8);
					const uint32_t w3 = read_be32(p + 12);
					const uint32_t w4 = read_be32(p + 16);
					const uint32_t w5 = read_be32(p + 20);
					const uint32_t w6 = read_be32(p + 24);
					const uint32_t w7 = read_be32(p + 28);

					// Standard 8-word SNC / PSL1GHT stub:
					// li r12, 0 (0x39800000); oris r12, r12, hi (0x658cXXXX); lwz r12, lo(r12) (0x818cYYYY);
					// std r2, 40(r1) (0xf8410028); lwz r0, 0(r12) (0x800c0000); lwz r2, 4(r12) (0x804c0004);
					// mtctr r0 (0x7c0903a6); bctr (0x4e800420)
					if (w0 == 0x39800000u && (w1 & 0xffff0000u) == 0x658c0000u && (w2 & 0xffff0000u) == 0x818c0000u &&
						w3 == 0xf8410028u && w4 == 0x800c0000u && w5 == 0x804c0004u && w6 == 0x7c0903a6u && w7 == 0x4e800420u)
					{
						const uint32_t hi = (w1 & 0xffffu) << 16;
						const int16_t lo = static_cast<int16_t>(w2 & 0xffffu);
						const uint32_t faddr = static_cast<uint32_t>(static_cast<int64_t>(hi) + lo);
						faddr_to_stub.emplace(faddr, seg.vaddr + off);
						off += 28;
						continue;
					}

					// 7-word lis/lwz PRX stub variant:
					// lis r12, ha (0x3d80XXXX); lwz r12, lo(r12) (0x818cYYYY); std r2, 40(r1) (0xf8410028);
					// lwz r0, 0(r12); lwz r2, 4(r12); mtctr r0; bctr
					if ((w0 & 0xffff0000u) == 0x3d800000u && (w1 & 0xffff0000u) == 0x818c0000u &&
						w2 == 0xf8410028u && w3 == 0x800c0000u && w4 == 0x804c0004u && w5 == 0x7c0903a6u && w6 == 0x4e800420u)
					{
						const int32_t ha = static_cast<int16_t>(w0 & 0xffffu) << 16;
						const int16_t lo = static_cast<int16_t>(w1 & 0xffffu);
						const uint32_t faddr = static_cast<uint32_t>(ha + lo);
						faddr_to_stub.emplace(faddr, seg.vaddr + off);
						off += 24;
					}
				}
			}
			return faddr_to_stub;
		}

		void collect_ref_list_relocs(ModuleDescriptor& desc, uint32_t ref_list_addr)
		{
			if (!ref_list_addr) return;
			for (uint32_t cur = ref_list_addr, guard = 0; guard < 65536; cur += 12, ++guard)
			{
				uint8_t rb[12]{};
				if (!desc.read_bytes(cur, rb, 12)) break;
				const uint32_t rtype = read_be32(rb);
				if (!rtype) break;
				const uint32_t raddr = read_be32(rb + 4);
				desc.relocs.push_back({raddr, rtype, 0});
			}
		}

		void parse_import_table(ModuleDescriptor& desc, uint32_t imports_start, uint32_t imports_end,
			const std::unordered_map<uint32_t, uint32_t>& scanned_stubs)
		{
			for (uint32_t pos = imports_start; pos + 44 <= imports_end;)
			{
				uint8_t hdr[44]{};
				if (!desc.read_bytes(pos, hdr, 44)) break;
				const uint8_t rec_size = hdr[0];
				const uint16_t attributes = read_be16(hdr + 4);
				const uint16_t num_func = read_be16(hdr + 6);
				const uint16_t num_var = read_be16(hdr + 8);
				const uint32_t name_ptr = read_be32(hdr + 16);
				const uint32_t nids_ptr = read_be32(hdr + 20);
				const uint32_t addrs_ptr = read_be32(hdr + 24);
				const uint32_t vstubs_ptr = read_be32(hdr + 32);
				const std::string mod_name = name_ptr ? read_cstring(desc, name_ptr) : std::string{};

				for (uint16_t i = 0; i < num_func; ++i)
				{
					uint32_t fnid = 0;
					uint32_t fstub = 0;
					const uint32_t faddr = addrs_ptr + static_cast<uint32_t>(i) * 4u;
					if (!desc.read_u32_be(nids_ptr + static_cast<uint32_t>(i) * 4u, fnid)) continue;
					desc.read_u32_be(faddr, fstub);

					if ((attributes & 0x2000u) != 0)
					{
						uint32_t frefs = 0;
						if (desc.read_u32_be(nids_ptr + static_cast<uint32_t>(num_func + i) * 4u, frefs) && frefs)
						{
							collect_ref_list_relocs(desc, frefs);
						}
					}

					uint32_t stub_pc = 0;
					if (fstub && desc.is_exec_addr(fstub))
					{
						stub_pc = fstub;
					}
					else if (const auto it = scanned_stubs.find(faddr); it != scanned_stubs.end())
					{
						stub_pc = it->second;
					}
					if (!stub_pc && !(fstub == 0 && desc.is_exec_addr(0) && i == 0 && scanned_stubs.find(faddr) == scanned_stubs.end()))
					{
						continue;
					}

					StubDesc sd;
					sd.stub_pc = stub_pc;
					sd.faddr = faddr;
					sd.fnid = fnid;
					sd.is_direct_hle = true;
					sd.module_name = mod_name;
					sd.func_name = ppu_get_function_name(mod_name, fnid);
					desc.stubs.push_back(std::move(sd));
				}

				for (uint16_t i = 0; i < num_var; ++i)
				{
					uint32_t vref = 0;
					if (vstubs_ptr && desc.read_u32_be(vstubs_ptr + static_cast<uint32_t>(i) * 4u, vref) && vref)
					{
						collect_ref_list_relocs(desc, vref);
					}
				}

				pos += rec_size ? rec_size : 44u;
			}

			std::sort(desc.stubs.begin(), desc.stubs.end(),
				[](const StubDesc& a, const StubDesc& b) { return a.stub_pc < b.stub_pc; });
			desc.stubs.erase(std::unique(desc.stubs.begin(), desc.stubs.end(),
				[](const StubDesc& a, const StubDesc& b) { return a.stub_pc == b.stub_pc; }), desc.stubs.end());
		}

		void parse_export_table(ModuleDescriptor& desc, uint32_t exports_start, uint32_t exports_end)
		{
			for (uint32_t pos = exports_start; pos + 28 <= exports_end;)
			{
				uint8_t hdr[28]{};
				if (!desc.read_bytes(pos, hdr, 28)) break;
				const uint8_t rec_size = hdr[0];
				const uint16_t attributes = read_be16(hdr + 4);
				const uint16_t num_func = read_be16(hdr + 6);
				const uint16_t num_var = read_be16(hdr + 8);
				const uint32_t addrs_ptr = read_be32(hdr + 24);
				const bool is_special_mgmt = ((attributes & 0x8000u) != 0) && ((attributes & 0x0001u) == 0);
				const uint32_t export_count = is_special_mgmt
					? (static_cast<uint32_t>(num_func) + static_cast<uint32_t>(num_var))
					: static_cast<uint32_t>(num_func);

				for (uint32_t i = 0; i < export_count; ++i)
				{
					uint32_t faddr = 0;
					if (!desc.read_u32_be(addrs_ptr + i * 4u, faddr) || !faddr) continue;
					desc.exported_funcs.push_back(faddr);
					if (i < num_func)
					{
						uint32_t fpc = 0, ftoc = 0;
						if (desc.read_u32_be(faddr, fpc) && desc.read_u32_be(faddr + 4, ftoc) &&
							(fpc & 3u) == 0 && desc.is_exec_addr(fpc))
						{
							desc.opds.push_back({faddr, fpc, ftoc});
						}
					}
				}
				pos += rec_size ? rec_size : 28u;
			}
		}

		// Scan loaded segments for embedded 32-bit Big-Endian SPU ELFs (\x7fELF\x01\x02, e_machine == 0x17)
		void scan_embedded_spu_elfs(ModuleDescriptor& desc)
		{
			for (const auto& seg : desc.segments)
			{
				const size_t len = std::min<size_t>(seg.filesz, seg.data.size());
				if (len < 52) continue;
				for (size_t off = 0; off + 52 <= len; off += 4)
				{
					const uint8_t* p = seg.data.data() + off;
					if (p[0] != 0x7f || p[1] != 'E' || p[2] != 'L' || p[3] != 'F') continue;
					if (p[4] != 1 || p[5] != 2 || p[6] != 1) continue; // ELFCLASS32, ELFDATA2MSB
					const uint16_t e_type = read_be16(p + 16);
					const uint16_t e_machine = read_be16(p + 18);
					if (e_type != 2 || e_machine != 0x17) continue; // ET_EXEC, EM_SPU

					const uint32_t e_entry = read_be32(p + 24);
					const uint32_t e_phoff = read_be32(p + 28);
					const uint16_t e_phentsize = read_be16(p + 42);
					const uint16_t e_phnum = read_be16(p + 44);
					if (e_entry >= 0x40000u || (e_entry & 3u) != 0 || e_phentsize < 32 || e_phnum == 0 || e_phnum > 32) continue;
					if (off + e_phoff + static_cast<size_t>(e_phnum) * e_phentsize > len) continue;

					SpuImageDesc spu;
					spu.guest_addr = seg.vaddr + static_cast<uint32_t>(off);
					spu.entry_pc = e_entry;
					spu.name = "spu_0x" + ([](uint32_t v) { char b[16]; std::snprintf(b, sizeof(b), "%x", v); return std::string(b); })(spu.guest_addr);
					spu.ls_image.assign(0x40000, 0);

					bool any_load = false;
					bool valid = true;
					for (uint16_t i = 0; i < e_phnum; ++i)
					{
						const uint8_t* ph = p + e_phoff + static_cast<size_t>(i) * e_phentsize;
						const uint32_t p_type = read_be32(ph);
						const uint32_t p_offset = read_be32(ph + 4);
						const uint32_t p_vaddr = read_be32(ph + 8);
						const uint32_t p_filesz = read_be32(ph + 16);
						const uint32_t p_memsz = read_be32(ph + 20);
						if (p_type != 1 || p_memsz == 0) continue; // PT_LOAD
						if (p_vaddr >= 0x40000u || p_vaddr + p_memsz > 0x40000u || off + p_offset + p_filesz > len)
						{
							valid = false;
							break;
						}
						if (p_filesz)
						{
							std::memcpy(spu.ls_image.data() + p_vaddr, p + p_offset, p_filesz);
						}
						any_load = true;
					}
					if (valid && any_load)
					{
						desc.spu_images.push_back(std::move(spu));
					}
				}
			}
		}

		std::string json_escape(std::string_view s)
		{
			std::string out;
			out.reserve(s.size() + 4);
			for (unsigned char c : s)
			{
				if (c == '"') out += "\\\"";
				else if (c == '\\') out += "\\\\";
				else if (c == '\n') out += "\\n";
				else if (c >= 0x20) out.push_back(static_cast<char>(c));
			}
			return out;
		}
	}

	bool extract_from_bytes(
		std::span<const uint8_t> raw_bytes,
		std::string_view module_name,
		uint32_t prx_base_addr,
		ModuleDescriptor& out,
		std::string& err,
		bool relocatable_wasm)
	{
		out = {};
		out.name = std::string(module_name);
		if (raw_bytes.size() < 64)
		{
			err = "Input binary is smaller than an ELF64 header";
			return false;
		}

		std::vector<uint8_t> decrypted_buf;
		std::span<const uint8_t> elf = raw_bytes;

		// Automatically decrypt PS3 SELF / SPRX ("SCE\0") in memory!
		if (elf[0] == 'S' && elf[1] == 'C' && elf[2] == 'E' && elf[3] == 0)
		{
			fs::file mem_self = fs::make_stream(std::vector<u8>(raw_bytes.begin(), raw_bytes.end()));
			fs::file dec = decrypt_self(mem_self);
			if (!dec || dec.size() < 64)
			{
				err = "decrypt_self failed on SCE binary: " + out.name;
				return false;
			}
			decrypted_buf.resize(dec.size());
			dec.seek(0);
			dec.read(decrypted_buf.data(), decrypted_buf.size());
			elf = decrypted_buf;
		}

		if (elf[0] != 0x7f || elf[1] != 'E' || elf[2] != 'L' || elf[3] != 'F' || elf[4] != 2 || elf[5] != 2)
		{
			err = "Expected 64-bit Big-Endian Cell PPU ELF for " + out.name;
			return false;
		}

		const uint16_t e_type = read_be16(elf.data() + 16);
		out.is_prx = (e_type == 0xffa4u);
		out.is_relocatable_wasm = out.is_prx && relocatable_wasm;
		out.entry_opd = static_cast<uint32_t>(read_be64(elf.data() + 24));
		const uint64_t e_phoff = read_be64(elf.data() + 32);
		const uint64_t e_shoff = read_be64(elf.data() + 40);
		const uint16_t e_phentsize = read_be16(elf.data() + 54);
		const uint16_t e_phnum = read_be16(elf.data() + 56);
		const uint16_t e_shentsize = read_be16(elf.data() + 58);
		const uint16_t e_shnum = read_be16(elf.data() + 60);

		uint32_t next_prx_addr = prx_base_addr ? ((prx_base_addr + 0xffffu) & ~0xffffu) : 0x28000000u;
		out.prx_base_addr = out.is_prx ? next_prx_addr : 0;

		struct RawPhdr
		{
			uint32_t p_type;
			uint32_t p_flags;
			uint64_t p_offset;
			uint64_t p_vaddr;
			uint64_t p_paddr;
			uint64_t p_filesz;
			uint64_t p_memsz;
		};
		std::vector<RawPhdr> phdrs;
		std::vector<uint32_t> load_orig_vaddrs;

		for (uint16_t i = 0; i < e_phnum; ++i)
		{
			const size_t off = static_cast<size_t>(e_phoff) + static_cast<size_t>(i) * e_phentsize;
			if (off + 48 > elf.size()) break;
			RawPhdr ph{};
			ph.p_type = read_be32(elf.data() + off);
			ph.p_flags = read_be32(elf.data() + off + 4);
			ph.p_offset = read_be64(elf.data() + off + 8);
			ph.p_vaddr = read_be64(elf.data() + off + 16);
			ph.p_paddr = read_be64(elf.data() + off + 24);
			ph.p_filesz = read_be64(elf.data() + off + 32);
			ph.p_memsz = read_be64(elf.data() + off + 40);
			phdrs.push_back(ph);

			if (ph.p_type != 1) continue; // PT_LOAD
			SegmentDesc seg;
			seg.filesz = static_cast<uint32_t>(ph.p_filesz);
			seg.memsz = static_cast<uint32_t>(ph.p_memsz);
			seg.flags = ph.p_flags;
			if (out.is_prx)
			{
				seg.vaddr = seg.memsz ? next_prx_addr : 0;
				if (seg.memsz)
				{
					next_prx_addr += ((seg.memsz + 0xffffu) & ~0xffffu);
				}
			}
			else
			{
				seg.vaddr = static_cast<uint32_t>(ph.p_vaddr);
			}
			if (seg.memsz > 0)
			{
				if (ph.p_offset + ph.p_filesz > elf.size())
				{
					err = "Corrupt PT_LOAD segment bounds in " + out.name;
					return false;
				}
				// +64 KiB zeroed tail so ppu_module::get_ptr never reads past segment allocation
				seg.data.assign(static_cast<size_t>(seg.memsz) + 0x10000u, 0);
				if (seg.filesz)
				{
					std::memcpy(seg.data.data(), elf.data() + ph.p_offset, seg.filesz);
				}
			}
			load_orig_vaddrs.push_back(static_cast<uint32_t>(ph.p_vaddr));
			out.segments.push_back(std::move(seg));
		}

		if (out.segments.empty())
		{
			err = "No PT_LOAD segments found in " + out.name;
			return false;
		}

		// Apply PRX PT_SCE_PPURELA (0x700000a4) relocations in place so all immediates are constants!
		if (out.is_prx)
		{
			for (const auto& ph : phdrs)
			{
				if (ph.p_type != 0x700000a4u || ph.p_offset + ph.p_filesz > elf.size()) continue;
				for (uint64_t off = 0; off + 24 <= ph.p_filesz; off += 24)
				{
					const uint8_t* r = elf.data() + ph.p_offset + off;
					const uint64_t r_offset = read_be64(r);
					const uint8_t idx_val = r[10];
					const uint8_t idx_addr = r[11];
					const uint32_t r_type = read_be32(r + 12);
					const uint64_t r_ptr = read_be64(r + 16);
					if (idx_addr >= out.segments.size()) continue;
					const uint32_t data_base = (idx_val == 0xffu) ? 0u : (idx_val < out.segments.size() ? out.segments[idx_val].vaddr : 0u);
					const uint32_t raddr = out.segments[idx_addr].vaddr + static_cast<uint32_t>(r_offset);
					const uint64_t rdata = static_cast<uint64_t>(data_base) + r_ptr;
					out.relocs.push_back({raddr, r_type, rdata});

					switch (r_type)
					{
					case 1: // R_PPC64_ADDR32
						if (auto* p = get_mutable_ptr(out, raddr, 4)) write_be32(p, static_cast<uint32_t>(rdata));
						break;
					case 4: // R_PPC64_ADDR16_LO
						if (auto* p = get_mutable_ptr(out, raddr, 2)) write_be16(p, static_cast<uint16_t>(rdata));
						break;
					case 5: // R_PPC64_ADDR16_HI
						if (auto* p = get_mutable_ptr(out, raddr, 2)) write_be16(p, static_cast<uint16_t>(rdata >> 16));
						break;
					case 6: // R_PPC64_ADDR16_HA
						if (auto* p = get_mutable_ptr(out, raddr, 2))
							write_be16(p, static_cast<uint16_t>((rdata >> 16) + ((rdata & 0x8000u) ? 1u : 0u)));
						break;
					case 10: // R_PPC64_REL24
						if (auto* p = get_mutable_ptr(out, raddr, 4))
						{
							const uint32_t orig = read_be32(p);
							const uint32_t disp = static_cast<uint32_t>(rdata - raddr) & 0x03fffffcu;
							write_be32(p, (orig & 0xfc000003u) | disp);
						}
						break;
					case 11: // R_PPC64_REL14
						if (auto* p = get_mutable_ptr(out, raddr, 4))
						{
							const uint32_t orig = read_be32(p);
							const uint32_t disp = static_cast<uint32_t>(rdata - raddr) & 0x0000fffcu;
							write_be32(p, (orig & 0xffff0003u) | disp);
						}
						break;
					case 38: // R_PPC64_ADDR64
						if (auto* p = get_mutable_ptr(out, raddr, 8)) write_be64(p, rdata);
						break;
					case 44: // R_PPC64_REL64
						if (auto* p = get_mutable_ptr(out, raddr, 8)) write_be64(p, rdata - raddr);
						break;
					case 57: // R_PPC64_ADDR16_LO_DS
						if (auto* p = get_mutable_ptr(out, raddr, 2))
						{
							const uint16_t orig = read_be16(p);
							write_be16(p, static_cast<uint16_t>((orig & 3u) | (static_cast<uint16_t>(rdata) & ~3u)));
						}
						break;
					default:
						break;
					}
				}
			}
		}

		// Compute seg0_code_end and scan .opd from ELF64 section headers
		out.seg0_code_end = out.segments[0].vaddr + out.segments[0].filesz;
		if (!out.is_prx && out.entry_opd)
		{
			uint32_t epc = 0, etoc = 0;
			if (out.read_u32_be(out.entry_opd, epc) && out.read_u32_be(out.entry_opd + 4, etoc) && out.is_exec_addr(epc))
			{
				out.entry_pc = epc;
				out.entry_toc = etoc;
			}
			else if (out.is_exec_addr(out.entry_opd))
			{
				out.entry_pc = out.entry_opd;
			}
		}

		if (e_shoff && e_shnum && e_shentsize >= 64)
		{
			uint32_t max_exec_end = 0;
			for (uint16_t i = 0; i < e_shnum; ++i)
			{
				const size_t off = static_cast<size_t>(e_shoff) + static_cast<size_t>(i) * e_shentsize;
				if (off + 64 > elf.size()) break;
				const uint32_t sh_type = read_be32(elf.data() + off + 4);
				const uint64_t sh_flags = read_be64(elf.data() + off + 8);
				uint32_t sh_addr = static_cast<uint32_t>(read_be64(elf.data() + off + 16));
				const uint32_t sh_size = static_cast<uint32_t>(read_be64(elf.data() + off + 32));
				if (sh_type != 1 || !sh_size) continue; // SHT_PROGBITS

				if (out.is_prx)
				{
					for (size_t si = 0; si < out.segments.size(); ++si)
					{
						if (sh_addr >= load_orig_vaddrs[si] && sh_addr < load_orig_vaddrs[si] + out.segments[si].memsz)
						{
							sh_addr = sh_addr - load_orig_vaddrs[si] + out.segments[si].vaddr;
							if ((sh_flags & 0x4u) && si == 0)
							{
								max_exec_end = std::max(max_exec_end, sh_addr + sh_size);
							}
							break;
						}
					}
				}
				else
				{
					if ((sh_flags & 0x4u) && sh_addr >= out.segments[0].vaddr && sh_addr < out.segments[0].vaddr + out.segments[0].memsz)
					{
						max_exec_end = std::max(max_exec_end, sh_addr + sh_size);
					}
					if (out.entry_opd >= sh_addr && out.entry_opd < sh_addr + sh_size)
					{
						for (uint32_t p = sh_addr; p + 8 <= sh_addr + sh_size; p += 8)
						{
							uint32_t fpc = 0, ftoc = 0;
							if (out.read_u32_be(p, fpc) && out.read_u32_be(p + 4, ftoc) &&
								fpc && (fpc & 3u) == 0 && out.is_exec_addr(fpc))
							{
								out.opds.push_back({p, fpc, ftoc});
							}
						}
					}
				}
			}
			if (max_exec_end > out.segments[0].vaddr)
			{
				out.seg0_code_end = max_exec_end;
			}
		}

		// Extract import stubs & exports automatically!
		const auto scanned_stubs = scan_stub_trampolines_by_faddr(out);
		if (out.is_prx)
		{
			if (!phdrs.empty() && phdrs[0].p_paddr >= phdrs[0].p_offset)
			{
				const uint32_t lib_info_addr = out.segments[0].vaddr + static_cast<uint32_t>(phdrs[0].p_paddr - phdrs[0].p_offset);
				uint8_t info_buf[52]{};
				if (out.read_bytes(lib_info_addr, info_buf, 52))
				{
					out.entry_toc = read_be32(info_buf + 32);
					const uint32_t exports_start = read_be32(info_buf + 36);
					const uint32_t exports_end = read_be32(info_buf + 40);
					const uint32_t imports_start = read_be32(info_buf + 44);
					const uint32_t imports_end = read_be32(info_buf + 48);
					parse_export_table(out, exports_start, exports_end);
					parse_import_table(out, imports_start, imports_end, scanned_stubs);
					if (out.name.empty() || out.name == "module")
					{
						out.name = std::string(reinterpret_cast<const char*>(info_buf + 4), strnlen(reinterpret_cast<const char*>(info_buf + 4), 28));
					}
				}
			}
		}
		else
		{
			for (const auto& ph : phdrs)
			{
				if (ph.p_type == 0x60000002u && ph.p_filesz >= 32) // PT_PROC_PRX
				{
					const uint32_t prx_param_vaddr = static_cast<uint32_t>(ph.p_vaddr);
					uint32_t magic = 0;
					if (out.read_u32_be(prx_param_vaddr + 4, magic) && magic == 0x1b434cecu)
					{
						uint32_t exports_start = 0, exports_end = 0, imports_start = 0, imports_end = 0;
						out.read_u32_be(prx_param_vaddr + 16, exports_start);
						out.read_u32_be(prx_param_vaddr + 20, exports_end);
						out.read_u32_be(prx_param_vaddr + 24, imports_start);
						out.read_u32_be(prx_param_vaddr + 28, imports_end);
						parse_export_table(out, exports_start, exports_end);
						parse_import_table(out, imports_start, imports_end, scanned_stubs);
					}
				}
			}
		}

		if (!out.relocs.empty())
		{
			const uint32_t s0_end = out.segments[0].vaddr + out.segments[0].memsz;
			std::stable_sort(out.relocs.begin(), out.relocs.end(),
				[s0_end](const RelocDesc& a, const RelocDesc& b)
				{
					const uint32_t ka = (a.addr < s0_end) ? (a.addr & ~3u) : a.addr;
					const uint32_t kb = (b.addr < s0_end) ? (b.addr & ~3u) : b.addr;
					return ka < kb;
				});
			out.relocs.erase(std::unique(out.relocs.begin(), out.relocs.end(),
				[s0_end](const RelocDesc& a, const RelocDesc& b)
				{
					const uint32_t ka = (a.addr < s0_end) ? (a.addr & ~3u) : a.addr;
					const uint32_t kb = (b.addr < s0_end) ? (b.addr & ~3u) : b.addr;
					return ka == kb;
				}), out.relocs.end());
		}

		scan_embedded_spu_elfs(out);
		out.sha1_hex = compute_sha1_hex(out);
		return true;
	}

	bool extract_from_file(
		const std::string& path,
		uint32_t prx_base_addr,
		ModuleDescriptor& out,
		std::string& err,
		bool relocatable_wasm)
	{
		fs::file f(path);
		if (!f)
		{
			err = "Cannot open file: " + path;
			return false;
		}
		std::vector<uint8_t> raw(f.size());
		f.read(raw.data(), raw.size());
		const auto slash = path.find_last_of("/\\");
		const std::string base_name = (slash == std::string::npos) ? path : path.substr(slash + 1);
		return extract_from_bytes(raw, base_name, prx_base_addr, out, err, relocatable_wasm);
	}

	bool extract_from_loaded_module(
		const ppu_module<lv2_obj>& mod,
		ModuleDescriptor& out,
		std::string& err)
	{
		out = {};
		out.name = mod.name;
		out.is_prx = mod.is_relocatable;
		if (mod.segs.empty())
		{
			err = "Loaded ppu_module has no segments: " + mod.name;
			return false;
		}
		out.prx_base_addr = out.is_prx ? mod.segs[0].addr : 0;

		for (const auto& s : mod.segs)
		{
			if (!s.size || !s.ptr) continue;
			SegmentDesc sd;
			sd.vaddr = s.addr;
			sd.filesz = s.filesz ? s.filesz : s.size;
			sd.memsz = s.size;
			sd.flags = s.flags;
			sd.data.assign(static_cast<size_t>(s.size) + 0x10000u, 0);
			std::memcpy(sd.data.data(), s.ptr, s.size);
			out.segments.push_back(std::move(sd));
		}
		if (out.segments.empty())
		{
			err = "No non-empty segments in loaded ppu_module: " + mod.name;
			return false;
		}

		out.seg0_code_end = out.segments[0].vaddr + out.segments[0].filesz;
		for (const auto& sec : mod.secs)
		{
			if ((sec.flags & 0x4u) && sec.addr >= out.segments[0].vaddr && sec.addr < out.segments[0].vaddr + out.segments[0].memsz)
			{
				out.seg0_code_end = std::max(out.seg0_code_end, sec.addr + sec.size);
			}
		}

		if (!out.is_prx && g_fxo->is_init<main_ppu_module<lv2_obj>>())
		{
			const auto& main_mod = g_fxo->get<main_ppu_module<lv2_obj>>();
			if (&mod == &main_mod)
			{
				out.entry_opd = main_mod.elf_entry;
				if (main_mod.seg0_code_end > out.segments[0].vaddr)
				{
					out.seg0_code_end = main_mod.seg0_code_end;
				}
				uint32_t epc = 0, etoc = 0;
				if (out.entry_opd && out.read_u32_be(out.entry_opd, epc) && out.read_u32_be(out.entry_opd + 4, etoc) && out.is_exec_addr(epc))
				{
					out.entry_pc = epc;
					out.entry_toc = etoc;
				}
				for (const auto& sec : mod.secs)
				{
					if (out.entry_opd >= sec.addr && out.entry_opd < sec.addr + sec.size)
					{
						for (uint32_t p = sec.addr; p + 8 <= sec.addr + sec.size; p += 8)
						{
							uint32_t fpc = 0, ftoc = 0;
							if (out.read_u32_be(p, fpc) && out.read_u32_be(p + 4, ftoc) &&
								fpc && (fpc & 3u) == 0 && out.is_exec_addr(fpc))
							{
								out.opds.push_back({p, fpc, ftoc});
							}
						}
					}
				}
			}
		}

		// Recover all .sceStub.text trampolines directly from live code + PT_PROC_PRX / lv2_prx tables
		const auto scanned_stubs = scan_stub_trampolines_by_faddr(out);
		if (out.is_prx)
		{
			const auto& prx = static_cast<const lv2_prx&>(mod);
			if (prx.exports_start < prx.exports_end)
			{
				parse_export_table(out, prx.exports_start, prx.exports_end);
			}
			if (prx.imports_start < prx.imports_end)
			{
				parse_import_table(out, prx.imports_start, prx.imports_end, scanned_stubs);
			}
			for (uint32_t special_opd : {prx.start.addr(), prx.stop.addr(), prx.prologue.addr(), prx.epilogue.addr(), prx.exit.addr()})
			{
				if (special_opd) out.exported_funcs.push_back(special_opd);
			}
			if (!out.entry_toc && !out.opds.empty())
			{
				out.entry_toc = out.opds.front().toc_r2;
			}
			if (!out.entry_toc && !out.exported_funcs.empty())
			{
				out.read_u32_be(out.exported_funcs.front() + 4, out.entry_toc);
			}
		}
		else
		{
			for (const auto& seg : out.segments)
			{
				const uint32_t lim = std::min<uint32_t>(seg.memsz, static_cast<uint32_t>(seg.data.size()));
				for (uint32_t off = 0; off + 32 <= lim; off += 4)
				{
					const uint8_t* p = seg.data.data() + off;
					if (read_be32(p) == 0x40u && read_be32(p + 4) == 0x1b434cecu)
					{
						const uint32_t exports_start = read_be32(p + 16);
						const uint32_t exports_end = read_be32(p + 20);
						const uint32_t imports_start = read_be32(p + 24);
						const uint32_t imports_end = read_be32(p + 28);
						parse_export_table(out, exports_start, exports_end);
						parse_import_table(out, imports_start, imports_end, scanned_stubs);
					}
				}
			}
		}

		// Also include any stubs scanned directly from .sceStub.text if PRX header wasn't matched via magic
		if (out.stubs.empty() && !scanned_stubs.empty() && !mod.path.empty())
		{
			ModuleDescriptor file_desc;
			std::string file_err;
			if (extract_from_file(mod.path, out.prx_base_addr, file_desc, file_err))
			{
				out.stubs = std::move(file_desc.stubs);
				out.opds = std::move(file_desc.opds);
				out.exported_funcs = std::move(file_desc.exported_funcs);
				out.entry_toc = file_desc.entry_toc;
			}
		}

		scan_embedded_spu_elfs(out);
		char hex[41]{};
		for (int i = 0; i < 20; ++i)
		{
			std::snprintf(hex + i * 2, 3, "%02x", mod.sha1[i]);
		}
		out.sha1_hex = std::string(hex, 40);
		return true;
	}

	namespace
	{
		struct BinWriter
		{
			std::vector<uint8_t> buf;
			void u8_val(uint8_t v) { buf.push_back(v); }
			void u32_val(uint32_t v)
			{
				uint8_t b[4];
				write_be32(b, v);
				buf.insert(buf.end(), b, b + 4);
			}
			void u64_val(uint64_t v)
			{
				uint8_t b[8];
				write_be64(b, v);
				buf.insert(buf.end(), b, b + 8);
			}
			void str(std::string_view s)
			{
				u32_val(static_cast<uint32_t>(s.size()));
				buf.insert(buf.end(), s.begin(), s.end());
			}
			void bytes(std::span<const uint8_t> b)
			{
				u32_val(static_cast<uint32_t>(b.size()));
				buf.insert(buf.end(), b.begin(), b.end());
			}
		};

		struct BinReader
		{
			std::span<const uint8_t> buf;
			size_t pos = 0;
			bool ok = true;

			uint8_t u8_val()
			{
				if (pos + 1 > buf.size()) { ok = false; return 0; }
				return buf[pos++];
			}
			uint32_t u32_val()
			{
				if (pos + 4 > buf.size()) { ok = false; return 0; }
				const uint32_t v = read_be32(buf.data() + pos);
				pos += 4;
				return v;
			}
			uint64_t u64_val()
			{
				if (pos + 8 > buf.size()) { ok = false; return 0; }
				const uint64_t v = read_be64(buf.data() + pos);
				pos += 8;
				return v;
			}
			std::string str()
			{
				const uint32_t n = u32_val();
				if (!ok || pos + n > buf.size()) { ok = false; return {}; }
				std::string s(reinterpret_cast<const char*>(buf.data() + pos), n);
				pos += n;
				return s;
			}
			std::vector<uint8_t> bytes()
			{
				const uint32_t n = u32_val();
				if (!ok || pos + n > buf.size()) { ok = false; return {}; }
				std::vector<uint8_t> b(buf.begin() + pos, buf.begin() + pos + n);
				pos += n;
				return b;
			}
		};
	}

	std::vector<uint8_t> serialize_descriptor_binary(const ModuleDescriptor& desc)
	{
		BinWriter w;
		w.u32_val(0x50533352u); // "PS3R"
		w.u32_val(2u);          // version 2
		w.str(desc.name);
		w.str(desc.sha1_hex);
		w.u8_val((desc.is_prx ? 1u : 0u) | (desc.is_relocatable_wasm ? 2u : 0u));
		w.u32_val(desc.prx_base_addr);
		w.u32_val(desc.entry_opd);
		w.u32_val(desc.entry_pc);
		w.u32_val(desc.entry_toc);
		w.u32_val(desc.seg0_code_end);

		w.u32_val(static_cast<uint32_t>(desc.segments.size()));
		for (const auto& seg : desc.segments)
		{
			w.u32_val(seg.vaddr);
			w.u32_val(seg.filesz);
			w.u32_val(seg.memsz);
			w.u32_val(seg.flags);
			const size_t save_len = std::min<size_t>(seg.memsz, seg.data.size());
			w.bytes(std::span<const uint8_t>(seg.data.data(), save_len));
		}

		w.u32_val(static_cast<uint32_t>(desc.stubs.size()));
		for (const auto& st : desc.stubs)
		{
			w.u32_val(st.stub_pc);
			w.u32_val(st.faddr);
			w.u32_val(st.fnid);
			w.u8_val(st.is_direct_hle ? 1 : 0);
			w.str(st.module_name);
			w.str(st.func_name);
		}

		w.u32_val(static_cast<uint32_t>(desc.opds.size()));
		for (const auto& opd : desc.opds)
		{
			w.u32_val(opd.opd_addr);
			w.u32_val(opd.func_pc);
			w.u32_val(opd.toc_r2);
		}

		w.u32_val(static_cast<uint32_t>(desc.exported_funcs.size()));
		for (uint32_t f : desc.exported_funcs) w.u32_val(f);

		w.u32_val(static_cast<uint32_t>(desc.jump_tables.size()));
		for (const auto& jt : desc.jump_tables)
		{
			w.u32_val(jt.branch_pc);
			w.u32_val(static_cast<uint32_t>(jt.targets.size()));
			for (uint32_t t : jt.targets) w.u32_val(t);
		}

		w.u32_val(static_cast<uint32_t>(desc.spu_images.size()));
		for (const auto& spu : desc.spu_images)
		{
			w.u32_val(spu.guest_addr);
			w.u32_val(spu.entry_pc);
			w.str(spu.name);
			w.bytes(spu.ls_image);
		}

		w.u32_val(static_cast<uint32_t>(desc.relocs.size()));
		for (const auto& rel : desc.relocs)
		{
			w.u32_val(rel.addr);
			w.u32_val(rel.type);
			w.u64_val(rel.data);
		}
		return std::move(w.buf);
	}

	bool deserialize_descriptor_binary(std::span<const uint8_t> bytes, ModuleDescriptor& out, std::string& err)
	{
		out = {};
		BinReader r{bytes};
		const uint32_t magic = r.u32_val();
		const uint32_t version = r.u32_val();
		if (magic != 0x50533352u || (version != 1u && version != 2u))
		{
			err = "Invalid PS3R ModuleDescriptor magic or version";
			return false;
		}
		out.name = r.str();
		out.sha1_hex = r.str();
		const uint8_t flags = r.u8_val();
		out.is_prx = (flags & 1u) != 0;
		out.is_relocatable_wasm = (flags & 2u) != 0;
		out.prx_base_addr = r.u32_val();
		out.entry_opd = r.u32_val();
		out.entry_pc = r.u32_val();
		out.entry_toc = r.u32_val();
		out.seg0_code_end = r.u32_val();

		const uint32_t n_segs = r.u32_val();
		for (uint32_t i = 0; i < n_segs && r.ok; ++i)
		{
			SegmentDesc seg;
			seg.vaddr = r.u32_val();
			seg.filesz = r.u32_val();
			seg.memsz = r.u32_val();
			seg.flags = r.u32_val();
			auto payload = r.bytes();
			seg.data.assign(static_cast<size_t>(seg.memsz) + 0x10000u, 0);
			if (!payload.empty())
			{
				std::memcpy(seg.data.data(), payload.data(), std::min(payload.size(), seg.data.size()));
			}
			out.segments.push_back(std::move(seg));
		}

		const uint32_t n_stubs = r.u32_val();
		for (uint32_t i = 0; i < n_stubs && r.ok; ++i)
		{
			StubDesc st;
			st.stub_pc = r.u32_val();
			st.faddr = r.u32_val();
			st.fnid = r.u32_val();
			st.is_direct_hle = r.u8_val() != 0;
			st.module_name = r.str();
			st.func_name = r.str();
			out.stubs.push_back(std::move(st));
		}

		const uint32_t n_opds = r.u32_val();
		for (uint32_t i = 0; i < n_opds && r.ok; ++i)
		{
			OpdDesc opd;
			opd.opd_addr = r.u32_val();
			opd.func_pc = r.u32_val();
			opd.toc_r2 = r.u32_val();
			out.opds.push_back(opd);
		}

		const uint32_t n_exp = r.u32_val();
		for (uint32_t i = 0; i < n_exp && r.ok; ++i) out.exported_funcs.push_back(r.u32_val());

		const uint32_t n_jt = r.u32_val();
		for (uint32_t i = 0; i < n_jt && r.ok; ++i)
		{
			wasm_codegen::jump_table_entry jt;
			jt.branch_pc = r.u32_val();
			const uint32_t nt = r.u32_val();
			for (uint32_t j = 0; j < nt && r.ok; ++j) jt.targets.push_back(r.u32_val());
			out.jump_tables.push_back(std::move(jt));
		}

		const uint32_t n_spu = r.u32_val();
		for (uint32_t i = 0; i < n_spu && r.ok; ++i)
		{
			SpuImageDesc spu;
			spu.guest_addr = r.u32_val();
			spu.entry_pc = r.u32_val();
			spu.name = r.str();
			spu.ls_image = r.bytes();
			out.spu_images.push_back(std::move(spu));
		}

		if (version >= 2u)
		{
			const uint32_t n_rel = r.u32_val();
			for (uint32_t i = 0; i < n_rel && r.ok; ++i)
			{
				RelocDesc rel;
				rel.addr = r.u32_val();
				rel.type = r.u32_val();
				rel.data = r.u64_val();
				out.relocs.push_back(rel);
			}
		}

		if (!r.ok)
		{
			err = "Truncated PS3R ModuleDescriptor binary";
			return false;
		}
		return true;
	}

	std::string format_descriptor_json_summary(const ModuleDescriptor& desc)
	{
		const auto hex32 = [](uint32_t value)
		{
			char text[11];
			std::snprintf(text, sizeof(text), "0x%08x", value);
			return std::string(text);
		};

		std::ostringstream oss;
		oss << "{\n"
		    << "  \"name\": \"" << json_escape(desc.name) << "\",\n"
		    << "  \"sha1\": \"" << desc.sha1_hex << "\",\n"
		    << "  \"isPrx\": " << (desc.is_prx ? "true" : "false") << ",\n"
		    << "  \"prxBaseAddr\": " << desc.prx_base_addr << ",\n"
		    << "  \"entryOpd\": " << desc.entry_opd << ",\n"
		    << "  \"entryPc\": " << desc.entry_pc << ",\n"
		    << "  \"entryToc\": " << desc.entry_toc << ",\n"
		    << "  \"seg0CodeEnd\": " << desc.seg0_code_end << ",\n"
		    << "  \"segmentCount\": " << desc.segments.size() << ",\n"
		    << "  \"stubCount\": " << desc.stubs.size() << ",\n"
		    << "  \"stubs\": [";
		for (size_t i = 0; i < desc.stubs.size(); ++i)
		{
			const auto& stub = desc.stubs[i];
			oss << (i ? ",\n" : "\n")
			    << "    { \"stubPc\": " << stub.stub_pc
			    << ", \"stubPcHex\": \"" << hex32(stub.stub_pc)
			    << "\", \"faddr\": " << stub.faddr
			    << ", \"faddrHex\": \"" << hex32(stub.faddr)
			    << "\", \"fnid\": " << stub.fnid
			    << ", \"fnidHex\": \"" << hex32(stub.fnid)
			    << "\", \"directHle\": " << (stub.is_direct_hle ? "true" : "false")
			    << ", \"module\": \"" << json_escape(stub.module_name)
			    << "\", \"name\": \"" << json_escape(stub.func_name) << "\" }";
		}
		if (!desc.stubs.empty()) oss << '\n';
		oss << "  ],\n"
		    << "  \"opdCount\": " << desc.opds.size() << ",\n"
		    << "  \"exportedFuncCount\": " << desc.exported_funcs.size() << ",\n"
		    << "  \"jumpTableCount\": " << desc.jump_tables.size() << ",\n"
		    << "  \"spuImageCount\": " << desc.spu_images.size() << "\n"
		    << "}\n";
		return oss.str();
	}
}
