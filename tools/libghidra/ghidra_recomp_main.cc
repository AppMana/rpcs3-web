#include "libdecomp.hh"
#include "sleigh_arch.hh"
#include "loadimage.hh"
#include "funcdata.hh"
#include "jumptable.hh"
#include "flow.hh"
#include "Utilities/WasmStubMap.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace {

uint16_t read_be16(const uint8_t* p) {
	return (static_cast<uint16_t>(p[0]) << 8) | static_cast<uint16_t>(p[1]);
}

uint32_t read_be32(const uint8_t* p) {
	return (static_cast<uint32_t>(p[0]) << 24) |
	       (static_cast<uint32_t>(p[1]) << 16) |
	       (static_cast<uint32_t>(p[2]) << 8) |
	       static_cast<uint32_t>(p[3]);
}

uint64_t read_be64(const uint8_t* p) {
	return (static_cast<uint64_t>(read_be32(p)) << 32) | static_cast<uint64_t>(read_be32(p + 4));
}

struct ElfSegment {
	uint32_t vaddr = 0;
	uint32_t filesz = 0;
	uint32_t memsz = 0;
	uint32_t flags = 0;
	std::vector<uint8_t> data;
};

struct OpdEntry {
	uint32_t opd_addr = 0;
	uint32_t func_pc = 0;
	uint32_t toc_r2 = 0;
};

class CellElfImage {
public:
	std::string path;
	uint32_t e_entry = 0;
	uint32_t entry_pc = 0;
	uint32_t entry_toc = 0;
	std::vector<ElfSegment> segments;
	std::vector<std::pair<uint32_t, uint32_t>> readonly_ranges;
	std::vector<OpdEntry> opd_entries;

