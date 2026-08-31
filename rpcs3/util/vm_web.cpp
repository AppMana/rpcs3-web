#include "stdafx.h"
#include "util/vm.hpp"

#include <cstdlib>
#include <cstring>
#include <limits>

// WebAssembly has one compact linear-memory address space. It cannot provide
// the fixed-address sparse mappings and protection aliases used by RPCS3's
// desktop VM backend. Guest mapping and permissions therefore live in
// Emu/Memory/vm.cpp; this file supplies demand-allocated host storage only.
namespace utils
{
	long get_page_size()
	{
		return 4096;
	}

	static void* alloc_aligned(usz size)
	{
		if (!size)
		{
			return nullptr;
		}

		if (size > std::numeric_limits<usz>::max() - 0xffff)
		{
			return nullptr;
		}

		const usz aligned_size = (size + 0xffff) & ~usz{0xffff};
#ifdef RPCS3_WEB
		if (size >= 128 * 1024 * 1024) std::fprintf(stderr, "RPCS3 Web VM backing: allocate %zu bytes\n", static_cast<std::size_t>(aligned_size));
#endif
		void* ptr = std::aligned_alloc(0x10000, aligned_size);

		if (ptr)
		{
#ifdef RPCS3_WEB
			if (size >= 128 * 1024 * 1024) std::fprintf(stderr, "RPCS3 Web VM backing: zeroing\n");
#endif
			std::memset(ptr, 0, aligned_size);
#ifdef RPCS3_WEB
			if (size >= 128 * 1024 * 1024) std::fprintf(stderr, "RPCS3 Web VM backing: ready\n");
#endif
		}

		return ptr;
	}

	void* memory_reserve(usz size, void* use_addr, bool, bool)
	{
		// Fixed host addresses have no meaning in Wasm linear memory.
		if (use_addr)
		{
			return nullptr;
		}

		return alloc_aligned(size);
	}

	void memory_commit(void*, usz, protection)
	{
		// malloc-backed WebAssembly memory is already committed.
	}

	void memory_decommit(void* pointer, usz size, bool)
	{
		if (pointer && size)
		{
			std::memset(pointer, 0, size);
		}
	}

	void memory_reset(void* pointer, usz size, protection, bool)
	{
		if (pointer && size)
		{
			std::memset(pointer, 0, size);
		}
	}

	void memory_release(void* pointer, usz)
	{
		std::free(pointer);
	}

	void memory_protect(void*, usz, protection)
	{
		// Enforced by vm::g_pages and explicit interpreter accesses on Web.
	}

	bool memory_lock(void*, usz)
	{
		return true;
	}

	void* memory_map_fd(native_handle, usz, protection)
	{
		return nullptr;
	}

	shm::shm(u64 size, u32 flags)
		: m_file(-1)
		, m_flags(flags)
		, m_size((size + 0xffff) & ~u64{0xffff})
	{
	}

	shm::shm(u64 size, const std::string& storage)
		: m_file(-1)
		, m_size((size + 0xffff) & ~u64{0xffff})
		, m_storage(storage)
	{
	}

	shm::~shm()
	{
		unmap_self();
	}

	u8* shm::map(void*, protection prot, bool cow) const
	{
		auto* self = const_cast<shm*>(this);
		u8* backing = self->map_self(prot);

		if (!cow || !backing)
		{
			return backing;
		}

		ensure(m_size <= std::numeric_limits<usz>::max());
		u8* copy = static_cast<u8*>(alloc_aligned(static_cast<usz>(m_size)));

		if (copy)
		{
			std::memcpy(copy, backing, static_cast<usz>(m_size));
		}

		return copy;
	}

	u8* shm::try_map(void* ptr, protection prot, bool cow) const
	{
		return map(ptr, prot, cow);
	}

	std::pair<u8*, std::string> shm::map_critical(void* ptr, protection prot, bool cow)
	{
		return {map(ptr, prot, cow), {}};
	}

	u8* shm::map_self(protection)
	{
		void* ptr = m_ptr;

		while (!ptr)
		{
			if (m_size > std::numeric_limits<usz>::max())
			{
				return nullptr;
			}

			void* allocated = alloc_aligned(static_cast<usz>(m_size));

			if (!allocated)
			{
				return nullptr;
			}

			if (m_ptr.compare_exchange(ptr, allocated))
			{
				ptr = allocated;
			}
			else
			{
				std::free(allocated);
			}
		}

		return static_cast<u8*>(ptr);
	}

	void shm::unmap(void* ptr) const
	{
		if (ptr && ptr != +m_ptr)
		{
			std::free(ptr);
		}
	}

	void shm::unmap_critical(void*)
	{
		// Guest aliases are removed from vm's software page table.
	}

	void shm::unmap_self()
	{
		std::free(m_ptr.exchange(nullptr));
	}
}
