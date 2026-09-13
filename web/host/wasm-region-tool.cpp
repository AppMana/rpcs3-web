// Native driver for the same region formation used by the browser LLVM tier.
#include "../../Utilities/WasmRegion.h"
#include "../../Utilities/WasmCallPolicy.h"
#include "../../Utilities/WasmSimdPolicy.h"
#include <llvm/IR/Verifier.h>
#include <llvm/IRReader/IRReader.h>
#include <llvm/Support/SourceMgr.h>
#include <llvm/Support/FileSystem.h>
#include <string_view>

int main(int argc, char** argv)
{
	if (argc < 3) return 2;
	bool regions = true, direct_exits = false, unary_swizzles = false;
	for (int i = 3; i < argc; ++i)
	{
		if (std::string_view(argv[i]) == "--no-regions") regions = false;
		else if (std::string_view(argv[i]) == "--unary-swizzles") unary_swizzles = true;
		else if (std::string_view(argv[i]) == "--direct-exits") direct_exits = true;
		else return 2;
	}
	llvm::LLVMContext context;
	llvm::SMDiagnostic error;
	auto module = llvm::parseIRFile(argv[1], error, context);
	if (!module) { error.print(argv[0], llvm::errs()); return 1; }
	const auto exits = direct_exits ? wasm_codegen::lower_spu_dispatch_returns(*module) : 0;
	const auto stats = regions ? wasm_codegen::form_regions(*module) : wasm_codegen::region_statistics{};
	const auto swizzles = unary_swizzles ? wasm_codegen::lower_unary_byte_shuffles(*module) : 0;
	wasm_codegen::preserve_import_call_frames(*module);
	if (llvm::verifyModule(*module, &llvm::errs())) return 1;
	std::error_code ec;
	llvm::raw_fd_ostream output(argv[2], ec, llvm::sys::fs::OF_None);
	if (ec) { llvm::errs() << ec.message(); return 1; }
	module->print(output, nullptr);
	llvm::outs() << "{\"functions\":" << stats.functions << ",\"linkedCalls\":"
		<< stats.linked_calls << ",\"budgetExits\":" << stats.budget_exits << ",\"directExits\":" << exits << ",\"unarySwizzles\":" << swizzles << "}\n";
}
