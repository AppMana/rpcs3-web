#include "stdafx.h"
#include "ModuleCompiler.h"

#include "Utilities/WasmCallPolicy.h"
#include "Utilities/WasmRegion.h"
#include "Utilities/WasmSimdPolicy.h"
#include "Utilities/LLVMOptimization.h"
#include "Utilities/PPUCodegenPolicy.h"

#include "llvm/IR/LegacyPassManager.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Passes/OptimizationLevel.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Program.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"

#ifdef RPCS3_WEB
#include "lld/Common/Driver.h"
LLD_HAS_DRIVER(wasm)
#endif

#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <sstream>
#include <thread>

#ifndef RPCS3_WEB
#include <unistd.h>
#endif

namespace ps3recomp
{
	namespace
	{
		constexpr const char* k_wasm_triple = "wasm32-unknown-unknown";
		constexpr const char* k_wasm_features = "+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128,+tail-call";
		std::atomic<uint64_t> s_serial{1};

		void ensure_wasm_target_init()
		{
			static std::once_flag s_once;
			std::call_once(s_once, []
			{
				LLVMInitializeWebAssemblyTargetInfo();
				LLVMInitializeWebAssemblyTarget();
				LLVMInitializeWebAssemblyTargetMC();
				LLVMInitializeWebAssemblyAsmPrinter();
				LLVMInitializeWebAssemblyAsmParser();
			});
		}

		std::unique_ptr<llvm::TargetMachine> make_wasm_pic_target_machine(std::string& err)
		{
			ensure_wasm_target_init();
			const llvm::Triple triple(k_wasm_triple);
			const llvm::Target* target = llvm::TargetRegistry::lookupTarget(triple, err);
			if (!target) return nullptr;
			llvm::TargetOptions topts;
			return std::unique_ptr<llvm::TargetMachine>(target->createTargetMachine(
				triple,
				"generic",
				k_wasm_features,
				topts,
				llvm::Reloc::PIC_,
				std::nullopt,
				llvm::CodeGenOptLevel::Aggressive));
		}

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
							if (++printed == 8) return;
						}
					}
				}
			}
		}

#ifndef RPCS3_WEB
		std::vector<std::string> find_runtime_archives()
		{
			const char* home = std::getenv("HOME");
			const char* emsdk = std::getenv("EMSDK");
			std::vector<std::string> dirs;
			if (emsdk && *emsdk)
			{
				dirs.push_back(std::string(emsdk) + "/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten");
			}
			if (home && *home)
			{
				dirs.push_back(std::string(home) + "/.cache/emsdk-6.0.8/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten");
				dirs.push_back(std::string(home) + "/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten");
			}
			for (const auto& dir : dirs)
			{
				for (const char* bname : {"libclang_rt.builtins-mt.a", "libclang_rt.builtins.a", "libclang_rt.builtins-wasmsjlj.a"})
				{
					const std::string bpath = dir + "/" + bname;
					if (llvm::sys::fs::exists(bpath))
					{
						return {bpath};
					}
				}
			}
			return {};
		}

		std::string find_tool_binary(std::initializer_list<const char*> names)
		{
			for (const char* root : {"/usr/lib/llvm-22/bin/", "/usr/bin/"})
			{
				for (const char* name : names)
				{
					const std::string cand = std::string(root) + name;
					if (llvm::sys::fs::can_execute(cand)) return cand;
				}
			}
			for (const char* name : names)
			{
				if (auto p = llvm::sys::findProgramByName(name)) return *p;
			}
			return {};
		}
