#include "stdafx.h"

#ifdef RPCS3_WEB

#include "PPUThread.h"
#include "PPUAnalyser.h"
#include "Emu/Memory/vm.h"
#include "Emu/System.h"
#include "Emu/system_config.h"
#include "Emu/Cell/lv2/sys_sync.h"
#include "Emu/Cell/timers.hpp"
#include "Utilities/Thread.h"
#include "Utilities/PPUCodegenPolicy.h"
#include "../tools/recomp/ModuleExtractor.h"

#include <algorithm>
#include <chrono>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include <emscripten.h>
#include <emscripten/threading.h>

// The function-table region above the ahead-of-time bundles belongs to every tier that compiles
// while the guest runs, so one allocator hands out its indices: a PPU block and an SPU program can
// never claim the same entry, and a registry that reserves under its own lock keeps its entries in
// index order, which is what lets a worker decide from one number whether an index is placed here.
namespace
{
	std::mutex g_web_hot_table_mutex;
	u32 g_web_hot_table_next = 0;
	atomic_t<u32> g_web_hot_table_base{0};
	atomic_t<u32> g_ppu_web_backend{static_cast<u32>(make_ppu_codegen_policy(ppu_backend_kind::jit, ppu_target_kind::wasm).backend)};
	atomic_t<u32> g_ppu_web_fail_closed{make_ppu_codegen_policy(ppu_backend_kind::jit, ppu_target_kind::wasm).fail_closed ? 1u : 0u};
}

extern void ppu_web_codegen_configure(bool aot, bool fail_closed)
{
	g_ppu_web_backend = static_cast<u32>(aot ? ppu_backend_kind::aot : ppu_backend_kind::jit);
	g_ppu_web_fail_closed = fail_closed ? 1 : 0;
}

extern u32 ppu_web_codegen_backend()
{
	return g_ppu_web_backend.load();
}

extern u32 ppu_web_codegen_fail_closed()
{
	return g_ppu_web_fail_closed.load();
}

extern u32 ppu_web_codegen_semantics_version()
{
	return ppu_codegen_policy::semantics_version;
}

// A PPU block reaches another through the function table, so an index a worker's table does not
// hold yet would trap inside compiled code. Every worker that runs a PPU thread therefore reserves
// this whole span up front and fills it with a stub that returns to the interpreter, and the tier
// registers nothing outside it. The span is a per-worker cost, so how many entries it is worth is a
// property of the run rather than of the port; a run that fills it leaves the rest interpreted.
atomic_t<u32> g_web_hot_table_capacity{585000};

extern void web_hot_table_set_capacity(u32 entries)
{
	g_web_hot_table_capacity = entries ? entries : 585000;
}

extern u32 web_hot_table_limit()
{
	const u32 base = g_web_hot_table_base.load();
	return base ? base + g_web_hot_table_capacity : 0;
}

extern void web_hot_table_set_base(u32 base)
{
	std::lock_guard lock(g_web_hot_table_mutex);
	g_web_hot_table_next = base;
	g_web_hot_table_base = base;
}

extern u32 web_hot_table_base()
{
	return g_web_hot_table_base.load();
}

extern u32 web_hot_table_reserve(u32 count)
{
	std::lock_guard lock(g_web_hot_table_mutex);
	const u32 first = g_web_hot_table_next;
	g_web_hot_table_next += count;
	return first;
}

// Per-worker placement without messages, as the SPU tier does it: compiled module bytes stay in a
// registry in wasm memory and every PPU thread places the entries its own worker has not placed yet
// right before dispatching. Returns the highest function-table index this worker holds.
// JS impl lives in web/host/rpcs3_web_lib.js (a --js-library entry) instead of an EM_JS macro:
// under thin-LTO the em_js section + address-taken import chain are stripped, which made this
// hook an undefined symbol at wasm-ld. The library entry resolves it for all link modes.
extern "C" u32 rpcs3_web_ppu_hot_sync();

extern void ppu_web_jit_publish(u32 addr, u32 table_index);
extern void ppu_web_jit_mark_entry(u32 addr);
extern u32 ppu_web_aot_blocks();
extern u32 g_ppu_web_jit_threshold;
extern atomic_t<u64> g_ppu_web_aot_dispatch_count;
extern u64 ppu_web_blocks_used();
extern atomic_t<u32> g_ppu_web_jit_unplaced;
extern atomic_t<u32> g_ppu_web_jit_syncs;
extern u32 ppu_web_auto_recomp_enabled();

namespace
{
	struct ppu_web_jit_entry
	{
		u32 addr;
		u32 index;
		std::vector<u8> bytes;
		u32 elem_base;
		u32 table_size;
		u32 memory_base;
		u32 imports_table;
	};