	bool load(const std::string& elf_path, std::string& err) {
		path = elf_path;
		std::ifstream ifs(elf_path, std::ios::binary | std::ios::ate);
		if (!ifs) {
			err = "Failed to open ELF: " + elf_path;
			return false;
		}
		const auto file_size = static_cast<size_t>(ifs.tellg());
		if (file_size < 64) {
			err = "ELF file too small";
			return false;
		}
		std::vector<uint8_t> raw(file_size);
		ifs.seekg(0);
		ifs.read(reinterpret_cast<char*>(raw.data()), static_cast<std::streamsize>(file_size));

		if (raw[0] != 0x7f || raw[1] != 'E' || raw[2] != 'L' || raw[3] != 'F' || raw[4] != 2 || raw[5] != 2) {
			err = "Expected 64-bit big-endian ELF (Cell PPU)";
			return false;
		}

		e_entry = static_cast<uint32_t>(read_be64(raw.data() + 24));
		const uint64_t e_phoff = read_be64(raw.data() + 32);
		const uint64_t e_shoff = read_be64(raw.data() + 40);
		const uint16_t e_phentsize = read_be16(raw.data() + 54);
		const uint16_t e_phnum = read_be16(raw.data() + 56);
		const uint16_t e_shentsize = read_be16(raw.data() + 58);
		const uint16_t e_shnum = read_be16(raw.data() + 60);

		for (uint16_t i = 0; i < e_phnum; ++i) {
			const size_t off = static_cast<size_t>(e_phoff) + static_cast<size_t>(i) * e_phentsize;
			if (off + 56 > raw.size()) break;
			const uint32_t p_type = read_be32(raw.data() + off);
			const uint32_t p_flags = read_be32(raw.data() + off + 4);
			const uint64_t p_offset = read_be64(raw.data() + off + 8);
			const uint64_t p_vaddr = read_be64(raw.data() + off + 16);
			const uint64_t p_filesz = read_be64(raw.data() + off + 32);
			const uint64_t p_memsz = read_be64(raw.data() + off + 40);
			if (p_type != 1 || p_memsz == 0) continue; // PT_LOAD = 1
			if (p_offset + p_filesz > raw.size()) continue;

			ElfSegment seg;
			seg.vaddr = static_cast<uint32_t>(p_vaddr);
			seg.filesz = static_cast<uint32_t>(p_filesz);
			seg.memsz = static_cast<uint32_t>(p_memsz);
			seg.flags = p_flags;
			seg.data.resize(seg.memsz, 0);
			std::memcpy(seg.data.data(), raw.data() + p_offset, seg.filesz);
			segments.push_back(std::move(seg));

			// PF_W = 0x2: non-writable PT_LOAD segments (.text, .rodata) are read-only
			if ((p_flags & 0x2u) == 0 && seg.memsz > 0) {
				readonly_ranges.emplace_back(seg.vaddr, seg.vaddr + seg.memsz - 1);
			}
		}

		uint32_t opd_word0 = 0, opd_word1 = 0;
		if (read_u32_be(e_entry, opd_word0) && read_u32_be(e_entry + 4, opd_word1)) {
			entry_pc = opd_word0;
			entry_toc = opd_word1;
		}

		// Inspect ELF64 section headers to locate non-writable sections plus immutable .opd and .toc
		if (e_shoff && e_shnum && e_shentsize >= 64) {
			const uint32_t toc_sec_probe = entry_toc >= 0x8000u ? (entry_toc - 0x8000u) : entry_toc;
			for (uint16_t i = 0; i < e_shnum; ++i) {
				const size_t off = static_cast<size_t>(e_shoff) + static_cast<size_t>(i) * e_shentsize;
				if (off + 64 > raw.size()) break;
				const uint32_t sh_type = read_be32(raw.data() + off + 4);
				const uint64_t sh_flags = read_be64(raw.data() + off + 8);
				const uint32_t sh_addr = static_cast<uint32_t>(read_be64(raw.data() + off + 16));
				const uint32_t sh_size = static_cast<uint32_t>(read_be64(raw.data() + off + 32));
				if (sh_type == 0 || sh_addr == 0 || sh_size == 0) continue;

				const bool is_alloc = (sh_flags & 0x2u) != 0; // SHF_ALLOC
				const bool is_write = (sh_flags & 0x1u) != 0; // SHF_WRITE
				const bool is_opd = (e_entry >= sh_addr && e_entry < sh_addr + sh_size);
				const bool is_toc = (entry_toc != 0 && toc_sec_probe >= sh_addr && toc_sec_probe < sh_addr + sh_size);

				if (is_alloc && (!is_write || is_opd || is_toc)) {
					readonly_ranges.emplace_back(sh_addr, sh_addr + sh_size - 1);
				}

				if (is_opd) {
					for (uint32_t p = sh_addr; p + 8 <= sh_addr + sh_size; p += 8) {
						uint32_t fpc = 0, ftoc = 0;
						if (read_u32_be(p, fpc) && read_u32_be(p + 4, ftoc) && fpc != 0 && (fpc & 3u) == 0 && is_exec_addr(fpc)) {
							opd_entries.push_back({p, fpc, ftoc});
						}
					}
				}
			}
		}
		return !segments.empty();
	}

	bool is_exec_addr(uint32_t addr) const {
		for (const auto& seg : segments) {
			if ((seg.flags & 0x1u) && addr >= seg.vaddr && addr < seg.vaddr + seg.memsz) {
				return true;
			}
		}
		return false;
	}

	bool read_bytes(uint32_t addr, uint8_t* dst, uint32_t size) const {
		for (const auto& seg : segments) {
			if (addr >= seg.vaddr && addr < seg.vaddr + seg.memsz) {
				const uint32_t off = addr - seg.vaddr;
				const uint32_t avail = std::min<uint32_t>(size, seg.memsz - off);
				std::memcpy(dst, seg.data.data() + off, avail);
				if (avail < size) {
					std::memset(dst + avail, 0, size - avail);
				}
				return true;
			}
		}
		return false;
	}

	bool read_u32_be(uint32_t addr, uint32_t& out) const {
		uint8_t buf[4];
		if (!read_bytes(addr, buf, 4)) return false;
		out = read_be32(buf);
		return true;
	}
};

