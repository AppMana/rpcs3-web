#include "stdafx.h"
#include "ModuleExtractor.h"
#include "ModuleLifter.h"
#include "ModuleCompiler.h"

#include "Emu/IdManager.h"
#include "Emu/Cell/PPUAnalyser.h"
#include "Emu/Cell/PPUOpcodes.h"
#include "Emu/system_config.h"
#include "Utilities/File.h"
#include "Utilities/Thread.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

extern void ppu_initialize_modules(struct ppu_linkage_info* link);
extern const ppu_decoder<ppu_iname> g_ppu_iname;

namespace
{
	[[noreturn]] void clean_exit(int code)
	{
		std::cout.flush();
		std::cerr.flush();
		std::fflush(stdout);
		std::fflush(stderr);
		std::_Exit(code);
	}
	namespace stdfs = std::filesystem;

	bool read_all_bytes(const stdfs::path& p, std::vector<uint8_t>& out, std::string& err)
	{
		std::ifstream ifs(p, std::ios::binary | std::ios::ate);
		if (!ifs) { err = "Cannot open file: " + p.string(); return false; }
		const auto sz = static_cast<size_t>(ifs.tellg());
		out.resize(sz);
		ifs.seekg(0);
		if (sz > 0) ifs.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(sz));
		return true;
	}

	bool write_all_bytes(const stdfs::path& p, std::span<const uint8_t> data, std::string& err)
	{
		if (p.has_parent_path()) stdfs::create_directories(p.parent_path());
		std::ofstream ofs(p, std::ios::binary | std::ios::trunc);
		if (!ofs) { err = "Cannot write file: " + p.string(); return false; }
		if (!data.empty()) ofs.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
		return true;
	}

	bool write_all_text(const stdfs::path& p, std::string_view text, std::string& err)
	{
		return write_all_bytes(p, std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(text.data()), text.size()), err);
	}

	bool load_or_extract_descriptor(const stdfs::path& input, uint32_t prx_base, bool relocatable_wasm, ps3recomp::ModuleDescriptor& desc, std::string& err)
	{
		std::vector<uint8_t> bytes;
		if (!read_all_bytes(input, bytes, err)) return false;
		if (bytes.size() >= 8 && bytes[0] == 'P' && bytes[1] == 'S' && bytes[2] == '3' && bytes[3] == 'R')
		{
			return ps3recomp::deserialize_descriptor_binary(bytes, desc, err);
		}
		return ps3recomp::extract_from_bytes(bytes, input.filename().string(), prx_base, desc, err, relocatable_wasm);
	}

	void print_usage()
	{
		std::cerr <<
			"Usage:\n"
			"  ps3recomp extract  <elf_or_self> -o <out.ps3r> [--json <summary.json>] [--prx-base 0x28000000] [--relocatable]\n"
			"  ps3recomp disasm   <in.ps3r|elf> --range START:END [--data] [--prx-base 0x28000000] [--relocatable]\n"
			"  ps3recomp plan     <in.ps3r|elf> -o <plan.json> [--prx-base 0x28000000] [--relocatable] [--shard-blocks 2048] [--plan-range START:END]\n"
			"  ps3recomp lift     <in.ps3r|elf> -o <lifted_dir> [--frontend llvm-ir|ghidra-cpp] [--shard-blocks 2048] [--relocatable]\n"
			"  ps3recomp compile  <lifted_dir>  -o <wasm_dir> [-j <threads>] [--shard-filter <text>] [--no-inline-reads] [--no-regions]\n"
			"  ps3recomp build    <elf_or_self> -o <wasm_dir> [--frontend llvm-ir|ghidra-cpp] [-j <threads>] [--prx-base 0x28000000] [--relocatable]\n"
			"  ps3recomp firmware <dev_flash_external_dir> -o <firmware_wasm_dir> [-j <threads>] [--shard-blocks 4096]\n";
	}
}