	// One request slot per compile in flight: the JIT thread fills a slot and waits, the module
	// thread forwards it to a compiler worker (web/public/rpcs3-spu-llvm.mjs) and writes the side
	// module back into the slot.
	struct ppu_web_jit_request
	{
		atomic_t<u32> state{0}; // 0 free, 1 filling, 2 ready, 3 taken by the module thread, 4 done, 5 failed
		u32 addr = 0;
		u32 attr = 0;
		std::vector<u8> code;
		u8* result = nullptr; // malloc'd by the module thread, freed by the waiting JIT thread
		u32 result_size = 0;
		u32 memory_size = 0;
		u32 memory_align = 0;
		u32 table_size = 0;
		u32 imports_table = 0;
	};

	constexpr u32 ppu_web_jit_slots = 2;

	// A block larger than this is left to the interpreter: one wasm function per guest block, and a
	// browser compiles a very large one slowly enough to stall the tier behind it
	constexpr u32 ppu_web_jit_max_block = 256 * 1024;

	ppu_web_jit_request* g_ppu_web_jit_requests = nullptr;
	std::once_flag g_ppu_web_jit_requests_once;

	shared_mutex g_ppu_web_jit_mutex;
	std::deque<ppu_web_jit_entry> g_ppu_web_jit_entries; // stable addresses
	atomic_t<u32> g_ppu_web_jit_count{0};                // entries published (release)

	atomic_t<u32> g_ppu_web_jit_enabled{0};
	atomic_t<u32> g_ppu_web_jit_queued{0}, g_ppu_web_jit_compiled{0}, g_ppu_web_jit_failed{0};
	atomic_t<u32> g_ppu_web_jit_refused{0}, g_ppu_web_jit_bytes{0};
	atomic_t<u64> g_ppu_web_jit_compile_us{0};

	// The analyser's function/block starts are the complete set of addresses this tier may compile.
	// Dynamic control flow must still land on a discovered block; compiling an arbitrary byte window
	// from an unknown PC can turn data or the middle of an instruction into executable guest code.
	shared_mutex g_ppu_web_jit_funcs_mutex;
	std::vector<std::pair<u32, u32>> g_ppu_web_jit_funcs; // sorted by address
	std::vector<std::pair<u32, u32>> g_ppu_web_jit_function_ranges; // analyser function extents
	u32 g_ppu_web_jit_attr = 0;

	std::mutex g_ppu_web_jit_queue_mutex;
	std::deque<u32> g_ppu_web_jit_queue;

	// A guest reaches the threshold far faster than the compiler workers drain the queue, so an
	// unbounded queue grows without ever being served. A block dropped here is still interpreted and
	// still hot, so it is offered again; the bound keeps the backlog to work the workers can reach.
	constexpr u32 web_jit_queue_limit = 256;
	atomic_t<u32> g_ppu_web_jit_dropped{0};

	std::string g_ppu_web_jit_error;
}

static void ppu_web_jit_start();

// Guest thread: the block at this address passed the miss threshold and is not compiled yet
extern bool ppu_web_jit_enqueue(u32 addr)
{
	std::lock_guard lock(g_ppu_web_jit_queue_mutex);
	if (g_ppu_web_jit_queue.size() >= web_jit_queue_limit)
	{
		g_ppu_web_jit_dropped++;
		return false;
	}
	g_ppu_web_jit_queue.push_back(addr);
	g_ppu_web_jit_queued++;
	return true;
}

extern u32 ppu_web_jit_enabled()
{
	return g_ppu_web_jit_enabled.load();
}

