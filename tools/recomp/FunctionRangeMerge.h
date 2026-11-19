#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <set>
#include <vector>

namespace ps3recomp
{
	// Analyser output may contain an alternate entry or shared tail as a second
	// function whose range overlaps the real function. Preserve every recovered
	// entry, but extend each entry through the union of the overlapping tail so
	// a dispatcher edge cannot fall off the end of a truncated analyser range.
	// Collapsing entries would make a call into the inner entry execute without
	// the outer function's frame setup.
	template <typename Function, typename MergeInfo>
	uint32_t merge_overlapping_function_ranges(std::vector<Function>& funcs, std::vector<MergeInfo>* merge_groups)
	{
		std::vector<Function> sorted;
		sorted.reserve(funcs.size());

		for (auto& fn : funcs)
		{
			if (fn.size)
			{
				sorted.push_back(std::move(fn));
			}
		}

		std::sort(sorted.begin(), sorted.end(), [](const Function& a, const Function& b)
		{
			if (a.addr != b.addr)
			{
				return a.addr < b.addr;
			}

			return a.size < b.size;
		});

		struct merge_group
		{
			uint32_t begin = 0;
			uint32_t end = 0;
			std::vector<Function> members;
		};

		std::vector<merge_group> groups;
		groups.reserve(sorted.size());
		uint32_t merged = 0;

		for (auto& fn : sorted)
		{
			const uint32_t fn_end = fn.addr + fn.size;
			if (groups.empty() || fn.addr >= groups.back().end)
			{
				merge_group group;
				group.begin = fn.addr;
				group.end = fn_end;
				group.members.push_back(std::move(fn));
				groups.push_back(std::move(group));
				continue;
			}

			auto& group = groups.back();
			group.end = std::max(group.end, fn_end);
			group.members.push_back(std::move(fn));
		}

		std::vector<Function> merged_funcs;
		merged_funcs.reserve(groups.size());
		if (merge_groups)
		{
			merge_groups->reserve(groups.size());
		}

		for (auto& group : groups)
		{
			std::map<uint32_t, int> events;
			std::set<uint32_t> boundaries{group.begin, group.end};

			const auto add_interval = [&](uint32_t addr, uint32_t size)
			{
				if ((addr & 3u) || !size || addr < group.begin || addr >= group.end)
				{
					return;
				}

				const uint32_t end = std::min<uint32_t>(group.end, addr + (size & ~3u));
				if (end <= addr)
				{
					return;
				}

				++events[addr];
				--events[end];
				boundaries.insert(addr);
				boundaries.insert(end);
			};

			for (const auto& member : group.members)
			{
				boundaries.insert(member.addr);
				if (member.blocks.empty())
				{
					add_interval(member.addr, member.size);
					continue;
				}

				for (const auto& [addr, size] : member.blocks)
				{
					boundaries.insert(addr);
					add_interval(addr, size);
				}
			}

			if (events.empty())
			{
				add_interval(group.begin, group.end - group.begin);
			}

			std::map<uint32_t, uint32_t> normalized;
			int active = 0;
			auto event = events.begin();
			for (auto boundary = boundaries.begin(); boundary != boundaries.end(); ++boundary)
			{
				while (event != events.end() && event->first <= *boundary)
				{
					active += event->second;
					++event;
				}

				const auto next = std::next(boundary);
				if (active > 0 && next != boundaries.end() && *boundary < *next)
				{
					normalized.emplace(*boundary, *next - *boundary);
				}
			}

			std::map<uint32_t, Function> entries;
			for (auto& member : group.members)
			{
				const auto it = entries.find(member.addr);
				if (it == entries.end())
				{
					entries.emplace(member.addr, std::move(member));
					continue;
				}

				auto& dst = it->second;
				if ((!dst.toc || dst.toc == UINT32_MAX) && member.toc && member.toc != UINT32_MAX)
				{
					dst.toc = member.toc;
				}

				for (const auto& [addr, size] : member.blocks)
				{
					dst.blocks.emplace(addr, size);
				}
			}

			for (auto& [_, fn] : entries)
			{
				fn.size = group.end - fn.addr;
				fn.blocks.clear();
				for (const auto& [addr, size] : normalized)
				{
					const uint32_t begin = std::max(addr, fn.addr);
					const uint32_t end = std::min<uint32_t>(addr + size, group.end);
					if (begin < end)
					{
						fn.blocks.emplace(begin, end - begin);
					}
				}

				merged_funcs.push_back(std::move(fn));
			}

			if (merge_groups && entries.size() > 1)
			{
				merge_groups->push_back(MergeInfo{group.begin, group.end - group.begin, static_cast<uint32_t>(entries.size())});
				merged += static_cast<uint32_t>(entries.size());
			}
		}

		funcs = std::move(merged_funcs);
		return merged;
	}
}
