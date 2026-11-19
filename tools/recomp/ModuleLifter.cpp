#include "stdafx.h"
#include "ModuleLifter.h"
#include "FunctionRangeMerge.h"
#include "GhidraCppLifter.h"

#include "Emu/Cell/PPUAnalyser.h"
#include "Emu/Cell/PPUTranslator.h"
#include "Emu/Cell/lv2/sys_sync.h"
#include "Utilities/File.h"
#include "Utilities/JIT.h"

#include "llvm/IR/Constants.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/GlobalVariable.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/TargetParser/Triple.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <map>
#include <set>

extern const ppu_decoder<ppu_itype> g_ppu_itype;

namespace ps3recomp
{
	namespace
	{
		void append_non_dominating_uses(llvm::Module& module, llvm::raw_ostream& out)
		{
			unsigned printed = 0;
			for (auto& function : module)
			{
				if (function.isDeclaration()) continue;
				llvm::DominatorTree dom(function);
				for (auto& block : function)
				{
					for (auto& inst : block)
					{
						if (llvm::isa<llvm::PHINode>(inst)) continue;
						for (const llvm::Use& use : inst.operands())
						{
							const auto* def = llvm::dyn_cast_or_null<llvm::Instruction>(use.get());
							if (!def || def->getFunction() != &function || dom.dominates(def, &inst)) continue;
							out << "non-dominating operand in " << function.getName() << " block " << block.getName()
								<< ": def in " << def->getParent()->getName() << " `" << *def << "` used by `" << inst << "`\n";
							out << "  def terminator: " << *def->getParent()->getTerminator() << "\n";
							out << "  use predecessors:";
							for (const auto* pred : llvm::predecessors(&block)) out << " " << pred->getName();
							out << " terminator: " << *block.getTerminator() << "\n";
							if (++printed == 8) return;
						}
					}
				}
			}
		}

		std::string sanitize_symbol(std::string_view s)
		{
			std::string out(s);
			for (char& c : out)
			{
				if (!std::isalnum(static_cast<unsigned char>(c))) c = '_';
			}
			if (out.empty()) out = "part";
			return out;
		}

		// The analyser can retain an island whose start is executable but whose
		// inferred size crosses the end of the containing segment. Clamp every
		// planned range to one executable segment before it reaches
		// PPUTranslator, which treats an unmapped instruction as a fatal error.
		uint32_t executable_extent(const ModuleDescriptor& desc, uint32_t addr, uint32_t requested)
		{
			if (!requested || (addr & 3u))
			{
				return 0;
			}

			for (const auto& seg : desc.segments)
			{
				const uint32_t end = seg.vaddr + seg.memsz;
				if ((seg.flags & 1u) && addr >= seg.vaddr && addr < end)
				{
					return std::min<uint32_t>(requested, end - addr) & ~3u;
				}
			}

			return 0;
		}

		// Split any merged basic block [addr, addr + size) in funcs whenever an indirect target
		// (recovered jump-table case, OPD function entry, or .sceStub.text trampoline) lands mid-block!
		uint32_t split_blocks_at_targets(std::vector<ppu_function>& funcs, const std::set<uint32_t>& targets)
		{
			if (funcs.empty() || targets.empty()) return 0;
			std::sort(funcs.begin(), funcs.end(),
				[](const ppu_function& a, const ppu_function& b) { return a.addr < b.addr; });

			std::vector<ppu_function> out;
			out.reserve(funcs.size() + targets.size());
			uint32_t splits = 0;

			for (const auto& fn : funcs)
			{
				if (!fn.size) continue;
				uint32_t cur_addr = fn.addr;
				const uint32_t end_addr = fn.addr + fn.size;
				auto it = targets.upper_bound(cur_addr);
				while (it != targets.end() && *it < end_addr)
				{
					const uint32_t split_pc = *it++;
					if ((split_pc & 3u) != 0 || split_pc <= cur_addr) continue;
					ppu_function head;
					head.addr = cur_addr;
					head.toc = fn.toc;
					head.size = split_pc - cur_addr;
					out.push_back(std::move(head));
					cur_addr = split_pc;
					++splits;
				}
				if (cur_addr < end_addr)
				{
					ppu_function tail;
					tail.addr = cur_addr;
					tail.toc = fn.toc;
					tail.size = end_addr - cur_addr;
					out.push_back(std::move(tail));
				}
			}

			std::sort(out.begin(), out.end(),
				[](const ppu_function& a, const ppu_function& b)
				{
					return (a.addr != b.addr) ? (a.addr < b.addr) : (a.size < b.size);
				});
			out.erase(std::unique(out.begin(), out.end(),
				[](const ppu_function& a, const ppu_function& b) { return a.addr == b.addr; }), out.end());
			for (size_t i = 0; i + 1 < out.size(); ++i)
			{
				if (out[i].addr + out[i].size > out[i + 1].addr)
				{
					out[i].size = out[i + 1].addr - out[i].addr;
				}
			}
			funcs = std::move(out);
			return splits;
		}

