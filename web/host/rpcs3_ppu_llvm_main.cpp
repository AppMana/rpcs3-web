// Browser PPU LLVM tier: RPCS3's PPUTranslator in its wasm mode, lowered by LLVM's WebAssembly
// backend and wasm-ld inside the same compiler worker that hosts the SPU tier
// (web/public/rpcs3-spu-llvm-worker.mjs). Input is one block of guest code and its address, output
// a dylink side module the runtime registers as that block's dispatch entry
// (rpcs3/Emu/Cell/PPUWebRecompiler.cpp).
//
// The block is self-contained by construction: in wasm mode the translator reaches guest memory
// through the runtime's rpcs3_web_vm_*_raw imports and every branch that leaves the block goes
// through the guest-address table, so nothing outside these bytes has to travel with the request.
#include "stdafx.h"
#include "Emu/system_config.h"
#include "Emu/Cell/PPUAnalyser.h"
#include "Emu/Cell/PPUTranslator.h"
#include "Emu/Cell/lv2/sys_sync.h"

#include "Utilities/JIT.h"
#include "../tools/recomp/ModuleExtractor.h"
#include "../tools/recomp/ModuleLifter.h"
#include "../tools/recomp/ModuleCompiler.h"

#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/TargetParser/Triple.h"

#include <cstring>
#include <emscripten.h>
#include <memory>
#include <string>
#include <vector>

namespace
{
	std::unique_ptr<jit_compiler> s_ppu_jit;
	std::vector<u8> s_ppu_output;
	std::string s_ppu_error;
	ppu_wasm_branch_mode s_branch_mode = ppu_wasm_branch_mode::tail_call;
}

