#pragma once
#include <cstdint>

// Optional fourth argument of a Wasm PPU block. Native translation keeps its memory-base ABI.
// The dispatcher owns this context for the entire compiled chain. A zero/absent span means
// return to the dispatcher; a target within the span belongs to this same Wasm instance.
struct ppu_wasm_dispatch_context
{
	std::uint32_t table_begin = 0;
	std::uint32_t table_end = 0;

	bool contains(std::uint32_t index) const
	{
		return index >= table_begin && index < table_end;
	}
};
static_assert(sizeof(ppu_wasm_dispatch_context) == 8);