#endif

		std::string make_temp_prefix()
		{
			const uint64_t id = s_serial.fetch_add(1, std::memory_order_relaxed);
#ifdef RPCS3_WEB
			return "/tmp/ps3recomp_" + std::to_string(id);
#else
			return "/tmp/ps3recomp_" + std::to_string(static_cast<unsigned long>(::getpid())) + "_" + std::to_string(id);
#endif
		}

		struct ObjectShard
		{
			std::vector<char> obj_bytes;
			uint32_t block_count = 0;
			uint32_t hle_calls = 0;
			uint32_t jump_tables = 0;
			uint32_t region_links = 0;
		};

		bool lower_llvm_module_to_object(
			const ModuleDescriptor& desc,
			llvm::Module& mod,
			const std::string& symbol_suffix,
			LiftFrontend frontend,
			const CompileOptions& opts,
			ObjectShard& out_obj,
			std::string& err)
		{
			using namespace llvm;
			const ppu_codegen_policy codegen_policy = make_ppu_codegen_policy(ppu_backend_kind::aot, ppu_target_kind::wasm);

			if (frontend == LiftFrontend::LlvmIr)
			{
				const auto sce_stubs = desc.materialize_sce_stubs();
				wasm_codegen::mark_nocapture_helpers(mod);
				out_obj.hle_calls = wasm_codegen::lower_import_stub_calls(mod, sce_stubs, desc.is_relocatable_wasm);
				// Import lowering matches the translator's dispatch CFG. Run the
				// shared O3 policy after the rewrite so canonicalization cannot
				// erase the fallback shape before it is recognized.
				if (opts.optimize_ir)
				{
					llvm_opt::optimize_module(mod, nullptr, codegen_policy.optimization);
				}
				if (!desc.is_relocatable_wasm)
				{
					out_obj.jump_tables = wasm_codegen::lower_jump_table_switches(mod, desc.jump_tables);
				}
				wasm_codegen::lower_syscall_continuations(mod);
				if (opts.form_regions)
				{
					out_obj.region_links = wasm_codegen::form_regions(mod).linked_calls;
				}
				wasm_codegen::restore_vm_helper_memory_effects(mod);
				if (opts.inline_reads)
				{
					wasm_codegen::inline_vm_reads(mod);
				}
				if (opts.inline_writes)
				{
					wasm_codegen::inline_vm_writes(mod);
				}
				if (opts.unary_swizzles)
				{
					wasm_codegen::lower_unary_byte_shuffles(mod);
				}
			}
			else if (frontend == LiftFrontend::GhidraCpp)
			{
				wasm_codegen::mark_nocapture_helpers(mod);
				if (const auto* hle_fn = mod.getFunction("__hle_call_fnid"))
				{
					out_obj.hle_calls = static_cast<uint32_t>(hle_fn->getNumUses());
				}
				wasm_codegen::restore_vm_helper_memory_effects(mod);
				if (opts.inline_reads)
				{
					wasm_codegen::inline_vm_reads(mod);
				}
				if (opts.inline_writes)
				{
					wasm_codegen::inline_vm_writes(mod);
				}
			}

			if (llvm::Function* trap_fn = mod.getFunction("__trap"); trap_fn && trap_fn->isDeclaration())
			{
				trap_fn->setName("__ppu_trap");
			}
			wasm_codegen::preserve_import_call_frames(mod);
			{
				std::string verify_err;
				raw_string_ostream vout(verify_err);
				if (verifyModule(mod, &vout))
				{
					append_non_dominating_uses(mod, vout);
					vout.flush();
					err = "Post-HLE-link IR verification failed in " + symbol_suffix + ": " + verify_err;
					return false;
				}
			}

			auto tm = make_wasm_pic_target_machine(err);
			if (!tm) return false;
			mod.setTargetTriple(tm->getTargetTriple());
			mod.setDataLayout(tm->createDataLayout());

			// NOTE: Do NOT run another LLVM optimization pipeline *after*
			// inline_vm_reads / inline_vm_writes! form_regions() already ran EarlyCSE, SimplifyCFG,
			// LoopRotate, LICM, GVN, DSE, and ADCE while VM accesses were opaque helper calls; once
			// inline_vm_reads / inline_vm_writes lower guest loads/stores to raw address-space-0
			// pointers alongside NoAlias %0 / %1 parameters, post-inline IR optimization passes
			// mis-alias guest memory against ppu_thread / page-table accesses and interprocedurally
			// mutate hidden @__0x... block functions. Matching wasm-region-tool's exact pass order
			// preserves guest memory semantics identically on desktop and browser Wasm.
			SmallVector<char, 0> sv_bytes;
			{
				raw_svector_ostream obj_stream(sv_bytes);
				legacy::PassManager codegen_pm;
				if (tm->addPassesToEmitFile(codegen_pm, obj_stream, nullptr, CodeGenFileType::ObjectFile))
				{
					err = "WebAssembly TargetMachine failed to configure object emission";
					return false;
				}
				codegen_pm.run(mod);
			}
			out_obj.obj_bytes.assign(sv_bytes.begin(), sv_bytes.end());
			return true;
		}

		bool lower_shard_to_object(
			const ModuleDescriptor& desc,
			const LiftedShard& shard,
			const CompileOptions& opts,
			ObjectShard& out_obj,
			std::string& err)
		{
			using namespace llvm;
			out_obj = {};
			out_obj.block_count = static_cast<uint32_t>(shard.block_addrs.size());

			LLVMContext ctx;
			std::unique_ptr<Module> mod;
			const std::string tmp_prefix = make_temp_prefix();

			if (shard.frontend == LiftFrontend::GhidraCpp)
			{
#ifdef RPCS3_WEB
				err = "GhidraCpp C++ frontend requires Clang C++ frontend; use LlvmIr inside Wasm worker";
				return false;
#else
				const std::string cpp_path = tmp_prefix + ".cpp";
				const std::string ll_path = tmp_prefix + ".ll";
				{
					std::error_code ec;
					raw_fd_ostream f(cpp_path, ec, sys::fs::OF_None);
					if (ec) { err = "Failed to write temp C++ shard: " + ec.message(); return false; }
					f << shard.text;
				}
				const std::string clang_bin = find_tool_binary({"clang++-22", "clang++"});
				if (clang_bin.empty())
				{
					sys::fs::remove(cpp_path);
					err = "clang++-22 not found on PATH for GhidraCpp compilation";
					return false;
				}
				std::vector<StringRef> cargs = {
					clang_bin,
					"--target=wasm32-unknown-unknown",
					"-std=c++20",
					"-O3",
					"-fPIC",
					"-fno-exceptions",
					"-fno-rtti",
					"-matomics",
					"-mbulk-memory",
					"-mmutable-globals",
					"-msign-ext",
					"-msimd128",
					"-mtail-call",
					"-Wno-unused-label",
					"-Wno-unused-variable",
					"-S",
					"-emit-llvm",
					cpp_path,
					"-o",
					ll_path
				};
				std::string clang_err;
				const int rc = sys::ExecuteAndWait(clang_bin, cargs, std::nullopt, {}, 0, 0, &clang_err);
				sys::fs::remove(cpp_path);
				if (rc != 0)
				{
					sys::fs::remove(ll_path);
					err = "clang++ failed compiling GhidraCpp shard (" + std::to_string(rc) + "): " + clang_err;
					return false;
				}
				SMDiagnostic sm_err;
				mod = parseIRFile(ll_path, sm_err, ctx);
				sys::fs::remove(ll_path);
				if (!mod)
				{
					raw_string_ostream os(err);
					sm_err.print("ghidra-cpp-ir", os);
					return false;
				}
#endif
			}
			else
			{
				SMDiagnostic sm_err;
				mod = parseIR(*MemoryBuffer::getMemBuffer(shard.text, shard.symbol_suffix, false), sm_err, ctx);
				if (!mod)
				{
					raw_string_ostream os(err);
					sm_err.print(shard.symbol_suffix.c_str(), os);
					return false;
				}
			}

			return lower_llvm_module_to_object(desc, *mod, shard.symbol_suffix, shard.frontend, opts, out_obj, err);
		}

		bool link_objects_to_shared_wasm(
			std::span<const ObjectShard> objs,
			std::vector<uint8_t>& out_wasm,
			std::string& err)
		{
			using namespace llvm;
			const std::string tmp_prefix = make_temp_prefix();
			std::vector<std::string> obj_paths;
			obj_paths.reserve(objs.size());

			for (size_t i = 0; i < objs.size(); ++i)
			{
				const std::string p = tmp_prefix + "_" + std::to_string(i) + ".o";
				std::error_code ec;
				raw_fd_ostream f(p, ec, sys::fs::OF_None);
				if (ec)
				{
					for (const auto& prev : obj_paths) sys::fs::remove(prev);
					err = "Cannot stage WebAssembly object file: " + ec.message();
					return false;
				}
				f.write(objs[i].obj_bytes.data(), objs[i].obj_bytes.size());
				obj_paths.push_back(p);
			}
			const std::string wasm_path = tmp_prefix + ".wasm";

#ifdef RPCS3_WEB
			{
				static std::mutex s_lld_mutex;
				std::lock_guard lock(s_lld_mutex);
				std::string lld_out, lld_err;
				raw_string_ostream out_s(lld_out), err_s(lld_err);
				std::vector<const char*> args = {
					"wasm-ld",
					"--shared",
					"--import-memory",
					"--shared-memory",
					"--max-memory=2147483648",
					"--allow-undefined"
				};
				for (const auto& p : obj_paths) args.push_back(p.c_str());
				args.push_back("/lib/libclang_rt.builtins.a");
				args.push_back("-o");
				args.push_back(wasm_path.c_str());

				const lld::Result res = lld::lldMain(args, out_s, err_s, {{lld::Wasm, &lld::wasm::link}});
				for (const auto& p : obj_paths) sys::fs::remove(p);
				if (res.retCode != 0)
				{
					sys::fs::remove(wasm_path);
					err = "in-process wasm-ld failed: " + lld_err;
					return false;
				}
			}
#else
			{
				const std::string wasm_ld = find_tool_binary({"wasm-ld-22", "wasm-ld"});
				if (wasm_ld.empty())
				{
					for (const auto& p : obj_paths) sys::fs::remove(p);
					err = "wasm-ld-22 / wasm-ld not found on PATH";
					return false;
				}
				const auto archives = find_runtime_archives();
				std::vector<StringRef> ld_args = {
					wasm_ld,
					"--shared",
					"--import-memory",
					"--shared-memory",
					"--max-memory=2147483648",
					"--allow-undefined"
				};
				for (const auto& p : obj_paths) ld_args.push_back(p);
				for (const auto& a : archives) ld_args.push_back(a);
				ld_args.push_back("-o");
				ld_args.push_back(wasm_path);

				std::string ld_err;
				const int rc = sys::ExecuteAndWait(wasm_ld, ld_args, std::nullopt, {}, 0, 0, &ld_err);
				for (const auto& p : obj_paths) sys::fs::remove(p);
				if (rc != 0)
				{
					sys::fs::remove(wasm_path);
					err = "wasm-ld failed (" + std::to_string(rc) + "): " + ld_err;
					return false;
				}
			}
#endif

			auto wasm_buf = MemoryBuffer::getFile(wasm_path);
			sys::fs::remove(wasm_path);
			if (!wasm_buf)
			{
				err = "Failed to read linked .wasm output: " + wasm_buf.getError().message();
				return false;
			}
			const StringRef bytes = (*wasm_buf)->getBuffer();
			out_wasm.assign(bytes.bytes_begin(), bytes.bytes_end());
			return true;
		}
	}

	bool compile_llvm_module_to_wasm(
		const ModuleDescriptor& desc,
		llvm::Module& mod,
		const std::string& symbol_suffix,
		uint32_t block_count,
		const CompileOptions& opts,
		CompiledPart& out_part,
		std::string& err)
	{
		out_part = {};
		out_part.shard_name = symbol_suffix;
		out_part.filename = symbol_suffix + ".wasm";
		ObjectShard obj;
		obj.block_count = block_count;
		if (!lower_llvm_module_to_object(desc, mod, symbol_suffix, LiftFrontend::LlvmIr, opts, obj, err)) return false;
		if (!link_objects_to_shared_wasm(std::span<const ObjectShard>(&obj, 1), out_part.wasm_bytes, err)) return false;
		out_part.block_count = obj.block_count;
		out_part.hle_stub_calls_lowered = obj.hle_calls;
		out_part.jump_tables_lowered = obj.jump_tables;
		out_part.region_linked_calls = obj.region_links;
		return true;
	}

	bool compile_shard_to_wasm(
		const ModuleDescriptor& desc,
		const LiftedShard& shard,
		const CompileOptions& opts,
		CompiledPart& out_part,
		std::string& err)
	{
		out_part = {};
		out_part.shard_name = shard.shard_name;
		out_part.filename = shard.symbol_suffix + ".wasm";
		ObjectShard obj;
		if (!lower_shard_to_object(desc, shard, opts, obj, err)) return false;
		if (!link_objects_to_shared_wasm(std::span<const ObjectShard>(&obj, 1), out_part.wasm_bytes, err)) return false;
		out_part.block_count = obj.block_count;
		out_part.hle_stub_calls_lowered = obj.hle_calls;
		out_part.jump_tables_lowered = obj.jump_tables;
		out_part.region_linked_calls = obj.region_links;
		return true;
	}

	bool compile_lifted_module(
		const ModuleDescriptor& desc,
		const LiftResult& lifted,
		const CompileOptions& opts,
		uint32_t parallel_threads,
		CompileResult& out,
		std::string& err)
	{
		out = {};
		const size_t n = lifted.ppu_shards.size();
		if (n == 0)
		{
			err = "LiftResult has 0 PPU shards to compile";
			return false;
		}

		// Step 1: Lower all shards to .o objects in parallel across CPU threads!
		std::vector<ObjectShard> objs(n);
		const uint32_t threads = std::max<uint32_t>(1u, std::min<uint32_t>(
			parallel_threads ? parallel_threads : 1u, static_cast<uint32_t>(n)));

		if (threads == 1)
		{
			for (size_t i = 0; i < n; ++i)
			{
				if (!lower_shard_to_object(desc, lifted.ppu_shards[i], opts, objs[i], err)) return false;
			}
		}
		else
		{
			ensure_wasm_target_init();
			std::atomic<size_t> next_idx{0};
			std::atomic<bool> failed{false};
			std::mutex err_mtx;
			std::vector<std::thread> workers;
			workers.reserve(threads);

			for (uint32_t t = 0; t < threads; ++t)
			{
				workers.emplace_back([&]
				{
					for (;;)
					{
						if (failed.load(std::memory_order_relaxed)) break;
						const size_t idx = next_idx.fetch_add(1, std::memory_order_relaxed);
						if (idx >= n) break;
						std::string local_err;
						if (!lower_shard_to_object(desc, lifted.ppu_shards[idx], opts, objs[idx], local_err))
						{
							if (!failed.exchange(true))
							{
								std::lock_guard lock(err_mtx);
								err = std::move(local_err);
							}
							break;
						}
					}
				});
			}
			for (auto& w : workers) w.join();
			if (failed.load()) return false;
		}

		// Step 2: Coalesce up to 16 object shards into each linked shared .wasm module so V8 creates
		// minimal WebAssembly.Instances per module while staying comfortably under V8's size limits!
		constexpr size_t k_objs_per_wasm = 16;
		std::string clean_base = desc.name;
		for (char& c : clean_base)
		{
			if (!std::isalnum(static_cast<unsigned char>(c))) c = '_';
		}
		if (clean_base.empty()) clean_base = "module";

		uint32_t group_idx = 0;
		for (size_t g = 0; g < n; g += k_objs_per_wasm, ++group_idx)
		{
			const size_t gend = std::min(n, g + k_objs_per_wasm);
			CompiledPart part;
			char fname[128];
			std::snprintf(fname, sizeof(fname), "%s_%s_%02u.wasm", clean_base.c_str(), desc.sha1_hex.substr(0, 8).c_str(), group_idx);
			part.shard_name = "wasm_" + std::to_string(group_idx);
			part.filename = fname;

			const std::span<const ObjectShard> group_span(objs.data() + g, gend - g);
			if (!link_objects_to_shared_wasm(group_span, part.wasm_bytes, err))
			{
				return false;
			}
			for (const auto& o : group_span)
			{
				part.block_count += o.block_count;
				part.hle_stub_calls_lowered += o.hle_calls;
				part.jump_tables_lowered += o.jump_tables;
				part.region_linked_calls += o.region_links;
			}
			out.parts.push_back(std::move(part));
		}

		const ppu_codegen_policy codegen_policy = make_ppu_codegen_policy(ppu_backend_kind::aot, ppu_target_kind::wasm);
		std::ostringstream mf;
		mf << "{\n  \"version\": 2,\n"
		      "  \"schema\": \"" << ppu_codegen_policy::cache_schema << "\",\n"
		      "  \"semanticsVersion\": " << ppu_codegen_policy::semantics_version << ",\n"
		      "  \"target\": \"" << ppu_codegen_policy::target_name(codegen_policy.target) << "\",\n"
		      "  \"optimization\": \"" << codegen_policy.cache_tag() << "\",\n"
		      "  \"module\": \"" << desc.name << "\",\n"
		      "  \"sha1\": \"" << desc.sha1_hex << "\",\n"
		      "  \"parts\": [\n";
		for (size_t i = 0; i < out.parts.size(); ++i)
		{
			const auto& p = out.parts[i];
			out.total_blocks += p.block_count;
			out.total_hle_calls += p.hle_stub_calls_lowered;
			out.total_jump_tables += p.jump_tables_lowered;
			out.total_region_links += p.region_linked_calls;
			if (i > 0) mf << ",\n";
			mf << "    { \"url\": \"" << p.filename << "\", \"relocatable\": false, \"localTableOnly\": false, \"blockCount\": " << p.block_count << " }";
		}
		mf << "\n  ]\n}\n";
		out.manifest_json = mf.str();
		return true;
	}
}
