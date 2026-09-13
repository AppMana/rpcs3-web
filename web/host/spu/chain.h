#pragma once
// Shared execution ABI is owned by the Cell backend, not the offline builder.
#include "../../../rpcs3/Emu/Cell/SPUWasmChain.h"

// Resolve only a search preference. The selected program still verifies LS.
// Missing publication/preferences return to the owner; bounds/state are checked
// by the runner before executing the selected target.
static inline int spu_chain_cached_target(const struct spu_chain_context* c, uint32_t pc, uint32_t* target)
{
	const uint32_t word = (pc & 0x3fffc) >> 2;
	const uint32_t list = __atomic_load_n((uint32_t*)(uintptr_t)c->lists + word, __ATOMIC_ACQUIRE);
	const uint32_t* cached = (const uint32_t*)(uintptr_t)c->cache + spu_chain_cache_slot(pc) * 2;
	if (!list || cached[0] != list || cached[1] >= *(const uint32_t*)(uintptr_t)list) return 0;
	*target = ((const uint32_t*)(uintptr_t)list)[1 + cached[1]];
	return 1;
}

