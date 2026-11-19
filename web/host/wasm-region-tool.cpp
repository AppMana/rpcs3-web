// Native driver for the same region formation used by the browser LLVM tier.
#include "../../Utilities/WasmRegion.h"
#include "../../Utilities/WasmCallPolicy.h"
#include "../../Utilities/WasmSimdPolicy.h"
#include <llvm/IR/LegacyPassManager.h>
#include <llvm/IR/Verifier.h>
#include <llvm/IRReader/IRReader.h>
#include <llvm/MC/TargetRegistry.h>
#include <llvm/Support/FileSystem.h>
#include <llvm/Support/MemoryBuffer.h>
#include <llvm/Support/SourceMgr.h>
#include <llvm/Support/TargetSelect.h>
#include <llvm/Target/TargetMachine.h>
#include <llvm/Target/TargetOptions.h>
#include <llvm/TargetParser/Triple.h>
#include <charconv>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace
{
	constexpr const char* k_triple = "wasm32-unknown-unknown";
	constexpr const char* k_features = "+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128,+tail-call";

	std::unique_ptr<llvm::TargetMachine> make_target_machine(bool pic)
	{
		static const bool initialized = []
		{
			LLVMInitializeWebAssemblyTargetInfo();
			LLVMInitializeWebAssemblyTarget();
			LLVMInitializeWebAssemblyTargetMC();
			LLVMInitializeWebAssemblyAsmPrinter();
			LLVMInitializeWebAssemblyAsmParser();
			return true;
		}();
		(void)initialized;

		std::string error;
		const llvm::Target* target = llvm::TargetRegistry::lookupTarget(k_triple, error);
		if (!target)
		{
			llvm::errs() << error << "\n";
			return nullptr;
		}
		llvm::TargetOptions options;
		const auto reloc = pic ? std::optional<llvm::Reloc::Model>(llvm::Reloc::PIC_) : std::optional<llvm::Reloc::Model>{};
		return std::unique_ptr<llvm::TargetMachine>(target->createTargetMachine(
			llvm::Triple(k_triple), "generic", k_features, options, reloc, std::nullopt, llvm::CodeGenOptLevel::Aggressive));
	}

	struct process_options
	{
		bool regions = true;
		bool stubs_only = false;
		bool direct_exits = false;
		bool unary_swizzles = false;
		bool inline_reads = false;
		bool inline_writes = false;
		bool emit_obj = false;
		bool pic = false;
		std::vector<wasm_codegen::sce_stub_entry> stubs;
	};

	bool parse_hex_u32(std::string_view text, uint32_t& out)
	{
		if (text.starts_with("0x") || text.starts_with("0X")) text.remove_prefix(2);
		if (text.empty()) return false;
		const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), out, 16);
		return error == std::errc{} && end == text.data() + text.size();
	}

	bool parse_stub_spec(std::string_view text, wasm_codegen::sce_stub_entry& out)
	{
		const auto first = text.find(':');
		if (first == std::string_view::npos) return false;
		const auto second = text.find(':', first + 1);
		if (second == std::string_view::npos) return false;
		return parse_hex_u32(text.substr(0, first), out.stub_pc)
			&& parse_hex_u32(text.substr(first + 1, second - first - 1), out.faddr)
			&& parse_hex_u32(text.substr(second + 1), out.fnid);
	}

	bool process_one(llvm::StringRef input_path, llvm::StringRef output_path, const process_options& opts, llvm::TargetMachine* tm, llvm::raw_ostream& json_out)
	{
		llvm::LLVMContext context;
		llvm::SMDiagnostic error;
		auto module = llvm::parseIRFile(input_path, error, context);
		if (!module)
		{
			error.print("wasm-region-tool", llvm::errs());
			return false;
		}
		const auto exits = opts.direct_exits ? wasm_codegen::lower_spu_dispatch_returns(*module) : 0;
		if (opts.regions || opts.inline_reads || opts.inline_writes)
		{
			wasm_codegen::mark_nocapture_helpers(*module);
		}
		wasm_codegen::set_active_sce_stubs(opts.stubs);
		const auto stub_calls = (opts.regions || opts.stubs_only || opts.inline_reads || opts.inline_writes) ? wasm_codegen::lower_import_stub_calls(*module) : 0;
		const auto sc_calls = (opts.regions || opts.inline_reads || opts.inline_writes) ? wasm_codegen::lower_syscall_continuations(*module) : 0;
		const auto stats = opts.regions
			? wasm_codegen::form_regions(*module)
			: wasm_codegen::region_statistics{};
		if (opts.regions || opts.inline_reads || opts.inline_writes)
		{
			wasm_codegen::restore_vm_helper_memory_effects(*module);
		}
		const auto inlined_reads = opts.inline_reads ? wasm_codegen::inline_vm_reads(*module) : 0;
		const auto inlined_writes = opts.inline_writes ? wasm_codegen::inline_vm_writes(*module) : 0;
		const auto swizzles = opts.unary_swizzles ? wasm_codegen::lower_unary_byte_shuffles(*module) : 0;
		if (opts.regions || opts.stubs_only || opts.direct_exits || opts.unary_swizzles || opts.inline_reads || opts.inline_writes)
		{
			wasm_codegen::preserve_import_call_frames(*module);
			if (llvm::verifyModule(*module, &llvm::errs()))
			{
				std::error_code ec;
				llvm::raw_fd_ostream invalid_output(output_path, ec, llvm::sys::fs::OF_None);
				if (!ec) module->print(invalid_output, nullptr);
				return false;
			}
		}
		std::error_code ec;
		llvm::raw_fd_ostream output(output_path, ec, llvm::sys::fs::OF_None);
		if (ec)
		{
			llvm::errs() << ec.message() << "\n";
			return false;
		}
		if (opts.emit_obj || output_path.ends_with(".o"))
		{
			if (!tm) return false;
			module->setTargetTriple(tm->getTargetTriple());
			module->setDataLayout(tm->createDataLayout());
			llvm::legacy::PassManager passes;
			if (tm->addPassesToEmitFile(passes, output, nullptr, llvm::CodeGenFileType::ObjectFile))
			{
				llvm::errs() << "TargetMachine cannot emit object file\n";
				return false;
			}
			passes.run(*module);
		}
		else
		{
			module->print(output, nullptr);
		}
		json_out << "{\"functions\":" << stats.functions << ",\"linkedCalls\":"
			<< stats.linked_calls << ",\"budgetExits\":" << stats.budget_exits << ",\"selfLoops\":" << stats.self_loops
			<< ",\"directExits\":" << exits
			<< ",\"unarySwizzles\":" << swizzles << ",\"inlinedReads\":" << inlined_reads
			<< ",\"inlinedWrites\":" << inlined_writes << ",\"stubCalls\":" << stub_calls
			<< ",\"scCalls\":" << sc_calls << "}";
		return true;
	}
}

