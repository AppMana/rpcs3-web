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
		struct ls_entry
		{
			std::uint64_t sig = 0;
			const void* generation = nullptr;
			std::uint16_t candidate = 0xffff;
			std::uint16_t word = 0xffff;
		};
		static constexpr std::size_t LsSets = 2048;
		static constexpr std::size_t LsWays = 4;
	public:
		alignas(8) std::array<std::uint32_t, Slots> direct_targets{};
		std::array<entry, Slots> entries{};
		alignas(8) std::array<std::uint64_t, Slots> entry_sigs{};
		std::array<std::array<ls_entry, LsWays>, LsSets> ls_cache{};
		std::array<std::uint16_t, Slots> fallback_candidates{};
	private:
		std::array<std::uint16_t, Slots> rejected_candidates{};
		std::uint32_t direct_epoch = 0;

		static std::uint64_t hash_ls(const std::uint8_t* ls_ptr, std::uint32_t pc) noexcept
		{
			const std::uint32_t base = pc & 0x3fffc;
			std::uint64_t h0 = 0x9e3779b97f4a7c15ull ^ base;
			std::uint64_t h1 = 0xc2b2ae3d27d4eb4full;
			constexpr std::uint32_t offsets[4] = {0, 16, 64, 160};
			for (std::uint32_t offset : offsets)
			{
				std::uint64_t a = 0, b = 0;
				__builtin_memcpy(&a, ls_ptr + ((base + offset) & 0x3fffc), sizeof(a));
				__builtin_memcpy(&b, ls_ptr + ((base + offset + 8) & 0x3fffc), sizeof(b));
				h0 = (h0 ^ a) * 0xbf58476d1ce4e5b9ull;
				h1 = (h1 ^ b) * 0x94d049bb133111ebull;
			}
			const std::uint64_t h = h0 ^ (h1 >> 31) ^ (h1 << 33);
			return h ? h : 1ull;
		}

		std::uint32_t lookup_ls(std::uint32_t word, const void* generation, std::uint64_t sig, std::uint32_t count) const noexcept
		{
			const auto& set = ls_cache[((sig ^ (sig >> 32)) ^ word) & (LsSets - 1)];
			const auto w16 = static_cast<std::uint16_t>(word);
			for (std::size_t way = 0; way < LsWays; ++way)
			{
				const auto& e = set[way];
				if (e.sig == sig && e.generation == generation && e.word == w16 && e.candidate < count)
				{
					return e.candidate;
				}
			}
			return count;
		}

		void record_ls(std::uint32_t word, const void* generation, std::uint64_t sig, std::uint32_t candidate) noexcept
		{
			auto& set = ls_cache[((sig ^ (sig >> 32)) ^ word) & (LsSets - 1)];
			const auto w16 = static_cast<std::uint16_t>(word);
			const auto c16 = static_cast<std::uint16_t>(candidate);
			std::size_t target_way = (sig >> 16) & (LsWays - 1);
			for (std::size_t way = 0; way < LsWays; ++way)
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
			set[target_way] = {sig, generation, c16, w16};
		}

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
			static_assert(sizeof(ls_entry) == 16 && offsetof(ls_entry, generation) == 8 && offsetof(ls_entry, candidate) == 12 && offsetof(ls_entry, word) == 14);
			static_assert(offsetof(verified_dispatch_cache, entries) - offsetof(verified_dispatch_cache, direct_targets) == 0x40000);
			static_assert(offsetof(verified_dispatch_cache, entry_sigs) - offsetof(verified_dispatch_cache, direct_targets) == 0xc0000);
			static_assert(offsetof(verified_dispatch_cache, ls_cache) - offsetof(verified_dispatch_cache, direct_targets) == 0x140000);
			static_assert(offsetof(verified_dispatch_cache, fallback_candidates) - offsetof(verified_dispatch_cache, direct_targets) == 0x160000);
