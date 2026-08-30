#pragma once

#include "guest_memory.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace rpcs3::web
{
    struct ppu_import_stub
    {
        std::string module;
        std::uint32_t nid = 0;
        std::uint32_t stub_address = 0;
        std::uint32_t call_address = 0;
    };

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
        std::uint32_t tls_address = 0;
        std::uint32_t tls_file_size = 0;
        std::uint32_t tls_memory_size = 0;
        std::vector<ppu_import_stub> imports;

        [[nodiscard]] explicit operator bool() const { return error == ppu_elf_error::none; }
    };

    ppu_elf_load_result load_ppu_elf(std::span<const std::byte> image, guest_memory& memory);
}
