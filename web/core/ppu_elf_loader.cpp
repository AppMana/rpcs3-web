#include "ppu_elf_loader.hpp"

#include <algorithm>
#include <array>
#include <limits>

namespace rpcs3::web
{
    namespace
    {
        template <typename T>
        bool read_be(std::span<const std::byte> image, std::uint64_t offset, T& output)
        {
            if (offset > image.size() || sizeof(T) > image.size() - static_cast<std::size_t>(offset)) return false;
            output = 0;
            for (std::size_t index = 0; index < sizeof(T); ++index)
            {
                output = static_cast<T>((output << 8) | std::to_integer<std::uint8_t>(image[static_cast<std::size_t>(offset) + index]));
            }
            return true;
        }

        constexpr std::uint64_t align_up(std::uint64_t value, std::uint64_t alignment)
        {
            return (value + alignment - 1) & ~(alignment - 1);
        }

        page_access segment_access(std::uint32_t flags)
        {
            page_access access = page_access::none;
            if ((flags & 4) != 0) access = access | page_access::read;
            if ((flags & 2) != 0) access = access | page_access::write;
            if ((flags & 1) != 0) access = access | page_access::execute;
            return access;
        }
    }

    ppu_elf_load_result load_ppu_elf(std::span<const std::byte> image, guest_memory& memory)
    {
        ppu_elf_load_result result;
        if (image.size() < 64)
        {
            result.error = ppu_elf_error::truncated;
            return result;
        }
        constexpr std::array magic{std::byte{0x7f}, std::byte{'E'}, std::byte{'L'}, std::byte{'F'}};
        if (!std::equal(magic.begin(), magic.end(), image.begin()))
        {
            result.error = ppu_elf_error::invalid_magic;
            return result;
        }
        if (image[4] != std::byte{2} || image[5] != std::byte{2} || image[6] != std::byte{1})
        {
            result.error = ppu_elf_error::unsupported_format;
            return result;
        }

        std::uint16_t type = 0;
        std::uint16_t machine = 0;
        std::uint64_t entry_descriptor = 0;
        std::uint64_t program_offset = 0;
        std::uint16_t program_entry_size = 0;
        std::uint16_t program_count = 0;
        if (!read_be(image, 16, type) || !read_be(image, 18, machine) || !read_be(image, 24, entry_descriptor) ||
            !read_be(image, 32, program_offset) || !read_be(image, 54, program_entry_size) || !read_be(image, 56, program_count))
        {
            result.error = ppu_elf_error::truncated;
            return result;
        }
        if (type != 2 || machine != 21 || program_entry_size < 56)
        {
            result.error = ppu_elf_error::unsupported_format;
            return result;
        }
        if (program_offset > image.size() || static_cast<std::uint64_t>(program_entry_size) * program_count > image.size() - program_offset)
        {
            result.error = ppu_elf_error::invalid_program_header;
            return result;
        }

        for (std::uint32_t index = 0; index < program_count; ++index)
        {
            const std::uint64_t header = program_offset + static_cast<std::uint64_t>(index) * program_entry_size;
            std::uint32_t kind = 0;
            std::uint32_t flags = 0;
            std::uint64_t file_offset = 0;
            std::uint64_t virtual_address = 0;
            std::uint64_t file_size = 0;
            std::uint64_t memory_size = 0;
            if (!read_be(image, header, kind) || !read_be(image, header + 4, flags) || !read_be(image, header + 8, file_offset) ||
                !read_be(image, header + 16, virtual_address) || !read_be(image, header + 32, file_size) || !read_be(image, header + 40, memory_size))
            {
                result.error = ppu_elf_error::invalid_program_header;
                return result;
            }
            if (kind != 1 || memory_size == 0) continue;
            if (file_size > memory_size || file_offset > image.size() || file_size > image.size() - file_offset)
            {
                result.error = ppu_elf_error::invalid_program_header;
                return result;
            }
            if (virtual_address > std::numeric_limits<std::uint32_t>::max() || memory_size > guest_memory::address_space_size - virtual_address)
            {
                result.error = ppu_elf_error::address_out_of_range;
                return result;
            }

            const std::uint64_t map_start = virtual_address & ~(static_cast<std::uint64_t>(guest_memory::page_size) - 1);
            const std::uint64_t map_end = align_up(virtual_address + memory_size, guest_memory::page_size);
            const std::uint64_t map_size = map_end - map_start;
            if (!memory.map(static_cast<std::uint32_t>(map_start), map_size, page_access::read_write))
            {
                result.error = ppu_elf_error::overlapping_segments;
                return result;
            }
            if (file_size != 0 && !memory.write(static_cast<std::uint32_t>(virtual_address), image.subspan(static_cast<std::size_t>(file_offset), static_cast<std::size_t>(file_size))))
            {
                result.error = ppu_elf_error::memory_write_failed;
                return result;
            }
            const page_access access = segment_access(flags);
            if (access == page_access::none || !memory.protect(static_cast<std::uint32_t>(map_start), map_size, access))
            {
                result.error = ppu_elf_error::invalid_program_header;
                return result;
            }
            ++result.segments;
            result.mapped_pages += static_cast<std::uint32_t>(map_size / guest_memory::page_size);
            result.file_bytes += file_size;
        }

        if (entry_descriptor > std::numeric_limits<std::uint32_t>::max() ||
            !memory.load_be(static_cast<std::uint32_t>(entry_descriptor), result.entry) ||
            !memory.load_be(static_cast<std::uint32_t>(entry_descriptor + 4), result.toc))
        {
            result.error = ppu_elf_error::invalid_entry;
            return result;
        }
        return result;
    }
}