class CellElfLoadImage : public ghidra::LoadImage {
	const CellElfImage& image_;
	ghidra::AddrSpace* code_space_ = nullptr;

public:
	explicit CellElfLoadImage(const CellElfImage& img)
		: ghidra::LoadImage(img.path), image_(img) {}

	void attachToSpace(ghidra::AddrSpace* spc) { code_space_ = spc; }

	void loadFill(ghidra::uint1* ptr, ghidra::int4 size, const ghidra::Address& addr) override {
		const uint32_t start = static_cast<uint32_t>(addr.getOffset());
		for (ghidra::int4 i = 0; i < size; ++i) {
			uint8_t b = 0;
			image_.read_bytes(start + static_cast<uint32_t>(i), &b, 1);
			ptr[i] = b;
		}
	}

	std::string getArchType(void) const override {
		return "PowerPC:BE:64:64-32addr";
	}

	void adjustVma(long) override {}

	void getReadonly(ghidra::RangeList& list) const override {
		if (!code_space_) return;
		for (const auto& [first, last] : image_.readonly_ranges) {
			list.insertRange(code_space_, first, last);
		}
	}
};

class CellPpuArchitecture : public ghidra::SleighArchitecture {
	const CellElfImage& image_;

protected:
	void buildLoader(ghidra::DocumentStorage&) override {
		collectSpecFiles(*errorstream);
		loader = new CellElfLoadImage(image_);
	}

	void resolveArchitecture(void) override {
		archid = getTarget();
		ghidra::SleighArchitecture::resolveArchitecture();
	}

	void buildSpecFile(ghidra::DocumentStorage& store) override {
		ghidra::SleighArchitecture::buildSpecFile(store);
		// Cell PPU LV2 ABI preserves r2 (TOC) and r13 (TLS) across calls.
		std::string cspec_file;
		specpaths.findFile(cspec_file, "ppc_64_32.cspec");
		if (!cspec_file.empty()) {
			std::ifstream ifs(cspec_file);
			std::string xml((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
			const std::string needle = "</unaffected>";
			const auto pos = xml.find(needle);
			if (pos != std::string::npos) {
				xml.insert(pos, "        <register name=\"r2\"/>\n        <register name=\"r13\"/>\n");
				std::istringstream iss(xml);
				ghidra::Document* doc = store.parseDocument(iss);
				store.registerTag(doc->getRoot());
			}
		}
	}

	void postSpecFile(void) override {
		ghidra::Architecture::postSpecFile();
		static_cast<CellElfLoadImage*>(loader)->attachToSpace(getDefaultCodeSpace());
	}

public:
	CellPpuArchitecture(const CellElfImage& img, const std::string& targ, std::ostream* estream)
		: ghidra::SleighArchitecture(img.path, targ, estream), image_(img) {}
};

std::string json_escape(const std::string& s) {
	std::ostringstream oss;
	for (unsigned char c : s) {
		switch (c) {
		case '"': oss << "\\\""; break;
		case '\\': oss << "\\\\"; break;
		case '\b': oss << "\\b"; break;
		case '\f': oss << "\\f"; break;
		case '\n': oss << "\\n"; break;
		case '\r': oss << "\\r"; break;
		case '\t': oss << "\\t"; break;
		default:
			if (c < 0x20) {
				oss << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c) << std::dec;
			} else {
				oss << static_cast<char>(c);
			}
		}
	}
	return oss.str();
}

std::string hex32(uint32_t v) {
	std::ostringstream oss;
	oss << "0x" << std::hex << v;
	return oss.str();
}

} // namespace

