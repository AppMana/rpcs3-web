// Browser SPU LLVM tier: RPCS3's LLVM SPU recompiler in wasm-IR mode, lowered by LLVM's
// WebAssembly backend and wasm-ld inside a compiler worker (web/public/rpcs3-spu-llvm-worker.mjs).
// Input is a local-storage snapshot and an entry point, output a dylink side module that the
// runtime registers as a dispatch candidate (rpcs3/Emu/Cell/SPUWasmRecompiler.cpp).
#include "stdafx.h"
#include "Emu/IdManager.h"
#include "Emu/system_config.h"
#include "Emu/Cell/SPURecompiler.h"

#include "Utilities/JIT.h"
#include "Utilities/Thread.h"

#include "llvm/IR/Module.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

#include <chrono>
#include <cstdio>
#include <emscripten.h>
#include <functional>
#include <thread>

// Host-level symbols the emulator library expects from its host (rpcs3_web_main.cpp provides the
// runtime's); this module never boots the emulator, so they only need to exist and stay faithful.
[[noreturn]] void report_fatal_error(std::string_view text, bool, bool)
{
	std::fprintf(stderr, "RPCS3 fatal error: %.*s\n", static_cast<int>(text.size()), text.data());
	std::abort();
}

void qt_events_aware_op(int repeat_duration_ms, std::function<bool()> wrapped_op)
{
	ensure(wrapped_op);

	while (!wrapped_op())
	{
		if (repeat_duration_ms == 0)
		{
			std::this_thread::yield();
		}
		else if (thread_ctrl::get_current())
		{
			thread_ctrl::wait_for(repeat_duration_ms * 1000);
		}
		else
		{
			std::this_thread::sleep_for(std::chrono::milliseconds(repeat_duration_ms));
		}
	}
}

extern "C"
{
	// The thread loops that ask for these never run here
	int rpcs3_web_ppu_aot_worker_ready()
	{
		return 0;
	}

	int rpcs3_web_spu_aot_worker_ready()
	{
		return 0;
	}
}

namespace
{
	std::unique_ptr<spu_recompiler_base> s_compiler;
	std::vector<u8> s_output;
	std::string s_error;
	u32 s_program_words = 0;
}

extern "C"
{
	EMSCRIPTEN_KEEPALIVE int rpcs3_spu_llvm_init()
	{
		// Same analysis settings as the runtime's dispatch-time analyse() (defaults); no disk cache here
		g_cfg.core.spu_cache.set(false);
		g_cfg.core.spu_debug.set(false);
		g_fxo->reset();
		g_fxo->init<spu_runtime>();
		s_compiler = spu_recompiler_base::make_llvm_recompiler();

		if (!s_compiler)
		{
			s_error = "no LLVM recompiler in this module";
			return 0;
		}

		s_compiler->init();
		return 1;
	}

	// Returns the side module size (0 on failure; rpcs3_spu_llvm_error explains)
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_spu_llvm_compile(const u8* ls, u32 pc)
	{
		s_output.clear();
		s_error.clear();
		s_program_words = 0;

		if (!s_compiler || pc >= SPU_LS_SIZE || (pc & 3))
		{
			s_error = "bad request";
			return 0;
		}

		spu_program program = s_compiler->analyse(reinterpret_cast<const be_t<u32>*>(ls), pc);

		if (program.data.empty())
		{
			s_error = "analysis produced no program";
			return 0;
		}

		s_program_words = ::size32(program.data);

		if (!s_compiler->compile(std::move(program)))
		{
			s_error = "compile() failed";
			return 0;
		}

		s_output = std::move(g_spu_web_llvm_output);
		return ::size32(s_output);
	}

	// LLVM textual IR straight through the same lowering (llc for wasm32 + wasm-ld --shared) the SPU
	// programs take: the test lane's proof that the LLVM build itself produces working wasm.
	// Returns the side module size, 0 on failure (rpcs3_spu_llvm_error explains).
	EMSCRIPTEN_KEEPALIVE u32 rpcs3_spu_llvm_compile_ir(const char* text)
	{
		s_output.clear();
		s_error.clear();
		s_program_words = 0;

		static jit_compiler s_ir_compiler{{}, ""};
		llvm::SMDiagnostic diagnostic;
		std::unique_ptr<llvm::Module> module = llvm::parseIR(*llvm::MemoryBuffer::getMemBuffer(text, "ir", false), diagnostic, s_ir_compiler.get_context());

		if (!module)
		{
			llvm::raw_string_ostream out(s_error);
			diagnostic.print("ir", out);
			return 0;
		}

		s_output = s_ir_compiler.emit_wasm(*module, s_error);
		return ::size32(s_output);
	}

	EMSCRIPTEN_KEEPALIVE const u8* rpcs3_spu_llvm_output()
	{
		return s_output.data();
	}

	EMSCRIPTEN_KEEPALIVE u32 rpcs3_spu_llvm_program_words()
	{
		return s_program_words;
	}

	EMSCRIPTEN_KEEPALIVE const char* rpcs3_spu_llvm_error()
	{
		return s_error.c_str();
	}
}

int main()
{
	return 0;
}
