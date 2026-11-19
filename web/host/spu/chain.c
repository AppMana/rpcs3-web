#include "chain.h"

struct spu_cache_entry
{
	uint32_t generation;
	uint32_t candidate;
};

struct spu_ls_entry
{
	uint64_t sig;
	uint32_t generation;
	uint16_t candidate;
	uint16_t word;
};

struct spu_chain_tables
{
	uint32_t direct_targets[SPU_CHAIN_CACHE_SLOTS];
	struct spu_cache_entry entries[SPU_CHAIN_CACHE_SLOTS];
	uint64_t entry_sigs[SPU_CHAIN_CACHE_SLOTS];
	struct spu_ls_entry ls_cache[2048 * 4];
	uint16_t fallback_candidates[SPU_CHAIN_CACHE_SLOTS];
};

_Static_assert(__builtin_offsetof(struct spu_chain_tables, entries) == 0x40000, "entries offset");
_Static_assert(__builtin_offsetof(struct spu_chain_tables, entry_sigs) == 0xc0000, "entry_sigs offset");
_Static_assert(__builtin_offsetof(struct spu_chain_tables, ls_cache) == 0x140000, "ls_cache offset");
_Static_assert(__builtin_offsetof(struct spu_chain_tables, fallback_candidates) == 0x160000, "fallback_candidates offset");

#define SPU_HASH_PAIR(off) \
	do { \
		uint64_t a = 0, b = 0; \
		__builtin_memcpy(&a, ls_ptr + ((base + (off)) & 0x3fffc), sizeof(a)); \
		__builtin_memcpy(&b, ls_ptr + ((base + (off) + 8) & 0x3fffc), sizeof(b)); \
		h0 = (h0 ^ a) * 0xbf58476d1ce4e5b9ull; \
		h1 = (h1 ^ b) * 0x94d049bb133111ebull; \
	} while (0)

static __attribute__((always_inline)) inline uint64_t spu_hash_ls(const uint8_t* ls_ptr, uint32_t pc)
{
	const uint32_t base = pc & 0x3fffc;
	uint64_t h0 = 0x9e3779b97f4a7c15ull ^ base;
	uint64_t h1 = 0xc2b2ae3d27d4eb4full;
	SPU_HASH_PAIR(0);
	SPU_HASH_PAIR(16);
	SPU_HASH_PAIR(64);
	SPU_HASH_PAIR(160);
	const uint64_t h = h0 ^ (h1 >> 31) ^ (h1 << 33);
	return h ? h : 1ull;
}

#undef SPU_HASH_PAIR

static __attribute__((always_inline)) inline uint32_t spu_lookup_ls(const struct spu_ls_entry* ls_cache, uint32_t word, uint32_t generation, uint64_t sig, uint32_t count)
{
	const uint32_t set_idx = ((uint32_t)(sig ^ (sig >> 32)) ^ word) & 2047u;
	const struct spu_ls_entry* const set = ls_cache + (set_idx << 2);
	const uint16_t w16 = (uint16_t)word;
	for (uint32_t way = 0; way < 4; ++way)
	{
		if (set[way].sig == sig && set[way].generation == generation && set[way].word == w16 && set[way].candidate < count)
		{
			return set[way].candidate;
		}
	}
	return count;
}

static __attribute__((always_inline)) inline void spu_record_ls(struct spu_ls_entry* ls_cache, uint32_t word, uint32_t generation, uint64_t sig, uint32_t candidate)
{
	const uint32_t set_idx = ((uint32_t)(sig ^ (sig >> 32)) ^ word) & 2047u;
	struct spu_ls_entry* const set = ls_cache + (set_idx << 2);
	const uint16_t w16 = (uint16_t)word;
	const uint16_t c16 = (uint16_t)candidate;
	uint32_t target_way = ((uint32_t)(sig >> 16)) & 3u;
	for (uint32_t way = 0; way < 4; ++way)
	{
		if (set[way].sig == sig && set[way].generation == generation && set[way].word == w16)
		{
			set[way].candidate = c16;
			return;
		}
		if (!set[way].sig || set[way].generation != generation)
		{
			target_way = way;
		}
	}
	set[target_way].sig = sig;
	set[target_way].generation = generation;
	set[target_way].candidate = c16;
	set[target_way].word = w16;
}

