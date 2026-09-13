#pragma once

#include "SPUWasmChain.h"
#include <array>
#include <cstddef>
#include <cstdint>

namespace spu_web
{
	// Per executing SPU, never shared between workers. A hit is only a search preference:
	// the caller must still verify the program against mutable local store. Publication creates
	// a new immutable list, invalidating the preference so an optimizing tier is tried first.
	template <std::size_t Slots = 256, bool Instrument = false, bool FoldAddress = false>
	class verified_dispatch_cache
	{
		static_assert(Slots && (Slots & (Slots - 1)) == 0);
		struct entry
		{
			const void* generation = nullptr;
			std::uint32_t candidate = 0;
		};
		std::array<entry, Slots> entries{};

	public:
		struct counters
		{
			std::uint64_t cold = 0, generation_misses = 0;
			std::uint64_t preferred_hits = 0, preferred_rejections = 0;
		};
		counters observations{};

	public:
		// Read-only wasm32 view consumed by the same-instance chain runner.
		// Keep this check at the boundary so native pointer width cannot silently
		// become the layout of the browser's persistent preference table.
		const void* chain_entries() const
		{
			static_assert(Slots == SPU_CHAIN_CACHE_SLOTS && FoldAddress);
#ifdef __wasm32__
			static_assert(sizeof(entry) == 8 && offsetof(entry, candidate) == 4);
#endif
			return entries.data();
		}

		template <typename Verify>
		std::uint32_t find(std::uint32_t pc, const void* generation, std::uint32_t count, Verify&& verify, bool enabled = true)
		{
			// Block starts are aligned and often differ only in high address bits.
			// Folding those bits avoids concentrating them in a few direct-map slots.
			const auto word = pc >> 2;
			const auto key = FoldAddress ? word ^ (word >> 8) : word;
			auto& cached = entries[key & (Slots - 1)];
			const auto preferred = enabled && cached.generation == generation ? cached.candidate : count;
			if constexpr (Instrument)
			{
				if (enabled && !cached.generation) ++observations.cold;
				else if (enabled && cached.generation != generation) ++observations.generation_misses;
			}
			if (preferred < count)
			{
				if (verify(preferred))
				{
					if constexpr (Instrument) ++observations.preferred_hits;
					return preferred;
				}
				if constexpr (Instrument) ++observations.preferred_rejections;
			}
			for (std::uint32_t i = 0; i < count; ++i)
			{
				if (i == preferred) continue;
				if (verify(i))
				{
					if (enabled) cached = {generation, i};
					return i;
				}
			}
			if (enabled) cached = {};
			return count;
		}
	};
}