// ppu_initialize(): the analyser has just described this module, so its block starts become the
// addresses the tier is allowed to compile. Relocatable modules are left out, as the offline
// bundles leave them out: their blocks are named relative to a segment the dispatch table does not
// carry, and their relocations are not part of what a block snapshot transports.
extern void ppu_web_jit_register_module(const ppu_module<lv2_obj>& info)
{
	if ((!g_ppu_web_jit_enabled && !ppu_web_auto_recomp_enabled()) || info.segs.empty())
	{
		return;
	}

	std::vector<std::pair<u32, u32>> added;
	std::vector<std::pair<u32, u32>> function_ranges;

	const auto add_function_blocks = [&](const ppu_function& func)
	{
		if (!func.size || std::count(info.excluded_funcs.begin(), info.excluded_funcs.end(), func.addr))
		{
			return;
		}

		function_ranges.emplace_back(func.addr, func.size);

		if (func.blocks.empty())
		{
			added.emplace_back(func.addr, func.size);
			return;
		}

		for (const auto& [addr, size] : func.blocks)
		{
			if (size)
			{
				added.emplace_back(addr, size);
			}
		}
	};

	// The analyser retains the complete CFG here even when get_funcs() exposes only the
	// function-granularity view. Keep every branch target available to fail-closed
	// synchronous compilation so a whole-module bundle coverage hole can be filled by
	// the AOT worker instead of falling through to interpretation.
	for (const auto& func : info.functions)
	{
		add_function_blocks(func);
	}

	for (const auto& func : info.get_funcs())
	{
		add_function_blocks(func);
	}

	if (added.empty())
	{
		return;
	}

	// The whole-function CFG and the legacy flattened block list can both
	// describe the same start with different extents. Registration must expose
	// the complete analyser block: compile() uses lower_bound(addr, 0), so
	// retaining a smaller duplicate silently drops its fallthrough instructions.
	std::sort(added.begin(), added.end());
	std::vector<std::pair<u32, u32>> normalized;
	normalized.reserve(added.size());
	for (const auto& [addr, size] : added)
	{
		if (!size)
		{
			continue;
		}

		if (!normalized.empty() && normalized.back().first == addr)
		{
			normalized.back().second = std::max(normalized.back().second, size);
		}
		else
		{
			normalized.emplace_back(addr, size);
		}
	}
	added = std::move(normalized);

	std::sort(function_ranges.begin(), function_ranges.end());
	function_ranges.erase(std::unique(function_ranges.begin(), function_ranges.end()), function_ranges.end());

	{
		std::lock_guard lock(g_ppu_web_jit_funcs_mutex);
		g_ppu_web_jit_funcs.insert(g_ppu_web_jit_funcs.end(), added.begin(), added.end());
		g_ppu_web_jit_function_ranges.insert(g_ppu_web_jit_function_ranges.end(), function_ranges.begin(), function_ranges.end());
		std::sort(g_ppu_web_jit_funcs.begin(), g_ppu_web_jit_funcs.end());
		std::sort(g_ppu_web_jit_function_ranges.begin(), g_ppu_web_jit_function_ranges.end());
		g_ppu_web_jit_function_ranges.erase(std::unique(g_ppu_web_jit_function_ranges.begin(), g_ppu_web_jit_function_ranges.end()), g_ppu_web_jit_function_ranges.end());
		std::vector<std::pair<u32, u32>> merged;
		merged.reserve(g_ppu_web_jit_funcs.size());
		for (const auto& [addr, size] : g_ppu_web_jit_funcs)
		{
			if (!merged.empty() && merged.back().first == addr)
			{
				merged.back().second = std::max(merged.back().second, size);
			}
			else
			{
				merged.emplace_back(addr, size);
			}
		}
		g_ppu_web_jit_funcs = std::move(merged);
		g_ppu_web_jit_attr |= static_cast<u32>(static_cast<std::underlying_type_t<ppu_attr>>(info.attr));
	}

	for (const auto& [addr, size] : added)
	{
		ppu_web_jit_mark_entry(addr);
	}

	ppu_web_jit_start();
	ppu_log.notice("PPU JIT tier: %u blocks of '%s' are compilable", ::size32(added), info.name);
}

// Module thread: next ready slot (taken), -1 when none
extern s32 ppu_web_jit_poll()
{
	if (!g_ppu_web_jit_requests) return -1;

	for (u32 i = 0; i < ppu_web_jit_slots; i++)
	{
		u32 expected = 2;
		if (g_ppu_web_jit_requests[i].state.compare_exchange(expected, 3)) return static_cast<s32>(i);
	}

	return -1;
}

extern u32 ppu_web_jit_slot_addr(u32 i)
{
	return i < ppu_web_jit_slots ? g_ppu_web_jit_requests[i].addr : 0;
}

extern u32 ppu_web_jit_slot_size(u32 i)
{
	return i < ppu_web_jit_slots ? ::size32(g_ppu_web_jit_requests[i].code) : 0;
}

extern const u8* ppu_web_jit_slot_code(u32 i)
{
	return i < ppu_web_jit_slots ? g_ppu_web_jit_requests[i].code.data() : nullptr;
}

extern u32 ppu_web_jit_slot_attr(u32 i)
{
	return i < ppu_web_jit_slots ? g_ppu_web_jit_requests[i].attr : 0;
}

