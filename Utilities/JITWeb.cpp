#include "stdafx.h"

#ifdef RPCS3_WEB
#include "JIT.h"
#include "util/logs.hpp"

#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Module.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"
#include "lld/Common/Driver.h"

LLD_HAS_DRIVER(wasm)

LOG_CHANNEL(jit_log, "JIT");

// The browser compiler lowers RPCS3's wasm-mode IR exactly like the offline bundle path
// (web/scripts/compile-ppu-ir-to-wasm.mjs): llc -O2 for wasm32 with the runtime's feature set
// and -relocation-model=pic, then wasm-ld --shared against the runtime's shared memory.
static constexpr const char* s_triple = "wasm32-unknown-unknown";
static constexpr const char* s_features = "+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128,+tail-call";

jit_compiler::jit_compiler(const std::unordered_map<std::string, u64>&, std::string_view, u32, std::function<u64(const std::string&)>)
	: m_context(std::make_unique<llvm::LLVMContext>())
{
	static const bool s_initialized = []
	{
		LLVMInitializeWebAssemblyTargetInfo();
		LLVMInitializeWebAssemblyTarget();
		LLVMInitializeWebAssemblyTargetMC();
		LLVMInitializeWebAssemblyAsmPrinter();
		LLVMInitializeWebAssemblyAsmParser();
		return true;
	}();

	std::string error;
	const llvm::Target* target = llvm::TargetRegistry::lookupTarget(s_triple, error);
	ensure(target, "WebAssembly target");
	llvm::TargetOptions options;
	m_target_machine.reset(target->createTargetMachine(llvm::Triple(s_triple), "generic", s_features, options, llvm::Reloc::PIC_, std::nullopt, llvm::CodeGenOptLevel::Default));
	ensure(m_target_machine, "WebAssembly target machine");
	static_cast<void>(s_initialized);
}

jit_compiler::~jit_compiler() noexcept
{
}

std::vector<u8> jit_compiler::emit_wasm(llvm::Module& module, std::string& error)
{
	using namespace llvm;

	module.setTargetTriple(m_target_machine->getTargetTriple());
	module.setDataLayout(m_target_machine->createDataLayout());

	SmallVector<char, 0> object;
	{
		raw_svector_ostream stream(object);
		legacy::PassManager passes;

		if (m_target_machine->addPassesToEmitFile(passes, stream, nullptr, CodeGenFileType::ObjectFile))
		{
			error = "the target cannot emit object files";
			return {};
		}

		passes.run(module);
	}

	// Fixed names: wasm-ld records the output name in the module, and the same program must
	// always produce the same bytes (this module compiles one program at a time)
	const std::string object_path = "/tmp/spu.o";
	const std::string output_path = "/tmp/spu.wasm";
	m_serial++;

	{
		std::error_code code;
		raw_fd_ostream file(object_path, code, sys::fs::OF_None);

		if (code)
		{
			error = "cannot stage the object: " + code.message();
			return {};
		}

		file.write(object.data(), object.size());
	}

	std::string lld_out, lld_err;
	raw_string_ostream out(lld_out), err(lld_err);
	const char* args[] = {"wasm-ld", "--shared", "--import-memory", "--shared-memory", "--max-memory=2147483648", "--allow-undefined", "--export-all", object_path.c_str(), "-o", output_path.c_str()};
	const lld::Result result = lld::lldMain(args, out, err, {{lld::Wasm, &lld::wasm::link}});
	sys::fs::remove(object_path);

	if (result.retCode != 0 || !result.canRunAgain)
	{
		error = "wasm-ld failed: " + lld_err;
		sys::fs::remove(output_path);
		return {};
	}

	auto buffer = MemoryBuffer::getFile(output_path);
	sys::fs::remove(output_path);

	if (!buffer)
	{
		error = "cannot read the linked module: " + buffer.getError().message();
		return {};
	}

	const StringRef bytes = (*buffer)->getBuffer();
	return std::vector<u8>(bytes.bytes_begin(), bytes.bytes_end());
}

std::string jit_compiler::cpu(std::string_view)
{
	return "generic";
}

std::string jit_compiler::triple1()
{
	return s_triple;
}

std::string jit_compiler::triple2()
{
	return s_triple;
}
#endif