#endif
			return entries.data();
		}

		const void* direct_chain_entries() const
		{
			static_assert(Slots == SPU_CHAIN_CACHE_SLOTS);
			return direct_targets.data();
		}

		void sync_epoch(std::uint32_t epoch)
		{
			if (direct_epoch != epoch) [[unlikely]]
			{
				direct_targets.fill(0);
				direct_epoch = epoch;
			}
		}

		void set_direct_target(std::uint32_t pc, std::uint32_t target)
		{
			direct_targets[((pc & 0x3fffc) >> 2) & (Slots - 1)] = target;
		}

		std::uint32_t get_direct_target(std::uint32_t pc) const
		{
			return direct_targets[((pc & 0x3fffc) >> 2) & (Slots - 1)];
		}

		bool cached_candidate(std::uint32_t pc, const void* generation, std::uint32_t count, std::uint32_t& out) const
		{
			const auto word = (pc & 0x3fffc) >> 2;
			const auto key = FoldAddress ? word ^ (word >> 8) : word;
			const auto slot = key & (Slots - 1);
			const auto& cached = entries[slot];
			if (!generation || cached.generation != generation || cached.candidate >= count) return false;
			if (rejected_candidates[slot] == static_cast<std::uint16_t>(cached.candidate + 1u)) return false;
			out = cached.candidate;
			return true;
		}

		void note_rejected(std::uint32_t pc, const void* generation, std::uint32_t count)
		{
			const auto word = (pc & 0x3fffc) >> 2;
			direct_targets[word & (Slots - 1)] = 0;
			const auto key = FoldAddress ? word ^ (word >> 8) : word;
			const auto slot = key & (Slots - 1);
			auto& cached = entries[slot];
			if (!generation || cached.generation != generation || cached.candidate >= count) return;
			rejected_candidates[slot] = static_cast<std::uint16_t>(cached.candidate + 1u);
		}

		template <typename Verify>
		std::uint32_t find(std::uint32_t pc, const void* generation, std::uint32_t count, Verify&& verify, bool enabled = true, const std::uint8_t* ls_ptr = nullptr)
		{
			// Block starts are aligned and often differ only in high address bits.
			// Folding those bits avoids concentrating them in a few direct-map slots.
			const auto word = (pc & 0x3fffc) >> 2;
			const auto key = FoldAddress ? word ^ (word >> 8) : word;
			const auto slot = key & (Slots - 1);
			auto& cached = entries[slot];
			const bool same_gen = enabled && cached.generation == generation;
			if (enabled && !same_gen)
			{
				fallback_candidates[slot] = 0xffff;
				rejected_candidates[slot] = 0;
				entry_sigs[slot] = 0;
			}
			const std::uint32_t mid_rejected = (same_gen && rejected_candidates[slot]) ? static_cast<std::uint32_t>(rejected_candidates[slot] - 1u) : count;
			if (enabled) rejected_candidates[slot] = 0;
			const auto preferred = same_gen ? cached.candidate : count;
			if constexpr (Instrument)
			{
				if (enabled && !cached.generation) ++observations.cold;
				else if (enabled && !same_gen) ++observations.generation_misses;
			}
			const std::uint64_t sig = (enabled && ls_ptr && count > 1) ? hash_ls(ls_ptr, pc) : 0;
			const bool try_preferred_first = preferred < count && preferred != mid_rejected && (!sig || !entry_sigs[slot] || entry_sigs[slot] == sig);
			if (try_preferred_first)
			{
				if (verify(preferred))
				{
					if (sig)
					{
						entry_sigs[slot] = sig;
						record_ls(word, generation, sig, preferred);
					}
					if constexpr (Instrument) ++observations.preferred_hits;
					return preferred;
				}
				if constexpr (Instrument) ++observations.preferred_rejections;
			}
			const std::uint32_t ls_cand = sig ? lookup_ls(word, generation, sig, count) : count;
			if (ls_cand < count && ls_cand != mid_rejected && (ls_cand != preferred || !try_preferred_first))
			{
				if (enabled) cached = {generation, ls_cand};
				if (verify(ls_cand))
				{
					if (enabled)
					{
						entry_sigs[slot] = sig;
						if (preferred < count && preferred != ls_cand) fallback_candidates[slot] = static_cast<std::uint16_t>(preferred);
					}
					return ls_cand;
				}
			}
			if (!try_preferred_first && preferred < count && preferred != mid_rejected && preferred != ls_cand)
			{
				if (enabled) cached = {generation, preferred};
				if (verify(preferred))
				{
					if (sig)
					{
						entry_sigs[slot] = sig;
						record_ls(word, generation, sig, preferred);
					}
					if constexpr (Instrument) ++observations.preferred_hits;
					return preferred;
				}
				if constexpr (Instrument) ++observations.preferred_rejections;
			}
			const std::uint32_t secondary = same_gen ? static_cast<std::uint32_t>(fallback_candidates[slot]) : count;
			if (secondary < count && secondary != preferred && secondary != mid_rejected && secondary != ls_cand)
			{
				if (enabled) cached = {generation, secondary};
				if (verify(secondary))
				{
					if (enabled)
					{
						entry_sigs[slot] = sig;
						if (sig) record_ls(word, generation, sig, secondary);
						if (preferred < count) fallback_candidates[slot] = static_cast<std::uint16_t>(preferred);
					}
					return secondary;
				}
			}
			for (std::uint32_t i = 0; i < count; ++i)
			{
				if (i == preferred || i == secondary || i == mid_rejected || i == ls_cand) continue;
				if (enabled) cached = {generation, i};
				if (verify(i))
				{
					if (enabled)
					{
						entry_sigs[slot] = sig;
						if (sig) record_ls(word, generation, sig, i);
						if (preferred < count) fallback_candidates[slot] = static_cast<std::uint16_t>(preferred);
					}
					return i;
				}
			}
			if (mid_rejected < count)
			{
				if (enabled) cached = {generation, mid_rejected};
				if (verify(mid_rejected))
				{
					if (enabled && sig)
					{
						entry_sigs[slot] = sig;
						record_ls(word, generation, sig, mid_rejected);
					}
					return mid_rejected;
				}
			}
			if (enabled)
			{
				cached = {};
				entry_sigs[slot] = 0;
			}
			return count;
		}
	};
}