		// Preserve the analyser's function identity while splitting individual
		// basic blocks at recovered jump-table cases, OPD entries, and stubs.
		// A block is the runtime dispatch unit; a function is the AOT compile and
		// optimization unit.
		uint32_t split_function_blocks_at_targets(std::vector<ppu_function>& funcs, const std::set<uint32_t>& targets)
		{
			if (funcs.empty())
			{
				return 0;
			}

			uint32_t splits = 0;

			for (auto& fn : funcs)
			{
				if (!fn.size)
				{
					continue;
				}

				if (fn.blocks.empty())
				{
					fn.blocks.emplace(fn.addr, fn.size);
				}

				std::map<uint32_t, uint32_t> split;
				const uint32_t function_end = fn.addr + fn.size;

				for (const auto& [block_addr, block_size] : fn.blocks)
				{
					if (!block_size || block_addr < fn.addr || block_addr >= function_end)
					{
						continue;
					}

					const uint32_t block_end = std::min<uint32_t>(block_addr + block_size, function_end);
					uint32_t cursor = block_addr;

					for (auto it = targets.upper_bound(cursor); it != targets.end() && *it < block_end; ++it)
					{
						const uint32_t target = *it;
						if ((target & 3u) || target <= cursor)
						{
							continue;
						}

						split.emplace(cursor, target - cursor);
						cursor = target;
						++splits;
					}

					if (cursor < block_end)
					{
						split.emplace(cursor, block_end - cursor);
					}
				}

				if (!split.empty())
				{
					fn.blocks = std::move(split);
				}
			}

			return splits;
		}

		std::vector<PlannedFunctionInfo> summarize_functions(const std::vector<ppu_function>& funcs)
		{
			std::vector<PlannedFunctionInfo> out;
			out.reserve(funcs.size());
			for (const auto& fn : funcs)
			{
				out.push_back(PlannedFunctionInfo{fn.addr, fn.toc, fn.size, ::size32(fn.blocks)});
			}
			return out;
		}

		void populate_ppu_module_from_desc(const ModuleDescriptor& desc, ppu_module<lv2_obj>& info)
		{
			info.name = desc.name;
			info.path = desc.name;
			info.is_relocatable = desc.is_relocatable_wasm;
			if (desc.is_relocatable_wasm)
			{
				info.relocs.reserve(desc.relocs.size());
				for (const auto& r : desc.relocs)
				{
					info.relocs.push_back(ppu_reloc{r.addr, r.type, r.data});
				}
				std::stable_sort(info.relocs.begin(), info.relocs.end());
			}

			for (size_t i = 0; i < desc.segments.size(); ++i)
			{
				const auto& s = desc.segments[i];
				if (!s.memsz) continue;
				info.segs.push_back(ppu_segment{
					s.vaddr,
					s.memsz,
					1u,
					s.flags,
					s.filesz,
					const_cast<uint8_t*>(s.data.data())
				});
				info.addr_to_seg_index.emplace(s.vaddr, ::size32(info.segs) - 1);
			}
		}
	}