int main(int argc, char** argv)
{
	if (argc < 3)
	{
		print_usage();
		clean_exit(2);
	}

	g_fxo->reset();
	g_cfg.core.ppu_debug.set(false);
	g_cfg.core.llvm_logs.set(false);

	const std::string cmd = argv[1];
	const stdfs::path input_path = argv[2];
	stdfs::path out_path;
	stdfs::path json_path;
	uint32_t prx_base = 0;
	bool relocatable_wasm = false;
	bool data_range = false;
	bool shard_blocks_explicit = false;
	bool frontend_explicit = false;
	std::string shard_filter;
	std::vector<std::pair<uint32_t, uint32_t>> plan_ranges;
	uint32_t jobs = std::max<uint32_t>(1u, std::thread::hardware_concurrency() / 2u);
	ps3recomp::LiftOptions lift_opts;
	ps3recomp::CompileOptions comp_opts;

	for (int i = 3; i < argc; ++i)
	{
		const std::string arg = argv[i];
		if ((arg == "-o" || arg == "--output") && i + 1 < argc) out_path = argv[++i];
		else if (arg == "--json" && i + 1 < argc) json_path = argv[++i];
		else if (arg == "--prx-base" && i + 1 < argc) prx_base = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 0));
		else if (arg == "--relocatable") relocatable_wasm = true;
		else if (arg == "--data") data_range = true;
		else if (arg == "--frontend" && i + 1 < argc)
		{
			const std::string fe = argv[++i];
			frontend_explicit = true;
			if (fe == "llvm-ir") lift_opts.frontend = ps3recomp::LiftFrontend::LlvmIr;
			else if (fe == "ghidra-cpp") lift_opts.frontend = ps3recomp::LiftFrontend::GhidraCpp;
			else { std::cerr << "Unknown frontend: " << fe << "\n"; clean_exit(2); }
		}
		else if (arg == "--shard-blocks" && i + 1 < argc)
		{
			lift_opts.max_blocks_per_shard = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 0));
			shard_blocks_explicit = true;
		}
		else if (arg == "--ghidra-home" && i + 1 < argc) lift_opts.ghidra_home = argv[++i];
		else if (arg == "--ghidra-comments") lift_opts.ghidra_decomp_comments = true;
		else if (arg == "--no-jump-tables") lift_opts.recover_jump_tables = false;
		else if (arg == "--return-dispatch") lift_opts.return_to_dispatcher = true;
		else if (arg == "-j" && i + 1 < argc) jobs = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 0));
		else if (arg == "--shard-filter" && i + 1 < argc) shard_filter = argv[++i];
		else if (arg == "--no-inline-reads") comp_opts.inline_reads = false;
		else if (arg == "--inline-writes") comp_opts.inline_writes = true;
		else if (arg == "--no-regions") comp_opts.form_regions = false;
		else if (arg == "--no-opt") comp_opts.optimize_ir = false;
		else if ((arg == "--plan-range" || arg == "--range") && i + 1 < argc)
		{
			const std::string range = argv[++i];
			const auto colon = range.find(':');
			if (colon == std::string::npos)
			{
				std::cerr << "Invalid --plan-range: " << range << "\n";
				clean_exit(2);
			}
			plan_ranges.emplace_back(
				static_cast<uint32_t>(std::strtoul(range.substr(0, colon).c_str(), nullptr, 0)),
				static_cast<uint32_t>(std::strtoul(range.substr(colon + 1).c_str(), nullptr, 0)));
		}
		else { std::cerr << "Unknown argument: " << arg << "\n"; print_usage(); clean_exit(2); }
	}

	if (out_path.empty() && cmd != "disasm")
	{
		std::cerr << "Missing required -o <output>\n";
		print_usage();
		clean_exit(2);
	}

	lift_opts.ranges = plan_ranges;

	const auto t0 = std::chrono::steady_clock::now();
	const auto elapsed_ms = [&]
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
	};

	std::string err;
	if (cmd == "disasm")
	{
		if (plan_ranges.size() != 1 || plan_ranges[0].first >= plan_ranges[0].second)
		{
			std::cerr << "disasm requires exactly one --range START:END\n";
			clean_exit(2);
		}

		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path, prx_base, relocatable_wasm, desc, err))
		{
			std::cerr << "[disasm] extract ERROR: " << err << "\n";
			clean_exit(1);
		}

		const auto [begin, end] = plan_ranges.front();
		std::ostringstream json;

		if (data_range)
		{
			if (end - begin > 4096)
			{
				std::cerr << "disasm --data range is limited to 4096 bytes\n";
				clean_exit(2);
			}

			std::vector<uint8_t> bytes(end - begin);
			if (!desc.read_bytes(begin, bytes.data(), static_cast<uint32_t>(bytes.size())))
			{
				std::cerr << "disasm --data range is not mapped\n";
				clean_exit(1);
			}

			static constexpr char hex[] = "0123456789abcdef";
			json << "{\"module\":\"" << desc.name << "\",\"begin\":" << begin << ",\"end\":" << end << ",\"hex\":\"";
			for (const uint8_t byte : bytes)
			{
				json << hex[byte >> 4] << hex[byte & 0xf];
			}
			json << "\",\"words\":[";
			bool first = true;
			for (size_t off = 0; off + 4 <= bytes.size(); off += 4)
			{
				const uint32_t word = (static_cast<uint32_t>(bytes[off]) << 24) |
					(static_cast<uint32_t>(bytes[off + 1]) << 16) |
					(static_cast<uint32_t>(bytes[off + 2]) << 8) |
					static_cast<uint32_t>(bytes[off + 3]);
				if (!first) json << ',';
				first = false;
				json << "{\"addr\":" << (begin + off) << ",\"word\":" << word << '}';
			}
			json << "]}\n";
			std::cout << json.str();
			clean_exit(0);
		}

		json << "{\"module\":\"" << desc.name << "\",\"begin\":" << begin << ",\"end\":" << end << ",\"instructions\":[";
		bool first = true;
		for (uint32_t addr = begin; addr < end; addr += 4)
		{
			uint32_t word = 0;
			if (!desc.read_u32_be(addr, word))
			{
				continue;
			}
			const ppu_opcode_t op{word};
			if (!first) json << ',';
			first = false;
			json << "{\"addr\":" << addr << ",\"word\":" << word << ",\"opcode\":\"" << g_ppu_iname.decode(word)
			     << "\",\"rd\":" << +op.rd << ",\"ra\":" << +op.ra << ",\"rb\":" << +op.rb
			     << ",\"simm16\":" << op.simm16 << ",\"bt24\":" << op.bt24 << '}';
		}
		json << "]}\n";
		std::cout << json.str();
		clean_exit(0);
	}

	if (cmd == "extract")
	{
		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path, prx_base, relocatable_wasm, desc, err))
		{
			std::cerr << "[extract] ERROR: " << err << "\n";
			clean_exit(1);
		}
		const auto bin = ps3recomp::serialize_descriptor_binary(desc);
		if (!write_all_bytes(out_path, bin, err))
		{
			std::cerr << "[extract] ERROR: " << err << "\n";
			clean_exit(1);
		}
		const std::string summary = ps3recomp::format_descriptor_json_summary(desc);
		if (!json_path.empty() && !write_all_text(json_path, summary, err))
		{
			std::cerr << "[extract] ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::cout << summary;
		std::cerr << "[ps3recomp extract] " << desc.name << ": " << desc.stubs.size() << " HLE/PRX stubs, "
		          << desc.opds.size() << " OPDs, " << desc.spu_images.size() << " SPU images (" << elapsed_ms() << " ms)\n";
		clean_exit(0);
	}

	if (cmd == "plan")
	{
		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path, prx_base, relocatable_wasm, desc, err))
		{
			std::cerr << "[plan] extract ERROR: " << err << "\n";
			clean_exit(1);
		}

		std::vector<ps3recomp::BlockPlanEntry> blocks;
		ps3recomp::PlanDiagnostics diagnostics;
		std::string clean_mod;
		uint32_t splits = 0;
		if (!ps3recomp::plan_module_blocks(desc, lift_opts, blocks, clean_mod, splits, err, &diagnostics))
		{
			std::cerr << "[plan] ERROR: " << err << "\n";
			clean_exit(1);
		}

		std::ostringstream json;
		const auto append_functions = [&](std::string_view name, const std::vector<ps3recomp::PlannedFunctionInfo>& funcs)
		{
			json << "\"" << name << "\":[";
			for (size_t i = 0; i < funcs.size(); ++i)
			{
				const auto& fn = funcs[i];
				if (i) json << ',';
				json << "{\"addr\":" << fn.addr << ",\"toc\":" << fn.toc << ",\"size\":" << fn.size << ",\"blocks\":" << fn.blocks << '}';
			}
			json << ']';
		};

		json << "{\"module\":\"" << clean_mod << "\",\"blocks\":" << blocks.size() << ",\"splits\":" << splits
		     << ",\"mergedFunctions\":" << diagnostics.merged_functions << ',';
		json << "\"mergeGroups\":[";
		for (size_t i = 0; i < diagnostics.merge_groups.size(); ++i)
		{
			const auto& group = diagnostics.merge_groups[i];
			if (i) json << ',';
			json << "{\"addr\":" << group.addr << ",\"size\":" << group.size << ",\"members\":" << group.members << '}';
		}
		json << "],";
		append_functions("analyzerFunctions", diagnostics.analyzer_functions);
		json << ',';
		append_functions("compileFunctions", diagnostics.compile_functions);
		json << ",\"selectedBlocks\":[";
		bool first_block = true;
		for (const auto& block : blocks)
		{
			const bool selected = std::any_of(plan_ranges.begin(), plan_ranges.end(), [&](const auto& range)
			{
				return block.addr < range.second && block.addr + block.size > range.first;
			});
			if (!selected) continue;
			if (!first_block) json << ',';
			first_block = false;
			json << "{\"addr\":" << block.addr << ",\"size\":" << block.size << ",\"functionAddr\":" << block.function_addr
			     << ",\"functionSize\":" << block.function_size << '}';
		}
		json << ']';
		json << "}\n";
		if (!write_all_text(out_path, json.str(), err))
		{
			std::cerr << "[plan] write ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::cout << "{\"module\":\"" << clean_mod << "\",\"blocks\":" << blocks.size() << ",\"splits\":" << splits
		          << ",\"analyzerFunctions\":" << diagnostics.analyzer_functions.size()
		          << ",\"mergedFunctions\":" << diagnostics.merged_functions
		          << ",\"compileFunctions\":" << diagnostics.compile_functions.size() << "}\n";
		std::cerr << "[ps3recomp plan] " << desc.name << ": " << blocks.size() << " blocks, "
		          << diagnostics.analyzer_functions.size() << " analyzer functions -> "
		          << diagnostics.compile_functions.size() << " compile functions (" << elapsed_ms() << " ms)\n";
		clean_exit(0);
	}

	if (cmd == "lift")
	{
		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path, prx_base, relocatable_wasm, desc, err))
		{
			std::cerr << "[lift] ERROR: " << err << "\n";
			clean_exit(1);
		}
		ps3recomp::LiftResult lifted;
		if (!ps3recomp::lift_module(desc, lift_opts, lifted, err))
		{
			std::cerr << "[lift] ERROR: " << err << "\n";
			clean_exit(1);
		}
		stdfs::create_directories(out_path);
		if (!write_all_bytes(out_path / "descriptor.ps3r", ps3recomp::serialize_descriptor_binary(desc), err))
		{
			std::cerr << "[lift] ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::ostringstream idx;
		idx << "{\n  \"frontend\": \"" << (lift_opts.frontend == ps3recomp::LiftFrontend::GhidraCpp ? "ghidra-cpp" : "llvm-ir") << "\",\n"
		    << "  \"totalBlocks\": " << lifted.total_blocks << ",\n"
		    << "  \"jumpTables\": " << desc.jump_tables.size() << ",\n"
		    << "  \"jumpTableSplits\": " << lifted.jump_table_splits << ",\n"
		    << "  \"shards\": [\n";
		for (size_t i = 0; i < lifted.ppu_shards.size(); ++i)
		{
			const auto& s = lifted.ppu_shards[i];
			const std::string ext = (s.frontend == ps3recomp::LiftFrontend::GhidraCpp) ? ".cpp" : ".ll";
			const std::string fname = s.symbol_suffix + ext;
			if (!write_all_text(out_path / fname, s.text, err))
			{
				std::cerr << "[lift] ERROR: " << err << "\n";
				clean_exit(1);
			}
			if (i > 0) idx << ",\n";
			idx << "    { \"shardName\": \"" << s.shard_name << "\", \"symbolSuffix\": \"" << s.symbol_suffix
			    << "\", \"file\": \"" << fname << "\", \"blocks\": " << s.block_addrs.size() << " }";
		}
		idx << "\n  ]\n}\n";
		if (!write_all_text(out_path / "lifted.json", idx.str(), err))
		{
			std::cerr << "[lift] ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::cout << idx.str();
		std::cerr << "[ps3recomp lift] " << desc.name << ": lifted " << lifted.total_blocks << " blocks into "
		          << lifted.ppu_shards.size() << " shards, " << desc.jump_tables.size() << " jump tables (" << elapsed_ms() << " ms)\n";
		clean_exit(0);
	}

	if (cmd == "compile")
	{
		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path / "descriptor.ps3r", 0, relocatable_wasm, desc, err))
		{
			std::cerr << "[compile] ERROR: " << err << "\n";
			clean_exit(1);
		}
		ps3recomp::LiftResult lifted;
		std::vector<stdfs::path> shard_files;
		for (const auto& entry : stdfs::directory_iterator(input_path))
		{
			const auto ext = entry.path().extension().string();
			if ((ext == ".ll" || ext == ".cpp")
				&& (shard_filter.empty() || entry.path().filename().string().find(shard_filter) != std::string::npos))
			{
				shard_files.push_back(entry.path());
			}
		}
		std::sort(shard_files.begin(), shard_files.end());
		for (size_t i = 0; i < shard_files.size(); ++i)
		{
			ps3recomp::LiftedShard s;
			s.symbol_suffix = shard_files[i].stem().string();
			s.shard_name = s.symbol_suffix;
			s.frontend = (shard_files[i].extension() == ".cpp") ? ps3recomp::LiftFrontend::GhidraCpp : ps3recomp::LiftFrontend::LlvmIr;
			std::vector<uint8_t> raw;
			if (!read_all_bytes(shard_files[i], raw, err)) { std::cerr << err << "\n"; clean_exit(1); }
			s.text.assign(reinterpret_cast<const char*>(raw.data()), raw.size());
			// Count defined __0x blocks in text for summary reporting
			size_t p = 0;
			while ((p = s.text.find("void @__0x", p)) != std::string::npos) { s.block_addrs.push_back(0); p += 10; }
			p = 0;
			while ((p = s.text.find("void __0x", p)) != std::string::npos) { s.block_addrs.push_back(0); p += 9; }
			// Subtract forward declarations in .cpp
			if (s.frontend == ps3recomp::LiftFrontend::GhidraCpp) s.block_addrs.resize(s.block_addrs.size() / 2);
			lifted.total_blocks += static_cast<uint32_t>(s.block_addrs.size());
			lifted.ppu_shards.push_back(std::move(s));
		}

		ps3recomp::CompileResult compiled;
		if (!ps3recomp::compile_lifted_module(desc, lifted, comp_opts, jobs, compiled, err))
		{
			std::cerr << "[compile] ERROR: " << err << "\n";
			clean_exit(1);
		}
		stdfs::create_directories(out_path);
		for (const auto& p : compiled.parts)
		{
			if (!write_all_bytes(out_path / p.filename, p.wasm_bytes, err))
			{
				std::cerr << "[compile] ERROR: " << err << "\n";
				clean_exit(1);
			}
		}
		if (!write_all_text(out_path / "manifest.json", compiled.manifest_json, err))
		{
			std::cerr << "[compile] ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::cout << compiled.manifest_json;
		std::cerr << "[ps3recomp compile] " << desc.name << ": linked " << compiled.parts.size() << " Wasm parts ("
		          << compiled.total_blocks << " blocks, " << compiled.total_hle_calls << " HLE calls lowered, "
		          << compiled.total_jump_tables << " jump tables lowered, " << compiled.total_region_links << " region links) in "
		          << elapsed_ms() << " ms\n";
		clean_exit(0);
	}

	if (cmd == "build")
	{
		ps3recomp::ModuleDescriptor desc;
		if (!load_or_extract_descriptor(input_path, prx_base, relocatable_wasm, desc, err))
		{
			std::cerr << "[build] extract ERROR: " << err << "\n";
			clean_exit(1);
		}
		const auto t_ext = elapsed_ms();
		ps3recomp::LiftResult lifted;
		if (!ps3recomp::lift_module(desc, lift_opts, lifted, err))
		{
			std::cerr << "[build] lift ERROR: " << err << "\n";
			clean_exit(1);
		}
		const auto t_lift = elapsed_ms();
		ps3recomp::CompileResult compiled;
		if (!ps3recomp::compile_lifted_module(desc, lifted, comp_opts, jobs, compiled, err))
		{
			std::cerr << "[build] compile ERROR: " << err << "\n";
			clean_exit(1);
		}
		stdfs::create_directories(out_path);
		for (const auto& p : compiled.parts)
		{
			if (!write_all_bytes(out_path / p.filename, p.wasm_bytes, err))
			{
				std::cerr << "[build] write ERROR: " << err << "\n";
				clean_exit(1);
			}
		}
		if (!write_all_text(out_path / "manifest.json", compiled.manifest_json, err))
		{
			std::cerr << "[build] manifest ERROR: " << err << "\n";
			clean_exit(1);
		}
		std::cout << compiled.manifest_json;
		std::cerr << "[ps3recomp build] " << desc.name << ": " << compiled.total_blocks << " blocks -> "
		          << compiled.parts.size() << " Wasm parts | stubs=" << desc.stubs.size()
		          << " hle_calls=" << compiled.total_hle_calls << " jump_tables=" << desc.jump_tables.size()
		          << " (extract=" << t_ext << "ms, lift=" << (t_lift - t_ext) << "ms, compile=" << (elapsed_ms() - t_lift) << "ms)\n";
		clean_exit(0);
	}

	if (cmd == "firmware")
	{
		if (!stdfs::is_directory(input_path))
		{
			std::cerr << "[firmware] ERROR: Not a directory: " << input_path << "\n";
			clean_exit(1);
		}
		if (!shard_blocks_explicit)
		{
			lift_opts.max_blocks_per_shard = 4096;
		}
		if (!frontend_explicit)
		{
			lift_opts.frontend = ps3recomp::LiftFrontend::GhidraCpp;
		}

		std::vector<stdfs::path> sprx_files;
		for (const auto& entry : stdfs::directory_iterator(input_path))
		{
			if (entry.is_regular_file() && entry.path().extension() == ".sprx")
			{
				sprx_files.push_back(entry.path());
			}
		}
		std::sort(sprx_files.begin(), sprx_files.end());
		if (sprx_files.empty())
		{
			std::cerr << "[firmware] ERROR: No .sprx files found in " << input_path << "\n";
			clean_exit(1);
		}

		struct FirmwareWorkItem
		{
			stdfs::path src_path;
			std::string sprx_name;
			std::string stem;
			std::string source_hash;
			ps3recomp::ModuleDescriptor desc;
			ps3recomp::LiftResult lifted;
			ps3recomp::CompileResult compiled;
			std::vector<std::string> out_files;
			std::string error;
			bool skipped_data_only = false;
		};

		std::unordered_map<std::string, std::string> existing_source_hashes;
		std::unordered_map<std::string, std::string> existing_sha1s;
		if (std::ifstream idx_in(out_path / "index.json"); idx_in)
		{
			std::string line;
			std::string cur_mod;
			while (std::getline(idx_in, line))
			{
				if (const auto pos = line.find(".sprx\": {"); pos != std::string::npos)
				{
					const auto q = line.rfind('"', pos);
					if (q != std::string::npos) cur_mod = line.substr(q + 1, pos + 5 - (q + 1));
				}
				else if (!cur_mod.empty())
				{
					const std::string key = "\"sourceHash\": \"";
					if (const auto kp = line.find(key); kp != std::string::npos)
					{
						const auto vs = kp + key.size();
						const auto ve = line.find('"', vs);
						if (ve != std::string::npos) existing_source_hashes[cur_mod] = line.substr(vs, ve - vs);
					}
					const std::string skey = "\"sha1\": \"";
					if (const auto kp = line.find(skey); kp != std::string::npos)
					{
						const auto vs = kp + skey.size();
						const auto ve = line.find('"', vs);
						if (ve != std::string::npos) existing_sha1s[cur_mod] = line.substr(vs, ve - vs);
					}
				}
			}
		}

		std::vector<FirmwareWorkItem> items(sprx_files.size());
		std::cerr << "[ps3recomp firmware] Decrypting & lifting " << sprx_files.size() << " PS3 firmware .sprx libraries...\n";

		size_t lifted_ok = 0;
		for (size_t i = 0; i < sprx_files.size(); ++i)
		{
			auto& item = items[i];
			item.src_path = sprx_files[i];
			item.sprx_name = sprx_files[i].filename().string();
			item.stem = sprx_files[i].stem().string();

			std::vector<uint8_t> raw;
			if (!read_all_bytes(item.src_path, raw, item.error))
			{
				continue;
			}
			if (!ps3recomp::extract_from_bytes(raw, item.sprx_name, 0, item.desc, item.error, true))
			{
				continue;
			}
			if (!ps3recomp::lift_module(item.desc, lift_opts, item.lifted, item.error))
			{
				if (item.error.find("No executable PPU blocks") != std::string::npos)
				{
					item.skipped_data_only = true;
					item.error.clear();
				}
				continue;
			}
			uint64_t fnv = 14695981039346656037ull;
			auto hash_bytes = [&](const void* data, size_t len)
			{
				const auto* p = static_cast<const uint8_t*>(data);
				for (size_t k = 0; k < len; ++k)
				{
					fnv ^= p[k];
					fnv *= 1099511628211ull;
				}
			};
			hash_bytes(&lift_opts.frontend, sizeof(lift_opts.frontend));
			for (const auto& sh : item.lifted.ppu_shards)
			{
				hash_bytes(sh.text.data(), sh.text.size());
			}
			char hbuf[20];
			std::snprintf(hbuf, sizeof(hbuf), "%016llx", static_cast<unsigned long long>(fnv));
			item.source_hash = hbuf;
			++lifted_ok;
		}
		const auto t_lifted = elapsed_ms();
		std::cerr << "[ps3recomp firmware] Lifted " << lifted_ok << "/" << sprx_files.size()
		          << " libraries in " << t_lifted << " ms. Compiling PIC shared .wasm assemblies across " << jobs << " workers...\n";

		stdfs::create_directories(out_path);
		std::atomic<size_t> next_idx{0};
		std::atomic<size_t> done_count{0};
		std::mutex log_mtx;
		const uint32_t worker_cnt = std::max<uint32_t>(1u, std::min<uint32_t>(jobs, static_cast<uint32_t>(items.size())));
		std::vector<std::thread> workers;
		workers.reserve(worker_cnt);

		for (uint32_t w = 0; w < worker_cnt; ++w)
		{
			workers.emplace_back([&]
			{
				for (;;)
				{
					const size_t idx = next_idx.fetch_add(1, std::memory_order_relaxed);
					if (idx >= items.size()) break;
					auto& item = items[idx];
					if (!item.error.empty() || item.skipped_data_only || item.lifted.ppu_shards.empty()) continue;

					const size_t expected_parts = (item.lifted.ppu_shards.size() + 15u) / 16u;
					const auto hit = existing_source_hashes.find(item.sprx_name);
					const auto shit = existing_sha1s.find(item.sprx_name);
					bool reused = expected_parts > 0 && (
						(hit != existing_source_hashes.end() && hit->second == item.source_hash) ||
						(hit == existing_source_hashes.end() && shit != existing_sha1s.end() && shit->second == item.desc.sha1_hex));
					std::vector<std::string> cand_files(expected_parts);
					std::vector<std::vector<uint8_t>> cand_bytes(expected_parts);
					for (size_t p = 0; p < expected_parts; ++p)
					{
						char pbuf[128];
						if (expected_parts == 1) std::snprintf(pbuf, sizeof(pbuf), "%s.wasm", item.stem.c_str());
						else std::snprintf(pbuf, sizeof(pbuf), "%s_part_%03zu.wasm", item.stem.c_str(), p);
						cand_files[p] = pbuf;
						std::string rerr;
						if (!stdfs::exists(out_path / cand_files[p]) || !read_all_bytes(out_path / cand_files[p], cand_bytes[p], rerr) || cand_bytes[p].empty())
						{
							reused = false;
							break;
						}
					}

					if (reused)
					{
						item.out_files = std::move(cand_files);
						item.compiled.total_blocks = item.lifted.total_blocks;
						item.compiled.parts.resize(expected_parts);
						for (size_t p = 0; p < expected_parts; ++p)
						{
							uint32_t g_blocks = 0;
							for (size_t s = p * 16u; s < std::min(item.lifted.ppu_shards.size(), (p + 1u) * 16u); ++s)
							{
								g_blocks += static_cast<uint32_t>(item.lifted.ppu_shards[s].block_addrs.size());
							}
							item.compiled.parts[p].filename = item.out_files[p];
							item.compiled.parts[p].block_count = g_blocks;
							item.compiled.parts[p].wasm_bytes = std::move(cand_bytes[p]);
						}
						done_count.fetch_add(1, std::memory_order_relaxed);
						continue;
					}

					if (!ps3recomp::compile_lifted_module(item.desc, item.lifted, comp_opts, 1u, item.compiled, item.error))
					{
						std::lock_guard lk(log_mtx);
						std::cerr << "  [FAIL] " << item.sprx_name << ": " << item.error << "\n";
						continue;
					}

					item.out_files.resize(item.compiled.parts.size());
					for (size_t p = 0; p < item.compiled.parts.size(); ++p)
					{
						char pbuf[128];
						if (item.compiled.parts.size() == 1)
						{
							std::snprintf(pbuf, sizeof(pbuf), "%s.wasm", item.stem.c_str());
						}
						else
						{
							std::snprintf(pbuf, sizeof(pbuf), "%s_part_%03zu.wasm", item.stem.c_str(), p);
						}
						item.out_files[p] = pbuf;
						if (!write_all_bytes(out_path / item.out_files[p], item.compiled.parts[p].wasm_bytes, item.error))
						{
							break;
						}
					}

					const size_t cur_done = done_count.fetch_add(1, std::memory_order_relaxed) + 1;
					if ((cur_done % 16) == 0 || cur_done == lifted_ok)
					{
						std::lock_guard lk(log_mtx);
						std::cerr << "  [" << cur_done << "/" << lifted_ok << "] compiled " << item.sprx_name
						          << " (" << item.compiled.total_blocks << " blocks -> " << item.compiled.parts.size() << " wasm)\n";
					}
				}
			});
		}
		for (auto& th : workers) th.join();

		uint64_t total_libs = 0;
		uint64_t total_parts = 0;
		uint64_t total_blocks = 0;
		uint64_t total_bytes = 0;
		size_t failures = 0;

		std::ostringstream index_json;
		index_json << "{\n"
		           << "  \"version\": 1,\n"
		           << "  \"relocatable\": true,\n"
		           << "  \"modules\": {\n";
		bool first_mod = true;
		for (const auto& item : items)
		{
			if (item.skipped_data_only) continue;
			if (!item.error.empty() || item.compiled.parts.empty())
			{
				++failures;
				std::cerr << "[firmware] FAILED " << item.sprx_name << ": " << item.error << "\n";
				continue;
			}
			if (!first_mod) index_json << ",\n";
			first_mod = false;
			++total_libs;
			total_parts += item.compiled.parts.size();
			total_blocks += item.compiled.total_blocks;

			index_json << "    \"" << item.sprx_name << "\": {\n"
			           << "      \"sha1\": \"" << item.desc.sha1_hex << "\",\n"
			           << "      \"sourceHash\": \"" << item.source_hash << "\",\n"
			           << "      \"blocks\": " << item.compiled.total_blocks << ",\n"
			           << "      \"hleCalls\": " << item.compiled.total_hle_calls << ",\n"
			           << "      \"relocs\": " << item.desc.relocs.size() << ",\n"
			           << "      \"parts\": [";
			for (size_t p = 0; p < item.compiled.parts.size(); ++p)
			{
				const auto& cp = item.compiled.parts[p];
				total_bytes += cp.wasm_bytes.size();
				if (p > 0) index_json << ",";
				index_json << "\n        { \"file\": \"" << item.out_files[p] << "\", \"size\": " << cp.wasm_bytes.size()
				           << ", \"blocks\": " << cp.block_count << " }";
			}
			index_json << "\n      ]\n    }";
		}
		index_json << "\n  }\n}\n";

		if (!write_all_text(out_path / "index.json", index_json.str(), err))
		{
			std::cerr << "[firmware] write index.json ERROR: " << err << "\n";
			clean_exit(1);
		}

		std::cerr << "[ps3recomp firmware] DONE: " << total_libs << " libraries (" << total_parts << " .wasm assemblies, "
		          << total_blocks << " blocks, " << (total_bytes / 1024) << " KiB, " << failures << " failures) in "
		          << elapsed_ms() << " ms\n";
		clean_exit(failures == 0 ? 0 : 1);
	}

	std::cerr << "Unknown command: " << cmd << "\n";
	print_usage();
	clean_exit(2);
}