// No imported helpers, TLS, allocation, stack recursion, or host calls. The
// indirect calls below must target program aliases owned by THIS instance.
// Local tail calls inside each program remain an independent compiler policy.
static __attribute__((always_inline)) inline void run_chain(uint32_t thread, uint32_t ls, uint64_t context, uint32_t edges)
{
	struct spu_chain_context* const c = (void*)(uintptr_t)context;
	uint32_t target = c->target;
	const uint32_t budget = c->budget;
	const uint32_t table_begin = c->table_begin;
	const uint32_t table_span = c->table_end - table_begin;
	const uint32_t* const pc_ptr = (const uint32_t*)(uintptr_t)c->pc;
	const uint64_t* const failure_ptr = (const uint64_t*)(uintptr_t)c->failure;
	const volatile uint32_t* const state_ptr = (const volatile uint32_t*)(uintptr_t)c->state;
	const uint32_t* const lists_ptr = (const uint32_t*)(uintptr_t)c->lists;
	struct spu_chain_tables* const tables = (struct spu_chain_tables*)(uintptr_t)c->cache;
	uint64_t failures = *failure_ptr;
	uint32_t pc = *pc_ptr;
	uint32_t previous = 0;
	uint32_t completed = 0;
	uint32_t reason = SPU_CHAIN_BUDGET;
	for (uint32_t n = 0; n < budget; ++n)
	{
		if (*state_ptr)
		{
			reason = SPU_CHAIN_STATE;
			break;
		}
		if ((target - table_begin) >= table_span)
		{
			reason = SPU_CHAIN_OTHER_MODULE;
			break;
		}
		((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)target)(thread, ls, 0);
		if (*failure_ptr != failures)
		{
			uint32_t resolved = 0;
			if (n > 0 && !*state_ptr)
			{
				const uint32_t word = (pc & 0x3fffc) >> 2;
				const uint32_t list_addr = lists_ptr[word];
				const uint32_t* const list = (const uint32_t*)(uintptr_t)list_addr;
				if (list && list[0] > 1)
				{
					const uint32_t count = list[0];
					const uint32_t slot = spu_chain_cache_slot(pc);
					if (count == 2)
					{
						const uint32_t cand = (list[1] == target) ? 1u : 0u;
						const uint32_t alt = list[1 + cand];
						if (alt != target && (alt - table_begin) < table_span)
						{
							failures = *failure_ptr;
							((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)alt)(thread, ls, 0);
							if (*failure_ptr == failures)
							{
								tables->direct_targets[word] = alt;
								tables->entries[slot].generation = list_addr;
								tables->entries[slot].candidate = cand;
								target = alt;
								resolved = 1;
							}
						}
					}
					else
					{
						const uint32_t same_gen = (tables->entries[slot].generation == list_addr);
						const uint32_t prev_cand = (same_gen && tables->entries[slot].candidate < count)
							? tables->entries[slot].candidate : count;
						const uint64_t sig = spu_hash_ls((const uint8_t*)(uintptr_t)ls, pc);
						const uint32_t ls_cand = spu_lookup_ls(tables->ls_cache, word, list_addr, sig, count);
						if (ls_cand < count)
						{
							const uint32_t alt = list[1 + ls_cand];
							if (alt != target && (alt - table_begin) < table_span)
							{
								failures = *failure_ptr;
								((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)alt)(thread, ls, 0);
								if (*failure_ptr == failures)
								{
									tables->direct_targets[word] = alt;
									tables->entries[slot].generation = list_addr;
									tables->entries[slot].candidate = ls_cand;
									tables->entry_sigs[slot] = sig;
									if (prev_cand < count && prev_cand != ls_cand)
										tables->fallback_candidates[slot] = (uint16_t)prev_cand;
									target = alt;
									resolved = 1;
								}
							}
						}
						const uint32_t sec_cand = same_gen ? (uint32_t)tables->fallback_candidates[slot] : count;
						if (!resolved && sec_cand < count && sec_cand != ls_cand && !*state_ptr)
						{
							const uint32_t alt = list[1 + sec_cand];
							if (alt != target && (alt - table_begin) < table_span)
							{
								failures = *failure_ptr;
								((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)alt)(thread, ls, 0);
								if (*failure_ptr == failures)
								{
									tables->direct_targets[word] = alt;
									tables->entries[slot].generation = list_addr;
									tables->entries[slot].candidate = sec_cand;
									tables->entry_sigs[slot] = sig;
									spu_record_ls(tables->ls_cache, word, list_addr, sig, sec_cand);
									if (prev_cand < count && prev_cand != sec_cand)
										tables->fallback_candidates[slot] = (uint16_t)prev_cand;
									target = alt;
									resolved = 1;
								}
							}
						}
						if (!resolved && !*state_ptr)
						{
							for (uint32_t i = 0; i < count; ++i)
							{
								if (i == ls_cand || i == sec_cand) continue;
								const uint32_t alt = list[1 + i];
								if (alt == target || (alt - table_begin) >= table_span) continue;
								if (*state_ptr) break;
								failures = *failure_ptr;
								((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)alt)(thread, ls, 0);
								if (*failure_ptr == failures)
								{
									tables->direct_targets[word] = alt;
									tables->entries[slot].generation = list_addr;
									tables->entries[slot].candidate = i;
									tables->entry_sigs[slot] = sig;
									spu_record_ls(tables->ls_cache, word, list_addr, sig, i);
									if (prev_cand < count && prev_cand != i)
										tables->fallback_candidates[slot] = (uint16_t)prev_cand;
									target = alt;
									resolved = 1;
									break;
								}
							}
						}
					}
				}
			}
			if (!resolved)
			{
				reason = SPU_CHAIN_REJECTED;
				break;
			}
		}
		++completed;
		if (edges && previous)
		{
			// Record only completed, verified transitions. A failed destination is
			// never presented to the region planner as a successful successor.
			const uint64_t key = ((uint64_t)previous << 32) | target;
			struct spu_chain_edge* slots = (void*)(uintptr_t)edges;
			uint32_t slot = ((previous * 2654435761u) ^ target) & (SPU_CHAIN_EDGE_SLOTS - 1);
			uint32_t recorded = 0;
			for (uint32_t probe = 0; probe < 16; ++probe)
			{
				uint64_t found = __atomic_load_n(&slots[slot].key, __ATOMIC_ACQUIRE);
				if (!found)
					__atomic_compare_exchange_n(&slots[slot].key, &found, key, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
				if (!found || found == key)
				{
					__atomic_fetch_add(&slots[slot].count, 1, __ATOMIC_RELAXED);
					recorded = 1;
					break;
				}
				slot = (slot + 1) & (SPU_CHAIN_EDGE_SLOTS - 1);
			}
			if (!recorded) __atomic_fetch_add(&slots[SPU_CHAIN_EDGE_SLOTS].count, 1, __ATOMIC_RELAXED);
		}
		previous = target;
		const uint32_t next_pc = *pc_ptr;
		if (next_pc == pc)
		{
			reason = SPU_CHAIN_INTERPRET;
			break;
		}
		if (n + 1 == budget) break;
		if (!spu_chain_cached_target_fast(lists_ptr, tables->direct_targets, next_pc, &target))
		{
			const uint32_t next_word = (next_pc & 0x3fffc) >> 2;
			const uint32_t list_addr = lists_ptr[next_word];
			const uint32_t* const list = (const uint32_t*)(uintptr_t)list_addr;
			uint32_t resolved = 0;
			uint32_t foreign_target = 0;
			if (list && list[0] == 1)
			{
				const uint32_t alt = list[1];
				if ((alt - table_begin) < table_span)
				{
					const uint32_t slot = spu_chain_cache_slot(next_pc);
					tables->direct_targets[next_word] = alt;
					tables->entries[slot].generation = list_addr;
					tables->entries[slot].candidate = 0;
					target = alt;
					resolved = 1;
				}
				else
				{
					foreign_target = 1;
				}
			}
			else if (list && list[0] > 1)
			{
				const uint32_t count = list[0];
				const uint32_t slot = spu_chain_cache_slot(next_pc);
				const uint32_t cand = (tables->entries[slot].generation == list_addr && tables->entries[slot].candidate < count)
					? tables->entries[slot].candidate : 0u;
				const uint32_t alt = list[1 + cand];
				if ((alt - table_begin) < table_span)
				{
					tables->direct_targets[next_word] = alt;
					tables->entries[slot].generation = list_addr;
					tables->entries[slot].candidate = cand;
					target = alt;
					resolved = 1;
				}
				else
				{
					foreign_target = 1;
				}
			}
			if (!resolved)
			{
				reason = foreign_target ? SPU_CHAIN_OTHER_MODULE : SPU_CHAIN_MISS;
				break;
			}
		}
		pc = next_pc;
	}
	c->completed = completed;
	c->reason = reason;
}

void rpcs3_spu_run_chain(uint32_t thread, uint32_t ls, uint64_t context)
{
	run_chain(thread, ls, context, 0);
}

#ifdef RPCS3_SPU_CHAIN_PROFILE
void rpcs3_spu_run_chain_profile(uint32_t thread, uint32_t ls, uint64_t context)
{
	const struct spu_chain_context* c = (void*)(uintptr_t)context;
	run_chain(thread, ls, context, c->edge_slots);
}
#endif
