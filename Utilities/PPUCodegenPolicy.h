#pragma once

#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string_view>

// Stable policy shared by the native PPU JIT and the AOT frontend. Values in this
// header participate in persistent cache identity, so append new values rather
// than renumbering existing ones.
enum class ppu_backend_kind : std::uint8_t
{
	jit = 0,
	aot = 1,
};

enum class ppu_target_kind : std::uint8_t
{
	native = 0,
	wasm = 1,
};

enum class ppu_llvm_optimization : std::uint8_t
{
	o0 = 0,
	o1 = 1,
	o2 = 2,
	o3 = 3,
};

struct ppu_codegen_policy
{
	// Increment when translated PPU semantics change in a way that invalidates
	// artifacts even if the guest bytes and compiler version are unchanged.
	static constexpr std::uint32_t semantics_version = 23;
	static constexpr std::string_view cache_schema = "ppu-codegen-v2";

	ppu_backend_kind backend = ppu_backend_kind::jit;
	ppu_target_kind target = ppu_target_kind::native;
	ppu_llvm_optimization optimization = ppu_llvm_optimization::o3;
	bool hle_direct_calls = true;
	bool inline_guest_reads = true;
	bool inline_guest_writes = false;
	bool fail_closed = false;

	static constexpr const char* backend_name(ppu_backend_kind value)
	{
		switch (value)
		{
		case ppu_backend_kind::jit: return "jit";
		case ppu_backend_kind::aot: return "aot";
		}

		return "unknown";
	}

	static constexpr const char* target_name(ppu_target_kind value)
	{
		switch (value)
		{
		case ppu_target_kind::native: return "x86_64";
		case ppu_target_kind::wasm: return "wasm32";
		}

		return "unknown";
	}

	static constexpr std::uint8_t optimization_number(ppu_llvm_optimization value)
	{
		return static_cast<std::uint8_t>(value);
	}

	std::string_view cache_tag() const
	{
		switch (optimization)
		{
		case ppu_llvm_optimization::o0: return "o0";
		case ppu_llvm_optimization::o1: return "o1";
		case ppu_llvm_optimization::o2: return "o2";
		case ppu_llvm_optimization::o3: return "o3";
		}

		return "unknown";
	}
};

inline ppu_backend_kind ppu_backend_from_environment(ppu_backend_kind fallback)
{
	const char* value = std::getenv("RPCS3_PPU_BACKEND");

	if (!value || !*value)
	{
		return fallback;
	}

	if (std::string_view(value) == "aot")
	{
		return ppu_backend_kind::aot;
	}

	if (std::string_view(value) == "jit")
	{
		return ppu_backend_kind::jit;
	}

	return fallback;
}

inline ppu_llvm_optimization ppu_optimization_from_environment(ppu_llvm_optimization fallback)
{
	const char* value = std::getenv("RPCS3_PPU_LLVM_OPT");

	if (!value || !*value)
	{
		return fallback;
	}

	switch (value[0])
	{
	case '0': return ppu_llvm_optimization::o0;
	case '1': return ppu_llvm_optimization::o1;
	case '2': return ppu_llvm_optimization::o2;
	case '3': return ppu_llvm_optimization::o3;
	default: return fallback;
	}
}

inline ppu_codegen_policy make_ppu_codegen_policy(ppu_backend_kind fallback_backend, ppu_target_kind target)
{
	ppu_codegen_policy result;
	result.backend = ppu_backend_from_environment(fallback_backend);
	result.target = target;
	result.optimization = ppu_optimization_from_environment(ppu_llvm_optimization::o3);
	result.fail_closed = result.backend == ppu_backend_kind::aot;
	return result;
}
