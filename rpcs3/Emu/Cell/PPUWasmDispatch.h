#pragma once
#include <cstdint>

// Optional fourth argument of a Wasm PPU block. Native translation keeps its memory-base ABI.
// The dispatcher owns this context for the entire compiled chain. A zero/absent span means
// return to the dispatcher; a target within the span belongs to this same Wasm instance.
struct ppu_wasm_dispatch_context
{
	std::uint32_t table_begin = 0;
	std::uint32_t table_end = 0;

	// Updated by generated code at every guest LR write. Keeping this in the
	// dispatch context makes a bad return address attributable to the block that
	// wrote it, including when the writer and epilogue are in different modules.
	std::uint32_t lr_write_pc = 0;
	std::uint32_t lr_write_value = 0;

	// Updated by generated code at every guest GPR11 write. The failure path at
	// 0x34b3c consumes GPR11 before it writes CTR, so LR provenance alone cannot
	// identify where the null object entered the compiled chain.
	std::uint32_t gpr11_write_pc = 0;
	std::uint32_t gpr11_write_value = 0;

	bool contains(std::uint32_t index) const
	{
		return index >= table_begin && index < table_end;
	}
};
static_assert(sizeof(ppu_wasm_dispatch_context) == 24);