// Module thread: the compiler worker's answer for a taken slot (bytes from malloc, null on failure)
extern void ppu_web_jit_slot_finish(u32 i, u8* bytes, u32 size, u32 memory_size, u32 memory_align, u32 table_size, u32 imports_table)
{
	if (i >= ppu_web_jit_slots) return;
	auto& slot = g_ppu_web_jit_requests[i];
	slot.result = bytes;
	slot.result_size = size;
	slot.memory_size = memory_size;
	slot.memory_align = memory_align;
	slot.table_size = table_size;
	slot.imports_table = imports_table;
	slot.state.store(bytes ? 4 : 5);
}

// Registers a compiled side module as the block's dispatch entry; returns its function table index
static u32 ppu_web_jit_register(const ppu_web_jit_request& slot)
{
	// Nothing may be registered outside the span the workers reserve, and there is no span until the
	// host has installed its base
	if (!web_hot_table_limit())
	{
		g_ppu_web_jit_refused++;
		return 0;
	}

	std::vector<u8> module(slot.result, slot.result + slot.result_size);
	u32 memory_base = 0;

	uptr allocation = 0;

	if (slot.memory_size)
	{
		const u32 align = std::max<u32>(16, 1u << std::min<u32>(slot.memory_align, 16)); // dylink.0 carries log2
		allocation = reinterpret_cast<uptr>(std::malloc(slot.memory_size + align));
		memory_base = static_cast<u32>((allocation + align - 1) & ~uptr{align - 1});
		std::memset(reinterpret_cast<void*>(static_cast<uptr>(memory_base)), 0, slot.memory_size);
	}

	u32 index;
	{
		std::lock_guard lock(g_ppu_web_jit_mutex);
		// Reserved under this lock so the registry stays in index order: a worker then knows that
		// every published index up to the highest one it placed is placed here.
		const u32 first = web_hot_table_reserve(slot.table_size + 1);
		index = first + slot.table_size;

		if (index >= web_hot_table_limit())
		{
			// The span is full: this block stays on the interpreter, and so does every later one
			g_ppu_web_jit_refused++;
			std::free(reinterpret_cast<void*>(static_cast<uptr>(allocation)));
			return 0;
		}

		g_ppu_web_jit_entries.push_back({ slot.addr, index, std::move(module), first, slot.table_size, memory_base, slot.imports_table });
		g_ppu_web_jit_count.store(::size32(g_ppu_web_jit_entries));
	}

	g_ppu_web_jit_compiled++;
	g_ppu_web_jit_bytes += slot.result_size;

	ppu_web_jit_publish(slot.addr, index);
	return index;
}

extern u32 ppu_web_jit_count()
{
	return g_ppu_web_jit_count.load();
}

// Seven words for the per-worker placement (rpcs3_web_pre.js): index, bytes, size, elem base,
// table size, memory base, imports table
extern void ppu_web_jit_info(u32 i, u32* out)
{
	reader_lock lock(g_ppu_web_jit_mutex);

	if (i >= g_ppu_web_jit_entries.size())
	{
		std::fill_n(out, 7, 0);
		return;
	}

	const auto& e = g_ppu_web_jit_entries[i];
	out[0] = e.index;
	out[1] = static_cast<u32>(reinterpret_cast<uptr>(e.bytes.data()));
	out[2] = ::size32(e.bytes);
	out[3] = e.elem_base;
	out[4] = e.table_size;
	out[5] = e.memory_base;
	out[6] = e.imports_table;
}

extern u32 ppu_web_jit_find_entry(u32 target_index, u32* out)
{
	reader_lock lock(g_ppu_web_jit_mutex);

	const auto it = std::upper_bound(
		g_ppu_web_jit_entries.begin(),
		g_ppu_web_jit_entries.end(),
		target_index,
		[](u32 idx, const ppu_web_jit_entry& e)
		{
			return idx < e.elem_base;
		});

	if (it != g_ppu_web_jit_entries.begin())
	{
		const auto prev = std::prev(it);
		const u32 begin = prev->elem_base;
		const u32 end = prev->index ? (prev->index + 1) : (prev->elem_base + prev->table_size);
		if (target_index >= begin && target_index < end)
		{
			out[0] = prev->index;
			out[1] = static_cast<u32>(reinterpret_cast<uptr>(prev->bytes.data()));
			out[2] = ::size32(prev->bytes);
			out[3] = prev->elem_base;
			out[4] = prev->table_size;
			out[5] = prev->memory_base;
			out[6] = prev->imports_table;
			out[7] = static_cast<u32>(std::distance(g_ppu_web_jit_entries.begin(), prev));
			return 1;
		}
	}

	std::fill_n(out, 8, 0);
	return 0;
}

