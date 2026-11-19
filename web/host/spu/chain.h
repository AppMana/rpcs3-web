#pragma once
// Shared execution ABI is owned by the Cell backend, not the offline builder.
#include "../../../rpcs3/Emu/Cell/SPUWasmChain.h"

// Resolve only a search preference. The selected program still verifies LS.
// Missing publication/preferences return to the owner; bounds/state are checked
// by the runner before executing the selected target.
static inline int spu_chain_cached_target_fast(const uint32_t* lists, const uint32_t* cache, uint32_t pc, uint32_t* target)
{
	(void)lists;
	const uint32_t t = *(const uint32_t*)((const uint8_t*)cache + (pc & 0x3fffc));
	if (!t) return 0;
	*target = t;
	return 1;
}

static inline int spu_chain_cached_target(const struct spu_chain_context* c, uint32_t pc, uint32_t* target)
{
	return spu_chain_cached_target_fast((const uint32_t*)(uintptr_t)c->lists, (const uint32_t*)(uintptr_t)c->cache, pc, target);
}

// Resolve from the worker-private (list generation, candidate) pairs used by
// the full runner. Region code has no view of the enclosing table struct, so
// this keeps it on the same cache format instead of guessing from a raw slot.
static inline int spu_chain_cached_target_pairs(const uint32_t* lists, const uint32_t* cache, uint32_t pc, uint32_t* target)
{
	const uint32_t word = (pc & 0x3fffc) >> 2;
	const uint32_t list_addr = lists[word];
	const uint32_t* list = (const uint32_t*)(uintptr_t)list_addr;
	const uint32_t* pair = cache + spu_chain_cache_slot(pc) * 2;
	if (!list || !list[0] || pair[0] != list_addr || pair[1] >= list[0]) return 0;
	*target = list[1 + pair[1]];
	return 1;
}

