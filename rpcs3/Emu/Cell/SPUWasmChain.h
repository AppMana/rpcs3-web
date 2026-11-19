#pragma once
#include <stdint.h>

// wasm32 ABI for a runner linked into the same module as the SPU programs.
// All addresses refer to the runtime's shared memory. The owner supplies a
// worker-private context/cache; only the immutable list publication is shared.
enum spu_chain_exit
{
	SPU_CHAIN_BUDGET,
	SPU_CHAIN_REJECTED,
	SPU_CHAIN_INTERPRET,
	SPU_CHAIN_STATE,
	SPU_CHAIN_MISS,
	SPU_CHAIN_OTHER_MODULE,
};

struct spu_chain_context
{
	uint32_t pc, failure, state;
	uint32_t lists, cache;
	uint32_t table_begin, table_end;
	uint32_t target, budget;
	uint32_t completed, reason;
	// ABI 2 diagnostic extension. ABI 1 runners access only the prefix above.
	uint32_t edge_slots, profile_clock;
};

#define SPU_CHAIN_CACHE_SLOTS 65536
static inline uint32_t spu_chain_cache_slot(uint32_t pc)
{
	const uint32_t word = (pc & 0x3fffc) >> 2;
	return (word ^ (word >> 8)) & (SPU_CHAIN_CACHE_SLOTS - 1);
}

#define SPU_CHAIN_EDGE_SLOTS 4096
#define SPU_CHAIN_EDGE_STORAGE (SPU_CHAIN_EDGE_SLOTS + 1)
struct spu_chain_edge { uint64_t key, count; };

void rpcs3_spu_run_chain(uint32_t thread, uint32_t ls, uint64_t context);
void rpcs3_spu_run_chain_profile(uint32_t thread, uint32_t ls, uint64_t context);