	bool plan_module_blocks(
		ModuleDescriptor& desc,
		const LiftOptions& opts,
		std::vector<BlockPlanEntry>& out_blocks,
		std::string& out_clean_mod,
		uint32_t& out_splits,
		std::string& err,
		PlanDiagnostics* diagnostics)
	{
		out_blocks.clear();
		out_clean_mod.clear();
		out_splits = 0;
		if (diagnostics)
		{
			*diagnostics = {};
		}

		if (desc.segments.empty())
		{
			err = "ModuleDescriptor has no segments";
			return false;
		}

		// Step 1: Recover indirect bctr switch tables via Ghidra 12.1.3 SLEIGH JumpTable analysis
		const std::string gh_home = opts.ghidra_home.empty() ? default_ghidra_home() : opts.ghidra_home;
		std::error_code fs_ec;
		if (opts.recover_jump_tables && desc.jump_tables.empty() && std::filesystem::is_directory(gh_home, fs_ec))
		{
			std::string jt_err;
			if (!recover_jump_tables_with_ghidra(desc, gh_home, jt_err))
			{
				if (opts.frontend == LiftFrontend::GhidraCpp)
				{
					err = jt_err;
					return false;
				}
			}
		}

		// Step 2: Run RPCS3's whole-binary PPUAnalyser across 100% of executable code (unfiltered!)
		ppu_module<lv2_obj> info;
		populate_ppu_module_from_desc(desc, info);

		const uint32_t analyse_entry = desc.is_prx ? 0u : desc.entry_opd;
		if (!info.analyse(desc.entry_toc, analyse_entry, desc.seg0_code_end, {}, desc.exported_funcs))
		{
			err = "ppu_module::analyse failed for " + desc.name;
			return false;
		}

		// The analyser now retains whole functions and their block maps. Fall back
		// to its flattened block list only for modules produced by older callers.
		std::vector<ppu_function> planned_functions = std::move(info.functions);
		if (planned_functions.empty())
		{
			planned_functions.reserve(info.funcs.size());
			for (const auto& block : info.funcs)
			{
				if (!block.size)
				{
					continue;
				}

				ppu_function fn;
				fn.addr = block.addr;
				fn.toc = block.toc;
				fn.size = block.size;
				fn.blocks.emplace(block.addr, block.size);
				planned_functions.push_back(std::move(fn));
			}
		}

		if (diagnostics)
		{
			diagnostics->analyzer_functions = summarize_functions(planned_functions);
		}

		const uint32_t merged_functions = merge_overlapping_function_ranges(
			planned_functions,
			diagnostics ? &diagnostics->merge_groups : nullptr);
		if (diagnostics)
		{
			diagnostics->merged_functions = merged_functions;
		}

		// The block pass can recover executable islands outside every function
		// accepted by the function analyser. Keep those dispatchable rather than
		// dropping them when a whole-function snapshot is available.
		for (const auto& block : info.funcs)
		{
			if (!block.size || !desc.is_exec_addr(block.addr))
			{
				continue;
			}

			const bool covered = std::any_of(planned_functions.begin(), planned_functions.end(), [&](const ppu_function& fn)
			{
				return block.addr >= fn.addr && block.addr < fn.addr + fn.size;
			});

			if (covered)
			{
				continue;
			}

			ppu_function standalone;
			standalone.addr = block.addr;
			standalone.toc = block.toc;
			standalone.size = block.size;
			standalone.blocks.emplace(block.addr, block.size);
			planned_functions.push_back(std::move(standalone));
		}

		// Step 3: Split basic blocks at every existing block start, recovered JumpTable case target, OPD entry, and .sceStub.text stub!
		std::set<uint32_t> mandatory_entries;
		for (const auto& fn : planned_functions)
		{
			if (!fn.size || !desc.is_exec_addr(fn.addr)) continue;
			mandatory_entries.insert(fn.addr);
			for (const auto& [block_addr, block_size] : fn.blocks)
			{
				if (block_size && desc.is_exec_addr(block_addr)) mandatory_entries.insert(block_addr);
			}
		}
		for (const auto& jt : desc.jump_tables)
		{
			for (uint32_t tpc : jt.targets)
			{
				if (desc.is_exec_addr(tpc)) mandatory_entries.insert(tpc);
			}
		}
		for (const auto& opd : desc.opds)
		{
			if (desc.is_exec_addr(opd.func_pc)) mandatory_entries.insert(opd.func_pc);
		}
		for (const auto& st : desc.stubs)
		{
			if (desc.is_exec_addr(st.stub_pc)) mandatory_entries.insert(st.stub_pc);
		}

		// Calls and syscalls return through the architectural link register to
		// the following instruction. That continuation is an indirect dispatch
		// entry at run time even when the analyser kept it inside a larger basic
		// block, so split it out before assigning AOT table slots.
		for (const auto& fn : planned_functions)
		{
			if (!fn.size)
			{
				continue;
			}

			const uint32_t end = fn.addr + executable_extent(desc, fn.addr, fn.size);
			for (uint32_t addr = fn.addr; addr + 4 <= end; addr += 4)
			{
				const ppu_opcode_t op{*ensure(info.get_ptr<u32>(addr))};
				const auto type = g_ppu_itype.decode(op.opcode);
				const bool linked_branch = (type == ppu_itype::B || type == ppu_itype::BC || type == ppu_itype::BCLR || type == ppu_itype::BCCTR) && op.lk;
				if ((linked_branch || type == ppu_itype::SC) && desc.is_exec_addr(addr + 4))
				{
					mandatory_entries.insert(addr + 4);
				}
			}
		}
		out_splits = split_function_blocks_at_targets(planned_functions, mandatory_entries);
		if (diagnostics)
		{
			diagnostics->compile_functions = summarize_functions(planned_functions);
		}

		// Also add any .sceStub.text 32-byte trampolines not covered by the analyser.
		{
			for (const auto& st : desc.stubs)
			{
				const bool covered = std::any_of(planned_functions.begin(), planned_functions.end(), [&](const ppu_function& fn)
				{
					return st.stub_pc >= fn.addr && st.stub_pc < fn.addr + fn.size;
				});

				if (st.stub_pc && desc.is_exec_addr(st.stub_pc) && !covered)
				{
					ppu_function sf;
					sf.addr = st.stub_pc;
					sf.size = 32;
					sf.blocks.emplace(sf.addr, sf.size);
					planned_functions.push_back(std::move(sf));
				}
			}
			std::sort(planned_functions.begin(), planned_functions.end(),
				[](const ppu_function& a, const ppu_function& b) { return a.addr < b.addr; });
		}

		if (planned_functions.empty())
		{
			err = "No executable PPU blocks discovered in " + desc.name;
			return false;
		}

		for (const auto& fn : planned_functions)
		{
			const uint32_t function_size = executable_extent(desc, fn.addr, fn.size);
			if (!function_size) continue;

			if (fn.blocks.empty())
			{
				out_blocks.push_back(BlockPlanEntry{fn.addr, fn.toc, function_size, fn.addr, function_size});
				continue;
			}

			for (const auto& [block_addr, block_size] : fn.blocks)
			{
				if (const uint32_t executable_size = executable_extent(desc, block_addr, block_size))
				{
					out_blocks.push_back(BlockPlanEntry{block_addr, fn.toc, executable_size, fn.addr, function_size});
				}
			}
		}

		std::sort(out_blocks.begin(), out_blocks.end(), [](const BlockPlanEntry& a, const BlockPlanEntry& b)
		{
			return a.addr != b.addr ? a.addr < b.addr : a.function_addr < b.function_addr;
		});
		out_clean_mod = sanitize_symbol(desc.name) + "_" + desc.sha1_hex.substr(0, 8);
		return !out_blocks.empty();
	}

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
		std::string& err)
	{
		using namespace llvm;
		out_mod.reset();
		out_emitted_addrs.clear();

		if (pos >= end_pos || end_pos > all_blocks.size())
		{
			err = "Invalid shard block range for " + suffix;
			return false;
		}

		ppu_module<lv2_obj> info;
		populate_ppu_module_from_desc(desc, info);

		std::map<uint32_t, ppu_function> planned_functions;
		for (size_t k = pos; k < end_pos; ++k)
		{
			const auto& b = all_blocks[k];
			const uint32_t block_size = executable_extent(desc, b.addr, b.size);
			if (!block_size)
			{
				continue;
			}

			const uint32_t function_addr = desc.is_exec_addr(b.function_addr) ? b.function_addr : b.addr;
			const uint32_t function_size = executable_extent(desc, function_addr, b.function_size ? b.function_size : block_size);
			auto& fn = planned_functions[function_addr];

			if (!fn.addr)
			{
				fn.addr = function_addr;
				fn.toc = b.toc;
				fn.size = function_size ? function_size : block_size;
			}

			fn.blocks[b.addr] = block_size;
		}

		if (planned_functions.empty())
		{
			err = "No executable PPU blocks in shard " + suffix;
			return false;
		}

		info.funcs.reserve(planned_functions.size());
		for (auto& [addr, fn] : planned_functions)
		{
			if (fn.blocks.empty())
			{
				fn.blocks.emplace(fn.addr, fn.size);
			}

			info.funcs.push_back(std::move(fn));
		}

		ppu_module<lv2_obj> part;
		part.copy_part(info);
		part.local_bounds = {info.funcs.front().addr, info.funcs.back().addr + 1u};

		const auto branch_mode = return_to_dispatcher
			? ppu_wasm_branch_mode::return_to_dispatcher
			: ppu_wasm_branch_mode::tail_call;

		auto mod = std::make_unique<Module>(suffix, jit.get_context());
		mod->setTargetTriple(Triple("wasm32-unknown-unknown"));
		mod->setDataLayout(DataLayout("e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128"));

#ifdef RPCS3_WEB
		PPUTranslator translator(jit.get_context(), mod.get(), part, jit.get_target_machine(), true, branch_mode);
#else
		PPUTranslator translator(jit.get_context(), mod.get(), part, jit.get_engine(), true, branch_mode);
#endif
		const auto fn_ty = FunctionType::get(translator.get_type<void>(), {
			translator.get_type<u8*>(),
			translator.get_type<u8*>(),
			translator.get_type<u64>(),
			translator.get_type<u8*>(),
			translator.get_type<u64>(),
			translator.get_type<u64>(),
			translator.get_type<u64>(),
		}, false);

		const uint32_t reloc_base = part.is_relocatable ? part.segs[0].addr : 0u;
		for (const auto& fn : part.get_funcs())
		{
			if (!fn.size) continue;
			auto* f = cast<Function>(mod->getOrInsertFunction(fmt::format("__0x%x", fn.addr - reloc_base), fn_ty).getCallee());
			f->setCallingConv(CallingConv::C);
			f->addParamAttr(1, Attribute::NoAlias);
			f->addFnAttr(Attribute::NoUnwind);
			f->setVisibility(GlobalValue::HiddenVisibility);
		}

		std::map<uint32_t, Function*> blocks;
		for (const auto& fn : part.get_funcs())
		{
			if (!fn.size) continue;
			Function* translated = translator.Translate(fn);
			if (!translated)
			{
				err = fmt::format("PPUTranslator::Translate failed at 0x%x in %s", fn.addr, desc.name);
				return false;
			}
			const uint32_t emitted_pc = fn.addr - reloc_base;
			blocks.emplace(emitted_pc, translated);

			for (const auto& [block_addr, block_size] : fn.blocks)
			{
				if (block_size)
				{
					blocks.emplace(block_addr - reloc_base, translated);
				}
			}
		}

		out_emitted_addrs.reserve(blocks.size());
		for (const auto& [addr, _] : blocks)
		{
			out_emitted_addrs.push_back(addr);
		}

		std::vector<Constant*> addrs_const;
		addrs_const.reserve(blocks.size());
		for (const auto& [addr, _] : blocks)
		{
			addrs_const.push_back(ConstantInt::get(translator.get_type<u32>(), addr));
		}
		auto* arr_ty = ArrayType::get(translator.get_type<u32>(), addrs_const.size());
		auto* tbl_ty = StructType::get(jit.get_context(), {translator.get_type<u32>(), arr_ty});
		auto* tbl_init = ConstantStruct::get(tbl_ty, {
			ConstantInt::get(translator.get_type<u32>(), ::size32(addrs_const)),
			ConstantArray::get(arr_ty, addrs_const)
		});
		auto* tbl_gv = new GlobalVariable(*mod, tbl_ty, true, GlobalValue::ExternalLinkage, tbl_init, "__ppu_blocks_" + suffix);
		tbl_gv->setAlignment(Align(4));

		auto* idx_ty = FunctionType::get(translator.get_type<u32>(), {translator.get_type<u32>()}, false);
		auto* idx_fn = cast<Function>(mod->getOrInsertFunction("__ppu_block_index_" + suffix, idx_ty).getCallee());
		idx_fn->setCallingConv(CallingConv::C);
		IRBuilder<> irb(BasicBlock::Create(jit.get_context(), "entry", idx_fn));
		auto* exit_bb = BasicBlock::Create(jit.get_context(), "none", idx_fn);
		auto* sw = irb.CreateSwitch(idx_fn->getArg(0), exit_bb, ::size32(blocks));
		uint32_t bi = 0;
		for (const auto& [_, function] : blocks)
		{
			auto* bb = BasicBlock::Create(jit.get_context(), "", idx_fn);
			sw->addCase(irb.getInt32(bi), bb);
			irb.SetInsertPoint(bb);
			irb.CreateRet(irb.CreatePtrToInt(function, translator.get_type<u32>()));
			++bi;
		}
		irb.SetInsertPoint(exit_bb);
		irb.CreateRet(ConstantInt::get(translator.get_type<u32>(), 0));

		std::string verify_err;
		raw_string_ostream vout(verify_err);
		if (verifyModule(*mod, &vout))
		{
			vout.flush();
			std::string dominance_err;
			raw_string_ostream dominance_out(dominance_err);
			append_non_dominating_uses(*mod, dominance_out);
			dominance_out.flush();
			err = "LLVM IR verification failed in " + suffix + ": " + dominance_err + verify_err;
			return false;
		}

		out_mod = std::move(mod);
		return true;
	}

	bool lift_module(
		ModuleDescriptor& desc,
		const LiftOptions& opts,
		LiftResult& out,
		std::string& err)
	{
		out = {};
		std::vector<BlockPlanEntry> all_blocks;
		std::string clean_mod;
		if (!plan_module_blocks(desc, opts, all_blocks, clean_mod, out.jump_table_splits, err))
		{
			return false;
		}

		if (!opts.ranges.empty())
		{
			all_blocks.erase(std::remove_if(all_blocks.begin(), all_blocks.end(), [&](const BlockPlanEntry& block)
			{
				return std::none_of(opts.ranges.begin(), opts.ranges.end(), [&](const auto& range)
				{
					const uint32_t block_end = block.addr + block.size;
					const uint32_t function_end = block.function_addr + block.function_size;
					return block.addr < range.second && block_end > range.first
						|| block.function_addr < range.second && function_end > range.first;
				});
			}), all_blocks.end());
		}

		const std::string gh_home = opts.ghidra_home.empty() ? default_ghidra_home() : opts.ghidra_home;
		const uint32_t shard_cap = std::max<uint32_t>(64u, opts.max_blocks_per_shard);

		uint32_t shard_idx = 0;
		for (size_t pos = 0; pos < all_blocks.size(); ++shard_idx)
		{
			size_t end_pos = std::min(all_blocks.size(), pos + shard_cap);

			// A shard boundary may not cut through a function. Keep direct CFG
			// edges and function-local register state in one compilation unit.
			while (end_pos < all_blocks.size() && all_blocks[end_pos].function_addr == all_blocks[end_pos - 1].function_addr)
			{
				++end_pos;
			}
			char sname_buf[64];
			std::snprintf(sname_buf, sizeof(sname_buf), "part_%03u", shard_idx);
			const std::string shard_name(sname_buf);
			const std::string suffix = clean_mod + "_" + shard_name;

			LiftedShard shard;
			shard.shard_name = shard_name;
			shard.symbol_suffix = suffix;
			shard.frontend = opts.frontend;

			if (opts.frontend == LiftFrontend::GhidraCpp)
			{
				std::vector<std::pair<uint32_t, uint32_t>> pairs;
				pairs.reserve(end_pos - pos);
				for (size_t k = pos; k < end_pos; ++k)
				{
					if (all_blocks[k].size)
					{
						pairs.emplace_back(all_blocks[k].addr, all_blocks[k].size);
						shard.block_addrs.push_back(all_blocks[k].addr);
					}
				}
				if (!lift_blocks_to_ghidra_cpp(desc, pairs, suffix, gh_home, opts.ghidra_decomp_comments, shard.text, err))
				{
					return false;
				}
			}
			else
			{
				jit_compiler jit({}, "");
				std::unique_ptr<llvm::Module> mod;
				if (!lift_planned_shard_to_llvm(desc, all_blocks, pos, end_pos, suffix, opts.return_to_dispatcher, jit, mod, shard.block_addrs, err))
				{
					return false;
				}
				llvm::raw_string_ostream ll_out(shard.text);
				ll_out << *mod;
				ll_out.flush();
			}

			out.total_blocks += static_cast<uint32_t>(shard.block_addrs.size());
			out.ppu_shards.push_back(std::move(shard));
			pos = end_pos;
		}

		return true;
	}
}
