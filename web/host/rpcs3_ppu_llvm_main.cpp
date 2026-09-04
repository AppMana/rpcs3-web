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
}

extern "C"
{
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

		PPUTranslator translator(s_ppu_jit->get_context(), _module.get(), info, s_ppu_jit->get_target_machine(), true);

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
}