// The tier's own thread, as the SPU LLVM tier has one: a guest thread never waits for a compile
static bool ppu_web_jit_compile(u32 addr)
{
	u32 size = 0;
	u32 attr = 0;
	{
		reader_lock lock(g_ppu_web_jit_funcs_mutex);
		const auto found = std::lower_bound(g_ppu_web_jit_funcs.begin(), g_ppu_web_jit_funcs.end(), std::make_pair(addr, u32{0}));

		if (found != g_ppu_web_jit_funcs.end() && found->first == addr)
		{
			size = found->second;
		}
		else if (found != g_ppu_web_jit_funcs.begin())
		{
			// A branch can resume at any instruction-aligned fallthrough inside an
			// analysed block. Compile that exact suffix; never widen an unknown PC
			// into a byte window that could begin in data or mid-instruction.
			const auto containing = std::prev(found);
			const u64 end = static_cast<u64>(containing->first) + containing->second;
			if ((addr & 3u) == 0 && addr >= containing->first && addr < end)
			{
				size = static_cast<u32>(end - addr);
			}
		}

		if (!size)
		{
			// A fallthrough can leave a basic block without becoming a separately
			// enumerated block. Its PC is still inside an analyser-owned function,
			// so compile the exact function suffix beginning there.
			const auto function = std::upper_bound(
				g_ppu_web_jit_function_ranges.begin(),
				g_ppu_web_jit_function_ranges.end(),
				addr,
				[](u32 value, const std::pair<u32, u32>& range) { return value < range.first; });

			if (function != g_ppu_web_jit_function_ranges.begin())
			{
				const auto containing = std::prev(function);
				const u64 end = static_cast<u64>(containing->first) + containing->second;
				if ((addr & 3u) == 0 && addr >= containing->first && addr < end)
				{
					size = static_cast<u32>(end - addr);
				}
			}
		}

		if (!size)
		{
			// A dispatch miss at an address outside the analysed CFG is unsupported. In fail-closed
			// mode the guest thread reports the PC and terminates instead of executing a byte-window
			// guess that may contain data or an instruction fragment.
			g_ppu_web_jit_refused++;
			return false;
		}

		attr = g_ppu_web_jit_attr;
	}

	if (!size || size > ppu_web_jit_max_block)
	{
		g_ppu_web_jit_refused++;
		return false;
	}

	ppu_web_jit_request* slot = nullptr;

	while (!slot)
	{
		for (u32 i = 0; i < ppu_web_jit_slots && !slot; i++)
		{
			u32 expected = 0;
			if (g_ppu_web_jit_requests[i].state.compare_exchange(expected, 1)) slot = &g_ppu_web_jit_requests[i];
		}

		if (!slot)
		{
			if (thread_ctrl::state() == thread_state::aborting) return false;
			thread_ctrl::wait_for(1000);
		}
	}

	slot->code.resize(size);

	// A block spans guest pages that the page-table memory model does not keep contiguous in host
	// memory, so the snapshot is copied through the translation rather than read as one span.
	if (!vm::web_copy_range(addr, slot->code.data(), size, false))
	{
		g_ppu_web_jit_refused++;
		slot->state.store(0);
		return false;
	}

	slot->addr = addr;
	slot->attr = attr;
	slot->result = nullptr;
	slot->state.store(2);

	const u64 started_at = get_system_time();

	while (slot->state.load() < 4)
	{
		if (thread_ctrl::state() == thread_state::aborting)
		{
			return false;
		}

		thread_ctrl::wait_for(500);
	}

	g_ppu_web_jit_compile_us += get_system_time() - started_at;
	const bool ok = slot->state.load() == 4;

	if (ok)
	{
		if (const u32 index = ppu_web_jit_register(*slot))
		{
			ppu_log.notice("PPU JIT tier: 0x%08x registered at table index %u (%u bytes)", addr, index, slot->result_size);
		}
		else
		{
			ppu_log.error("PPU JIT tier: 0x%08x has no room left in the runtime table region", addr);
		}
	}
	else
	{
		g_ppu_web_jit_failed++;
		ppu_log.error("PPU JIT tier: 0x%08x failed in the compiler worker", addr);
	}

	std::free(slot->result);
	slot->result = nullptr;
	slot->code.clear();
	slot->code.shrink_to_fit();
	slot->state.store(0);
	return ok;
}

// Fail-closed dispatch uses this entry to suspend the guest thread until the
// requested function/block has been compiled. No PPU instruction executes while
// the compiler worker is busy.
extern bool ppu_web_jit_compile_sync(u32 addr)
{
	std::call_once(g_ppu_web_jit_requests_once,
		[] { g_ppu_web_jit_requests = new ppu_web_jit_request[ppu_web_jit_slots]; });

	return ppu_web_jit_compile(addr);
}

