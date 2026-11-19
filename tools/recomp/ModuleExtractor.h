#pragma once

#include "ModuleDescriptor.h"
#include <span>
#include <string>
#include <string_view>

template <typename T>
struct ppu_module;
struct lv2_obj;

namespace ps3recomp
{
	// Stage 1A: Extract ModuleDescriptor (relocated segments, .opd descriptors, .sceStub.text HLE/LLE
	// imports, and embedded SPU ELF images) from raw ELF or encrypted SELF/SPRX bytes.
	bool extract_from_bytes(
		std::span<const uint8_t> raw_bytes,
		std::string_view module_name,
		uint32_t prx_base_addr,
		ModuleDescriptor& out,
		std::string& err,
		bool relocatable_wasm = false);

	// Convenience wrapper for file path on native CLI or WasmFS.
	bool extract_from_file(
		const std::string& path,
		uint32_t prx_base_addr,
		ModuleDescriptor& out,
		std::string& err,
		bool relocatable_wasm = false);

	// Extract directly from a live loaded RPCS3 ppu_module<lv2_obj> in guest VM (with relocations,
	// frefs, and vstubs already patched in place).
	bool extract_from_loaded_module(
		const ppu_module<lv2_obj>& mod,
		ModuleDescriptor& out,
		std::string& err);
}
