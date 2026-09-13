#include "chain.h"

// No imported helpers, TLS, allocation, stack recursion, or host calls. The
// indirect calls below must target program aliases owned by THIS instance.
// Local tail calls inside each program remain an independent compiler policy.
static __attribute__((always_inline)) inline void run_chain(uint32_t thread, uint32_t ls, uint64_t context, uint32_t edges)
{
	struct spu_chain_context* c = (void*)(uintptr_t)context;
	uint32_t target = c->target;
	uint32_t previous = 0;
	c->completed = 0;
	c->reason = SPU_CHAIN_BUDGET;
	for (uint32_t n = 0; n < c->budget; ++n)
	{
		if (__atomic_load_n((uint32_t*)(uintptr_t)c->state, __ATOMIC_ACQUIRE))
		{
			c->reason = SPU_CHAIN_STATE;
			return;
		}
		if (target < c->table_begin || target >= c->table_end)
		{
			c->reason = SPU_CHAIN_OTHER_MODULE;
			return;
		}
		const uint32_t pc = *(uint32_t*)(uintptr_t)c->pc;
		const uint64_t failures = *(uint64_t*)(uintptr_t)c->failure;
		((void (*)(uint32_t, uint32_t, uint64_t))(uintptr_t)target)(thread, ls, 0);
		if (*(uint64_t*)(uintptr_t)c->failure != failures)
		{
			// Earlier blocks still ran. Never make the caller retry their entry.
			c->reason = SPU_CHAIN_REJECTED;
			return;
		}
		++c->completed;
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
		const uint32_t next_pc = *(uint32_t*)(uintptr_t)c->pc;
		if (next_pc == pc)
		{
			c->reason = SPU_CHAIN_INTERPRET;
			return;
		}
		if (n + 1 == c->budget) return;
		if (!spu_chain_cached_target(c, next_pc, &target))
		{
			c->reason = SPU_CHAIN_MISS;
			return;
		}
	}
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