namespace
{
	struct ppu_web_jit_worker
	{
		void operator()() const
		{
			while (thread_ctrl::state() != thread_state::aborting)
			{
				u32 addr = 0;
				{
					std::lock_guard lock(g_ppu_web_jit_queue_mutex);
					if (!g_ppu_web_jit_queue.empty())
					{
						addr = g_ppu_web_jit_queue.front();
						g_ppu_web_jit_queue.pop_front();
					}
				}

				if (!addr)
				{
					// The tier lives for one emulation: a new boot re-analyses and starts it again
					if (Emu.IsStopped())
					{
						return;
					}

					thread_ctrl::wait_for(2000);
					continue;
				}

				ppu_web_jit_compile(addr);
			}
		}

		static constexpr auto thread_name = "PPU JIT"sv;
	};

	std::mutex g_ppu_web_jit_thread_mutex;
	std::unique_ptr<named_thread<ppu_web_jit_worker>> g_ppu_web_jit_thread;
}

static void ppu_web_jit_start()
{
	std::lock_guard lock(g_ppu_web_jit_thread_mutex);

	if (g_ppu_web_jit_thread && *g_ppu_web_jit_thread == thread_state::finished)
	{
		g_ppu_web_jit_thread.reset();
	}

	if (!g_ppu_web_jit_thread)
	{
		g_ppu_web_jit_thread = std::make_unique<named_thread<ppu_web_jit_worker>>();
	}
}

extern void ppu_web_jit_set_enabled(bool enabled)
{
	if (!enabled)
	{
		g_ppu_web_jit_enabled = 0;
		return;
	}

	if (!g_ppu_web_jit_requests)
	{
		g_ppu_web_jit_requests = new ppu_web_jit_request[ppu_web_jit_slots];
	}

	g_ppu_web_jit_enabled = 1;
	ppu_web_jit_start();
}

extern void web_hot_table_set_capacity(u32 entries);

extern void ppu_web_jit_set_capacity(u32 entries)
{
	web_hot_table_set_capacity(entries);
}

extern void ppu_web_jit_set_threshold(u32 misses)
{
	g_ppu_web_jit_threshold = misses ? misses : 64;
}

extern std::string ppu_web_jit_report()
{
	reader_lock funcs_lock(g_ppu_web_jit_funcs_mutex);
	std::lock_guard lock(g_ppu_web_jit_mutex);
	std::string queued;
	{
		std::lock_guard queue_lock(g_ppu_web_jit_queue_mutex);
		fmt::append(queued, "%u", ::size32(g_ppu_web_jit_queue));
	}
	return fmt::format(
		"{\"backend\":\"%s\",\"failClosed\":%u,\"semanticsVersion\":%u,\"enabled\":%u,\"threshold\":%u,\"compilable\":%u,\"requested\":%u,\"pending\":%s,\"registered\":%u,\"failed\":%u,\"refused\":%u,"
		"\"bytes\":%u,\"compileMs\":%u,\"tableBase\":%u,\"dispatches\":%u,\"blocksUsed\":%u,"
		"\"unplaced\":%u,\"syncs\":%u,\"capacity\":%u,\"dropped\":%u}",
		ppu_codegen_policy::backend_name(static_cast<ppu_backend_kind>(ppu_web_codegen_backend())), ppu_web_codegen_fail_closed(), ppu_web_codegen_semantics_version(),
		+g_ppu_web_jit_enabled, g_ppu_web_jit_threshold, ::size32(g_ppu_web_jit_funcs), +g_ppu_web_jit_queued, queued,
		::size32(g_ppu_web_jit_entries), +g_ppu_web_jit_failed, +g_ppu_web_jit_refused, +g_ppu_web_jit_bytes,
		static_cast<u32>(g_ppu_web_jit_compile_us / 1000), web_hot_table_base(),
		static_cast<u32>(g_ppu_web_aot_dispatch_count.load()), static_cast<u32>(ppu_web_blocks_used()),
		+g_ppu_web_jit_unplaced, +g_ppu_web_jit_syncs, +g_web_hot_table_capacity, +g_ppu_web_jit_dropped);
}

// ---------------------------------------------------------------------------
// Whole-module automated static recompilation queue (EBOOT + all .sprx PRXs)
// ---------------------------------------------------------------------------
extern u32 ppu_web_aot_registered(u32 addr);
extern void ppu_web_set_page_seg0(u32 page_idx, u32 seg0);

namespace
{
	struct ppu_web_recomp_module_request
	{
		atomic_t<u32> state{0}; // 0 free, 1 filling, 2 ready, 3 taken by host, 4 done, 5 failed
		std::string name;
		std::string sha1_hex;
		u32 seg0_addr = 0;
		u32 is_firmware_sprx = 0;
		std::vector<u8> ps3r_bytes;
	};

