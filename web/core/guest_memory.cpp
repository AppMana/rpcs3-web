#include "guest_memory.hpp"

#include <algorithm>
#include <cstring>

namespace rpcs3::web
{
    guest_memory::guest_memory()
        : m_pages(page_count)
    {
        // Slot zero is reserved so a zero entry always means unmapped.
        m_backing.emplace_back();
    }

    bool guest_memory::valid_range(std::uint32_t address, std::uint64_t size, bool require_aligned) const
    {
        if (size == 0 || static_cast<std::uint64_t>(address) + size > address_space_size) return false;
        if (require_aligned && ((address % page_size) != 0 || (size % page_size) != 0)) return false;
        return true;
    }

    bool guest_memory::map(std::uint32_t address, std::uint64_t size, page_access access)
    {
        if (!valid_range(address, size, true) || access == page_access::none) return false;
        const std::uint32_t first = address / page_size;
        const std::uint32_t count = static_cast<std::uint32_t>(size / page_size);
        for (std::uint32_t index = 0; index < count; ++index)
        {
            if (m_pages[first + index].slot != no_slot) return false;
        }
        for (std::uint32_t index = 0; index < count; ++index)
        {
            m_backing.emplace_back();
            m_pages[first + index] = {static_cast<std::uint32_t>(m_backing.size() - 1), access};
        }
        m_mapped_pages += count;
        return true;
    }

    bool guest_memory::map_alias(std::uint32_t destination, std::uint32_t source, std::uint64_t size, page_access access)
    {
        if (!valid_range(destination, size, true) || !valid_range(source, size, true) || access == page_access::none) return false;
        const std::uint32_t destination_first = destination / page_size;
        const std::uint32_t source_first = source / page_size;
        const std::uint32_t count = static_cast<std::uint32_t>(size / page_size);
        for (std::uint32_t index = 0; index < count; ++index)
        {
            const auto& source_page = m_pages[source_first + index];
            if (source_page.slot == no_slot || m_pages[destination_first + index].slot != no_slot || !has_access(source_page.access, access)) return false;
        }
        for (std::uint32_t index = 0; index < count; ++index)
        {
            m_pages[destination_first + index] = {m_pages[source_first + index].slot, access};
        }
        m_mapped_pages += count;
        return true;
    }

    bool guest_memory::unmap(std::uint32_t address, std::uint64_t size)
    {
        if (!valid_range(address, size, true)) return false;
        const std::uint32_t first = address / page_size;
        const std::uint32_t count = static_cast<std::uint32_t>(size / page_size);
        for (std::uint32_t index = 0; index < count; ++index)
        {
            if (m_pages[first + index].slot == no_slot) return false;
        }
        for (std::uint32_t index = 0; index < count; ++index) m_pages[first + index] = {};
        m_mapped_pages -= count;
        return true;
    }

    bool guest_memory::protect(std::uint32_t address, std::uint64_t size, page_access access)
    {
        if (!valid_range(address, size, true) || access == page_access::none) return false;
        const std::uint32_t first = address / page_size;
        const std::uint32_t count = static_cast<std::uint32_t>(size / page_size);
        for (std::uint32_t index = 0; index < count; ++index)
        {
            if (m_pages[first + index].slot == no_slot) return false;
        }
        for (std::uint32_t index = 0; index < count; ++index) m_pages[first + index].access = access;
        return true;
    }

    bool guest_memory::check_range(std::uint32_t address, std::size_t size, page_access access) const
    {
        if (!valid_range(address, size, false)) return false;
        const std::uint64_t last_address = static_cast<std::uint64_t>(address) + size - 1;
        const std::uint32_t first = address / page_size;
        const std::uint32_t last = static_cast<std::uint32_t>(last_address / page_size);
        for (std::uint32_t page = first; page <= last; ++page)
        {
            if (m_pages[page].slot == no_slot || !has_access(m_pages[page].access, access)) return false;
        }
        return true;
    }

    guest_memory::page_bytes& guest_memory::make_resident(std::uint32_t slot)
    {
        auto& backing = m_backing[slot];
        if (!backing.data)
        {
            backing.data = std::make_unique<page_bytes>();
            backing.data->fill(std::byte{0});
            ++m_resident_pages;
        }
        return *backing.data;
    }

    bool guest_memory::read(std::uint32_t address, std::span<std::byte> output) const
    {
        if (output.empty() || !check_range(address, output.size(), page_access::read)) return false;
        std::size_t copied = 0;
        while (copied < output.size())
        {
            const std::uint32_t current = address + static_cast<std::uint32_t>(copied);
            const auto& entry = m_pages[current / page_size];
            const std::size_t offset = current % page_size;
            const std::size_t length = std::min<std::size_t>(page_size - offset, output.size() - copied);
            const auto& backing = m_backing[entry.slot];
            if (backing.data) std::memcpy(output.data() + copied, backing.data->data() + offset, length);
            else std::fill_n(output.data() + copied, length, std::byte{0});
            copied += length;
        }
        return true;
    }

    bool guest_memory::write(std::uint32_t address, std::span<const std::byte> input)
    {
        if (input.empty() || !check_range(address, input.size(), page_access::write)) return false;
        std::size_t copied = 0;
        while (copied < input.size())
        {
            const std::uint32_t current = address + static_cast<std::uint32_t>(copied);
            const auto& entry = m_pages[current / page_size];
            const std::size_t offset = current % page_size;
            const std::size_t length = std::min<std::size_t>(page_size - offset, input.size() - copied);
            auto& backing = make_resident(entry.slot);
            std::memcpy(backing.data() + offset, input.data() + copied, length);
            ++m_backing[entry.slot].generation;
            copied += length;
        }
        return true;
    }

    std::size_t guest_memory::mapped_pages() const
    {
        return m_mapped_pages;
    }

    std::size_t guest_memory::resident_pages() const
    {
        return m_resident_pages;
    }
}