int main(int argc, char** argv)
{
	if (argc < 3) return 2;
	process_options opts;
	std::string_view batch_file;
	int flag_start = 3;
	if (std::string_view(argv[1]) == "--batch")
	{
		batch_file = argv[2];
		flag_start = 3;
	}
	for (int i = flag_start; i < argc; ++i)
	{
		const std::string_view arg(argv[i]);
		if (arg == "--no-regions") opts.regions = false;
		else if (arg == "--stubs-only") opts.stubs_only = true;
		else if (arg == "--unary-swizzles") opts.unary_swizzles = true;
		else if (arg == "--direct-exits") opts.direct_exits = true;
		else if (arg == "--inline-reads") opts.inline_reads = true;
		else if (arg == "--inline-writes") opts.inline_writes = true;
		else if (arg == "--emit-obj") opts.emit_obj = true;
		else if (arg == "--pic") opts.pic = true;
		else if (arg == "--stub")
		{
			if (++i >= argc) return 2;
			wasm_codegen::sce_stub_entry stub;
			if (!parse_stub_spec(argv[i], stub)) return 2;
			opts.stubs.push_back(stub);
		}
		else return 2;
	}

	std::sort(opts.stubs.begin(), opts.stubs.end(), [](const auto& lhs, const auto& rhs)
	{
		return lhs.stub_pc < rhs.stub_pc;
	});

	std::unique_ptr<llvm::TargetMachine> tm;
	if (opts.emit_obj || (!batch_file.empty()) || std::string_view(argv[2]).ends_with(".o"))
	{
		tm = make_target_machine(opts.pic);
		if (!tm) return 1;
	}

	if (!batch_file.empty())
	{
		auto buf = llvm::MemoryBuffer::getFile(batch_file);
		if (!buf)
		{
			llvm::errs() << buf.getError().message() << "\n";
			return 1;
		}
		llvm::StringRef content = (*buf)->getBuffer();
		llvm::SmallVector<llvm::StringRef, 0> lines;
		content.split(lines, '\n', -1, false);
		llvm::outs() << "[";
		bool first = true;
		for (llvm::StringRef line : lines)
		{
			line = line.trim();
			if (line.empty()) continue;
			auto [in_path, out_path] = line.split('\t');
			if (in_path.empty() || out_path.empty()) return 2;
			if (!first) llvm::outs() << ",";
			first = false;
			if (!process_one(in_path, out_path, opts, tm.get(), llvm::outs())) return 1;
		}
		llvm::outs() << "]\n";
		return 0;
	}

	if (!process_one(argv[1], argv[2], opts, tm.get(), llvm::outs())) return 1;
	llvm::outs() << "\n";
	return 0;
}