extern "C"
{
	EMSCRIPTEN_KEEPALIVE void rpcs3_ppu_llvm_return_dispatch(int enabled)
	{
		s_branch_mode = enabled ? ppu_wasm_branch_mode::return_to_dispatcher : ppu_wasm_branch_mode::tail_call;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_ppu_llvm_inline_reads(int enabled)
	{
		setenv("RPCS3_PPU_WASM_INLINE_READS", enabled ? "1" : "0", 1);
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_ppu_llvm_inline_writes(int enabled)
	{
		setenv("RPCS3_PPU_WASM_INLINE_WRITES", enabled ? "1" : "0", 1);
	}

	EMSCRIPTEN_KEEPALIVE int rpcs3_ppu_llvm_init()
	{
		if (!s_ppu_jit)
		{
			s_ppu_jit = std::make_unique<jit_compiler>(std::unordered_map<std::string, u64>{}, "");
		}

		return s_ppu_jit ? 1 : 0;
	}

	// Returns the side module size (0 on failure; rpcs3_ppu_llvm_error explains)
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_ppu_llvm_compile(u32 addr, u32 size, const u8* code, u32 attr)
	{
		using namespace llvm;

		s_ppu_output.clear();
		s_ppu_error.clear();

		if (!s_ppu_jit || !size || (size & 3) || (addr & 3) || !code)
		{
			s_ppu_error = "bad request";
			return 0;
		}

		ppu_module<lv2_obj> info;
		info.name = fmt::format("__0x%x", addr);
		info.path = info.name;
		info.is_relocatable = false;

		if (attr & (1u << static_cast<u32>(ppu_attr::has_mfvscr)))
		{
			info.attr += ppu_attr::has_mfvscr;
		}

		// ppu_module::get_ptr bounds a segment at the next 64 KiB boundary, so the copy carries that
		// much zeroed tail and a read the translator makes past the block still lands inside it
		std::vector<u8> image(usz{size} + 0x10000, 0);
		std::memcpy(image.data(), code, size);
		info.segs.push_back(ppu_segment{addr, size, 1, 0, size, image.data()});
		info.addr_to_seg_index.emplace(addr, 0);

		ppu_function func;
		func.addr = addr;
		func.size = size;
		info.funcs.push_back(std::move(func));
		info.local_bounds = {addr, addr + size};

		auto _module = std::make_unique<Module>(info.name, s_ppu_jit->get_context());
		_module->setTargetTriple(Triple("wasm32-unknown-unknown"));
		_module->setDataLayout(DataLayout("e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128"));

		PPUTranslator translator(s_ppu_jit->get_context(), _module.get(), info, s_ppu_jit->get_target_machine(), true, s_branch_mode);

		// The signature the offline bundles and the runtime's dispatch site share (PPUThread.cpp)
		const auto _func = FunctionType::get(translator.get_type<void>(), {
			translator.get_type<u8*>(), // Exec base
			translator.get_type<u8*>(), // PPU context
			translator.get_type<u64>(), // Segment address (for PRX)
			translator.get_type<u8*>(), // Memory base
			translator.get_type<u64>(), // r0
			translator.get_type<u64>(), // r1
			translator.get_type<u64>(), // r2
			}, false);

		const auto entry = cast<Function>(_module->getOrInsertFunction(info.name, _func).getCallee());
		entry->setCallingConv(CallingConv::C);
		entry->addParamAttr(1, Attribute::NoAlias);
		entry->addFnAttr(Attribute::NoUnwind);

		if (!translator.Translate(info.funcs[0]))
		{
			s_ppu_error = "translation failed";
			return 0;
		}
		if (auto* trap_fn = _module->getFunction("__trap"); trap_fn && trap_fn->isDeclaration())
		{
			trap_fn->setName("__ppu_trap");
		}

		{
			std::string verified;
			raw_string_ostream out(verified);

			if (verifyModule(*_module, &out))
			{
				out.flush();
				s_ppu_error = "verification failed: " + verified;
				return 0;
			}
		}

		s_ppu_output = s_ppu_jit->emit_wasm(*_module, s_ppu_error);
		return ::size32(s_ppu_output);
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_ppu_llvm_output()
	{
		return s_ppu_output.data();
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_ppu_llvm_error()
	{
		return s_ppu_error.c_str();
	}

	// Whole-module decomposed static recompilation inside the Wasm compiler worker:
	// Stage 1: Extract + Plan 100% of a PS3 ELF/SELF/SPRX or PS3R descriptor into block ranges (<0.5s, <30 MiB).
	static std::vector<u8> s_recomp_desc_bytes;
	static std::vector<ps3recomp::BlockPlanEntry> s_recomp_plan_blocks;
	static std::string s_recomp_clean_mod;
	static ps3recomp::LiftResult s_recomp_lifted;
	static u32 s_recomp_last_hle_calls = 0;
	static u32 s_recomp_last_region_links = 0;
	static u32 s_recomp_last_emitted_blocks = 0;

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_plan_descriptor(
		const u8* input_bytes,
		u32 input_size,
		const char* module_name,
		u32 prx_base,
		u32 max_blocks_per_shard)
	{
		s_ppu_error.clear();
		s_recomp_desc_bytes.clear();
		s_recomp_plan_blocks.clear();
		s_recomp_clean_mod.clear();

		if (!input_bytes || input_size < 8)
		{
			s_ppu_error = "empty module input";
			return 0;
		}

		ps3recomp::ModuleDescriptor desc;
		std::span<const uint8_t> raw(input_bytes, input_size);
		bool ok = false;
		if (raw[0] == 'P' && raw[1] == 'S' && raw[2] == '3' && raw[3] == 'R')
		{
			ok = ps3recomp::deserialize_descriptor_binary(raw, desc, s_ppu_error);
		}
		else
		{
			ok = ps3recomp::extract_from_bytes(raw, module_name ? module_name : "module", prx_base, desc, s_ppu_error);
		}
		if (!ok) return 0;

		ps3recomp::LiftOptions lopts;
		lopts.frontend = ps3recomp::LiftFrontend::LlvmIr;
		lopts.max_blocks_per_shard = max_blocks_per_shard ? max_blocks_per_shard : 2048;
		uint32_t splits = 0;
		if (!ps3recomp::plan_module_blocks(desc, lopts, s_recomp_plan_blocks, s_recomp_clean_mod, splits, s_ppu_error))
		{
			return 0;
		}

		s_recomp_desc_bytes = ps3recomp::serialize_descriptor_binary(desc);
		return ::size32(s_recomp_plan_blocks);
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_recomp_plan_blocks_data()
	{
		return reinterpret_cast<const u8*>(s_recomp_plan_blocks.data());
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_plan_blocks_bytes()
	{
		return static_cast<u32>(s_recomp_plan_blocks.size() * sizeof(ps3recomp::BlockPlanEntry));
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_plan_block_entry_bytes()
	{
		return sizeof(ps3recomp::BlockPlanEntry);
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_recomp_plan_clean_mod()
	{
		return s_recomp_clean_mod.c_str();
	}

	// Parallel per-shard Stage 1B + Stage 2: Lift [pos, end_pos) directly into an in-memory llvm::Module
	// and compile + link to PIC shared .wasm without any ASCII IR serialization!
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_lift_and_compile_shard(
		const u8* ps3r_bytes,
		u32 ps3r_size,
		const u8* plan_blocks_bytes,
		u32 total_blocks,
		u32 pos,
		u32 end_pos,
		const char* symbol_suffix,
		u32 return_dispatch,
		u32 form_regions,
		u32 inline_reads,
		u32 inline_writes)
	{
		s_ppu_output.clear();
		s_ppu_error.clear();
		s_recomp_last_hle_calls = 0;
		s_recomp_last_region_links = 0;
		s_recomp_last_emitted_blocks = 0;

		if (!ps3r_bytes || !ps3r_size || !plan_blocks_bytes || !total_blocks || pos >= end_pos || end_pos > total_blocks || !symbol_suffix)
		{
			s_ppu_error = "invalid lift_and_compile_shard arguments";
			return 0;
		}

		ps3recomp::ModuleDescriptor desc;
		if (!ps3recomp::deserialize_descriptor_binary(std::span<const uint8_t>(ps3r_bytes, ps3r_size), desc, s_ppu_error))
		{
			return 0;
		}

		std::span<const ps3recomp::BlockPlanEntry> all_blocks(
			reinterpret_cast<const ps3recomp::BlockPlanEntry*>(plan_blocks_bytes),
			total_blocks);

		ps3recomp::CompileOptions copts;
		copts.form_regions = form_regions != 0;
		copts.inline_reads = inline_reads != 0;
		copts.inline_writes = inline_writes != 0;

		ps3recomp::CompiledPart part;
		{
			jit_compiler jit({}, "");
			std::unique_ptr<llvm::Module> mod;
			std::vector<uint32_t> emitted_addrs;
			std::fprintf(stderr, "ppu-recomp shard %s: lifting %u..%u\n", symbol_suffix, pos, end_pos);
			if (!ps3recomp::lift_planned_shard_to_llvm(
				desc, all_blocks, pos, end_pos, symbol_suffix, return_dispatch != 0, jit, mod, emitted_addrs, s_ppu_error))
			{
				return 0;
			}
			std::fprintf(stderr, "ppu-recomp shard %s: lifted %zu blocks\n", symbol_suffix, emitted_addrs.size());
			if (!ps3recomp::compile_llvm_module_to_wasm(
				desc, *mod, symbol_suffix, static_cast<uint32_t>(emitted_addrs.size()), copts, part, s_ppu_error))
			{
				return 0;
			}
			std::fprintf(stderr, "ppu-recomp shard %s: compiled %u bytes\n", symbol_suffix, ::size32(part.wasm_bytes));
		}

		s_recomp_last_hle_calls = part.hle_stub_calls_lowered;
		s_recomp_last_region_links = part.region_linked_calls;
		s_recomp_last_emitted_blocks = part.block_count;
		s_ppu_output = std::move(part.wasm_bytes);
		return ::size32(s_ppu_output);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_last_emitted_blocks()
	{
		return s_recomp_last_emitted_blocks;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_lift_descriptor(
		const u8* input_bytes,
		u32 input_size,
		const char* module_name,
		u32 prx_base,
		u32 max_blocks_per_shard,
		u32 return_dispatch)
	{
		s_ppu_error.clear();
		s_recomp_desc_bytes.clear();
		s_recomp_lifted = {};

		if (!input_bytes || input_size < 8)
		{
			s_ppu_error = "empty module input";
			return 0;
		}

		ps3recomp::ModuleDescriptor desc;
		std::span<const uint8_t> raw(input_bytes, input_size);
		bool ok = false;
		if (raw[0] == 'P' && raw[1] == 'S' && raw[2] == '3' && raw[3] == 'R')
		{
			ok = ps3recomp::deserialize_descriptor_binary(raw, desc, s_ppu_error);
		}
		else
		{
			ok = ps3recomp::extract_from_bytes(raw, module_name ? module_name : "module", prx_base, desc, s_ppu_error);
		}
		if (!ok) return 0;

		ps3recomp::LiftOptions lopts;
		lopts.frontend = ps3recomp::LiftFrontend::LlvmIr;
		lopts.max_blocks_per_shard = max_blocks_per_shard ? max_blocks_per_shard : 2048;
		lopts.return_to_dispatcher = return_dispatch != 0;
		if (!ps3recomp::lift_module(desc, lopts, s_recomp_lifted, s_ppu_error))
		{
			return 0;
		}

		s_recomp_desc_bytes = ps3recomp::serialize_descriptor_binary(desc);
		return ::size32(s_recomp_lifted.ppu_shards);
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_recomp_desc_data()
	{
		return s_recomp_desc_bytes.data();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_desc_size()
	{
		return ::size32(s_recomp_desc_bytes);
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_recomp_shard_suffix(u32 i)
	{
		return i < s_recomp_lifted.ppu_shards.size() ? s_recomp_lifted.ppu_shards[i].symbol_suffix.c_str() : "";
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_recomp_shard_text(u32 i)
	{
		return i < s_recomp_lifted.ppu_shards.size() ? s_recomp_lifted.ppu_shards[i].text.c_str() : "";
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_shard_text_size(u32 i)
	{
		return i < s_recomp_lifted.ppu_shards.size() ? ::size32(s_recomp_lifted.ppu_shards[i].text) : 0;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_shard_blocks(u32 i)
	{
		return i < s_recomp_lifted.ppu_shards.size() ? ::size32(s_recomp_lifted.ppu_shards[i].block_addrs) : 0;
	}

	EMSCRIPTEN_KEEPALIVE void rpcs3_recomp_clear_lifted()
	{
		s_recomp_lifted = {};
		s_recomp_plan_blocks.clear();
		s_recomp_plan_blocks.shrink_to_fit();
		s_recomp_clean_mod.clear();
		s_recomp_desc_bytes.clear();
		s_recomp_desc_bytes.shrink_to_fit();
	}

	// Stage 2: Lower one lifted LLVM IR shard + PS3R HLE stubs & jump tables to a shared PIC .wasm module!
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_compile_shard(
		const u8* ps3r_bytes,
		u32 ps3r_size,
		const char* symbol_suffix,
		const char* ir_text,
		u32 ir_size,
		u32 form_regions,
		u32 inline_reads,
		u32 inline_writes)
	{
		s_ppu_output.clear();
		s_ppu_error.clear();
		s_recomp_last_hle_calls = 0;
		s_recomp_last_region_links = 0;

		if (!ps3r_bytes || !ps3r_size || !symbol_suffix || !ir_text || !ir_size)
		{
			s_ppu_error = "invalid compile_shard arguments";
			return 0;
		}

		ps3recomp::ModuleDescriptor desc;
		if (!ps3recomp::deserialize_descriptor_binary(std::span<const uint8_t>(ps3r_bytes, ps3r_size), desc, s_ppu_error))
		{
			return 0;
		}

		ps3recomp::LiftedShard shard;
		shard.shard_name = symbol_suffix;
		shard.symbol_suffix = symbol_suffix;
		shard.frontend = ps3recomp::LiftFrontend::LlvmIr;
		shard.text.assign(ir_text, ir_size);

		ps3recomp::CompileOptions copts;
		copts.form_regions = form_regions != 0;
		copts.inline_reads = inline_reads != 0;
		copts.inline_writes = inline_writes != 0;

		ps3recomp::CompiledPart part;
		if (!ps3recomp::compile_shard_to_wasm(desc, shard, copts, part, s_ppu_error))
		{
			return 0;
		}

		s_recomp_last_hle_calls = part.hle_stub_calls_lowered;
		s_recomp_last_region_links = part.region_linked_calls;
		s_ppu_output = std::move(part.wasm_bytes);
		return ::size32(s_ppu_output);
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_last_hle_calls()
	{
		return s_recomp_last_hle_calls;
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_recomp_last_region_links()
	{
		return s_recomp_last_region_links;
	}
}
