#include "stdafx.h"
#include "SPURecompiler.h"

// Factory stubs for the browser runtime, which carries no LLVM. The compiler module
// (web/host/rpcs3_spu_llvm_main.cpp) links SPULLVMRecompiler.cpp instead, so this object
// stays out of that link.
std::unique_ptr<spu_recompiler_base> spu_recompiler_base::make_llvm_recompiler(u8)
{
	return nullptr;
}