int main(int argc, char** argv) {
	std::string elf_path;
	std::string ghidra_home = DEFAULT_GHIDRA_HOME;
	std::string json_out;
	std::string cpp_out;
	std::vector<uint32_t> target_funcs;
	size_t scan_opd_switches = 0;

	for (int i = 1; i < argc; ++i) {
		const std::string arg = argv[i];
		if (arg == "--elf" && i + 1 < argc) {
			elf_path = argv[++i];
		} else if (arg == "--ghidra-home" && i + 1 < argc) {
			ghidra_home = argv[++i];
		} else if (arg == "--func" && i + 1 < argc) {
			target_funcs.push_back(static_cast<uint32_t>(std::stoul(argv[++i], nullptr, 0)));
		} else if (arg == "--scan-opd-switches" && i + 1 < argc) {
			scan_opd_switches = std::stoull(argv[++i], nullptr, 0);
		} else if (arg == "--json" && i + 1 < argc) {
			json_out = argv[++i];
		} else if (arg == "--cpp" && i + 1 < argc) {
			cpp_out = argv[++i];
		} else {
			std::cerr << "Unknown or incomplete argument: " << arg << "\n";
			return 2;
		}
	}

	if (elf_path.empty()) {
		std::cerr << "Usage: ghidra-recomp --elf <EBOOT.elf> [--func 0xADDR ...] [--scan-opd-switches N] [--cpp out.cpp] [--json out.json]\n";
		return 2;
	}

	CellElfImage elf;
	std::string err;
	if (!elf.load(elf_path, err)) {
		std::cerr << err << "\n";
		return 1;
	}

	ghidra::startDecompilerLibrary(ghidra_home.c_str());

	std::ostringstream arch_err;
	CellPpuArchitecture arch(elf, "PowerPC:BE:64:64-32addr", &arch_err);
	ghidra::DocumentStorage store;
	try {
		arch.init(store);
	} catch (const ghidra::LowlevelError& e) {
		std::cerr << "Ghidra architecture init error: " << e.explain << "\n" << arch_err.str() << "\n";
		return 1;
	}

	auto* code_space = arch.getDefaultCodeSpace();
	auto* global_scope = arch.symboltab->getGlobalScope();

	// Track the module's TOC pointer r2 across the entire address space so TOC loads fold cleanly.
	if (elf.entry_toc != 0) {
		auto& tracked = arch.context->getTrackedDefault();
		tracked.emplace_back();
		tracked.back().loc = arch.translate->getRegister("r2");
		tracked.back().val = elf.entry_toc;
	}

	// Dynamically scan executable segments for 8-word .sceStub.text trampolines (game-agnostic).
	struct DiscoveredStub {
		uint32_t stub_pc = 0;
		uint32_t faddr = 0;
		std::string name;
	};
	std::vector<DiscoveredStub> discovered_stubs;
	std::map<uint32_t, wasm_codegen::sce_stub_entry> stub_storage;
	std::map<uint32_t, const wasm_codegen::sce_stub_entry*> stub_by_pc;
	std::set<std::string> used_names;
	for (const auto& seg : elf.segments) {
		if ((seg.flags & 0x1u) == 0) continue;
		for (uint32_t pc = seg.vaddr; pc + 32 <= seg.vaddr + seg.filesz; pc += 4) {
			uint32_t w0 = 0, w1 = 0, w3 = 0, w7 = 0;
			if (!elf.read_u32_be(pc, w0) || !elf.read_u32_be(pc + 4, w1) ||
			    !elf.read_u32_be(pc + 12, w3) || !elf.read_u32_be(pc + 28, w7)) continue;
			if (w3 == 0xf8410028u && w7 == 0x4e800420u && (w0 & 0xffff0000u) == 0x3d800000u &&
			    ((w1 & 0xffff0000u) == 0x618c0000u || (w1 & 0xffff0000u) == 0x398c0000u)) {
				const uint32_t hi = w0 & 0xffffu;
				const uint32_t lo = w1 & 0xffffu;
				const uint32_t faddr = ((w1 & 0xffff0000u) == 0x618c0000u)
					? ((hi << 16) | lo)
					: ((hi << 16) + static_cast<uint32_t>(static_cast<int32_t>(static_cast<int16_t>(lo))));
				const char* stable_name = used_names.insert("sce_stub_" + hex32(pc).substr(2)).first->c_str();
				auto& st = stub_storage[pc];
				st = wasm_codegen::sce_stub_entry{pc, faddr, 0, "sceStub", stable_name, true};
				stub_by_pc[pc] = &st;
				global_scope->addFunction(ghidra::Address(code_space, pc), stable_name);
				pc += 28;
			}
		}
	}

	// Register all OPD-discovered functions in the global scope so intra-module calls have clean symbols.
	std::vector<uint32_t> sorted_opd_pcs;
	sorted_opd_pcs.reserve(elf.opd_entries.size());
	for (const auto& opd : elf.opd_entries) {
		sorted_opd_pcs.push_back(opd.func_pc);
		const ghidra::Address faddr(code_space, opd.func_pc);
		if (!global_scope->queryFunction(faddr)) {
			global_scope->addFunction(faddr, "sub_" + hex32(opd.func_pc).substr(2));
		}
	}
	std::sort(sorted_opd_pcs.begin(), sorted_opd_pcs.end());
	sorted_opd_pcs.erase(std::unique(sorted_opd_pcs.begin(), sorted_opd_pcs.end()), sorted_opd_pcs.end());

	// Optional: scan OPD functions containing bctr (0x4e800420) to verify JumpTable recovery at scale.
	if (scan_opd_switches > 0) {
		size_t added = 0;
		for (size_t idx = 0; idx + 1 < sorted_opd_pcs.size() && added < scan_opd_switches; ++idx) {
			const uint32_t start = sorted_opd_pcs[idx];
			const uint32_t end = std::min<uint32_t>(sorted_opd_pcs[idx + 1], start + 0x2000u);
			bool has_bctr = false;
			for (uint32_t pc = start; pc < end; pc += 4) {
				uint32_t insn = 0;
				if (elf.read_u32_be(pc, insn) && insn == 0x4e800420u) {
					has_bctr = true;
					break;
				}
			}
			if (has_bctr && std::find(target_funcs.begin(), target_funcs.end(), start) == target_funcs.end()) {
				target_funcs.push_back(start);
				++added;
			}
		}
	}

	std::ostringstream all_cpp;
	all_cpp << "// Generated by tools/libghidra/ghidra-recomp (Ghidra 12.1.3 PowerPC:BE:64:64-32addr)\n";
	all_cpp << "// ELF: " << elf_path << " (entry_pc=" << hex32(elf.entry_pc) << ", toc_r2=" << hex32(elf.entry_toc)
	        << ", opd_functions=" << sorted_opd_pcs.size() << ")\n\n";

	std::ostringstream json;
	json << "{\n";
	json << "  \"elf\": \"" << json_escape(elf_path) << "\",\n";
	json << "  \"arch\": \"PowerPC:BE:64:64-32addr\",\n";
	json << "  \"entryPc\": \"" << hex32(elf.entry_pc) << "\",\n";
	json << "  \"tocR2\": \"" << hex32(elf.entry_toc) << "\",\n";
	json << "  \"opdFunctionCount\": " << sorted_opd_pcs.size() << ",\n";
	json << "  \"registeredHleStubs\": " << stub_by_pc.size() << ",\n";
	json << "  \"functions\": [\n";

	size_t total_jump_tables = 0;
	size_t total_jump_targets = 0;
	size_t decompiled_ok = 0;

	auto* root_action = arch.allacts.getCurrent();

	for (size_t fi = 0; fi < target_funcs.size(); ++fi) {
		const uint32_t fpc = target_funcs[fi];
		const ghidra::Address faddr(code_space, fpc);
		ghidra::Funcdata* fd = global_scope->queryFunction(faddr);
		if (!fd) {
			fd = global_scope->addFunction(faddr, "sub_" + hex32(fpc).substr(2))->getFunction();
		}

		std::string decomp_err;
		std::ostringstream fn_cpp;
		try {
			root_action->reset(*fd);
			root_action->perform(*fd);
			arch.print->setOutputStream(&fn_cpp);
			arch.print->docFunction(fd);
			++decompiled_ok;
		} catch (const ghidra::LowlevelError& e) {
			decomp_err = e.explain;
		}

		all_cpp << "// === Function " << fd->getName() << " @ " << hex32(fpc) << " ===\n";
		if (!decomp_err.empty()) {
			all_cpp << "// ERROR: " << decomp_err << "\n\n";
		} else {
			all_cpp << fn_cpp.str() << "\n";
		}

		// Collect direct HLE/PRX calls made by this function.
		std::vector<const wasm_codegen::sce_stub_entry*> hle_calls;
		for (int qi = 0; qi < fd->numCalls(); ++qi) {
			const auto* fc = fd->getCallSpecs(qi);
			if (!fc) continue;
			const ghidra::Address call_target = fc->getEntryAddress();
			if (!call_target.isInvalid()) {
				auto it = stub_by_pc.find(static_cast<uint32_t>(call_target.getOffset()));
				if (it != stub_by_pc.end()) {
					hle_calls.push_back(it->second);
				}
			}
		}

		if (fi > 0) json << ",\n";
		json << "    {\n";
		json << "      \"address\": \"" << hex32(fpc) << "\",\n";
		json << "      \"name\": \"" << json_escape(fd->getName()) << "\",\n";
		json << "      \"basicBlocks\": " << fd->getBasicBlocks().getSize() << ",\n";
		json << "      \"error\": \"" << json_escape(decomp_err) << "\",\n";
		json << "      \"hleCalls\": [";
		for (size_t hi = 0; hi < hle_calls.size(); ++hi) {
			if (hi > 0) json << ", ";
			json << "{\"stubPc\": \"" << hex32(hle_calls[hi]->stub_pc)
			     << "\", \"module\": \"" << hle_calls[hi]->module_name
			     << "\", \"name\": \"" << hle_calls[hi]->func_name
			     << "\", \"directHle\": " << (hle_calls[hi]->is_direct_hle ? "true" : "false") << "}";
		}
		json << "],\n";
		json << "      \"jumpTables\": [";
		const int njt = fd->numJumpTables();
		for (int ji = 0; ji < njt; ++ji) {
			const ghidra::JumpTable* jt = fd->getJumpTable(ji);
			if (ji > 0) json << ", ";
			++total_jump_tables;
			const int nent = jt->numEntries();
			total_jump_targets += static_cast<size_t>(std::max(0, nent));
			json << "{\"opAddress\": \"" << hex32(static_cast<uint32_t>(jt->getOpAddress().getOffset()))
			     << "\", \"recovered\": " << (jt->isRecovered() ? "true" : "false")
			     << ", \"numEntries\": " << nent
			     << ", \"targets\": [";
			for (int ti = 0; ti < nent; ++ti) {
				if (ti > 0) json << ", ";
				json << "\"" << hex32(static_cast<uint32_t>(jt->getAddressByIndex(ti).getOffset())) << "\"";
			}
			json << "]}";
		}
		json << "]\n";
		json << "    }";
	}

	json << "\n  ],\n";
	json << "  \"summary\": {\n";
	json << "    \"requestedFunctions\": " << target_funcs.size() << ",\n";
	json << "    \"decompiledOk\": " << decompiled_ok << ",\n";
	json << "    \"recoveredJumpTables\": " << total_jump_tables << ",\n";
	json << "    \"recoveredJumpTargets\": " << total_jump_targets << "\n";
	json << "  }\n";
	json << "}\n";

	if (!cpp_out.empty()) {
		std::ofstream ofs(cpp_out);
		ofs << all_cpp.str();
	} else {
		std::cout << all_cpp.str();
	}

	if (!json_out.empty()) {
		std::ofstream ofs(json_out);
		ofs << json.str();
	}

	std::cerr << "[ghidra-recomp] ELF=" << elf_path
	          << " opd_funcs=" << sorted_opd_pcs.size()
	          << " decompiled=" << decompiled_ok << "/" << target_funcs.size()
	          << " jump_tables=" << total_jump_tables
	          << " jump_targets=" << total_jump_targets << "\n";

	ghidra::shutdownDecompilerLibrary();
	return decompiled_ok == target_funcs.size() ? 0 : 1;
}
