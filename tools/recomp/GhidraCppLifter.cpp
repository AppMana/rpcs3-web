#include "GhidraCppLifter.h"

#include "libdecomp.hh"
#include "sleigh_arch.hh"
#include "loadimage.hh"
#include "funcdata.hh"
#include "jumptable.hh"
#include "flow.hh"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace ps3recomp
{
	namespace
	{
		std::mutex g_ghidra_init_mutex;
		bool g_ghidra_initialized = false;

		void ensure_ghidra_started(std::string_view ghidra_home)
		{
			std::lock_guard lock(g_ghidra_init_mutex);
			if (!g_ghidra_initialized)
			{
				const std::string home(ghidra_home);
				ghidra::startDecompilerLibrary(home.c_str());
				g_ghidra_initialized = true;
			}
		}

		class DescriptorLoadImage final : public ghidra::LoadImage
		{
			const ModuleDescriptor& desc_;
			const std::unordered_map<uint32_t, uint32_t>* seg0_relocs_ = nullptr;
			ghidra::AddrSpace* code_space_ = nullptr;
			std::vector<std::pair<uint32_t, uint32_t>> readonly_ranges_;

		public:
			explicit DescriptorLoadImage(const ModuleDescriptor& desc, const std::unordered_map<uint32_t, uint32_t>* seg0_relocs = nullptr)
				: ghidra::LoadImage(desc.name), desc_(desc), seg0_relocs_(seg0_relocs)
			{
				for (const auto& seg : desc_.segments)
				{
					if ((seg.flags & 0x2u) == 0 && seg.memsz > 0)
					{
						readonly_ranges_.emplace_back(seg.vaddr, seg.vaddr + seg.memsz - 1);
					}
				}
				if (!desc_.opds.empty())
				{
					uint32_t min_opd = desc_.opds.front().opd_addr;
					uint32_t max_opd = desc_.opds.front().opd_addr + 7;
					for (const auto& o : desc_.opds)
					{
						min_opd = std::min(min_opd, o.opd_addr);
						max_opd = std::max(max_opd, o.opd_addr + 7);
					}
					readonly_ranges_.emplace_back(min_opd, max_opd);
				}
				if (desc_.entry_toc >= 0x8000u)
				{
					readonly_ranges_.emplace_back(desc_.entry_toc - 0x8000u, desc_.entry_toc + 0x7fffu);
				}
			}

			void attachToSpace(ghidra::AddrSpace* spc) { code_space_ = spc; }

			void loadFill(ghidra::uint1* ptr, ghidra::int4 size, const ghidra::Address& addr) override
			{
				const uint32_t start = static_cast<uint32_t>(addr.getOffset());
				if (!desc_.read_bytes(start, ptr, static_cast<uint32_t>(size)))
				{
					for (ghidra::int4 i = 0; i < size; ++i)
					{
						uint8_t b = 0;
						desc_.read_bytes(start + static_cast<uint32_t>(i), &b, 1);
						ptr[i] = b;
					}
				}
				if (seg0_relocs_ && !seg0_relocs_->empty() && size > 0)
				{
					const uint64_t start64 = start;
					const uint64_t end64 = start64 + static_cast<uint32_t>(size);
					for (uint64_t insn_pc64 = start64 & ~3ull; insn_pc64 < end64; insn_pc64 += 4ull)
					{
						const uint32_t insn_pc = static_cast<uint32_t>(insn_pc64);
						const auto it = seg0_relocs_->find(insn_pc);
						if (it == seg0_relocs_->end()) continue;
						const uint64_t hi_pos = insn_pc64 + 2ull;
						const uint64_t lo_pos = insn_pc64 + 3ull;
						if (hi_pos >= start64 && hi_pos < end64)
						{
							ptr[hi_pos - start64] = 0x7au;
						}
						if (lo_pos >= start64 && lo_pos < end64)
						{
							ptr[lo_pos - start64] = (it->second == 57u)
								? static_cast<ghidra::uint1>((ptr[lo_pos - start64] & 3u) | 0x5cu)
								: 0x5cu;
						}
					}
				}
			}

			std::string getArchType() const override
			{
				return "PowerPC:BE:64:64-32addr";
			}

			void adjustVma(long) override {}

			void getReadonly(ghidra::RangeList& list) const override
			{
				if (!code_space_) return;
				for (const auto& [first, last] : readonly_ranges_)
				{
					list.insertRange(code_space_, first, last);
				}
			}
		};

		class DescriptorPpuArchitecture final : public ghidra::SleighArchitecture
		{
			const ModuleDescriptor& desc_;
			const std::unordered_map<uint32_t, uint32_t>* seg0_relocs_ = nullptr;

		protected:
			void buildLoader(ghidra::DocumentStorage&) override
			{
				collectSpecFiles(*errorstream);
				loader = new DescriptorLoadImage(desc_, seg0_relocs_);
			}

			void resolveArchitecture() override
			{
				archid = getTarget();
				ghidra::SleighArchitecture::resolveArchitecture();
			}

			void buildSpecFile(ghidra::DocumentStorage& store) override
			{
				ghidra::SleighArchitecture::buildSpecFile(store);
				std::string cspec_file;
				specpaths.findFile(cspec_file, "ppc_64_32.cspec");
				if (!cspec_file.empty())
				{
					std::ifstream ifs(cspec_file);
					std::string xml((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
					const std::string needle = "</unaffected>";
					const auto pos = xml.find(needle);
					if (pos != std::string::npos)
					{
						xml.insert(pos, "        <register name=\"r2\"/>\n        <register name=\"r13\"/>\n");
						std::istringstream iss(xml);
						ghidra::Document* doc = store.parseDocument(iss);
						store.registerTag(doc->getRoot());
					}
				}
			}

			void postSpecFile() override
			{
				ghidra::Architecture::postSpecFile();
				static_cast<DescriptorLoadImage*>(loader)->attachToSpace(getDefaultCodeSpace());
			}

		public:
			DescriptorPpuArchitecture(const ModuleDescriptor& desc, std::ostream* estream, const std::unordered_map<uint32_t, uint32_t>* seg0_relocs = nullptr)
				: ghidra::SleighArchitecture(desc.name, "PowerPC:BE:64:64-32addr", estream), desc_(desc), seg0_relocs_(seg0_relocs) {}
		};

		std::string hex_u32(uint32_t v)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%x", v);
			return std::string(buf);
		}

		// SLEIGH P-code -> Compilable C++20 Emitter for a single PowerPC instruction
		struct PcodeRawOp
		{
			ghidra::OpCode opc;
			bool has_out = false;
			ghidra::VarnodeData out{};
			std::vector<ghidra::VarnodeData> in;
		};

		class PcodeCollector final : public ghidra::PcodeEmit
		{
		public:
			std::vector<PcodeRawOp> ops;

			void dump(const ghidra::Address&, ghidra::OpCode opc, ghidra::VarnodeData* outvar, ghidra::VarnodeData* vars, ghidra::int4 isize) override
			{
				PcodeRawOp op;
				op.opc = opc;
				if (outvar)
				{
					op.has_out = true;
					op.out = *outvar;
				}
				op.in.assign(vars, vars + isize);
				ops.push_back(std::move(op));
			}
		};

		std::string c_uint_type(uint32_t sz)
		{
			if (sz <= 1) return "uint8_t";
			if (sz <= 2) return "uint16_t";
			if (sz <= 4) return "uint32_t";
			if (sz <= 8) return "uint64_t";
			return "__uint128_t";
		}

		std::string c_sint_type(uint32_t sz)
		{
			if (sz <= 1) return "int8_t";
			if (sz <= 2) return "int16_t";
			if (sz <= 4) return "int32_t";
			if (sz <= 8) return "int64_t";
			return "__int128_t";
		}

		// Read a SLEIGH VarnodeData as a typed C++ expression (uint8/16/32/64/128)
		std::string read_varnode_expr(const ghidra::VarnodeData& vn, ghidra::AddrSpace* const_spc, ghidra::AddrSpace* uniq_spc, ghidra::AddrSpace* reg_spc)
		{
			const uint64_t off = vn.offset;
			const uint32_t sz = vn.size;
			const std::string ut = c_uint_type(sz);

			if (vn.space == const_spc)
			{
				if (sz <= 4) return "static_cast<" + ut + ">(" + std::to_string(static_cast<uint32_t>(off)) + "u)";
				return "static_cast<" + ut + ">(" + std::to_string(off) + "ull)";
			}
			if (vn.space == uniq_spc)
			{
				return "read_uniq<" + ut + ">(u_0x" + ([](uint64_t v){ char b[24]; std::snprintf(b, sizeof(b), "%llx", static_cast<unsigned long long>(v)); return std::string(b); })(off) + ")";
			}
			if (vn.space == reg_spc)
			{
				// GPR r0..r31: offset 0x00..0xff (8 bytes each, big-endian subpieces)
				if (off < 0x100u)
				{
					const uint32_t reg = static_cast<uint32_t>(off / 8u);
					const uint32_t sub = static_cast<uint32_t>(off % 8u);
					const std::string base = (reg == 0 ? "r0" : (reg == 1 ? "r1" : (reg == 2 ? "r2" : ("ctx->gpr[" + std::to_string(reg) + "]"))));
					if (sz == 8 && sub == 0) return base;
					const uint32_t shift = (8u - sub - sz) * 8u;
					return "static_cast<" + ut + ">(" + base + " >> " + std::to_string(shift) + ")";
				}
				// XER flags: 0x400=so, 0x401=ov, 0x402=ov32, 0x403=ca, 0x404=ca32, 0x405=cnt
				if (off == 0x400u) return "static_cast<" + ut + ">(ctx->so)";
				if (off == 0x401u || off == 0x402u) return "static_cast<" + ut + ">(ctx->ov)";
				if (off == 0x403u || off == 0x404u) return "static_cast<" + ut + ">(ctx->ca)";
				if (off == 0x405u) return "static_cast<" + ut + ">(ctx->cnt)";
				// CR0..CR7: 0x900..0x907 (nibble: bit3=LT, bit2=GT, bit1=EQ, bit0=SO)
				if (off >= 0x900u && off < 0x908u && sz == 1)
				{
					const uint32_t cr_idx = static_cast<uint32_t>(off - 0x900u);
					return "pack_cr_field(ctx, " + std::to_string(cr_idx) + ")";
				}
				if (off == 0x900u && sz == 8)
				{
					return "pack_cr_all(ctx)";
				}
				if (off == 0x988u) return "r2_save";
				// SPRs: LR=0x1040, CTR=0x1048, VRSAVE=0x1400, TBLr=0x1460
				if (off >= 0x1040u && off < 0x1048u)
				{
					const uint32_t sub = static_cast<uint32_t>(off - 0x1040u);
					const uint32_t shift = (8u - sub - sz) * 8u;
					return sz == 8 ? "ctx->lr" : ("static_cast<" + ut + ">(ctx->lr >> " + std::to_string(shift) + ")");
				}
				if (off >= 0x1048u && off < 0x1050u)
				{
					const uint32_t sub = static_cast<uint32_t>(off - 0x1048u);
					const uint32_t shift = (8u - sub - sz) * 8u;
					return sz == 8 ? "ctx->ctr" : ("static_cast<" + ut + ">(ctx->ctr >> " + std::to_string(shift) + ")");
				}
				if (off >= 0x1400u && off < 0x1408u) return "static_cast<" + ut + ">(ctx->vrsave)";
				if (off >= 0x1460u && off < 0x1468u) return "static_cast<" + ut + ">(__get_tb(ctx))";
				// FPR f0..f31: 0x4000 + 16*i (8 bytes)
				if (off >= 0x4000u && off < 0x4200u)
				{
					const uint32_t freg = static_cast<uint32_t>((off - 0x4000u) / 16u);
					if (sz == 8) return "bit_cast_val<uint64_t>(ctx->fpr[" + std::to_string(freg) + "])";
					if (sz == 4) return "static_cast<uint32_t>(bit_cast_val<uint64_t>(ctx->fpr[" + std::to_string(freg) + "]) >> 32)";
				}
				// Altivec VR0..VR31: 0x4200 + 16*i (16 bytes)
				if (off >= 0x4200u && off < 0x4400u)
				{
					const uint32_t vreg = static_cast<uint32_t>((off - 0x4200u) / 16u);
					const uint32_t sub = static_cast<uint32_t>((off - 0x4200u) % 16u);
					return "read_vr_be<" + ut + ">(ctx->vr[" + std::to_string(vreg) + "], " + std::to_string(sub) + ")";
				}
				return "read_misc_reg<" + ut + ">(misc_regs, " + std::to_string(off) + "u)";
			}
			// RAM space constant load (rare direct constant space read)
			return "vm_read_be<" + ut + ">(static_cast<uint32_t>(" + std::to_string(off) + "u))";
		}

		std::string write_varnode_stmt(const ghidra::VarnodeData& vn, const std::string& val_expr,
			ghidra::AddrSpace* uniq_spc, ghidra::AddrSpace* reg_spc, std::set<uint64_t>& declared_uniqs)
		{
			const uint64_t off = vn.offset;
			const uint32_t sz = vn.size;
			const std::string ut = c_uint_type(sz);

			if (vn.space == uniq_spc)
			{
				char b[24];
				std::snprintf(b, sizeof(b), "%llx", static_cast<unsigned long long>(off));
				const std::string uname = "u_0x" + std::string(b);
				declared_uniqs.insert(off);
				return "write_uniq(" + uname + ", static_cast<" + ut + ">(" + val_expr + "));";
			}
			if (vn.space == reg_spc)
			{
				if (off < 0x100u)
				{
					const uint32_t reg = static_cast<uint32_t>(off / 8u);
					const uint32_t sub = static_cast<uint32_t>(off % 8u);
					const std::string dst = (reg == 0 ? "r0" : (reg == 1 ? "r1" : (reg == 2 ? "r2" : ("ctx->gpr[" + std::to_string(reg) + "]"))));
					if (sz == 8 && sub == 0) return dst + " = static_cast<uint64_t>(" + val_expr + ");";
					const uint32_t shift = (8u - sub - sz) * 8u;
					const uint64_t mask = ((sz == 8 ? ~0ull : ((1ull << (sz * 8u)) - 1ull)) << shift);
					char mbuf[32];
					std::snprintf(mbuf, sizeof(mbuf), "0x%llxull", static_cast<unsigned long long>(~mask));
					return dst + " = (" + dst + " & " + mbuf + ") | (static_cast<uint64_t>(static_cast<" + ut + ">(" + val_expr + ")) << " + std::to_string(shift) + ");";
				}
				if (off == 0x400u) return "ctx->so = static_cast<uint8_t>((" + val_expr + ") & 1u);";
				if (off == 0x401u) return "ctx->ov = static_cast<uint8_t>((" + val_expr + ") & 1u);";
				if (off == 0x402u) return "/* xer_ov32 */ (void)(" + val_expr + ");";
				if (off == 0x403u) return "ctx->ca = static_cast<uint8_t>((" + val_expr + ") & 1u);";
				if (off == 0x404u) return "/* xer_ca32 */ (void)(" + val_expr + ");";
				if (off == 0x405u) return "ctx->cnt = static_cast<uint8_t>(" + val_expr + ");";
				if (off >= 0x900u && off < 0x908u && sz == 1)
				{
					const uint32_t cr_idx = static_cast<uint32_t>(off - 0x900u);
					return "unpack_cr_field(ctx, " + std::to_string(cr_idx) + ", static_cast<uint8_t>(" + val_expr + "));";
				}
				if (off == 0x900u && sz == 8) return "unpack_cr_all(ctx, static_cast<uint64_t>(" + val_expr + "));";
				if (off == 0x988u) return "r2_save = static_cast<uint64_t>(" + val_expr + ");";
				if (off >= 0x1040u && off < 0x1048u)
				{
					if (sz == 8) return "ctx->lr = static_cast<uint64_t>(" + val_expr + ");";
					return "ctx->lr = static_cast<uint32_t>(" + val_expr + ");";
				}
				if (off >= 0x1048u && off < 0x1050u)
				{
					if (sz == 8) return "ctx->ctr = static_cast<uint64_t>(" + val_expr + ");";
					return "ctx->ctr = static_cast<uint32_t>(" + val_expr + ");";
				}
				if (off >= 0x1400u && off < 0x1408u) return "ctx->vrsave = static_cast<uint32_t>(" + val_expr + ");";
				if (off >= 0x4000u && off < 0x4200u && sz == 8)
				{
					const uint32_t freg = static_cast<uint32_t>((off - 0x4000u) / 16u);
					return "ctx->fpr[" + std::to_string(freg) + "] = bit_cast_val<double>(static_cast<uint64_t>(" + val_expr + "));";
				}
				if (off >= 0x4200u && off < 0x4400u)
				{
					const uint32_t vreg = static_cast<uint32_t>((off - 0x4200u) / 16u);
					const uint32_t sub = static_cast<uint32_t>((off - 0x4200u) % 16u);
					return "write_vr_be<" + ut + ">(ctx->vr[" + std::to_string(vreg) + "], " + std::to_string(sub) + ", static_cast<" + ut + ">(" + val_expr + "));";
				}
				return "write_misc_reg<" + ut + ">(misc_regs, " + std::to_string(off) + "u, static_cast<" + ut + ">(" + val_expr + "));";
			}
			return "(void)(" + val_expr + ");";
		}
	}

	std::string default_ghidra_home()
	{
		if (const char* env = std::getenv("GHIDRA_HOME"); env && *env)
		{
			return std::string(env);
		}
#ifdef __EMSCRIPTEN__
		return "/ghidra";
#elif defined(PS3RECOMP_DEFAULT_GHIDRA_HOME)
		return PS3RECOMP_DEFAULT_GHIDRA_HOME;
#else
		return "/home/administrator/Documents/rpcs3-web/3rdparty/ghidra";
#endif
	}

	bool recover_jump_tables_with_ghidra(
		ModuleDescriptor& desc,
		std::string_view ghidra_home,
		std::string& err)
	{
		if (desc.segments.empty()) return true;
		ensure_ghidra_started(ghidra_home.empty() ? default_ghidra_home() : ghidra_home);

		std::ostringstream arch_err;
		DescriptorPpuArchitecture arch(desc, &arch_err);
		ghidra::DocumentStorage store;
		try
		{
			arch.init(store);
		}
		catch (const ghidra::LowlevelError& e)
		{
			err = "Ghidra architecture init failed: " + e.explain + " (" + arch_err.str() + ")";
			return false;
		}

		auto* code_space = arch.getDefaultCodeSpace();
		auto* global_scope = arch.symboltab->getGlobalScope();

		if (desc.entry_toc != 0)
		{
			auto& tracked = arch.context->getTrackedDefault();
			tracked.emplace_back();
			tracked.back().loc = arch.translate->getRegister("r2");
			tracked.back().val = desc.entry_toc;
		}

		std::unordered_set<uint32_t> stub_pcs;
		std::set<std::string> used_names;
		for (const auto& st : desc.stubs)
		{
			if (!st.stub_pc) continue;
			stub_pcs.insert(st.stub_pc);
			std::string sym = st.func_name.empty() ? ("stub_" + hex_u32(st.stub_pc)) : st.func_name;
			if (!used_names.insert(sym).second)
			{
				sym += "_" + hex_u32(st.stub_pc);
				used_names.insert(sym);
			}
			global_scope->addFunction(ghidra::Address(code_space, st.stub_pc), sym);
		}

		std::vector<uint32_t> func_starts;
		if (desc.entry_pc) func_starts.push_back(desc.entry_pc);
		for (const auto& opd : desc.opds) func_starts.push_back(opd.func_pc);
		std::sort(func_starts.begin(), func_starts.end());
		func_starts.erase(std::unique(func_starts.begin(), func_starts.end()), func_starts.end());

		for (uint32_t fpc : func_starts)
		{
			const ghidra::Address fa(code_space, fpc);
			if (!global_scope->queryFunction(fa))
			{
				global_scope->addFunction(fa, "sub_" + hex_u32(fpc).substr(2));
			}
		}

		// Scan every OPD function containing a non-stub bctr (0x4e800420) for switch jump tables!
		auto* root_action = arch.allacts.getCurrent();
		std::map<uint32_t, std::vector<uint32_t>> table_map;
		size_t analysed_candidates = 0;
		for (size_t i = 0; i < func_starts.size() && analysed_candidates < 512; ++i)
		{
			const uint32_t start = func_starts[i];
			if (stub_pcs.count(start)) continue;
			const uint32_t next_start = (i + 1 < func_starts.size()) ? func_starts[i + 1] : desc.seg0_code_end;
			const uint32_t end = std::min<uint32_t>(std::max<uint32_t>(next_start, start + 4), start + 0x4000u);

			bool has_mtctr = false;
			bool has_bctr = false;
			for (uint32_t pc = start; pc < end; pc += 4)
			{
				if (stub_pcs.count(pc)) { pc += 28; continue; }
				uint32_t insn = 0;
				if (!desc.read_u32_be(pc, insn)) continue;
				if ((insn & 0xfc1fffffu) == 0x7c0903a6u) has_mtctr = true;
				else if (insn == 0x4e800420u && has_mtctr) { has_bctr = true; break; }
			}
			if (!has_bctr) continue;

			ghidra::Funcdata* fd = global_scope->queryFunction(ghidra::Address(code_space, start));
			if (!fd) continue;
			++analysed_candidates;
			try
			{
				root_action->reset(*fd);
				root_action->perform(*fd);
				const int njt = fd->numJumpTables();
				for (int j = 0; j < njt; ++j)
				{
					const ghidra::JumpTable* jt = fd->getJumpTable(j);
					if (!jt || !jt->isRecovered()) continue;
					const uint32_t op_pc = static_cast<uint32_t>(jt->getOpAddress().getOffset());
					const int nent = jt->numEntries();
					if (nent <= 0) continue;
					auto& dst = table_map[op_pc];
					for (int ti = 0; ti < nent; ++ti)
					{
						const uint32_t tpc = static_cast<uint32_t>(jt->getAddressByIndex(ti).getOffset());
						if (desc.is_exec_addr(tpc) && (tpc & 3u) == 0)
						{
							dst.push_back(tpc);
						}
					}
				}
			}
			catch (const ghidra::LowlevelError&)
			{
			}
			fd->clear();
		}

		desc.jump_tables.clear();
		for (auto& [bpc, targets] : table_map)
		{
			std::sort(targets.begin(), targets.end());
			targets.erase(std::unique(targets.begin(), targets.end()), targets.end());
			if (!targets.empty())
			{
				desc.jump_tables.push_back({bpc, std::move(targets)});
			}
		}
		return true;
	}

	bool lift_blocks_to_ghidra_cpp(
		const ModuleDescriptor& desc,
		std::span<const std::pair<uint32_t, uint32_t>> blocks,
		std::string_view shard_suffix,
		std::string_view ghidra_home,
		bool include_decomp_comments,
		std::string& cpp_out,
		std::string& err)
	{
		ensure_ghidra_started(ghidra_home.empty() ? default_ghidra_home() : ghidra_home);

		std::unordered_map<uint32_t, uint32_t> seg0_relocs;
		if (desc.is_relocatable_wasm)
		{
			for (const auto& rel : desc.relocs)
			{
				if (rel.addr >= desc.prx_base_addr && rel.addr < desc.seg0_code_end &&
					((rel.type >= 4u && rel.type <= 6u) || rel.type == 57u))
				{
					seg0_relocs[rel.addr & ~3u] = rel.type;
				}
			}
		}

		std::ostringstream arch_err;
		DescriptorPpuArchitecture arch(desc, &arch_err, desc.is_relocatable_wasm ? &seg0_relocs : nullptr);
		ghidra::DocumentStorage store;
		try
		{
			arch.init(store);
		}
		catch (const ghidra::LowlevelError& e)
		{
			err = "Ghidra architecture init failed: " + e.explain;
			return false;
		}

		auto* code_space = arch.getDefaultCodeSpace();
		auto* const_space = arch.getConstantSpace();
		auto* uniq_space = arch.getUniqueSpace();
		auto* reg_space = arch.getSpaceByName("register");
		auto* global_scope = arch.symboltab->getGlobalScope();

		if (desc.entry_toc != 0)
		{
			auto& tracked = arch.context->getTrackedDefault();
			tracked.emplace_back();
			tracked.back().loc = arch.translate->getRegister("r2");
			tracked.back().val = desc.entry_toc;
		}

		const auto sce_stubs = desc.materialize_sce_stubs();
		std::unordered_set<uint32_t> shard_block_set;
		for (const auto& [bpc, bsz] : blocks)
		{
			if (bsz) shard_block_set.insert(bpc);
		}
		std::unordered_set<uint32_t> opd_func_set;
		for (const auto& opd : desc.opds) opd_func_set.insert(opd.func_pc);
		if (desc.entry_pc) opd_func_set.insert(desc.entry_pc);

		std::ostringstream out;
		out << "// Auto-generated by ps3recomp Ghidra SLEIGH C++20 Lifter (PowerPC:BE:64:64-32addr -> wasm32)\n"
		    << "using uint8_t = __UINT8_TYPE__;\n"
		    << "using uint16_t = __UINT16_TYPE__;\n"
		    << "using uint32_t = __UINT32_TYPE__;\n"
		    << "using uint64_t = __UINT64_TYPE__;\n"
		    << "using int8_t = __INT8_TYPE__;\n"
		    << "using int16_t = __INT16_TYPE__;\n"
		    << "using int32_t = __INT32_TYPE__;\n"
		    << "using int64_t = __INT64_TYPE__;\n"
		    << "using uintptr_t = __UINTPTR_TYPE__;\n"
		    << "template <typename To, typename From> constexpr inline To bit_cast_val(const From& v) noexcept { return __builtin_bit_cast(To, v); }\n\n"
		    << "struct alignas(16) PpuVr { uint64_t lo; uint64_t hi; };\n"
		    << "struct PpuThreadContext {\n"
		    << "  uint8_t _pad0[20];\n"
		    << "  volatile uint32_t state;\n"
		    << "  uint64_t gpr[32];\n"
		    << "  double fpr[32];\n"
		    << "  uint8_t _pad_vr[8];\n"
		    << "  PpuVr vr[32];\n"
		    << "  uint8_t cr[32];\n"
		    << "  uint8_t fpscr[32];\n"
		    << "  uint64_t lr;\n"
		    << "  uint64_t ctr;\n"
		    << "  uint32_t vrsave;\n"
		    << "  uint32_t cia;\n"
		    << "  uint8_t so;\n"
		    << "  uint8_t ov;\n"
		    << "  uint8_t ca;\n"
		    << "  uint8_t cnt;\n"
		    << "  uint8_t nj;\n"
		    << "  uint8_t _pad1[3];\n"
		    << "  PpuVr sat;\n"
		    << "  uint32_t jm_mask;\n"
		    << "};\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, state) == 20);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, gpr) == 24);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, fpr) == 280);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, vr) == 544);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, cr) == 1056);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, lr) == 1120);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, ctr) == 1128);\n"
		    << "static_assert(__builtin_offsetof(PpuThreadContext, cia) == 1140);\n\n"
		    << "extern \"C\" {\n"
		    << "  void __check(PpuThreadContext* ctx, uint64_t cia);\n"
		    << "  void __syscall(PpuThreadContext* ctx, uint64_t num);\n"
		    << "  uint32_t __hle_call_fnid(PpuThreadContext* ctx, uint32_t target, uint32_t fnid);\n"
		    << "  uint64_t __get_tb(PpuThreadContext* ctx);\n"
		    << "  uint32_t __lwarx(PpuThreadContext* ctx, uint64_t addr);\n"
		    << "  uint64_t __ldarx(PpuThreadContext* ctx, uint64_t addr);\n"
		    << "  uint32_t __stwcx(PpuThreadContext* ctx, uint64_t addr, uint32_t val);\n"
		    << "  uint32_t __stdcx(PpuThreadContext* ctx, uint64_t addr, uint64_t val);\n"
		    << "  uint8_t rpcs3_web_vm_read8_raw(uint32_t addr);\n"
		    << "  uint16_t rpcs3_web_vm_read16_raw(uint32_t addr);\n"
		    << "  uint32_t rpcs3_web_vm_read32_raw(uint32_t addr);\n"
		    << "  uint64_t rpcs3_web_vm_read64_raw(uint32_t addr);\n"
		    << "  void rpcs3_web_vm_write8_raw(uint32_t addr, uint8_t val);\n"
		    << "  void rpcs3_web_vm_write16_raw(uint32_t addr, uint16_t val);\n"
		    << "  void rpcs3_web_vm_write32_raw(uint32_t addr, uint32_t val);\n"
		    << "  void rpcs3_web_vm_write64_raw(uint32_t addr, uint64_t val);\n"
		    << "}\n\n"
		    << "namespace {\n"
		    << "using BlockFn = void(*)(uint32_t*, PpuThreadContext*, uint64_t, void*, uint64_t, uint64_t, uint64_t);\n"
		    << "template <typename T> inline T vm_read_be(uint32_t a) {\n"
		    << "  if constexpr (sizeof(T) == 1) return rpcs3_web_vm_read8_raw(a);\n"
		    << "  else if constexpr (sizeof(T) == 2) return __builtin_bswap16(rpcs3_web_vm_read16_raw(a));\n"
		    << "  else if constexpr (sizeof(T) == 4) return __builtin_bswap32(rpcs3_web_vm_read32_raw(a));\n"
		    << "  else if constexpr (sizeof(T) == 8) return __builtin_bswap64(rpcs3_web_vm_read64_raw(a));\n"
		    << "  else { __uint128_t hi = __builtin_bswap64(rpcs3_web_vm_read64_raw(a)); __uint128_t lo = __builtin_bswap64(rpcs3_web_vm_read64_raw(a + 8)); return (hi << 64) | lo; }\n"
		    << "}\n"
		    << "template <typename T> inline void vm_write_be(uint32_t a, T v) {\n"
		    << "  if constexpr (sizeof(T) == 1) rpcs3_web_vm_write8_raw(a, static_cast<uint8_t>(v));\n"
		    << "  else if constexpr (sizeof(T) == 2) rpcs3_web_vm_write16_raw(a, __builtin_bswap16(static_cast<uint16_t>(v)));\n"
		    << "  else if constexpr (sizeof(T) == 4) rpcs3_web_vm_write32_raw(a, __builtin_bswap32(static_cast<uint32_t>(v)));\n"
		    << "  else if constexpr (sizeof(T) == 8) rpcs3_web_vm_write64_raw(a, __builtin_bswap64(static_cast<uint64_t>(v)));\n"
		    << "  else { rpcs3_web_vm_write64_raw(a, __builtin_bswap64(static_cast<uint64_t>(v >> 64))); rpcs3_web_vm_write64_raw(a + 8, __builtin_bswap64(static_cast<uint64_t>(v))); }\n"
		    << "}\n"
		    << "template <typename T> inline T read_uniq(__uint128_t u) { return static_cast<T>(u); }\n"
		    << "template <typename T> inline void write_uniq(__uint128_t& u, T v) { u = static_cast<__uint128_t>(v); }\n"
		    << "template <typename T> inline T read_misc_reg(const uint8_t* m, uint32_t o) { T v{}; __builtin_memcpy(&v, m + (o & 255u), sizeof(T)); return v; }\n"
		    << "template <typename T> inline void write_misc_reg(uint8_t* m, uint32_t o, T v) { __builtin_memcpy(m + (o & 255u), &v, sizeof(T)); }\n"
		    << "template <typename T> inline T read_vr_be(const PpuVr& vr, uint32_t sub) {\n"
		    << "  uint8_t b[16]; uint64_t w0 = __builtin_bswap64(vr.hi), w1 = __builtin_bswap64(vr.lo);\n"
		    << "  __builtin_memcpy(b, &w0, 8); __builtin_memcpy(b + 8, &w1, 8);\n"
		    << "  if constexpr (sizeof(T) == 1) return b[sub & 15];\n"
		    << "  else if constexpr (sizeof(T) == 2) { uint16_t x; __builtin_memcpy(&x, b + (sub & 14), 2); return __builtin_bswap16(x); }\n"
		    << "  else if constexpr (sizeof(T) == 4) { uint32_t x; __builtin_memcpy(&x, b + (sub & 12), 4); return __builtin_bswap32(x); }\n"
		    << "  else if constexpr (sizeof(T) == 8) { uint64_t x; __builtin_memcpy(&x, b + (sub & 8), 8); return __builtin_bswap64(x); }\n"
		    << "  else { return (static_cast<__uint128_t>(vr.hi) << 64) | vr.lo; }\n"
		    << "}\n"
		    << "template <typename T> inline void write_vr_be(PpuVr& vr, uint32_t sub, T v) {\n"
		    << "  if constexpr (sizeof(T) == 16) { vr.hi = static_cast<uint64_t>(v >> 64); vr.lo = static_cast<uint64_t>(v); return; }\n"
		    << "  uint8_t b[16]; uint64_t w0 = __builtin_bswap64(vr.hi), w1 = __builtin_bswap64(vr.lo);\n"
		    << "  __builtin_memcpy(b, &w0, 8); __builtin_memcpy(b + 8, &w1, 8);\n"
		    << "  if constexpr (sizeof(T) == 1) b[sub & 15] = static_cast<uint8_t>(v);\n"
		    << "  else if constexpr (sizeof(T) == 2) { uint16_t x = __builtin_bswap16(static_cast<uint16_t>(v)); __builtin_memcpy(b + (sub & 14), &x, 2); }\n"
		    << "  else if constexpr (sizeof(T) == 4) { uint32_t x = __builtin_bswap32(static_cast<uint32_t>(v)); __builtin_memcpy(b + (sub & 12), &x, 4); }\n"
		    << "  else if constexpr (sizeof(T) == 8) { uint64_t x = __builtin_bswap64(static_cast<uint64_t>(v)); __builtin_memcpy(b + (sub & 8), &x, 8); }\n"
		    << "  __builtin_memcpy(&w0, b, 8); __builtin_memcpy(&w1, b + 8, 8);\n"
		    << "  vr.hi = __builtin_bswap64(w0); vr.lo = __builtin_bswap64(w1);\n"
		    << "}\n"
		    << "inline uint8_t pack_cr_field(const PpuThreadContext* c, uint32_t f) {\n"
		    << "  const uint8_t* p = c->cr + f * 4; return static_cast<uint8_t>(((p[0] & 1) << 3) | ((p[1] & 1) << 2) | ((p[2] & 1) << 1) | (p[3] & 1));\n"
		    << "}\n"
		    << "inline void unpack_cr_field(PpuThreadContext* c, uint32_t f, uint8_t v) {\n"
		    << "  uint8_t* p = c->cr + f * 4; p[0] = (v >> 3) & 1; p[1] = (v >> 2) & 1; p[2] = (v >> 1) & 1; p[3] = v & 1;\n"
		    << "}\n"
		    << "inline uint64_t pack_cr_all(const PpuThreadContext* c) {\n"
		    << "  uint64_t r = 0; for (uint32_t f = 0; f < 8; ++f) r |= static_cast<uint64_t>(pack_cr_field(c, f)) << ((7 - f) * 8); return r;\n"
		    << "}\n"
		    << "inline void unpack_cr_all(PpuThreadContext* c, uint64_t v) {\n"
		    << "  for (uint32_t f = 0; f < 8; ++f) unpack_cr_field(c, f, static_cast<uint8_t>(v >> ((7 - f) * 8)));\n"
		    << "}\n"
		    << "inline BlockFn lookup_table_fn(uint32_t* exec, uint32_t target_pc) {\n"
		    << "  const uint32_t page = exec[target_pc >> 16];\n"
		    << "  if (!page) return nullptr;\n"
		    << "  const auto* page_words = reinterpret_cast<const uint32_t*>(static_cast<uintptr_t>(page));\n"
		    << "  const uint32_t slot = (target_pc & 0xffffu) >> 2;\n"
		    << "  const uint32_t b = page_words[slot];\n"
		    << "  const uint32_t t = reinterpret_cast<const uint32_t*>(reinterpret_cast<const uint8_t*>(page_words) + 0x10000)[slot];\n"
		    << "  const uint32_t idx = b ? b : t;\n"
		    << "  if (idx - 1u >= 0x7fffffffu) return nullptr;\n"
		    << "  return reinterpret_cast<BlockFn>(static_cast<uintptr_t>(idx));\n"
		    << "}\n"
		    << "inline uint64_t lookup_page_seg0(uint32_t* exec, uint32_t target_pc) {\n"
		    << "  return static_cast<uint64_t>(reinterpret_cast<const uint32_t*>(reinterpret_cast<const uint8_t*>(exec) + 0x40000)[target_pc >> 16]);\n"
		    << "}\n"
		    << "} // namespace\n\n";

		// Forward-declare all hidden block functions in this shard
		std::vector<uint32_t> emitted_addrs;
		out << "extern \"C\" {\n";
		for (const auto& [bpc, bsz] : blocks)
		{
			if (!bsz) continue;
			emitted_addrs.push_back(bpc);
			out << "__attribute__((visibility(\"hidden\"))) void __0x" << std::hex << bpc << std::dec
			    << "(uint32_t* exec, PpuThreadContext* __restrict ctx, uint64_t seg0, void* mem, uint64_t r0, uint64_t r1, uint64_t r2) noexcept;\n";
		}
		out << "}\n\n";

		auto* root_action = arch.allacts.getCurrent();

		for (const auto& [bpc, bsz] : blocks)
		{
			if (!bsz) continue;

			// Optionally attach high-level Ghidra PrintC structured C++ comment on function entry blocks
			if (include_decomp_comments && opd_func_set.count(bpc))
			{
				const ghidra::Address fa(code_space, bpc);
				ghidra::Funcdata* fd = global_scope->queryFunction(fa);
				if (!fd) fd = global_scope->addFunction(fa, "sub_" + hex_u32(bpc).substr(2))->getFunction();
				try
				{
					std::ostringstream hl;
					root_action->reset(*fd);
					root_action->perform(*fd);
					arch.print->setOutputStream(&hl);
					arch.print->docFunction(fd);
					out << "/* [Ghidra Structured C++ @ " << hex_u32(bpc) << "]\n" << hl.str() << "*/\n";
				}
				catch (const ghidra::LowlevelError&)
				{
				}
				fd->clear();
			}

			// First collect SLEIGH P-code across all instructions in [bpc, bpc + bsz) to declare temporaries
			struct InsnBundle
			{
				uint32_t pc;
				uint32_t raw_word;
				uint32_t rel_type;
				std::vector<PcodeRawOp> pcode;
			};
			std::vector<InsnBundle> insns;
			std::set<uint64_t> uniq_ids;

			for (uint32_t pc = bpc; pc < bpc + bsz; pc += 4)
			{
				uint32_t word = 0;
				desc.read_u32_be(pc, word);
				uint32_t rel_type = 0;
				if (const auto rit = seg0_relocs.find(pc); rit != seg0_relocs.end())
				{
					rel_type = rit->second;
				}
				PcodeCollector col;
				try
				{
					arch.translate->oneInstruction(col, ghidra::Address(code_space, pc));
				}
				catch (const ghidra::LowlevelError&)
				{
				}
				for (const auto& pop : col.ops)
				{
					if (pop.has_out && pop.out.space == uniq_space) uniq_ids.insert(pop.out.offset);
					for (const auto& iv : pop.in)
					{
						if (iv.space == uniq_space) uniq_ids.insert(iv.offset);
					}
				}
				insns.push_back({pc, word, rel_type, std::move(col.ops)});
			}

			auto pc_expr = [&](uint32_t pc) -> std::string
			{
				if (desc.is_relocatable_wasm && pc >= desc.prx_base_addr && pc <= desc.seg0_code_end)
				{
					return "(static_cast<uint32_t>(seg0) + " + hex_u32(pc - desc.prx_base_addr) + "u)";
				}
				return hex_u32(pc) + "u";
			};

			const auto* self_stub = wasm_codegen::lookup_sce_stub_in(sce_stubs, bpc);

			out << "extern \"C\" __attribute__((visibility(\"hidden\"))) void __0x" << std::hex << bpc << std::dec
			    << "(uint32_t* exec, PpuThreadContext* __restrict ctx, uint64_t seg0, void* mem, uint64_t r0, uint64_t r1, uint64_t r2) noexcept {\n";
			if (bsz >= 16)
			{
				const std::string entry_pc_str = pc_expr(bpc);
				out << "  if (__builtin_expect(ctx->state != 0, 0)) {\n"
				    << "    ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; ctx->cia = " << entry_pc_str << ";\n"
				    << "    __check(ctx, static_cast<uint64_t>(" << entry_pc_str << "));\n"
				    << "    r0 = ctx->gpr[0]; r1 = ctx->gpr[1]; r2 = ctx->gpr[2];\n"
				    << "  }\n";
			}
			out << "  uint64_t r2_save = r2;\n  uint8_t misc_regs[256]{};\n  (void)r2_save; (void)misc_regs;\n";
			for (uint64_t uid : uniq_ids)
			{
				out << "  __uint128_t u_0x" << std::hex << uid << std::dec << " = 0;\n";
			}

			// Emit helper macro for clean tail-dispatch to any target guest PC (including direct HLE stubs & switch tables!)
			auto emit_dispatch_to_const = [&](uint32_t target_pc, uint32_t cur_pc, const std::string& indent)
			{
				if (!desc.is_relocatable_wasm)
				{
					if (const auto* st = wasm_codegen::lookup_sce_stub_in(sce_stubs, target_pc); st && st->is_direct_hle && target_pc != bpc)
					{
						out << indent << "vm_write_be<uint64_t>(static_cast<uint32_t>(r1 + 40ull), r2);\n"
						    << indent << "ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; ctx->cia = 0x" << std::hex << st->stub_pc << std::dec << "u;\n"
						    << indent << "const uint32_t hle_ret = __hle_call_fnid(ctx, 0x" << std::hex << (st->faddr | 0x80000000u) << "u, 0x" << st->fnid << std::dec << "u);\n"
						    << indent << "if (!hle_ret) return;\n"
						    << indent << "r0 = ctx->gpr[0]; r1 = ctx->gpr[1]; r2 = ctx->gpr[2]; ctx->cia = hle_ret;\n"
						    << indent << "if (auto fn = lookup_table_fn(exec, hle_ret)) { [[clang::musttail]] return fn(exec, ctx, lookup_page_seg0(exec, hle_ret), mem, r0, r1, r2); }\n"
						    << indent << "return;\n";
						return;
					}
				}
				if (shard_block_set.count(target_pc))
				{
					out << indent << "[[clang::musttail]] return __0x" << std::hex << target_pc << std::dec << "(exec, ctx, seg0, mem, r0, r1, r2);\n";
					return;
				}
				const std::string t_expr = pc_expr(target_pc);
				out << indent << "{ const uint32_t tgt_pc = " << t_expr << ";\n"
				    << indent << "  ctx->cia = tgt_pc;\n"
				    << indent << "  if (auto fn = lookup_table_fn(exec, tgt_pc)) { [[clang::musttail]] return fn(exec, ctx, lookup_page_seg0(exec, tgt_pc), mem, r0, r1, r2); }\n"
				    << indent << "  ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; return;\n"
				    << indent << "}\n";
				(void)cur_pc;
			};

			auto emit_dispatch_to_dyn = [&](const std::string& target_expr, uint32_t cur_pc, const std::string& indent)
			{
				out << indent << "{ const uint32_t dyn_pc = static_cast<uint32_t>(" << target_expr << ") & ~3u;\n";
				if (const auto* jt = wasm_codegen::lookup_jump_table_in(desc.jump_tables, cur_pc))
				{
					if (desc.is_relocatable_wasm)
					{
						out << indent << "  switch (dyn_pc - static_cast<uint32_t>(seg0)) {\n";
						for (uint32_t case_pc : jt->targets)
						{
							if (shard_block_set.count(case_pc) && case_pc >= desc.prx_base_addr)
							{
								out << indent << "    case 0x" << std::hex << (case_pc - desc.prx_base_addr) << std::dec << "u: [[clang::musttail]] return __0x"
								    << std::hex << case_pc << std::dec << "(exec, ctx, seg0, mem, r0, r1, r2);\n";
							}
						}
						out << indent << "    default: break;\n" << indent << "  }\n";
					}
					else
					{
						out << indent << "  switch (dyn_pc) {\n";
						for (uint32_t case_pc : jt->targets)
						{
							if (shard_block_set.count(case_pc))
							{
								out << indent << "    case 0x" << std::hex << case_pc << std::dec << "u: [[clang::musttail]] return __0x"
								    << std::hex << case_pc << std::dec << "(exec, ctx, seg0, mem, r0, r1, r2);\n";
							}
						}
						out << indent << "    default: break;\n" << indent << "  }\n";
					}
				}
				out << indent << "  ctx->cia = dyn_pc;\n"
				    << indent << "  if (auto fn = lookup_table_fn(exec, dyn_pc)) { [[clang::musttail]] return fn(exec, ctx, lookup_page_seg0(exec, dyn_pc), mem, r0, r1, r2); }\n";
				if (desc.is_relocatable_wasm && self_stub && self_stub->is_direct_hle)
				{
					out << indent << "  ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2;\n"
					    << indent << "  const uint32_t hle_ret = __hle_call_fnid(ctx, dyn_pc, 0x" << std::hex << self_stub->fnid << std::dec << "u);\n"
					    << indent << "  if (!hle_ret) return;\n"
					    << indent << "  r0 = ctx->gpr[0]; r1 = ctx->gpr[1]; r2 = ctx->gpr[2]; ctx->cia = hle_ret;\n"
					    << indent << "  if (auto fn = lookup_table_fn(exec, hle_ret)) { [[clang::musttail]] return fn(exec, ctx, lookup_page_seg0(exec, hle_ret), mem, r0, r1, r2); }\n"
					    << indent << "  return;\n"
					    << indent << "}\n";
				}
				else
				{
					out << indent << "  ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; return;\n"
					    << indent << "}\n";
				}
			};

			// Check if this block itself IS a .sceStub.text stub (for non-relocatable EBOOT.BIN)
			if (!desc.is_relocatable_wasm && self_stub && self_stub->is_direct_hle)
			{
				out << "  vm_write_be<uint64_t>(static_cast<uint32_t>(r1 + 40ull), r2);\n"
				    << "  ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; ctx->cia = 0x" << std::hex << bpc << std::dec << "u;\n"
				    << "  const uint32_t hle_ret = __hle_call_fnid(ctx, 0x" << std::hex << (self_stub->faddr | 0x80000000u) << "u, 0x" << self_stub->fnid << std::dec << "u);\n"
				    << "  if (!hle_ret) return;\n"
				    << "  r0 = ctx->gpr[0]; r1 = ctx->gpr[1]; r2 = ctx->gpr[2]; ctx->cia = hle_ret;\n"
				    << "  if (auto fn = lookup_table_fn(exec, hle_ret)) { [[clang::musttail]] return fn(exec, ctx, lookup_page_seg0(exec, hle_ret), mem, r0, r1, r2); }\n"
				    << "  return;\n}\n\n";
				continue;
			}

			bool terminated_block = false;
			for (size_t ii = 0; ii < insns.size(); ++ii)
			{
				const auto& ib = insns[ii];
				out << "  L_0x" << std::hex << ib.pc << std::dec << ":;\n";
				if (ib.rel_type != 0)
				{
					out << "  const uint16_t rel16_0x" << std::hex << ib.pc
					    << " = vm_read_be<uint16_t>(static_cast<uint32_t>(seg0) + 0x"
					    << (ib.pc - desc.prx_base_addr + 2u) << std::dec << "u);\n";
				}

				// Direct PowerPC atomic / system special opcodes before generic P-code
				const uint32_t op_prim = ib.raw_word >> 26;
				const uint32_t xo_31 = (ib.raw_word >> 1) & 0x3ffu;
				// sc (0x44000002)
				if (ib.raw_word == 0x44000002u)
				{
					const std::string next_pc_str = pc_expr(ib.pc + 4u);
					out << "  { const uint32_t sc_next_pc = " << next_pc_str << ";\n"
					    << "    ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2; ctx->cia = sc_next_pc;\n"
					    << "    __syscall(ctx, ctx->gpr[11]);\n"
					    << "    if (ctx->state != 0 || ctx->cia != sc_next_pc) return;\n"
					    << "    r0 = ctx->gpr[0]; r1 = ctx->gpr[1]; r2 = ctx->gpr[2]; }\n";
					continue;
				}
				// lwarx (31, xo=20) / ldarx (31, xo=84) / stwcx. (31, xo=150) / stdcx. (31, xo=214)
				if (op_prim == 31 && (xo_31 == 20 || xo_31 == 84 || xo_31 == 150 || xo_31 == 214))
				{
					const uint32_t rt = (ib.raw_word >> 21) & 31u;
					const uint32_t ra = (ib.raw_word >> 16) & 31u;
					const uint32_t rb = (ib.raw_word >> 11) & 31u;
					auto reg_ref = [](uint32_t r) -> std::string {
						if (r == 0) return "r0";
						if (r == 1) return "r1";
						if (r == 2) return "r2";
						return "ctx->gpr[" + std::to_string(r) + "]";
					};
					const std::string ea = ra ? ("(" + reg_ref(ra) + " + " + reg_ref(rb) + ")") : reg_ref(rb);
					out << "  ctx->gpr[0] = r0; ctx->gpr[1] = r1; ctx->gpr[2] = r2;\n";
					if (xo_31 == 20) out << "  " << reg_ref(rt) << " = __lwarx(ctx, static_cast<uint32_t>(" << ea << "));\n";
					else if (xo_31 == 84) out << "  " << reg_ref(rt) << " = __ldarx(ctx, static_cast<uint32_t>(" << ea << "));\n";
					else if (xo_31 == 150)
					{
						out << "  { const uint32_t ok = __stwcx(ctx, static_cast<uint32_t>(" << ea << "), static_cast<uint32_t>(" << reg_ref(rt) << "));\n"
						    << "    ctx->cr[0] = 0; ctx->cr[1] = 0; ctx->cr[2] = static_cast<uint8_t>(ok & 1u); ctx->cr[3] = ctx->so; }\n";
					}
					else
					{
						out << "  { const uint32_t ok = __stdcx(ctx, static_cast<uint32_t>(" << ea << "), " << reg_ref(rt) << ");\n"
						    << "    ctx->cr[0] = 0; ctx->cr[1] = 0; ctx->cr[2] = static_cast<uint8_t>(ok & 1u); ctx->cr[3] = ctx->so; }\n";
					}
					continue;
				}

				for (size_t pi = 0; pi < ib.pcode.size(); ++pi)
				{
					const auto& pop = ib.pcode[pi];
					out << "  P_" << ii << "_" << pi << ":;\n";
					auto rd = [&](size_t k) -> std::string
					{
						const auto& vn = pop.in[k];
						if (ib.rel_type != 0 && vn.space == const_space)
						{
							const std::string rvar = "rel16_" + hex_u32(ib.pc);
							const std::string ut = c_uint_type(vn.size);
							const std::string st = c_sint_type(vn.size);
							if (vn.offset == 0x7a5c0000ull)
							{
								if (op_prim == 15u)
								{
									return "static_cast<" + ut + ">((static_cast<uint64_t>(static_cast<int64_t>(static_cast<int16_t>(" + rvar + "))) << 16))";
								}
								return "static_cast<" + ut + ">((static_cast<uint64_t>(" + rvar + ") << 16))";
							}
							if (vn.offset == 0x7a5cull)
							{
								if (ib.rel_type == 57u || op_prim == 58u || op_prim == 62u)
								{
									return "static_cast<" + ut + ">(static_cast<" + st + ">(static_cast<int16_t>(" + rvar + " & ~3u)))";
								}
								if (op_prim == 10u || op_prim == 24u || op_prim == 26u || op_prim == 28u)
								{
									return "static_cast<" + ut + ">(" + rvar + ")";
								}
								return "static_cast<" + ut + ">(static_cast<" + st + ">(static_cast<int16_t>(" + rvar + ")))";
							}
							if (vn.offset == 0xffffffffffff85a4ull || vn.offset == 0xffff85a4ull)
							{
								return "static_cast<" + ut + ">(-static_cast<" + st + ">(static_cast<int16_t>(" + rvar + ")))";
							}
						}
						return read_varnode_expr(vn, const_space, uniq_space, reg_space);
					};
					auto wr = [&](const std::string& expr) { out << "  " << write_varnode_stmt(pop.out, expr, uniq_space, reg_space, uniq_ids) << "\n"; };
					const uint32_t osz = pop.has_out ? pop.out.size : 8;
					const uint32_t isz0 = pop.in.empty() ? 8 : pop.in[0].size;
					const std::string out_u = c_uint_type(osz);
					const std::string out_s = c_sint_type(osz);
					const std::string in0_u = c_uint_type(isz0);
					const std::string in0_s = c_sint_type(isz0);

					switch (pop.opc)
					{
					case ghidra::CPUI_COPY:
					case ghidra::CPUI_INT_ZEXT:
						if (desc.is_relocatable_wasm && pop.has_out && pop.out.space == reg_space &&
							pop.out.offset >= 0x1040u && pop.out.offset < 0x1048u &&
							pop.in.size() == 1 && pop.in[0].space == const_space)
						{
							wr("static_cast<" + out_u + ">(" + pc_expr(static_cast<uint32_t>(pop.in[0].offset)) + ")");
						}
						else
						{
							wr("static_cast<" + out_u + ">(" + rd(0) + ")");
						}
						break;
					case ghidra::CPUI_INT_SEXT:
						wr("static_cast<" + out_u + ">(static_cast<" + out_s + ">(static_cast<" + in0_s + ">(" + rd(0) + ")))");
						break;
					case ghidra::CPUI_SUBPIECE:
					{
						const uint64_t byte_shift = pop.in[1].offset * 8ull;
						wr("static_cast<" + out_u + ">((" + rd(0) + ") >> " + std::to_string(byte_shift) + ")");
						break;
					}
					case ghidra::CPUI_PIECE:
					{
						const uint32_t lo_bits = pop.in[1].size * 8u;
						wr("(static_cast<" + out_u + ">(" + rd(0) + ") << " + std::to_string(lo_bits) + ") | static_cast<" + out_u + ">(" + rd(1) + ")");
						break;
					}
					case ghidra::CPUI_LOAD:
						wr("vm_read_be<" + out_u + ">(static_cast<uint32_t>(" + rd(1) + "))");
						break;
					case ghidra::CPUI_STORE:
					{
						const std::string val_t = c_uint_type(pop.in[2].size);
						out << "  vm_write_be<" << val_t << ">(static_cast<uint32_t>(" << rd(1) << "), static_cast<" << val_t << ">(" << rd(2) << "));\n";
						break;
					}
					case ghidra::CPUI_INT_ADD: wr("(" + rd(0) + ") + (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_SUB: wr("(" + rd(0) + ") - (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_2COMP: wr("-(" + rd(0) + ")"); break;
					case ghidra::CPUI_INT_NEGATE: wr("~(" + rd(0) + ")"); break;
					case ghidra::CPUI_INT_XOR: wr("(" + rd(0) + ") ^ (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_AND: wr("(" + rd(0) + ") & (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_OR: wr("(" + rd(0) + ") | (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_LEFT:
						wr("((" + rd(1) + ") >= " + std::to_string(osz * 8u) + "u) ? 0 : ((" + rd(0) + ") << (" + rd(1) + "))");
						break;
					case ghidra::CPUI_INT_RIGHT:
						wr("((" + rd(1) + ") >= " + std::to_string(osz * 8u) + "u) ? 0 : (static_cast<" + in0_u + ">(" + rd(0) + ") >> (" + rd(1) + "))");
						break;
					case ghidra::CPUI_INT_SRIGHT:
						wr("static_cast<" + out_u + ">(((" + rd(1) + ") >= " + std::to_string(isz0 * 8u) + "u) ? (static_cast<" + in0_s + ">(" + rd(0) + ") >> " + std::to_string(isz0 * 8u - 1u) + ") : (static_cast<" + in0_s + ">(" + rd(0) + ") >> (" + rd(1) + ")))");
						break;
					case ghidra::CPUI_INT_MULT: wr("(" + rd(0) + ") * (" + rd(1) + ")"); break;
					case ghidra::CPUI_INT_DIV: wr("((" + rd(1) + ") == 0) ? 0 : ((" + rd(0) + ") / (" + rd(1) + "))"); break;
					case ghidra::CPUI_INT_SDIV: wr("((" + rd(1) + ") == 0) ? 0 : static_cast<" + out_u + ">(static_cast<" + in0_s + ">(" + rd(0) + ") / static_cast<" + in0_s + ">(" + rd(1) + "))"); break;
					case ghidra::CPUI_INT_REM: wr("((" + rd(1) + ") == 0) ? 0 : ((" + rd(0) + ") % (" + rd(1) + "))"); break;
					case ghidra::CPUI_INT_SREM: wr("((" + rd(1) + ") == 0) ? 0 : static_cast<" + out_u + ">(static_cast<" + in0_s + ">(" + rd(0) + ") % static_cast<" + in0_s + ">(" + rd(1) + "))"); break;
					case ghidra::CPUI_INT_EQUAL: wr("((" + rd(0) + ") == (" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_NOTEQUAL: wr("((" + rd(0) + ") != (" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_LESS: wr("(static_cast<" + in0_u + ">(" + rd(0) + ") < static_cast<" + in0_u + ">(" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_LESSEQUAL: wr("(static_cast<" + in0_u + ">(" + rd(0) + ") <= static_cast<" + in0_u + ">(" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_SLESS: wr("(static_cast<" + in0_s + ">(" + rd(0) + ") < static_cast<" + in0_s + ">(" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_SLESSEQUAL: wr("(static_cast<" + in0_s + ">(" + rd(0) + ") <= static_cast<" + in0_s + ">(" + rd(1) + ")) ? 1u : 0u"); break;
					case ghidra::CPUI_INT_CARRY:
						wr("(static_cast<" + in0_u + ">((" + rd(0) + ") + (" + rd(1) + ")) < static_cast<" + in0_u + ">(" + rd(0) + ")) ? 1u : 0u");
						break;
					case ghidra::CPUI_INT_SCARRY:
						wr("(((~((" + rd(0) + ") ^ (" + rd(1) + "))) & (((" + rd(0) + ") + (" + rd(1) + ")) ^ (" + rd(0) + "))) >> " + std::to_string(isz0 * 8u - 1u) + ") & 1u");
						break;
					case ghidra::CPUI_INT_SBORROW:
						wr("(((((" + rd(0) + ") ^ (" + rd(1) + "))) & (((" + rd(0) + ") - (" + rd(1) + ")) ^ (" + rd(0) + "))) >> " + std::to_string(isz0 * 8u - 1u) + ") & 1u");
						break;
					case ghidra::CPUI_BOOL_NEGATE: wr("((" + rd(0) + ") & 1u) ^ 1u"); break;
					case ghidra::CPUI_BOOL_XOR: wr("((" + rd(0) + ") ^ (" + rd(1) + ")) & 1u"); break;
					case ghidra::CPUI_BOOL_AND: wr("((" + rd(0) + ") & (" + rd(1) + ")) & 1u"); break;
					case ghidra::CPUI_BOOL_OR: wr("((" + rd(0) + ") | (" + rd(1) + ")) & 1u"); break;
					case ghidra::CPUI_POPCOUNT:
						wr("static_cast<" + out_u + ">(__builtin_popcountll(static_cast<uint64_t>(" + rd(0) + ")))");
						break;
					case ghidra::CPUI_LZCOUNT:
						if (isz0 == 4) wr("static_cast<" + out_u + ">(((" + rd(0) + ") == 0) ? 32u : __builtin_clz(static_cast<uint32_t>(" + rd(0) + ")))");
						else wr("static_cast<" + out_u + ">(((" + rd(0) + ") == 0) ? 64u : __builtin_clzll(static_cast<uint64_t>(" + rd(0) + ")))");
						break;
					case ghidra::CPUI_FLOAT_ADD:
					case ghidra::CPUI_FLOAT_SUB:
					case ghidra::CPUI_FLOAT_MULT:
					case ghidra::CPUI_FLOAT_DIV:
					{
						const char* fop = (pop.opc == ghidra::CPUI_FLOAT_ADD) ? "+" : (pop.opc == ghidra::CPUI_FLOAT_SUB ? "-" : (pop.opc == ghidra::CPUI_FLOAT_MULT ? "*" : "/"));
						if (osz == 4) wr("bit_cast_val<uint32_t>(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + ")) " + fop + " bit_cast_val<float>(static_cast<uint32_t>(" + rd(1) + ")))");
						else wr("bit_cast_val<uint64_t>(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + ")) " + fop + " bit_cast_val<double>(static_cast<uint64_t>(" + rd(1) + ")))");
						break;
					}
					case ghidra::CPUI_FLOAT_NEG:
						if (osz == 4) wr("bit_cast_val<uint32_t>(-bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + ")))");
						else wr("bit_cast_val<uint64_t>(-bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + ")))");
						break;
					case ghidra::CPUI_FLOAT_ABS:
						if (osz == 4) wr("bit_cast_val<uint32_t>(__builtin_fabsf(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + "))))");
						else wr("bit_cast_val<uint64_t>(__builtin_fabs(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + "))))");
						break;
					case ghidra::CPUI_FLOAT_SQRT:
						if (osz == 4) wr("bit_cast_val<uint32_t>(__builtin_sqrtf(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + "))))");
						else wr("bit_cast_val<uint64_t>(__builtin_sqrt(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + "))))");
						break;
					case ghidra::CPUI_FLOAT_FLOAT2FLOAT:
						if (isz0 == 4 && osz == 8) wr("bit_cast_val<uint64_t>(static_cast<double>(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + "))))");
						else if (isz0 == 8 && osz == 4) wr("bit_cast_val<uint32_t>(static_cast<float>(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + "))))");
						break;
					case ghidra::CPUI_FLOAT_INT2FLOAT:
						if (osz == 8) wr("bit_cast_val<uint64_t>(static_cast<double>(static_cast<" + in0_s + ">(" + rd(0) + ")))");
						else wr("bit_cast_val<uint32_t>(static_cast<float>(static_cast<" + in0_s + ">(" + rd(0) + ")))");
						break;
					case ghidra::CPUI_FLOAT_TRUNC:
						if (isz0 == 8) wr("static_cast<" + out_u + ">(static_cast<" + out_s + ">(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + "))))");
						else wr("static_cast<" + out_u + ">(static_cast<" + out_s + ">(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + "))))");
						break;
					case ghidra::CPUI_FLOAT_EQUAL:
					case ghidra::CPUI_FLOAT_NOTEQUAL:
					case ghidra::CPUI_FLOAT_LESS:
					case ghidra::CPUI_FLOAT_LESSEQUAL:
					{
						const char* cmp = (pop.opc == ghidra::CPUI_FLOAT_EQUAL) ? "==" : (pop.opc == ghidra::CPUI_FLOAT_NOTEQUAL ? "!=" : (pop.opc == ghidra::CPUI_FLOAT_LESS ? "<" : "<="));
						if (isz0 == 4) wr("(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + ")) " + cmp + " bit_cast_val<float>(static_cast<uint32_t>(" + rd(1) + "))) ? 1u : 0u");
						else wr("(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + ")) " + cmp + " bit_cast_val<double>(static_cast<uint64_t>(" + rd(1) + "))) ? 1u : 0u");
						break;
					}
					case ghidra::CPUI_FLOAT_NAN:
						if (isz0 == 4) wr("__builtin_isnan(bit_cast_val<float>(static_cast<uint32_t>(" + rd(0) + "))) ? 1u : 0u");
						else wr("__builtin_isnan(bit_cast_val<double>(static_cast<uint64_t>(" + rd(0) + "))) ? 1u : 0u");
						break;
					case ghidra::CPUI_BRANCH:
					case ghidra::CPUI_CALL:
					{
						if (pop.in[0].space == const_space)
						{
							const int32_t rel = static_cast<int32_t>(pop.in[0].offset);
							const int32_t tgt = static_cast<int32_t>(pi) + rel;
							if (tgt >= 0 && static_cast<size_t>(tgt) < ib.pcode.size())
							{
								out << "  goto P_" << ii << "_" << tgt << ";\n";
							}
							else if (ii + 1 < insns.size())
							{
								out << "  goto L_0x" << std::hex << insns[ii + 1].pc << std::dec << ";\n";
							}
						}
						else
						{
							const uint32_t target_pc = static_cast<uint32_t>(pop.in[0].offset);
							if (target_pc >= bpc && target_pc < bpc + bsz && target_pc != bpc)
							{
								out << "  goto L_0x" << std::hex << target_pc << std::dec << ";\n";
							}
							else
							{
								emit_dispatch_to_const(target_pc, ib.pc, "  ");
								if (ii + 1 == insns.size() && pi + 1 == ib.pcode.size()) terminated_block = true;
							}
						}
						break;
					}
					case ghidra::CPUI_CBRANCH:
					{
						out << "  if ((" << rd(1) << ") != 0) {\n";
						if (pop.in[0].space == const_space)
						{
							const int32_t rel = static_cast<int32_t>(pop.in[0].offset);
							const int32_t tgt = static_cast<int32_t>(pi) + rel;
							if (tgt >= 0 && static_cast<size_t>(tgt) < ib.pcode.size())
							{
								out << "    goto P_" << ii << "_" << tgt << ";\n";
							}
							else if (ii + 1 < insns.size())
							{
								out << "    goto L_0x" << std::hex << insns[ii + 1].pc << std::dec << ";\n";
							}
							else
							{
								emit_dispatch_to_const(bpc + bsz, ib.pc, "    ");
							}
						}
						else
						{
							const uint32_t target_pc = static_cast<uint32_t>(pop.in[0].offset);
							if (target_pc >= bpc && target_pc < bpc + bsz && target_pc != bpc)
							{
								out << "    goto L_0x" << std::hex << target_pc << std::dec << ";\n";
							}
							else
							{
								emit_dispatch_to_const(target_pc, ib.pc, "    ");
							}
						}
						out << "  }\n";
						break;
					}
					case ghidra::CPUI_BRANCHIND:
					case ghidra::CPUI_CALLIND:
					case ghidra::CPUI_RETURN:
						emit_dispatch_to_dyn(rd(0), ib.pc, "  ");
						if (ii + 1 == insns.size() && pi + 1 == ib.pcode.size()) terminated_block = true;
						break;
					case ghidra::CPUI_CALLOTHER:
						if (pop.has_out) wr("0");
						break;
					default:
						break;
					}
				}
			}

			if (!terminated_block)
			{
				emit_dispatch_to_const(bpc + bsz, bpc + bsz - 4, "  ");
			}
			out << "}\n\n";
		}

		// Emit __ppu_blocks_<suffix> and __ppu_block_index_<suffix> exports matching RPCS3's Wasm ABI!
		out << "struct BlockTable_" << shard_suffix << " {\n"
		    << "  uint32_t count;\n"
		    << "  uint32_t addrs[" << std::max<size_t>(1, emitted_addrs.size()) << "];\n"
		    << "};\n"
		    << "extern \"C\" __attribute__((visibility(\"default\"))) const BlockTable_" << shard_suffix
		    << " __ppu_blocks_" << shard_suffix << " = {\n"
		    << "  " << emitted_addrs.size() << "u,\n  {";
		for (size_t i = 0; i < emitted_addrs.size(); ++i)
		{
			if (i > 0) out << ", ";
			const uint32_t table_addr = desc.is_relocatable_wasm
				? (emitted_addrs[i] - desc.prx_base_addr)
				: emitted_addrs[i];
			out << "0x" << std::hex << table_addr << std::dec << "u";
		}
		if (emitted_addrs.empty()) out << "0u";
		out << "}\n};\n\n"
		    << "extern \"C\" __attribute__((visibility(\"default\"))) uint32_t __ppu_block_index_" << shard_suffix << "(uint32_t i) {\n"
		    << "  switch (i) {\n";
		for (size_t i = 0; i < emitted_addrs.size(); ++i)
		{
			out << "    case " << i << "u: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&__0x"
			    << std::hex << emitted_addrs[i] << std::dec << "));\n";
		}
		out << "    default: return 0u;\n  }\n}\n";

		cpp_out = out.str();
		return true;
	}
}
