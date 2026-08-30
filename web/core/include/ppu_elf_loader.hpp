#pragma once

#include "guest_memory.hpp"

#include <cstddef>
#include <cstdint>
#include <span>

namespace rpcs3::web
{
    enum class ppu_elf_error : std::uint8_t
    {
        none,
        truncated,
        invalid_magic,
        unsupported_format,
        invalid_program_header,
        address_out_of_range,
        overlapping_segments,
        memory_write_failed,
        invalid_entry,
    };

    struct ppu_elf_load_result
    {
        ppu_elf_error error = ppu_elf_error::none;
        std::uint32_t entry = 0;
        std::uint32_t toc = 0;
        std::uint32_t segments = 0;
        std::uint32_t mapped_pages = 0;
        std::uint64_t file_bytes = 0;

        [[nodiscard]] explicit operator bool() const { return error == ppu_elf_error::none; }
    };

    ppu_elf_load_result load_ppu_elf(std::span<const std::byte> image, guest_memory& memory);
}
