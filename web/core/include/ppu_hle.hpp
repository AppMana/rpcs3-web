#pragma once

#include "ppu_elf_loader.hpp"
#include "ppu_interpreter.hpp"

#include <cstdint>

namespace rpcs3::web
{
    struct ppu_hle_context
    {
        const ppu_elf_load_result* elf = nullptr;
        std::uint32_t calls = 0;
        std::uint32_t last_nid = 0;
        std::uint32_t next_object_id = 0x95000001;
        std::uint32_t syscalls = 0;
        std::uint32_t last_syscall = 0;
    };

    bool handle_minimal_ppu_hle(ppu_state& state, guest_memory& memory, std::uint32_t call_address, void* context);
    bool handle_minimal_ppu_syscall(ppu_state& state, guest_memory& memory, std::uint32_t syscall, void* context);
}