	std::mutex g_ppu_web_recomp_submit_mutex;
	ppu_web_recomp_module_request g_ppu_web_recomp_slot;
	atomic_t<u32> g_ppu_web_auto_recomp_enabled{0};
	atomic_t<u32> g_ppu_web_recomp_modules_done{0};
	atomic_t<u32> g_ppu_web_recomp_shards_registered{0};
	atomic_t<u32> g_ppu_web_recomp_blocks_registered{0};
	std::vector<std::pair<u32, u32>> g_ppu_web_recomp_covered_ranges;
}

extern void ppu_web_auto_recomp_set_enabled(bool enabled)
{
	g_ppu_web_auto_recomp_enabled = enabled ? 1 : 0;
}

extern u32 ppu_web_auto_recomp_enabled()
{
	return g_ppu_web_auto_recomp_enabled.load();
}

extern void ppu_web_recomp_module_sync(const ppu_module<lv2_obj>& info)
{
	if (!g_ppu_web_auto_recomp_enabled.load() || info.segs.empty() || !info.segs[0].size || !info.segs[0].ptr)
	{
		return;
	}
#ifdef __EMSCRIPTEN__
	if (emscripten_is_main_runtime_thread())
	{
		ppu_log.warning("PPU auto-recomp: skipping synchronous wait on main runtime thread for '%s'", info.name);
		return;
	}
#endif

	const u32 seg0_start = info.segs[0].addr;
	const u32 seg0_end = seg0_start + info.segs[0].size;

	// Skip if an existing AOT bundle or previous recompilation already covers this module's code segment
	for (u32 probe = seg0_start; probe < std::min<u32>(seg0_end, seg0_start + 0x4000u); probe += 4)
	{
		if (ppu_web_aot_registered(probe))
		{
			return;
		}
	}

	std::lock_guard submit_lock(g_ppu_web_recomp_submit_mutex);
	for (const auto& [r_start, r_end] : g_ppu_web_recomp_covered_ranges)
	{
		if (seg0_start == r_start && seg0_end == r_end)
		{
			return;
		}
	}

	ps3recomp::ModuleDescriptor desc;
	std::string err;
	if (!ps3recomp::extract_from_loaded_module(info, desc, err))
	{
		ppu_log.error("PPU auto-recomp: failed to extract '%s': %s", info.name, err);
		return;
	}

	const bool is_fw_sprx = info.is_relocatable && (info.path.find("sys/external/") != std::string::npos);
	auto serialized = ps3recomp::serialize_descriptor_binary(desc);
	g_ppu_web_recomp_slot.state.store(1);
	g_ppu_web_recomp_slot.name = desc.name;
	g_ppu_web_recomp_slot.sha1_hex = desc.sha1_hex;
	g_ppu_web_recomp_slot.seg0_addr = seg0_start;
	g_ppu_web_recomp_slot.is_firmware_sprx = is_fw_sprx ? 1u : 0u;
	g_ppu_web_recomp_slot.ps3r_bytes = std::move(serialized);
	g_ppu_web_recomp_slot.state.store(2);

	ppu_log.notice("PPU auto-recomp: queued whole-module recompilation of '%s' (seg0=0x%x..0x%x, stubs=%zu)",
		desc.name, seg0_start, seg0_end, desc.stubs.size());

	while (!Emu.IsStopped())
	{
		const u32 st = g_ppu_web_recomp_slot.state.load();
		if (st == 4 || st == 5)
		{
			break;
		}
		if (thread_ctrl::get_current())
		{
			thread_ctrl::wait_for(2000);
		}
		else
		{
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
	}

	const bool ok = g_ppu_web_recomp_slot.state.load() == 4;
	g_ppu_web_recomp_slot.ps3r_bytes.clear();
	g_ppu_web_recomp_slot.ps3r_bytes.shrink_to_fit();
	g_ppu_web_recomp_slot.state.store(0);

	if (ok)
	{
		g_ppu_web_recomp_covered_ranges.emplace_back(seg0_start, seg0_end);
		g_ppu_web_recomp_modules_done++;
	}
}

extern s32 ppu_web_recomp_poll()
{
	u32 expected = 2;
	return g_ppu_web_recomp_slot.state.compare_exchange(expected, 3) ? 0 : -1;
}

extern const u8* ppu_web_recomp_slot_data()
{
	return g_ppu_web_recomp_slot.ps3r_bytes.data();
}

extern u32 ppu_web_recomp_slot_size()
{
	return ::size32(g_ppu_web_recomp_slot.ps3r_bytes);
}

extern const char* ppu_web_recomp_slot_name()
{
	return g_ppu_web_recomp_slot.name.c_str();
}

extern const char* ppu_web_recomp_slot_sha1()
{
	return g_ppu_web_recomp_slot.sha1_hex.c_str();
}

extern u32 ppu_web_recomp_slot_seg0()
{
	return g_ppu_web_recomp_slot.seg0_addr;
}

extern u32 ppu_web_recomp_slot_is_firmware()
{
	return g_ppu_web_recomp_slot.is_firmware_sprx;
}

extern void ppu_web_recomp_forget_range(u32 addr, u32 size)
{
	std::lock_guard submit_lock(g_ppu_web_recomp_submit_mutex);
	const u32 end = addr + size;
	g_ppu_web_recomp_covered_ranges.erase(
		std::remove_if(g_ppu_web_recomp_covered_ranges.begin(), g_ppu_web_recomp_covered_ranges.end(),
			[addr, end](const std::pair<u32, u32>& r)
			{
				return r.first < end && addr < r.second;
			}),
		g_ppu_web_recomp_covered_ranges.end());
}

extern void ppu_web_clear_prx_range(u32 addr, u32 size);

namespace vm
{
	extern void ppu_web_code_invalidate(u32 addr, u32 size) noexcept
	{
		ppu_web_clear_prx_range(addr, size);
		ppu_web_recomp_forget_range(addr, size);
	}
}

// Register one compiled shared PIC .wasm shard into g_ppu_web_jit_entries (index=0 => element segment
// places all blocks at elem_base + rel_index) and publish every (guest_pc, elem_base + rel_index) pair!
extern u32 ppu_web_recomp_register_shard(
	const u8* wasm_bytes,
	u32 wasm_size,
	u32 memory_size,
	u32 memory_align,
	u32 table_size,
	u32 imports_table,
	const u32* guest_rel_pairs,
	u32 pair_count,
	u32 shard_seg0)
{
	if (!wasm_bytes || !wasm_size || !table_size || !web_hot_table_limit())
	{
		return 0;
	}

	std::vector<u8> mod_vec(wasm_bytes, wasm_bytes + wasm_size);
	u32 memory_base = 0;
	uptr allocation = 0;
	if (memory_size)
	{
		const u32 align = std::max<u32>(16, 1u << std::min<u32>(memory_align, 16));
		allocation = reinterpret_cast<uptr>(std::malloc(memory_size + align));
		memory_base = static_cast<u32>((allocation + align - 1) & ~uptr{align - 1});
		std::memset(reinterpret_cast<void*>(static_cast<uptr>(memory_base)), 0, memory_size);
	}

	u32 elem_base = 0;
	{
		std::lock_guard lock(g_ppu_web_jit_mutex);
		elem_base = web_hot_table_reserve(table_size);
		if (elem_base + table_size > web_hot_table_limit())
		{
			g_ppu_web_jit_refused++;
			if (allocation) std::free(reinterpret_cast<void*>(static_cast<uptr>(allocation)));
			return 0;
		}
		// index == 0 signals rpcs3PpuHotSyncImpl() that this entry is a whole-module shard whose
		// element segment populates [elem_base, elem_base + table_size) automatically.
		g_ppu_web_jit_entries.push_back({0, 0, std::move(mod_vec), elem_base, table_size, memory_base, imports_table});
		g_ppu_web_jit_count.store(::size32(g_ppu_web_jit_entries));
	}
	extern void ppu_web_register_instance_span(u32 begin, u32 end);
	ppu_web_register_instance_span(elem_base, elem_base + table_size);

	u32 last_seg0_page = 0xffff'ffffu;
	for (u32 i = 0; i < pair_count; ++i)
	{
		const u32 guest_pc = guest_rel_pairs[i * 2];
		const u32 rel_idx = guest_rel_pairs[i * 2 + 1];
		const u32 page_idx = guest_pc >> 16;
		if (page_idx != last_seg0_page)
		{
			ppu_web_set_page_seg0(page_idx, shard_seg0);
			last_seg0_page = page_idx;
		}
		ppu_web_jit_publish(guest_pc, elem_base + rel_idx);
	}

	g_ppu_web_jit_compiled += pair_count;
	g_ppu_web_jit_bytes += wasm_size;
	g_ppu_web_recomp_shards_registered++;
	g_ppu_web_recomp_blocks_registered += pair_count;
	return elem_base;
}

extern void ppu_web_recomp_slot_finish(u32 ok)
{
	g_ppu_web_recomp_slot.state.store(ok ? 4 : 5);
}

#endif // RPCS3_WEB
